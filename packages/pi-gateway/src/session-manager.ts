/**
 * Session manager — queues inbound messages and dispatches them to account bridges.
 *
 * Invariants:
 * - One account bridge processes at most one prompt at a time.
 * - Different account bridges may process concurrently.
 * - Queue depth is bounded per account to avoid unbounded memory growth.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentBridge, AgentBridgeSnapshot } from "./agent-bridge";
import type { InboundMessage, SessionRecord } from "./types";

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
		const accountId = session.accountId;
		const state = this.#getQueue(accountId);
		if (state.depth >= this.#maxQueueDepth) {
			logger.warn("Session queue full, rejecting message", {
				accountId,
				conversationId: session.conversationId,
				depth: state.depth,
				maxQueueDepth: this.#maxQueueDepth,
			});
			return QUEUE_FULL_MESSAGE;
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
			return await bridge.forward(msg, session);
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
