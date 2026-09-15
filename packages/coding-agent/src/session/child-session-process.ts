/**
 * One formal Child Session process.
 *
 * A formal Child Session is an *isolated OS process* — never an in-process
 * `AgentSession`. This class owns the part of that which is purely about the
 * process: spawn, the wire handshake, request/response correlation, and the
 * graceful-stop ladder. It knows nothing about the session tree, restart
 * policy or concurrency — `./child-session-supervisor.ts` owns those.
 *
 * Child program: `cornfield --mode wire-stdio` (the same `@cornfield/wire`
 * protocol the gateway drives), spawned with the orchestrator edge in its
 * environment so it registers on the intercom broker as a child.
 *
 * Restarts reuse the instance: `sessionId` is the session's identity and must
 * survive a crash, while `bootId` increments per launch so that a frame or an
 * exit from a previous incarnation can be recognised as stale instead of being
 * attributed to the process that replaced it.
 *
 * The stop ladder — and its deliberate end:
 *
 *   1. `abort`            — leave the in-flight turn in a defined state
 *   2. close stdin        — wire-stdio / rpc mode exit(0) on stdin EOF
 *   3. SIGTERM            — the signal a running child can still handle
 *   4. drain window       — and then STOP. There is no automatic SIGKILL.
 *
 * Step 4 is the point. SIGKILL skips every handler the child would have run on
 * the way out (the restart sentinel, the tail of its session log, in-flight
 * writes), so a supervisor that force-kills after a timeout is not stopping a
 * child gracefully — it is destroying one and calling it stopped. When the
 * ladder runs out, `stop()` reports that the child did **not** stop, names the
 * pid, and leaves the decision to kill to the operator. This mirrors the
 * existing `terminateSidecar()` contract in `src/commands/serve-sidecar.ts`:
 * SIGTERM, one drain window, and no force-kill after it.
 */

import { logger } from "@cornfield/utils";
import { type ClientFrame, MULTIDEVICE_PROTOCOL_VERSION, type ServerFrame, type WireCommand } from "@cornfield/wire";
import type { FileSink, Subprocess } from "bun";

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_TIMEOUT_MS = 3_000;
const DEFAULT_EXIT_GRACE_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 3_000;
/** How many trailing stderr lines to keep for crash diagnosis. */
const STDERR_TAIL_LINES = 20;

export type ChildSessionProcessState = "idle" | "starting" | "ready" | "stopping" | "exited";

/** Everything a caller needs to decide whether an exit was a crash. */
export interface ChildSessionExit {
	bootId: number;
	pid: number;
	/** Numeric exit code, or `null` when the process died from a signal. */
	code: number | null;
	signal: NodeJS.Signals | null;
	/** True when `stop()` asked for this exit — a stop is not a crash. */
	expected: boolean;
	/** Trailing stderr, joined; empty when the child wrote nothing. */
	stderrTail: string;
}

export type ChildSessionProcessEvent =
	| { type: "ready"; bootId: number; pid: number }
	| { type: "frame"; bootId: number; frame: ServerFrame }
	| ({ type: "exited" } & ChildSessionExit);

export interface ChildSessionCommand {
	/** Executable to spawn. */
	bin: string;
	/** Arguments; callers pass `--mode wire-stdio` (plus any model/cwd flags). */
	args: readonly string[];
}

export interface ChildSessionProcessOptions {
	/** Session-tree identity of the child this process serves. Survives restarts. */
	sessionId: string;
	cwd: string;
	command: ChildSessionCommand;
	/** Extra environment on top of this process's own (the orchestrator edge lives here). */
	env?: Record<string, string>;
	/** Budget for the hello → hello_ack handshake. */
	readyTimeoutMs?: number;
	/** Budget for one `request` when the caller does not pass its own. */
	requestTimeoutMs?: number;
	/** Budget for the pre-stop `abort`. */
	abortTimeoutMs?: number;
	/** Time the child gets to exit after stdin closes. */
	exitGraceMs?: number;
	/** Time the child gets to exit after SIGTERM before the stop is reported as failed. */
	termGraceMs?: number;
}

/** A child session process could not do what was asked. */
export class ChildSessionProcessError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ChildSessionProcessError";
	}
}

