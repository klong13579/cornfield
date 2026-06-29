/**
 * Inbound message handling — session management, cron creation, agent dispatch.
 *
 * Encapsulates the inbound message processing chain that was inline in Gateway:
 * session lookup/rotation, abort/model-command/NL-switch interception, agent
 * forwarding through response handler, and cron-from-message creation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildAgentSessionPath } from "@oh-my-pi/pi-coding-agent/skeleton";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AgentBridge } from "./agent-bridge";
import type { ChannelRegistry } from "./channels/registry";
import { getDataDir } from "./config";
import type { CronLifecycle } from "./gateway-cron-lifecycle";
import type { ModelSwitch } from "./gateway-model-switch";
import type { NewSessionHandler } from "./gateway-new-session";
import type { ResponseHandler } from "./gateway-response";
import { createCronTaskFromMessage } from "./scheduler/from-message";
import type { SessionManager } from "./session-manager";
import type { SQLiteSessionStore } from "./session-store";
import type { GatewayConfig, InboundMessage, OutboundMessage } from "./types";

/** Interface for the subset of Gateway that MessageHandler needs. */
export interface MessageGatewayDeps {
	config: GatewayConfig;
	store: SQLiteSessionStore | null;
	registry: ChannelRegistry;
	bridge: AgentBridge;
	accountBridges: Map<string, AgentBridge>;
	accountAgentDirs: Map<string, string>;
	cronLifecycle: CronLifecycle;
	sessionManager: SessionManager | undefined;
	modelSwitch: ModelSwitch;
	newSessionHandler: NewSessionHandler;
	responseHandler: ResponseHandler;
	extractMessageText(msg: InboundMessage): string;
}

export class MessageHandler {
	#deps: MessageGatewayDeps;

	constructor(deps: MessageGatewayDeps) {
		this.#deps = deps;
	}

	/** Update the store reference after it's created in Gateway.start(). */
	setStore(store: SQLiteSessionStore): void {
		this.#deps.store = store;
	}

	/** Update the session manager reference after it's created in Gateway.start(). */
	setSessionManager(sm: SessionManager): void {
		this.#deps.sessionManager = sm;
	}

