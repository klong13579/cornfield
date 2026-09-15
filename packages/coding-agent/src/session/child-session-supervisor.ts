/**
 * Child Session Process Supervisor.
 *
 * A formal Child Session is an isolated `cornfield` process that carries a
 * parent edge on the intercom broker (see `./child-session-process.ts` for the
 * process itself). This module owns everything that spans more than one
 * process:
 *
 *   - **registration** — a child is only a Child Session once its parent edge is
 *     visible on the broker, so the supervisor refuses to report a child as
 *     started before that, through the injected `ChildSessionRegistrationProbe`,
 *   - **concurrency** — one global cap per process. A formal Child Session is a
 *     separate OS process, which is not the same thing as unlimited parallelism
 *     (each one builds, indexes and calls a model),
 *   - **crash restart** — a child that dies after becoming ready is relaunched
 *     with bounded exponential backoff, on the same session identity,
 *   - **pending requests** — a request in flight when the child dies is failed
 *     with the real cause. It is *not* silently replayed: replaying a prompt is
 *     not safe in general, so a caller that knows its command is idempotent must
 *     opt in with `retryOnRestart`.
 *
 * Who owns an exit: the exit handler is the single decision point. While a
 * launch is in flight the exit is that launch's failure (a child that never
 * reached ready is a startup error, not a crash to retry); once the child is
 * ready the same exit is a crash, and the restart policy governs it.
 *
 * What this module is not: it is not the session tree store (it projects a
 * `SessionNode` per child for the caller that owns the tree) and it is not a
 * second runtime for in-process work. The in-process subagent Task
 * (`task/executor.ts` `runSubprocess`) stays exactly what it is and never
 * enters this supervisor.
 */

import { logger } from "@cornfield/utils";
import type { WireCommand } from "@cornfield/wire";
import type { AgentId, SessionId, SessionNode } from "../agent-domain";
import { Semaphore } from "../task/parallel";
import {
	ChildSessionExitedError,
	ChildSessionProcess,
	type ChildSessionProcessEvent,
	type ChildSessionProcessOptions,
	ChildSessionUnavailableError,
} from "./child-session-process";

/** Default global cap on concurrently running Child Session processes (§5.2). */
export const DEFAULT_CHILD_SESSION_CONCURRENCY = 3;

type ChildStatus = SessionNode["status"];
type TerminalStatus = Extract<ChildStatus, "completed" | "failed" | "cancelled">;

/**
 * The parent edge a freshly spawned child must show on the intercom broker.
 *
 * Implemented in the intercom layer (`intercom-extension/child-session-edge.ts`).
 * A host that runs no broker at all has no edge to observe and passes an
 * explicit no-op probe — required rather than optional so that "no parent edge"
 * is always a stated choice instead of a field someone forgot to wire.
 */
export interface ChildSessionRegistrationProbe {
	/**
	 * Resolve once the child's parent edge is visible on the broker.
	 *
	 * `pid` identifies the exact incarnation: several children of one parent
	 * share the same `parentId`, so the process handle — not the edge name — is
	 * what disambiguates them.
	 */
	awaitRegistration(input: { sessionId: SessionId; bootId: number; pid: number; signal: AbortSignal }): Promise<void>;
}

export interface ChildSessionRestartPolicy {
	/** Relaunches allowed after the first launch. `0` disables restart entirely. */
	maxRestarts: number;
	/** Backoff before the first relaunch; doubles per attempt. */
	baseBackoffMs: number;
	/** Upper bound on the backoff. */
	maxBackoffMs?: number;
}

const DEFAULT_RESTART_POLICY: ChildSessionRestartPolicy = {
	maxRestarts: 3,
	baseBackoffMs: 500,
	maxBackoffMs: 10_000,
};

/** The parent session node a child hangs off. Root and depth are derived, not restated. */
export interface ChildSessionParent {
	sessionId: SessionId;
	rootSessionId: SessionId;
	depth: number;
}

export interface ChildSessionSpec {
	/** Tree identity of the child. Parent-assigned; survives a crash restart. */
	sessionId: SessionId;
	parent: ChildSessionParent;
	agentId: AgentId;
	projectId?: string;
	/** Working directory the child process runs in. */
	cwd: string;
	/** Program to spawn; callers pass the `cornfield` binary and its args. */
	command: ChildSessionProcessOptions["command"];
	/** Extra environment — the orchestrator edge from `childSessionEnv()`. */
	env?: Record<string, string>;
	delegationRole?: string;
	objective?: string;
}

