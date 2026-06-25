/**
 * Session manager — queues inbound messages and dispatches them to account bridges.
 *
 * Invariants:
 * - One account bridge processes at most one prompt at a time.
 * - Different account bridges may process concurrently.
 * - Queue depth is bounded per account to avoid unbounded memory growth.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentBridge, AgentBridgeSnapshot, ForwardStreamHandlers } from "./agent-bridge";
import type { AgentResponseMeta, InboundMessage, SessionRecord } from "./types";

export interface QueueStat {
	accountId: string;
	depth: number;
	oldestAgeMs: number;
}

export interface BridgeStat extends AgentBridgeSnapshot {
	accountId: string;
}

export interface SessionManagerOptions {
	bridges: Map<string, AgentBridge>;
	defaultBridge?: AgentBridge;
	maxQueueDepth?: number;
}

interface AccountQueueState {
	tail: Promise<void>;
	depth: number;
	oldestQueuedAt?: number;
}

const DEFAULT_MAX_QUEUE_DEPTH = 100;
const QUEUE_FULL_MESSAGE = "系统繁忙，请稍后重试。";

export class SessionManager {
	readonly #bridges: Map<string, AgentBridge>;
	readonly #defaultBridge?: AgentBridge;
	readonly #maxQueueDepth: number;
	readonly #queues = new Map<string, AccountQueueState>();

	constructor(options: SessionManagerOptions) {
		this.#bridges = options.bridges;
		this.#defaultBridge = options.defaultBridge;
		this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
	}

	async enqueue(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		const meta = await this.enqueueWithMeta(msg, session);
		if (meta === null) return QUEUE_FULL_MESSAGE;
		return meta.text;
	}

	/**
	 * Same queueing / serialization contract as `enqueue`, but returns the
	 * full `AgentResponseMeta` instead of just the rendered text. Callers
	 * that want richer reply chrome (status line, tool summary, quote
	 * content) use this directly.
	 *
	 * Returns `null` when the queue is full (caller is expected to handle
	 * the empty case — typically by sending a localized "system busy"
	 * message without the chrome).
	 *
	 * When `handlers` is provided, the bridge fires streaming callbacks
	 * (`onTextDelta` / `onThinkingDelta` / `onAssistantMessageEnd` /
	 * `onAgentEnd`) as RPC events arrive. Used by the AI Card path to
	 * surface incremental progress to the user before the run ends.
	 */
	async enqueueWithMeta(
		msg: InboundMessage,
		session: SessionRecord,
		handlers?: ForwardStreamHandlers,
	): Promise<AgentResponseMeta | null> {
		const accountId = session.accountId;
		const state = this.#getQueue(accountId);
		if (state.depth >= this.#maxQueueDepth) {
			logger.warn("Session queue full, rejecting message", {
				accountId,
				conversationId: session.conversationId,
				depth: state.depth,
				maxQueueDepth: this.#maxQueueDepth,
			});
			return null;
		}

		state.depth++;
		state.oldestQueuedAt ??= Date.now();

		const previous = state.tail;
		const { promise: current, resolve } = Promise.withResolvers<void>();
		state.tail = previous.catch(() => {}).then(() => current);

		await previous.catch(() => {});
		try {
			const bridge = this.#resolveBridge(accountId);
			if (!bridge.isRunning) {
				throw new Error(`Agent bridge for account "${accountId}" is not running`);
			}
			return await bridge.forwardWithMeta(msg, session, handlers);
		} finally {
			state.depth--;
			if (state.depth === 0) {
				state.oldestQueuedAt = undefined;
				this.#queues.delete(accountId);
			}
			resolve();
		}
	}

	async abort(accountId: string): Promise<boolean> {
		const bridge = this.#resolveBridge(accountId);
		return await bridge.abort();
	}

	/**
	 * Abort the bridge for the account that owns a given user. Used as
	 * a fallback when a card-action click arrives for a cardInstanceId
	 * the registry doesn't know about (e.g. the schema's static
	 * `btn_stop` button fires from a card we never registered because
	 * the long-task watcher never ran for that tool). Pick the account
	 * that has the most recent activity for this user; if no account
	 * has seen them, fall back to the default bridge.
	 */
	async abortByUser(userId: string): Promise<boolean> {
		// We don't track user→account directly, so the safest
		// fallback is: if a default bridge exists, abort it; the
		// single-account case is the common one. Multi-account
		// deployments should always go through the registry.
		if (this.#defaultBridge) {
			return await this.#defaultBridge.abort();
		}
		// No default — try every account; return true if any aborted.
		let any = false;
		for (const bridge of this.#bridges.values()) {
			try {
				if (await bridge.abort()) any = true;
			} catch {
				// ignore per-bridge abort errors so a single failed
				// bridge doesn't block the others
			}
		}
		return any;
	}

	getQueueStats(): QueueStat[] {
		const now = Date.now();
		return Array.from(this.#queues.entries()).map(([accountId, state]) => ({
			accountId,
			depth: state.depth,
			oldestAgeMs: state.oldestQueuedAt ? now - state.oldestQueuedAt : 0,
		}));
	}

	getBridgeStats(): BridgeStat[] {
		const stats = Array.from(this.#bridges.entries()).map(([accountId, bridge]) => ({
			accountId,
			...bridge.getSnapshot(),
		}));
		if (this.#defaultBridge) {
			stats.push({
				accountId: "__default__",
				...this.#defaultBridge.getSnapshot(),
			});
		}
		return stats;
	}

	async waitForAllDrained(timeoutMs: number): Promise<boolean> {
		const tails = Array.from(this.#queues.values()).map(state => state.tail.catch(() => {}));
		if (tails.length === 0) return true;

		const timeout = Bun.sleep(timeoutMs).then(() => false);
		const drained = Promise.all(tails).then(() => true);
		return await Promise.race([drained, timeout]);
	}

	#getQueue(accountId: string): AccountQueueState {
		let state = this.#queues.get(accountId);
		if (!state) {
			state = { tail: Promise.resolve(), depth: 0 };
			this.#queues.set(accountId, state);
		}
		return state;
	}

	#resolveBridge(accountId: string): AgentBridge {
		if (accountId === "__default__") {
			if (!this.#defaultBridge) throw new Error("Default agent bridge is not available");
			return this.#defaultBridge;
		}

		const bridge = this.#bridges.get(accountId);
		if (!bridge) throw new Error(`No agent bridge registered for account "${accountId}"`);
		return bridge;
	}
}