	async handleInboundMessage(msg: InboundMessage): Promise<void> {
		logger.debug("Received message", {
			channel: msg.channelId,
			user: msg.userId,
			group: msg.isGroup ? msg.conversationTitle : "DM",
		});

		try {
			const accountId = msg.accountId ?? "__default__";
			if (await this.#deps.responseHandler.handleAbortMessage(msg, accountId)) return;
			if (await this.#deps.modelSwitch.handleModelCommand(msg, accountId)) return;
			if (await this.#deps.newSessionHandler.handle(msg, accountId)) return;
			// Natural-language model switch patterns (e.g. "切换模型到 X") are NOT intercepted here;
			// they fall through to the agent so the LLM can call the `switch_model` tool, fuzzy-match
			// the user's request, and confirm the switch in the assistant reply.
			let session = await this.#deps.store?.getSession(msg.channelId, accountId, msg.conversationId);
			const now = Date.now();

			if (session && this.#deps.newSessionHandler.shouldRotate(session)) {
				const rotated = await this.#deps.newSessionHandler.rotate(session, accountId, {
					injectSystemNote: true,
					msg,
				});
				session = rotated.session;
			}
			if (!session && this.#deps.store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, accountId, msg.conversationId);
				session = await this.#deps.store.createSession({
					channelId: msg.channelId,
					accountId,
					userId: msg.userId,
					conversationId: msg.conversationId,
					createdAt: now,
					updatedAt: now,
					ompSessionPath: sessionPath,
					sessionWebhook: msg.sessionWebhook,
					status: "active",
				});
			} else if (session && this.#deps.store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, accountId, msg.conversationId);
				if (session.ompSessionPath !== sessionPath) {
					if (session.ompSessionPath) {
						await this.#migrateSessionPath(session.ompSessionPath, sessionPath);
					}
					await this.#deps.store.updateSession(session.id, {
						ompSessionPath: sessionPath,
						updatedAt: now,
						sessionWebhook: msg.sessionWebhook,
					});
					session = { ...session, ompSessionPath: sessionPath, sessionWebhook: msg.sessionWebhook };
				} else {
					await this.#deps.store.updateSession(session.id, { updatedAt: now, sessionWebhook: msg.sessionWebhook });
					session = { ...session, sessionWebhook: msg.sessionWebhook };
				}
			}

			if (!session) {
				logger.error("Failed to create session", {
					channelId: msg.channelId,
					accountId,
					conversationId: msg.conversationId,
				});
				return;
			}

			const cronOutcome = this.#tryCreateCronFromMessage(msg, accountId);
			if (cronOutcome) {
				await this.#sendCronOutcomeReply(msg, cronOutcome);
				if (this.#deps.store && session) {
					await this.#deps.store.updateSession(session.id, { updatedAt: Date.now() });
				}
				return;
			}

			const channel = this.#deps.registry.get(`${msg.channelId}${msg.accountId ? `:${msg.accountId}` : ""}`);
			const usedCard = await this.#deps.responseHandler.tryStreamAgentResponse(
				msg,
				session,
				accountId,
				channel,
				this.#deps.sessionManager,
			);
			if (!usedCard) {
				await this.#deps.responseHandler.sendAgentResponseViaV1Markdown(
					msg,
					session,
					accountId,
					this.#deps.sessionManager,
				);
			}

			if (this.#deps.store && session) {
				await this.#deps.store.updateSession(session.id, { updatedAt: Date.now() });
			}
		} catch (err) {
			logger.error("Failed to handle message", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#buildSessionPath(channelId: string, accountId: string, conversationId: string): string {
		const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		const agentDir = this.#deps.accountAgentDirs.get(accountId);
		if (agentDir) {
			return buildAgentSessionPath(agentDir, conversationId);
		}
		const dataDir = getDataDir(this.#deps.config);
		return path.join(dataDir, "sessions", channelId, accountId, `${safeId}.jsonl`);
	}

	async #migrateSessionPath(fromPath: string, toPath: string): Promise<void> {
		if (fromPath === toPath) return;
		try {
			await fs.mkdir(path.dirname(toPath), { recursive: true });
			await fs.rename(fromPath, toPath);
			logger.debug("Migrated gateway session path", { fromPath, toPath });
		} catch (err) {
			if (isEnoent(err)) {
				logger.debug("Session path migration skipped because old path is missing", { fromPath, toPath });
				return;
			}
			throw err;
		}
	}

	#extractMessageText(msg: InboundMessage): string {
		const c = msg.content;
		if (c.type === "text") return c.text;
		if (c.type === "markdown") return c.markdown;
		if (c.type === "voice") return c.text ?? "";
		return "";
	}

	#tryCreateCronFromMessage(
		msg: InboundMessage,
		accountId: string,
	): ReturnType<typeof createCronTaskFromMessage> | undefined {
		const text = this.#extractMessageText(msg);
		if (!text.trimStart().startsWith("/cron create")) return undefined;
		const storage = this.#deps.cronLifecycle.schedulerStorage;
		if (!storage) {
			logger.warn("Cron creation requested but scheduler storage is not initialised");
			return {
				ok: false,
				error: { reason: "db-failed", detail: "scheduler storage not initialised" },
			};
		}
		const acctId = msg.accountId ?? accountId;
		const agentDir = this.#deps.accountAgentDirs.get(acctId);
		return createCronTaskFromMessage(text, agentDir, storage);
	}

	async #sendCronOutcomeReply(
		msg: InboundMessage,
		outcome: ReturnType<typeof createCronTaskFromMessage>,
	): Promise<void> {
		if (!outcome) return;
		const lines: string[] = [];
		if (outcome.ok) {
			const r = outcome.result;
			lines.push(`Task "${r.name}" created.`);
			lines.push(`  Schedule: ${r.schedule}`);
			lines.push(`  Command: ${r.command}`);
			lines.push(`  Type: ${r.type}`);
			lines.push(`  File: ${r.filePath}`);
		} else {
			const e = outcome.error;
			lines.push(`Failed to create task: ${e.reason}`);
			if (e.detail) lines.push(`  ${e.detail}`);
			if (e.reason === "not-cron-intent") return;
		}
		const outbound: OutboundMessage = {
			channelId: msg.channelId,
			conversationId: msg.conversationId,
			content: { type: "markdown", markdown: lines.join("\n") },
			sessionWebhook: msg.sessionWebhook,
			accountId: msg.accountId,
		};
		try {
			await this.#deps.registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send cron-creation reply", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