export interface ChildSessionSupervisorOptions {
	/** Global cap on running child processes. Defaults to {@link DEFAULT_CHILD_SESSION_CONCURRENCY}. */
	maxConcurrent?: number;
	/** Parent-edge observation for every spawn (and relaunch). Required. */
	registration: ChildSessionRegistrationProbe;
	/** Crash-restart policy for children that reached ready. Defaults to 3 attempts from 500ms. */
	restart?: ChildSessionRestartPolicy;
	/** Override process-level timings (handshake budget, stop ladder). */
	process?: Partial<
		Pick<
			ChildSessionProcessOptions,
			"readyTimeoutMs" | "requestTimeoutMs" | "abortTimeoutMs" | "exitGraceMs" | "termGraceMs"
		>
	>;
}

export interface ChildSessionRequestOptions {
	timeoutMs?: number;
	/**
	 * Retry once after the child is relaunched, instead of failing with the crash.
	 * Only for commands that are safe to run twice.
	 */
	retryOnRestart?: boolean;
}

/** A supervised child session: identity, tree projection, request path and stop. */
export interface ChildSession {
	readonly sessionId: SessionId;
	readonly spec: ChildSessionSpec;
	/** The transport to the current incarnation. Replaced on each restart. */
	readonly transport: ChildSessionProcess;
	status(): ChildStatus;
	/** Number of relaunches performed so far. */
	restarts(): number;
	/** Tree node for this child, as the session-tree owner should persist it. */
	toNode(): SessionNode;
	/** Send one command to the current incarnation. */
	request<Result = unknown>(command: WireCommand, options?: ChildSessionRequestOptions): Promise<Result>;
	/** Graceful stop, then terminal `cancelled`. Idempotent. */
	stop(): Promise<void>;
	/** Mark the child as finished (optionally with its result) and stop it. */
	complete(resultRef?: string): Promise<void>;
}

interface ChildEntry {
	spec: ChildSessionSpec;
	process: ChildSessionProcess;
	status: ChildStatus;
	restarts: number;
	/** True from the moment a stop/complete was requested — exits are no longer crashes. */
	stopping: boolean;
	/** The slot is held from the first launch until a terminal status. */
	slotHeld: boolean;
	/** Cancels a registration wait or a relaunch wait when the child is stopped. */
	controller: AbortController;
	/** Callers waiting for the next successful relaunch (pending-request retries). */
	bootWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
	/**
	 * The terminal status a stop was asked for (`completed` vs `cancelled`). The
	 * exit that follows a stop must not overwrite it with its own guess.
	 */
	requestedStatus: "completed" | "cancelled" | null;
	/** Set while a launch is in flight: an exit fails it instead of triggering a restart. */
	launchAttempt: { fail: (error: Error) => void } | null;
	/** Why the in-flight launch failed, when the exit beat it to the finishing line. */
	launchFailure: Error | null;
	resultRef?: string;
}

class SupervisedChildSession implements ChildSession {
	readonly #entry: ChildEntry;
	readonly #supervisor: ChildSessionSupervisor;

	constructor(entry: ChildEntry, supervisor: ChildSessionSupervisor) {
		this.#entry = entry;
		this.#supervisor = supervisor;
	}

	get sessionId(): SessionId {
		return this.#entry.spec.sessionId;
	}

	/** The child's own definition — identity, cwd, command and environment. */
	get spec(): ChildSessionSpec {
		return this.#entry.spec;
	}

	get transport(): ChildSessionProcess {
		return this.#entry.process;
	}

	status(): ChildStatus {
		return this.#entry.status;
	}

	restarts(): number {
		return this.#entry.restarts;
	}