/** A request was issued against a process that is not ready (or no longer alive). */
export class ChildSessionUnavailableError extends ChildSessionProcessError {
	constructor(message: string) {
		super(message);
		this.name = "ChildSessionUnavailableError";
	}
}

/** The child died with a request still in flight — the request did not complete. */
export class ChildSessionExitedError extends ChildSessionProcessError {
	readonly exit: ChildSessionExit;

	constructor(exit: ChildSessionExit) {
		super(`Child session process ${exit.pid} exited ${describeExit(exit)} with a request in flight`);
		this.name = "ChildSessionExitedError";
		this.exit = exit;
	}
}

/** The child answered nothing in time; it is alive until proven otherwise. */
export class ChildSessionRequestTimeoutError extends ChildSessionProcessError {
	constructor(message: string) {
		super(message);
		this.name = "ChildSessionRequestTimeoutError";
	}
}

/**
 * The child is still running after every step of the stop ladder.
 *
 * It is thrown, not swallowed: the process exists and keeps whatever it was
 * doing, so reporting the stop as done would be a plausible lie about both the
 * child's state and the resources it still holds.
 */
export class ChildSessionStopTimeoutError extends ChildSessionProcessError {
	readonly pid: number;
	/** What was already tried, in order, so the caller can decide the next step. */
	readonly attempted: readonly string[];

	constructor(input: { sessionId: string; pid: number; attempted: readonly string[]; waitedMs: number }) {
		super(
			`Child session "${input.sessionId}" (pid ${input.pid}) did not exit within ${input.waitedMs}ms of ${input.attempted.join(" then ")}; it is still running and was not force-killed`,
		);
		this.name = "ChildSessionStopTimeoutError";
		this.pid = input.pid;
		this.attempted = input.attempted;
	}
}

