/**
 * New-session command + session rotation handling.
 *
 * Two entry points share the same core rotation:
 *
 * 1. Slash commands — `/new`, `/reset`, `/clear`, `新会话`, `重新开始`, `清空对话`.
 *    Intercepted at the top of `MessageHandler.handleInboundMessage` before
 *    the message reaches the agent. Replies "已开启新会话" and returns.
 *
 * 2. Lazy rotation — triggered by `shouldRotate()` from `MessageHandler`
 *    when an existing session is past the idle/daily policy. Reuses the
 *    same archive + RPC flow; the next user message naturally starts a
 *    fresh conversation. Optionally injects a system note so the LLM
 *    understands the abrupt context loss on the next turn.
 *
 * Rotation is a hard reset:
 *   1. fs.rename the old `ompSessionPath` to `ompSessionPath.<TIMESTAMP>.jsonl`
 *      (history preserved, file disappears from the active path).
 *   2. RPC `new_session` → agent clears in-memory messages, context, cache.
 *   3. RPC `switch_session(ompSessionPath)` → agent re-opens the
 *      gateway-tracked path; the file does not exist yet, so the write
 *      stream creates a fresh empty file. This step is required because
 *      `new_session` makes the agent point at an interactive-style
 *      `by-date/<date>/<8hex>.jsonl` path, not the gateway convention.
 *   4. SQLite row updated in place (same `id`, fresh `updatedAt`).
 *      We do not close+create because `(channel, account, convId)` is
 *      unique — same conversation always uses the same SQLite row.
 */
import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AgentBridge } from "./agent-bridge";
import type { SQLiteSessionStore } from "./session-store";
import type { GatewayConfig, InboundMessage, MessageContent, SessionRecord } from "./types";

/**
 * Triggers matched at the start of the message text. Slash commands use
 * `\b` (word boundary) to avoid `/news` matching `/new`. Chinese triggers
 * can't use `\b` because Chinese characters are non-word; we anchor on
 * the prefix and a look-ahead that excludes CJK continuation characters,
 * so `新会话开始` would NOT match — the user must type the command
 * followed by punctuation, whitespace, or end-of-string.
 */
const NEW_SESSION_TRIGGERS: readonly RegExp[] = [
	// Use Unicode property escapes (`\p{Script=Han}`) for CJK look-ahead
	// because V8's `\b` (word boundary) treats CJK chars as non-word, so
	// `/^\s*\/new\b/` falsely matches `/new主题` (`w` then `主` is a word
	// boundary in default V8). The correct gate is: NOT followed by an
	// ASCII letter (so `/newtest` does not match) AND NOT followed by a
	// Han character (so `/new主题` does not match), but space / digit /
	// punctuation / EOF are all fine (e.g. `/new` end, `/new test`,
	// `/new1`, `/new,`).
	/^\s*\/new(?![a-zA-Z]|\p{Script=Han})/u,
	/^\s*\/reset(?![a-zA-Z]|\p{Script=Han})/u,
	/^\s*\/clear(?![a-zA-Z]|\p{Script=Han})/u,
	/^\s*新会话(?=\s|$|[^\u4e00-\u9fff])/,
	/^\s*重新开始(?=\s|$|[^\u4e00-\u9fff])/,
	/^\s*清空对话(?=\s|$|[^\u4e00-\u9fff])/,
];

const SYSTEM_NOTE = "[System note: This is a fresh conversation with no prior context.]\n\n";

export interface NewSessionHandlerDeps {
	config: GatewayConfig;
	store: SQLiteSessionStore | null;
	resolveDirectBridge(accountId?: string): AgentBridge | null;
	sendAgentResponse(msg: InboundMessage, text: string): Promise<void>;
	extractMessageText(msg: InboundMessage): string;
}

export class NewSessionHandler {
	#deps: NewSessionHandlerDeps;

	constructor(deps: NewSessionHandlerDeps) {
		this.#deps = deps;
	}

	/** Update the store reference after it's created in Gateway.start(). */
	setStore(store: SQLiteSessionStore): void {
		this.#deps.store = store;
	}

	/** Whether `text` matches any of the `/new` family of triggers. */
	isNewSessionCommand(text: string): boolean {
		const trimmed = text.trimStart();
		return NEW_SESSION_TRIGGERS.some(rx => rx.test(trimmed));
	}

	/**
	 * Intercept `/new` and friends. Returns true if the message was a
	 * trigger (handled, do not forward to agent). Returns false if the
	 * message should fall through to the normal pipeline.
	 */
	async handle(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#deps.extractMessageText(msg);
		if (!this.isNewSessionCommand(text)) return false;

		const session = await this.#deps.store?.getSession(msg.channelId, accountId, msg.conversationId);
		if (!session) {
			await this.#deps.sendAgentResponse(msg, "当前没有活跃会话。");
			return true;
		}

		try {
			await this.rotate(session, accountId);
			await this.#deps.sendAgentResponse(msg, "已开启新会话。之前的对话已归档。");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Failed to start new session", { error: message, sessionId: session.id });
			await this.#deps.sendAgentResponse(msg, `开启新会话失败: ${message}`);
		}
		return true;
	}