	toNode(): SessionNode {
		const spec = this.#entry.spec;
		return {
			sessionId: spec.sessionId,
			agentId: spec.agentId,
			...(spec.projectId ? { projectId: spec.projectId } : {}),
			parentSessionId: spec.parent.sessionId,
			rootSessionId: spec.parent.rootSessionId,
			depth: spec.parent.depth + 1,
			kind: "child",
			status: this.#entry.status,
			executionPolicy: "isolated-process",
			...(spec.delegationRole ? { delegationRole: spec.delegationRole } : {}),
			...(spec.objective ? { objective: spec.objective } : {}),
			...(this.#entry.resultRef ? { resultRef: this.#entry.resultRef } : {}),
		};
	}

	async request<Result = unknown>(command: WireCommand, options: ChildSessionRequestOptions = {}): Promise<Result> {
		try {
			return await this.#entry.process.request<Result>(command, options.timeoutMs);
		} catch (error) {
			if (!options.retryOnRestart || !isRestartableFailure(error)) throw error;
			// The child died with this command in flight. Wait for the relaunch the
			// supervisor already scheduled, then run the command once on the new
			// process — the caller opted in because the command is idempotent.
			await this.#supervisor.waitForRelaunch(this.#entry);
			return await this.#entry.process.request<Result>(command, options.timeoutMs);
		}
	}

	async stop(): Promise<void> {
		await this.#supervisor.stopChild(this.#entry, "cancelled");
	}

	async complete(resultRef?: string): Promise<void> {
		this.#entry.resultRef = resultRef;
		await this.#supervisor.stopChild(this.#entry, "completed");
	}
}

function isRestartableFailure(error: unknown): boolean {
	return error instanceof ChildSessionExitedError || error instanceof ChildSessionUnavailableError;
}

function isTerminal(status: ChildStatus): status is TerminalStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}

export class ChildSessionSupervisor {
	readonly #maxConcurrent: number;
	readonly #registration: ChildSessionRegistrationProbe;
	readonly #restart: ChildSessionRestartPolicy;
	readonly #processOptions: ChildSessionSupervisorOptions["process"];
	readonly #slots: Semaphore;
	readonly #children = new Map<SessionId, ChildEntry>();

