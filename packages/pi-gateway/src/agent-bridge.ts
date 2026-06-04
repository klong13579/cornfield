/**
 * Agent Bridge — forwards IM messages to OMP via RPC mode.
 *
 * Architecture:
 *   [DingTalk Message] → AgentBridge.forward() → omp --mode rpc → JSON-line protocol → [Reply]
 *
 * Spawns `omp --mode rpc` as a long-running child process. Communicates via
 * the RPC JSON-line protocol (stdin/stdout). Handles process lifecycle: spawn,
 * crash detection, and recovery with exponential backoff.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { InboundMessage, SessionRecord } from "./types";

export interface AgentBridgeOptions {
	/** Path to omp binary (default: "omp") */
	ompPath?: string;
	/** Model to use (default: undefined = omp default) */
	model?: string;
	/** Maximum time to wait for agent response in ms (default: 120000) */
	timeoutMs?: number;
	/** Working directory for agent execution (default: process.cwd()) */
	cwd?: string;
	/** Max retries for RPC process crash recovery (default: 3) */
	maxCrashRetries?: number;
	/** Base delay for crash recovery backoff in ms (default: 1000) */
	crashBackoffMs?: number;
}

/** Agent event from RPC stream */
interface AgentEvent {
	type: string;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
	};
	text?: string;
}