	/**
	 * Whether the session is past the idle/daily reset policy and should
	 * be rotated before forwarding the next message.
	 */
	shouldRotate(session: SessionRecord): boolean {
		const policy = this.#deps.config.session?.resetPolicy ?? "both";
		if (policy === "none") return false;

		const now = Date.now();
		const updatedAt = session.updatedAt;

		if (policy === "idle" || policy === "both") {
			const idleMs = (this.#deps.config.session?.idleTimeoutMinutes ?? 240) * 60_000;
			if (now - updatedAt > idleMs) return true;
		}

		if (policy === "daily" || policy === "both") {
			const resetHour = this.#deps.config.session?.dailyResetHour ?? 2;
			const today = new Date(now);
			const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate(), resetHour, 0, 0, 0);
			const boundary = now < todayReset.getTime() ? todayReset.getTime() - 86_400_000 : todayReset.getTime();
			if (updatedAt < boundary) return true;
		}

		return false;
	}

	/**
	 * Rotate the session: archive old, RPC new_session + switch_session,
	 * update SQLite row. Returns the refreshed record.
	 *
	 * If `injectSystemNote` is true and `msg` is provided, the message
	 * content is prepended with a system note so the LLM understands the
	 * abrupt context loss on the next turn. This is used for lazy rotation
	 * (the user did not explicitly ask to reset). Explicit `/new` skips
	 * the note because the next message will be the user's new request.
	 */
	async rotate(
		session: SessionRecord,
		accountId: string,
		opts: { injectSystemNote?: boolean; msg?: InboundMessage } = {},
	): Promise<SessionRecord> {
		logger.info("Rotating session", {
			sessionId: session.id,
			channelId: session.channelId,
			accountId,
			conversationId: session.conversationId,
			trigger: opts.injectSystemNote ? "lazy" : "command",
		});

		// 1. Archive old file (rename with timestamp suffix).
		if (session.ompSessionPath) {
			try {
				const archivePath = this.#archivePath(session.ompSessionPath);
				await fs.rename(session.ompSessionPath, archivePath);
				logger.debug("Archived old session file", { from: session.ompSessionPath, to: archivePath });
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("Failed to archive old session file", {
						path: session.ompSessionPath,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		// 2. RPC: clear agent in-memory state, then force it back to the
		//    gateway-tracked file. If the bridge is not running, we still
		//    rotate at the file + SQLite level — the agent will pick up
		//    the cleared file the next time it is asked to switch.
		const bridge = this.#deps.resolveDirectBridge(accountId === "__default__" ? undefined : accountId);
		if (bridge?.isRunning) {
			try {
				await bridge.newSession();
				if (session.ompSessionPath) {
					await bridge.switchSession(session.ompSessionPath);
				}
			} catch (err) {
				logger.warn("Failed to reset agent in-memory state during rotation", {
					sessionId: session.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} else {
			logger.debug("Bridge not running; rotation applied to file + SQLite only", {
				sessionId: session.id,
			});
		}

		// 3. Update SQLite row in place. Same conversation always uses the
		//    same row (UNIQUE on channel/account/conversation), so we
		//    refresh the timestamp rather than close+create.
		const now = Date.now();
		await this.#deps.store?.updateSession(session.id, {
			updatedAt: now,
			sessionWebhook: opts.msg?.sessionWebhook ?? session.sessionWebhook,
		});

		const newSession: SessionRecord = {
			...session,
			updatedAt: now,
			sessionWebhook: opts.msg?.sessionWebhook ?? session.sessionWebhook,
		};

		// 4. Optionally inject system note into the next message. We mutate
		//    `msg.content` in place because the caller (`MessageHandler`)
		//    holds the reference and forwards the same object downstream.
		if (opts.injectSystemNote && opts.msg) {
			prependSystemNote(opts.msg.content, SYSTEM_NOTE);
		}

		return newSession;
	}

	#archivePath(sessionPath: string): string {
		const ts = new Date()
			.toISOString()
			.replace(/[-:T]/g, "")
			.slice(0, 14)
			.replace(/(\d{8})(\d{6})/, "$1_$2");
		const dot = sessionPath.lastIndexOf(".");
		if (dot === -1) return `${sessionPath}.${ts}`;
		return `${sessionPath.slice(0, dot)}.${ts}${sessionPath.slice(dot)}`;
	}
}

function prependSystemNote(content: MessageContent, note: string): void {
	if (content.type === "text") {
		content.text = note + content.text;
	} else if (content.type === "markdown") {
		content.markdown = note + content.markdown;
	}
}