	constructor(options: ChildSessionSupervisorOptions) {
		const maxConcurrent = options.maxConcurrent ?? DEFAULT_CHILD_SESSION_CONCURRENCY;
		if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
			throw new Error(`maxConcurrent must be a positive number, got ${String(options.maxConcurrent)}`);
		}
		this.#maxConcurrent = maxConcurrent;
		this.#registration = options.registration;
		this.#restart = options.restart ?? DEFAULT_RESTART_POLICY;
		this.#processOptions = options.process;
		this.#slots = new Semaphore(maxConcurrent);
	}

	/** Every child this supervisor has seen, including terminal ones. */
	list(): ChildSession[] {
		return [...this.#children.values()].map(entry => new SupervisedChildSession(entry, this));
	}

	/** Live capacity: `active` counts children holding a slot (running or restarting). */
	concurrency(): { active: number; limit: number; queued: number } {
		let active = 0;
		let queued = 0;
		for (const entry of this.#children.values()) {
			if (entry.slotHeld) active += 1;
			else if (!isTerminal(entry.status)) queued += 1;
		}
		return { active, limit: this.#maxConcurrent, queued };
	}

	/**
	 * Launch a Child Session process and wait until it is ready *and* registered.
	 *
	 * Failure is reported as failure: a child that cannot spawn, cannot complete
	 * the handshake, or never appears on the broker as a child of its parent is
	 * stopped and thrown back to the caller — never returned as "started".
	 */
	async start(spec: ChildSessionSpec, options: { signal?: AbortSignal } = {}): Promise<ChildSession> {
		if (this.#children.has(spec.sessionId)) {
			throw new Error(`Child session "${spec.sessionId}" is already supervised`);
		}
		this.#assertParentEdge(spec);

		const process = new ChildSessionProcess({
			sessionId: spec.sessionId,
			cwd: spec.cwd,
			command: spec.command,
			...(spec.env ? { env: spec.env } : {}),
			...this.#processOptions,
		});
		const entry: ChildEntry = {
			spec,
			process,
			status: "running",
			restarts: 0,
			stopping: false,
			slotHeld: false,
			controller: new AbortController(),
			bootWaiters: [],
			requestedStatus: null,
			launchAttempt: null,
			launchFailure: null,
		};
		this.#children.set(spec.sessionId, entry);
		process.subscribe(event => this.#onProcessEvent(entry, event));

		try {
			await this.#acquireSlot(entry, options.signal);
			await this.#launch(entry);
		} catch (error) {
			await this.#stopProcess(entry);
			this.#children.delete(spec.sessionId);
			this.#releaseSlot(entry);
			throw error;
		}

		logger.debug("Child session started", {
			sessionId: spec.sessionId,
			pid: process.pid,
			cwd: spec.cwd,
		});
		return new SupervisedChildSession(entry, this);
	}

	/** Stop every supervised child. Never throws — a failed stop is logged. */
	async stopAll(): Promise<void> {
		await Promise.all(
			[...this.#children.values()].map(async entry => {
				try {
					await this.stopChild(entry, "cancelled");
				} catch (error) {
					logger.warn("Child session failed to stop", {
						sessionId: entry.spec.sessionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}

	/** Wait for the next successful relaunch, or fail with why there will not be one. */
	async waitForRelaunch(entry: ChildEntry): Promise<void> {
		if (isTerminal(entry.status)) {
			throw new ChildSessionUnavailableError(
				`Child session "${entry.spec.sessionId}" is ${entry.status}; it will not be relaunched`,
			);
		}
		if (this.#restartBudgetExhausted(entry)) {
			throw new ChildSessionUnavailableError(
				`Child session "${entry.spec.sessionId}" will not be relaunched (restart budget ${this.#restart.maxRestarts} exhausted)`,
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		entry.bootWaiters.push({ resolve, reject });
		if (entry.controller.signal.aborted) {
			this.#rejectBootWaiters(
				entry,
				new ChildSessionUnavailableError(
					`Child session "${entry.spec.sessionId}" was stopped while waiting for a relaunch`,
				),
			);
		}
		return promise;
	}

	/** Stop one child and give it a terminal status. Idempotent once terminal. */
	async stopChild(entry: ChildEntry, status: "completed" | "cancelled"): Promise<void> {
		if (isTerminal(entry.status)) return;
		entry.requestedStatus = status;
		entry.stopping = true;
		entry.controller.abort();
		this.#rejectBootWaiters(
			entry,
			new ChildSessionUnavailableError(`Child session "${entry.spec.sessionId}" was stopped`),
		);
		await this.#stopProcess(entry);
		this.#terminalize(entry, status);
	}

	// ── internals ────────────────────────────────────────────────────────────

	#assertParentEdge(spec: ChildSessionSpec): void {
		if (!spec.parent.sessionId.trim()) {
			throw new Error(`Child session "${spec.sessionId}" needs a parent session id`);
		}
		if (!Number.isFinite(spec.parent.depth) || spec.parent.depth < 0) {
			throw new Error(`Child session "${spec.sessionId}" has an invalid parent depth ${spec.parent.depth}`);
		}
	}

	async #acquireSlot(entry: ChildEntry, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new Error(`Child session "${entry.spec.sessionId}" was cancelled before launch`);
		}
		await this.#slots.acquire();
		entry.slotHeld = true;
		// A queued acquire cannot be interrupted, so cancellation is checked right
		// after the slot arrives: the child is then not spawned at all.
		if (signal?.aborted) {
			throw new Error(`Child session "${entry.spec.sessionId}" was cancelled before launch`);
		}
	}

	/**
	 * Spawn + handshake + registration for one incarnation.
	 *
	 * The exit handler must not schedule a restart while this is in flight — a
	 * child that dies before it is registered is this launch's failure, and the
	 * caller of `start()`/`#relaunch()` is the one that decides what happens next.
	 */
	async #launch(entry: ChildEntry): Promise<void> {
		entry.launchFailure = null;
		const failed = Promise.withResolvers<never>();
		entry.launchAttempt = { fail: error => failed.reject(error) };
		try {
			await Promise.race([this.#handshake(entry), failed.promise]);
			// The exit can land in the same microtask turn as the handshake's
			// resolution; a process that is no longer ready did not start.
			if (entry.process.state !== "ready") {
				throw (
					entry.launchFailure ??
					new ChildSessionUnavailableError(
						`Child session "${entry.spec.sessionId}" is ${entry.process.state} after launch`,
					)
				);
			}
			this.#resolveBootWaiters(entry);
		} finally {
			entry.launchAttempt = null;
		}
	}

	async #handshake(entry: ChildEntry): Promise<void> {
		await entry.process.start();
		await this.#registration.awaitRegistration({
			sessionId: entry.spec.sessionId,
			bootId: entry.process.bootId,
			pid: entry.process.pid ?? 0,
			signal: entry.controller.signal,
		});
	}

	#onProcessEvent(entry: ChildEntry, event: ChildSessionProcessEvent): void {
		if (event.type !== "exited") return;
		const reason = event.signal ? `signal ${event.signal}` : `exit code ${event.code ?? "unknown"}`;

		// A launch in flight owns its own exit: the awaiting caller decides whether
		// that was a startup failure or a crash worth retrying.
		if (entry.launchAttempt && !entry.stopping) {
			const failure = new ChildSessionExitedError({
				bootId: event.bootId,
				pid: event.pid,
				code: event.code,
				signal: event.signal,
				expected: false,
				stderrTail: event.stderrTail,
			});
			entry.launchFailure = failure;
			entry.launchAttempt.fail(failure);
			return;
		}

		// A stop was requested: the caller that asked for it names the terminal status
		// (completed vs cancelled), so this handler must not assign one of its own.
		if (entry.stopping) {
			logger.debug("Child session stopped", { sessionId: entry.spec.sessionId, pid: event.pid, reason });
			if (entry.launchAttempt) {
				entry.launchAttempt.fail(
					new ChildSessionUnavailableError(`Child session "${entry.spec.sessionId}" was stopped`),
				);
			}
			return;
		}

		if (event.expected) {
			logger.debug("Child session exited on request", { sessionId: entry.spec.sessionId, pid: event.pid, reason });
			this.#terminalize(entry, "cancelled");
			return;
		}

		const crash = new ChildSessionExitedError({
			bootId: event.bootId,
			pid: event.pid,
			code: event.code,
			signal: event.signal,
			expected: false,
			stderrTail: event.stderrTail,
		});

		logger.warn("Child session crashed", {
			sessionId: entry.spec.sessionId,
			pid: event.pid,
			reason,
			stderrTail: event.stderrTail.slice(-2000),
		});
		// Waiters survive the crash: a relaunch is still coming, and rejecting them
		// here would break the one caller that legitimately wants to wait for it.
		if (this.#restartBudgetExhausted(entry)) {
			logger.error("Child session crashed and the restart budget is exhausted", {
				sessionId: entry.spec.sessionId,
				restarts: entry.restarts,
				maxRestarts: this.#restart.maxRestarts,
			});
			this.#terminalize(entry, "failed");
			this.#rejectBootWaiters(entry, crash);
			return;
		}
		entry.restarts += 1;
		void this.#relaunch(entry, this.#backoffMs(entry));
	}

	#restartBudgetExhausted(entry: ChildEntry): boolean {
		return this.#restart.maxRestarts <= 0 || entry.restarts >= this.#restart.maxRestarts;
	}

	#backoffMs(entry: ChildEntry): number {
		const raw = this.#restart.baseBackoffMs * 2 ** Math.max(0, entry.restarts - 1);
		return Math.min(raw, this.#restart.maxBackoffMs ?? raw);
	}

	async #relaunch(entry: ChildEntry, delayMs: number): Promise<void> {
		await Bun.sleep(delayMs);
		if (entry.stopping || isTerminal(entry.status)) {
			this.#terminalize(entry, entry.requestedStatus ?? "cancelled");
			return;
		}
		logger.debug("Relaunching child session", { sessionId: entry.spec.sessionId, attempt: entry.restarts });
		try {
			await this.#launch(entry);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			logger.warn("Child session relaunch failed", {
				sessionId: entry.spec.sessionId,
				attempt: entry.restarts,
				error: failure.message,
			});
			await this.#stopProcess(entry);
			if (entry.stopping) {
				this.#terminalize(entry, entry.requestedStatus ?? "cancelled");
				return;
			}
			if (this.#restartBudgetExhausted(entry)) {
				this.#terminalize(entry, "failed");
				this.#rejectBootWaiters(entry, failure);
				return;
			}
			entry.restarts += 1;
			void this.#relaunch(entry, this.#backoffMs(entry));
		}
	}

	#resolveBootWaiters(entry: ChildEntry): void {
		for (const waiter of entry.bootWaiters.splice(0)) waiter.resolve();
	}

	#rejectBootWaiters(entry: ChildEntry, error: Error): void {
		for (const waiter of entry.bootWaiters.splice(0)) waiter.reject(error);
	}

	async #stopProcess(entry: ChildEntry): Promise<void> {
		try {
			await entry.process.stop();
		} catch (error) {
			logger.warn("Child session process stop threw", {
				sessionId: entry.spec.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Terminal states release the slot exactly once. */
	#terminalize(entry: ChildEntry, status: TerminalStatus): void {
		if (isTerminal(entry.status)) return;
		entry.status = status;
		entry.stopping = true;
		entry.controller.abort();
		this.#releaseSlot(entry);
	}

	#releaseSlot(entry: ChildEntry): void {
		if (!entry.slotHeld) return;
		entry.slotHeld = false;
		this.#slots.release();
	}
}