function describeExit(exit: Pick<ChildSessionExit, "code" | "signal">): string {
	if (exit.signal) return `from ${exit.signal}`;
	return `with code ${exit.code ?? "unknown"}`;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

interface ResolvedOptions {
	sessionId: string;
	cwd: string;
	command: ChildSessionCommand;
	env: Record<string, string>;
	readyTimeoutMs: number;
	requestTimeoutMs: number;
	abortTimeoutMs: number;
	exitGraceMs: number;
	termGraceMs: number;
}

export class ChildSessionProcess {
	readonly sessionId: string;
	readonly #options: ResolvedOptions;

	#proc: Subprocess | null = null;
	#stdin: FileSink | null = null;
	#state: ChildSessionProcessState = "idle";
	/** Increments per launch; stamps every event so stale ones are recognisable. */
	#bootId = 0;
	#expectedExit = false;
	#stderrTail: string[] = [];
	#pending = new Map<string, PendingRequest>();
	#listeners: Array<(event: ChildSessionProcessEvent) => void> = [];
	#nextRequestId = 0;
	#readyWait: { resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout } | null = null;
	/** The stop ladder currently in flight, shared by every caller of `stop()`. */
	#stopPromise: Promise<void> | null = null;

	constructor(options: ChildSessionProcessOptions) {
		this.sessionId = options.sessionId;
		this.#options = {
			sessionId: options.sessionId,
			cwd: options.cwd,
			command: options.command,
			env: options.env ?? {},
			readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			abortTimeoutMs: options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
			exitGraceMs: options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS,
			termGraceMs: options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
		};
	}

	get state(): ChildSessionProcessState {
		return this.#state;
	}

	/** Launch counter of the current incarnation; 0 before the first `start()`. */
	get bootId(): number {
		return this.#bootId;
	}

	get pid(): number | undefined {
		return this.#proc?.pid;
	}

	/** Subscribe to lifecycle events. Returns an unsubscribe function. */
	subscribe(listener: (event: ChildSessionProcessEvent) => void): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index !== -1) this.#listeners.splice(index, 1);
		};
	}

	#emit(event: ChildSessionProcessEvent): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Child session process event listener threw", {
					sessionId: this.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Spawn the child and complete the wire handshake.
	 *
	 * Resolves only once the child answered `hello_ack`; a child that exits or
	 * stays silent before that rejects with the reason (exit code + stderr tail,
	 * or the handshake timeout) rather than being reported as ready.
	 */
	async start(): Promise<void> {
		if (this.#state === "starting" || this.#state === "ready") {
			throw new ChildSessionProcessError(`Child session "${this.sessionId}" is already ${this.#state}`);
		}

		const bootId = ++this.#bootId;
		this.#expectedExit = false;
		this.#stderrTail = [];
		this.#state = "starting";

		const { bin, args } = this.#options.command;
		let proc: Subprocess;
		try {
			proc = Bun.spawn([bin, ...args], {
				cwd: this.#options.cwd,
				env: { ...process.env, ...this.#options.env },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			this.#state = "exited";
			throw new ChildSessionProcessError(
				`Failed to spawn child session process "${bin}": ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}

		this.#proc = proc;
		this.#stdin = (proc.stdin as FileSink | null) ?? null;
		if (!this.#stdin) {
			proc.kill("SIGTERM");
			this.#proc = null;
			this.#state = "exited";
			throw new ChildSessionProcessError(`Child session process "${bin}" produced no stdin pipe`);
		}

		void this.#readStdout(proc, bootId);
		void this.#readStderr(proc);
		void proc.exited.then(
			() => this.#onExit(proc, bootId),
			error => this.#onExit(proc, bootId, error instanceof Error ? error : new Error(String(error))),
		);

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timeout = setTimeout(() => {
			this.#failReadyWait(
				new ChildSessionProcessError(
					`Child session process (pid ${proc.pid}) did not complete the wire handshake within ${this.#options.readyTimeoutMs}ms`,
				),
			);
		}, this.#options.readyTimeoutMs);
		timeout.unref?.();
		this.#readyWait = { resolve, reject, timeout };

		try {
			this.#writeFrame({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "child-session" });
		} catch (error) {
			this.#failReadyWait(error instanceof Error ? error : new Error(String(error)));
		}

		try {
			await promise;
		} catch (error) {
			// A child that cannot complete the handshake is not left silently running:
			// reap it through the no-kill ladder and report the handshake failure.
			if (this.#isRunning()) await this.#reapUnusableProcess(proc);
			throw error;
		}
	}

	/**
	 * Send one command and wait for its response.
	 *
	 * Rejects — never resolves with a placeholder — when the child is not ready,
	 * when the child exits with the request in flight, or when the response does
	 * not arrive in time. A caller that retries must decide for itself whether
	 * the command is safe to run twice.
	 */
	async request<Result = unknown>(command: WireCommand, timeoutMs?: number): Promise<Result> {
		if (this.#state !== "ready" || !this.#stdin) {
			throw new ChildSessionUnavailableError(
				`Child session "${this.sessionId}" is ${this.#state}; cannot send "${command.type}"`,
			);
		}
		return this.#sendRequest<Result>(command, timeoutMs);
	}

	/**
	 * Write one request and wait for its response.
	 *
	 * Unguarded on purpose: `stop()` uses it for the pre-stop `abort` while the
	 * process is already in the `stopping` state, where the public `request()`
	 * would (correctly) refuse to start new work.
	 */
	async #sendRequest<Result = unknown>(command: WireCommand, timeoutMs?: number): Promise<Result> {
		const id = `cs${this.#bootId}_${++this.#nextRequestId}`;
		const { promise, resolve, reject } = Promise.withResolvers<Result>();
		// The id goes on the frame AND inside the command: wire servers answer with
		// `command.id` (the frame id is not what comes back), so a frame-only id would
		// leave every response unmatched and every request timing out.
		const wireCommand = { ...command, id } as WireCommand;
		const budget = timeoutMs ?? this.#options.requestTimeoutMs;
		const timeout = setTimeout(() => {
			this.#pending.delete(id);
			reject(
				new ChildSessionRequestTimeoutError(
					`Child session "${this.sessionId}" did not answer "${command.type}" within ${budget}ms`,
				),
			);
		}, budget);
		timeout.unref?.();
		this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });

		try {
			this.#writeFrame({ type: "request", id, command: wireCommand });
		} catch (error) {
			this.#settlePending(id, error instanceof Error ? error : new Error(String(error)));
		}

		return promise;
	}

	/**
	 * Stop the child through the ladder, and stop there.
	 *
	 * Idempotent: a second call on an already-exited process returns immediately.
	 * Throws {@link ChildSessionStopTimeoutError} when the child is still running
	 * after the drain window — the caller must be able to tell "stopped" from
	 * "asked to stop and was ignored".
	 */
	stop(): Promise<void> {
		const proc = this.#proc;
		if (!proc || this.#state === "exited" || this.#state === "idle") {
			this.#state = "exited";
			return Promise.resolve();
		}
		// One ladder, however many callers ask for it. Two independent stops (a
		// caller's and the supervisor's own cleanup) must not race over the same
		// process: the loser would report a stop failure that never happened.
		if (this.#stopPromise) return this.#stopPromise;

		const attempt = this.#runStopLadder(proc);
		this.#stopPromise = attempt.then(
			() => {
				this.#stopPromise = null;
			},
			error => {
				// Clear it so a later stop() retries the ladder — the child is still there.
				this.#stopPromise = null;
				throw error;
			},
		);
		return this.#stopPromise;
	}

	async #runStopLadder(proc: Subprocess): Promise<void> {
		const attempted: string[] = [];
		this.#expectedExit = true;
		this.#state = "stopping";

		// 1. Let the child settle its in-flight turn. A child that is already idle
		//    answers immediately; one that ignores the command falls through to EOF.
		if (this.#stdin) {
			attempted.push("abort");
			try {
				await this.#sendRequest({ type: "abort" }, this.#options.abortTimeoutMs);
			} catch {
				// Abort is best effort — EOF (2) is the actual stop signal.
			}
		}

		// 2. stdin EOF: wire-stdio and rpc mode both exit(0) on it.
		attempted.push("stdin close");
		try {
			this.#stdin?.end();
		} catch (error) {
			logger.debug("Child session stdin close failed", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (await this.#waitForExit(proc, this.#options.exitGraceMs)) return;

		// 3. SIGTERM — a signal a stuck-but-healthy child still handles, so its
		//    exit path (sentinel, log flush) can run.
		logger.warn("Child session did not exit on stdin EOF; sending SIGTERM", {
			sessionId: this.sessionId,
			pid: proc.pid,
		});
		attempted.push("SIGTERM");
		try {
			proc.kill("SIGTERM");
		} catch {}
		if (await this.#waitForExit(proc, this.#options.termGraceMs)) return;

		// 4. Out of graceful options — and that is where it ends. Killing the child
		//    here would skip its own shutdown path and turn a failed stop into a
		//    silent success; the caller gets the truth instead.
		this.#state = "stopping";
		logger.error("Child session ignored stdin close and SIGTERM; leaving it running", {
			sessionId: this.sessionId,
			pid: proc.pid,
		});
		throw new ChildSessionStopTimeoutError({
			sessionId: this.sessionId,
			pid: proc.pid,
			attempted,
			waitedMs: this.#options.exitGraceMs + this.#options.termGraceMs,
		});
	}

	/**
	 * Reap a child that never became usable, through the same no-kill ladder.
	 *
	 * Used after a failed handshake, where nothing will ever talk to the process.
	 * A child that survives even this is left running and named in the log rather
	 * than killed: it is still somebody's process, and the caller is told.
	 */
	async #reapUnusableProcess(proc: Subprocess): Promise<void> {
		this.#expectedExit = true;
		try {
			this.#stdin?.end();
		} catch {}
		if (await this.#waitForExit(proc, this.#options.exitGraceMs)) return;
		try {
			proc.kill("SIGTERM");
		} catch {}
		if (await this.#waitForExit(proc, this.#options.termGraceMs)) return;
		logger.error("Child session process survived stdin close and SIGTERM after a failed handshake", {
			sessionId: this.sessionId,
			pid: proc.pid,
		});
	}

	// ── internals ────────────────────────────────────────────────────────────

	/**
	 * True while a live process is registered.
	 *
	 * A method rather than an inline `this.#state !== "exited"`: TypeScript narrows
	 * a private field straight from its last assignment and cannot see that the
	 * stdout reader is what moves it on.
	 */
	#isRunning(): boolean {
		return this.#proc !== null && this.#state !== "exited";
	}

	#writeFrame(frame: ClientFrame): void {
		const stdin = this.#stdin;
		if (!stdin) {
			throw new ChildSessionUnavailableError(`Child session "${this.sessionId}" has no stdin`);
		}
		stdin.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
	}

	#settlePending(id: string, error: Error): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timeout);
		pending.reject(error);
	}

	#failReadyWait(error: Error): void {
		const wait = this.#readyWait;
		if (!wait) return;
		this.#readyWait = null;
		clearTimeout(wait.timeout);
		wait.reject(error);
	}

	async #readStdout(proc: Subprocess, bootId: number): Promise<void> {
		const stream = proc.stdout as ReadableStream<Uint8Array> | null;
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) this.#handleLine(line, bootId);
					newline = buffer.indexOf("\n");
				}
			}
			if (buffer.trim()) this.#handleLine(buffer.trim(), bootId);
		} catch (error) {
			logger.debug("Child session stdout reader failed", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			reader.releaseLock();
		}
	}

	async #readStderr(proc: Subprocess): Promise<void> {
		const stream = proc.stderr as ReadableStream<Uint8Array> | null;
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const push = (line: string) => {
			if (!line.trim()) return;
			this.#stderrTail.push(line);
			if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
		};
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					push(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			}
			push(buffer);
		} catch {
			// The exit is reported by `#onExit`; stderr is diagnosis only.
		} finally {
			reader.releaseLock();
		}
	}

	#handleLine(line: string, bootId: number): void {
		if (bootId !== this.#bootId) return;
		let frame: ServerFrame;
		try {
			frame = JSON.parse(line) as ServerFrame;
		} catch {
			logger.warn("Child session wrote an unparsable line", {
				sessionId: this.sessionId,
				line: line.slice(0, 200),
			});
			return;
		}

		switch (frame.type) {
			case "hello_ack": {
				if (typeof frame.protocolVersion !== "number" || frame.protocolVersion < 1) {
					this.#failReadyWait(
						new ChildSessionProcessError(
							`Child session "${this.sessionId}" answered an incompatible protocol version: ${String(frame.protocolVersion)}`,
						),
					);
					return;
				}
				this.#state = "ready";
				const wait = this.#readyWait;
				if (wait) {
					this.#readyWait = null;
					clearTimeout(wait.timeout);
					wait.resolve();
				}
				this.#emit({ type: "ready", bootId, pid: this.#proc?.pid ?? 0 });
				return;
			}

			case "hello_error": {
				this.#failReadyWait(
					new ChildSessionProcessError(`Child session "${this.sessionId}" rejected the handshake: ${frame.error}`),
				);
				return;
			}

			case "response": {
				const pending = this.#pending.get(frame.id);
				if (!pending) return;
				this.#pending.delete(frame.id);
				clearTimeout(pending.timeout);
				if (frame.ok) {
					pending.resolve(frame.result);
				} else {
					const message = typeof frame.error === "string" ? frame.error : frame.error.message;
					pending.reject(
						new ChildSessionProcessError(`Child session "${this.sessionId}" failed the request: ${message}`),
					);
				}
				return;
			}

			default: {
				this.#emit({ type: "frame", bootId, frame });
			}
		}
	}

	#onExit(proc: Subprocess, bootId: number, cause?: Error): void {
		if (bootId !== this.#bootId) {
			// A previous incarnation. Dropping it is the whole point of `bootId`:
			// attributing it to the replacement would report a live child as dead.
			logger.debug("Ignoring exit from a stale child session process", {
				sessionId: this.sessionId,
				pid: proc.pid,
				bootId,
				currentBootId: this.#bootId,
			});
			return;
		}

		const exit: ChildSessionExit = {
			bootId,
			pid: proc.pid,
			code: proc.exitCode ?? null,
			signal: proc.signalCode ?? null,
			expected: this.#expectedExit,
			stderrTail: this.#stderrTail.join("\n"),
		};
		this.#state = "exited";
		this.#stdin = null;

		const wait = this.#readyWait;
		if (wait) {
			this.#readyWait = null;
			clearTimeout(wait.timeout);
			wait.reject(
				new ChildSessionProcessError(
					`Child session process (pid ${proc.pid}) exited ${describeExit(exit)} before the handshake completed${cause ? `: ${cause.message}` : ""}`,
				),
			);
		}

		const error = new ChildSessionExitedError(exit);
		for (const id of [...this.#pending.keys()]) {
			this.#settlePending(id, error);
		}

		this.#emit({ type: "exited", ...exit });
	}

	async #waitForExit(proc: Subprocess, timeoutMs: number): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timeout = setTimeout(() => resolve(false), timeoutMs);
		timeout.unref?.();
		void proc.exited.then(
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
		);
		return promise;
	}
}