export class AgentBridge {
	#proc: { pid: number; kill: () => void } | null = null;
	#stdinWriter?: { write: (data: Uint8Array) => void };
	#ready = false;
	#pendingPrompts = new Map<string, { resolve: (events: AgentEvent[]) => void; reject: (error: Error) => void }>();
	#eventBuffer: string[] = [];
	#crashCount = 0;
	#options: AgentBridgeOptions;

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
	}

	// ═══════════════════════════════════════════════════════════════
	// Process Lifecycle
	// ═══════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		await this.#spawnAndWaitReady();
	}

	stop(): void {
		this.#crashCount = 0;
		this.#ready = false;
		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#stdinWriter = undefined;
		const error = new Error("Agent bridge stopped");
		for (const pending of this.#pendingPrompts.values()) {
			pending.reject(error);
		}
		this.#pendingPrompts.clear();
	}

	get isRunning(): boolean {
		return this.#ready && this.#proc !== null;
	}

	// ═══════════════════════════════════════════════════════════════
	// Message Forwarding
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Forward a message to OMP and return the assistant's response text.
	 */
	async forward(msg: InboundMessage, _session: SessionRecord): Promise<string | null> {
		const text = this.#extractText(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		if (!this.isRunning) {
			logger.warn("Agent bridge not running, attempting restart");
			await this.#spawnAndWaitReady();
		}

		logger.debug("Forwarding to agent", {
			userId: msg.userId,
			conversationId: msg.conversationId,
			messageLength: text.length,
		});

		const timeoutMs = this.#options.timeoutMs ?? 120_000;

		try {
			const events = await this.#promptAndWait(text, timeoutMs);
			const response = this.#extractAssistantText(events);

			if (!response) {
				logger.warn("Agent returned empty response");
				return "（Agent 未返回内容）";
			}

			const formatted = this.#formatResponse(response.trim());
			logger.debug("Agent responded", { responseLength: formatted.length });
			return formatted;
		} catch (err) {
			if (this.#isCrashError(err)) {
				logger.warn("Agent process crashed, attempting recovery");
				await this.#attemptRecovery();
				return "系统正在恢复中，请稍后再试。";
			}
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Agent bridge failed", { error: message });
			return `系统错误：${message}`;
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// RPC Protocol
	// ═══════════════════════════════════════════════════════════════

	async #spawnAndWaitReady(): Promise<void> {
		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#ready = false;
		this.#eventBuffer = [];

		const ompPath = this.#options.ompPath ?? "omp";
		const args = ["--mode", "rpc"];
		if (this.#options.model) {
			args.push("--model", this.#options.model);
		}

		logger.debug("Spawning agent RPC process", { ompPath, args });

		const proc = Bun.spawn([ompPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "pipe",
			cwd: this.#options.cwd ?? process.cwd(),
			env: { ...process.env },
		});

		// FileSink for stdin (Bun specific)
		const stdin = proc.stdin as FileSink;
		if (!stdin || typeof stdin.write !== 'function') {
			logger.error("Invalid stdin for agent bridge");
			throw new Error("Failed to initialize agent bridge stdin");
		}

		this.#proc = { pid: proc.pid, kill: () => proc.kill() };
		this.#stdinWriter = {
			write: (data: Uint8Array) => {
				stdin.write(data);
			},
		};
		// Process stdout lines asynchronously
		(async () => {
			for await (const line of this.#readLines(proc.stdout as ReadableStream<Uint8Array>)) {
				this.#handleRpcLine(line);
			}
		})();

		// Drain stderr (non-blocking)
		(async () => {
			for await (const _line of this.#readLines(proc.stderr as ReadableStream<Uint8Array>)) {
				// stderr logging only, no action needed
			}
		})();

		// Wait for "ready" signal or process exit
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill();
			reject(new Error("Agent RPC process timed out waiting for ready signal"));
		}, 30000);

		const checkReady = setInterval(() => {
			if (settled) return;
			if (this.#ready) {
				settled = true;
				clearTimeout(timeout);
				clearInterval(checkReady);
				resolve();
			}
		}, 50);

		void proc.exited.then(exitCode => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearInterval(checkReady);
			reject(new Error(`Agent RPC process exited with code ${exitCode} before ready`));
		});

		try {
			await promise;
			this.#crashCount = 0;
			logger.debug("Agent RPC process ready", { pid: proc.pid });
		} catch (err) {
			proc.kill();
			this.#proc = null;
			this.#stdinWriter = undefined;
			throw err;
		}
	}

	#handleRpcLine(line: string): void {
		try {
			const parsed = JSON.parse(line);

			if (parsed.type === "ready") {
				this.#ready = true;
				return;
			}

			// Collect agent events for pending prompts
			this.#eventBuffer.push(line);
		} catch {
			// Non-JSON line — ignore
		}
	}

	async #promptAndWait(message: string, timeoutMs: number): Promise<AgentEvent[]> {
		this.#eventBuffer = [];

		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`Agent RPC timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		// Write prompt to stdin
		const frame = `${JSON.stringify({ type: "prompt", message })}\n`;
		if (this.#stdinWriter) {
			this.#stdinWriter.write(new TextEncoder().encode(frame));
		} else {
			clearTimeout(timeout);
			reject(new Error("Agent process not running"));
			return promise;
		}

		// Check event buffer for agent_end (events processed by #handleRpcLine in real-time)
		const checkInterval = setInterval(() => {
			if (settled) {
				clearInterval(checkInterval);
				return;
			}
			const events: AgentEvent[] = [];
			let agentEndFound = false;
			for (const line of this.#eventBuffer) {
				try {
					const parsed = JSON.parse(line);
					events.push(parsed);
					if (parsed.type === "agent_end") {
						agentEndFound = true;
						break;
					}
				} catch {
					// skip invalid JSON
				}
			}
			if (agentEndFound) {
				settled = true;
				clearTimeout(timeout);
				clearInterval(checkInterval);
				resolve(events);
			}
		}, 100);

		return promise;
	}

	#extractAssistantText(events: AgentEvent[]): string | null {
		const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
		const last = assistantEvents[assistantEvents.length - 1];
		if (!last?.message?.content) return null;
		const textContent = last.message.content.find(c => c.type === "text");
		return textContent?.text ?? null;
	}

	// ═══════════════════════════════════════════════════════════════
	// Crash Recovery
	// ═══════════════════════════════════════════════════════════════

	#isCrashError(err: unknown): boolean {
		if (err instanceof Error) {
			const msg = err.message;
			return msg.includes("exited") || msg.includes("before ready") || msg.includes("not running");
		}
		return false;
	}

	async #attemptRecovery(): Promise<void> {
		const maxRetries = this.#options.maxCrashRetries ?? 3;
		const baseDelay = this.#options.crashBackoffMs ?? 1000;

		if (this.#crashCount >= maxRetries) {
			logger.error("Max crash retries exceeded, giving up", {
				crashCount: this.#crashCount,
				maxRetries,
			});
			return;
		}

		this.#crashCount++;
		const delay = baseDelay * 2 ** (this.#crashCount - 1);
		logger.warn("Agent process crashed, restarting", {
			crashCount: this.#crashCount,
			delayMs: delay,
		});

		await Bun.sleep(delay);
		await this.#spawnAndWaitReady();
	}

	// ═══════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════

	async *#readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
		const reader = stream.getReader();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += new TextDecoder().decode(value);
				let idx = buffer.indexOf("\n");
				while (idx !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);
					if (line) yield line;
					idx = buffer.indexOf("\n");
				}
			}
		} catch {
			if (buffer.trim()) yield buffer.trim();
		}
	}

	#extractText(msg: InboundMessage): string {
		if (msg.content.type === "text") return msg.content.text;
		if (msg.content.type === "markdown") return msg.content.markdown;
		if (msg.content.type === "voice" && msg.content.text) return msg.content.text;
		return "[non-text message]";
	}

	#formatResponse(text: string): string {
		const MAX_LENGTH = 2000;
		const TRUNCATE_NOTICE = "\n\n...(内容已截断，请使用终端查看完整输出)";
		if (text.length <= MAX_LENGTH) return text;
		let cutAt = text.lastIndexOf("\n\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = text.lastIndexOf("\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		}
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = MAX_LENGTH - TRUNCATE_NOTICE.length;
		}
		return text.slice(0, cutAt) + TRUNCATE_NOTICE;
	}
}
