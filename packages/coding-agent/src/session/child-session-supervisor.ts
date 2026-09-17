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
 *   - **stop is never a force-kill** — `./child-session-process.ts` ends its
 *     ladder at SIGTERM plus a drain window. A child that ignores all of it is
 *     reported `failed` with the reason and *keeps its slot*, because it is
 *     still running and still consuming capacity. Reporting it `cancelled`
 *     would be a lie about both the child and the machine it is eating;
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
	/**
	 * Resolve once the current incarnation is live *and registered* — the
	 * supervisor's own notion of ready, which is stronger than "the process
	 * answered the handshake".
	 *
	 * Needed after a crash: `start()` covers the initial launch, but nothing else
	 * tells a caller when a relaunch finished, so a caller would have to poll the
	 * broker and would still race the supervisor's own confirmation window.
	 */
	awaitReady(): Promise<void>;
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
	/**
	 * True while a relaunch is scheduled or running.
	 *
	 * Distinct from "budget left": on the last allowed attempt the budget is
	 * already spent (`restarts === maxRestarts`) while the relaunch is still
	 * coming. Reading the budget as "no relaunch will happen" would fail a
	 * pending-request retry on the one attempt that was about to succeed.
	 */
	relaunchPending: boolean;
	/** Settles when the in-flight `start()` — including a queued slot wait — is over. */
	startSettled: Promise<void>;
	/** Resolves `startSettled`; held separately so `start()` can settle it in a `finally`. */
	settleStart: () => void;
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

	awaitReady(): Promise<void> {
		return this.#supervisor.awaitReady(this.#entry);
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
		const settled = Promise.withResolvers<void>();
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
			relaunchPending: false,
			startSettled: settled.promise,
			settleStart: settled.resolve,
		};
		this.#children.set(spec.sessionId, entry);
		process.subscribe(event => this.#onProcessEvent(entry, event));

		try {
			await this.#acquireSlot(entry, options.signal);
			await this.#launch(entry);
		} catch (error) {
			await this.#stopProcess(entry);
			if (entry.process.state === "exited") {
				// Nothing was left behind — drop the entry entirely.
				this.#children.delete(spec.sessionId);
				this.#releaseSlot(entry);
			} else {
				// The failed launch could not even be reaped: keep it visible as failed
				// (and keep its slot) instead of deleting the only handle on a process
				// that is still running.
				entry.status = "failed";
				entry.stopping = true;
				entry.controller.abort();
				this.#maybeReleaseSlot(entry);
			}
			throw error;
		} finally {
			entry.settleStart();
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
					logger.error("Child session failed to stop and is still running", {
						sessionId: entry.spec.sessionId,
						pid: entry.process.pid,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
	}

	/**
	 * Wait until the in-flight launch (initial or relaunch) has completed, or fail
	 * with why it never will.
	 *
	 * Safe against the launch finishing mid-call: `#launch` clears `launchAttempt`
	 * in the same synchronous block as it resolves the waiters, so observing a
	 * launch in flight means it is parked at an `await` and has not resolved them.
	 */
	async awaitReady(entry: ChildEntry): Promise<void> {
		if (isTerminal(entry.status)) {
			throw new ChildSessionUnavailableError(
				`Child session "${entry.spec.sessionId}" is ${entry.status}; it will not become ready`,
			);
		}
		if (!entry.launchAttempt) {
			if (entry.process.state === "ready") return;
			// Between a crash and its relaunch the process is gone but the child is
			// still coming back, so a pending relaunch is a "wait", not a failure.
			if (!entry.relaunchPending) {
				throw new ChildSessionUnavailableError(
					`Child session "${entry.spec.sessionId}" is ${entry.process.state} and no launch is in flight`,
				);
			}
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		entry.bootWaiters.push({ resolve, reject });
		if (entry.controller.signal.aborted) {
			reject(
				new ChildSessionUnavailableError(
					`Child session "${entry.spec.sessionId}" was stopped before it became ready`,
				),
			);
		}
		return promise;
	}

	/** Wait for the next successful relaunch, or fail with why there will not be one. */
	async waitForRelaunch(entry: ChildEntry): Promise<void> {
		if (isTerminal(entry.status)) {
			throw new ChildSessionUnavailableError(
				`Child session "${entry.spec.sessionId}" is ${entry.status}; it will not be relaunched`,
			);
		}
		// "Is a relaunch coming" — not "is budget left". On the final allowed
		// attempt the budget reads as spent while the relaunch is already scheduled.
		if (!entry.relaunchPending) {
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
	/**
	 * Stop one child and give it a terminal status. Idempotent once terminal.
	 *
	 * Throws when the child did not actually stop: it is then reported `failed`
	 * (not the status the caller asked for) and keeps its slot, because it is
	 * still running. Silently calling that outcome `cancelled` is exactly the
	 * kind of plausible lie that leaves someone counting a machine that is not
	 * there.
	 */
	async stopChild(entry: ChildEntry, status: "completed" | "cancelled"): Promise<void> {
		if (isTerminal(entry.status)) return;
		entry.requestedStatus = status;
		entry.stopping = true;
		entry.controller.abort();
		this.#rejectBootWaiters(
			entry,
			new ChildSessionUnavailableError(`Child session "${entry.spec.sessionId}" was stopped`),
		);
		// A `start()` still waiting for a slot has not spawned anything yet. The
		// abort above makes it give the slot back the moment it gets one, so waiting
		// here is what makes "stopped" mean settled rather than merely requested.
		await entry.startSettled;
		try {
			await entry.process.stop();
		} catch (error) {
			entry.status = "failed";
			entry.relaunchPending = false;
			logger.error("Child session did not stop; it is still running and keeps its slot", {
				sessionId: entry.spec.sessionId,
				pid: entry.process.pid,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#maybeReleaseSlot(entry);
			throw error;
		}
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
		// A queued acquire cannot be interrupted, so the slot can arrive long after
		// the request — by which time the child may already have been stopped
		// (`stop()`, `complete()`, `stopAll()`). Everything that revokes a launch is
		// checked HERE, before the first byte is spawned; checking only the caller's
		// `signal` would let a stopped child be launched and then immediately
		// re-stopped, spawning a process nobody asked for any more.
		if (signal?.aborted || entry.stopping || entry.controller.signal.aborted || isTerminal(entry.status)) {
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
		// (completed vs cancelled), so this handler must not assign one of its own —
		// but a child that kept running after a failed stop only releases its slot
		// now, when it is finally gone.
		if (entry.stopping) {
			logger.debug("Child session stopped", { sessionId: entry.spec.sessionId, pid: event.pid, reason });
			if (entry.launchAttempt) {
				entry.launchAttempt.fail(
					new ChildSessionUnavailableError(`Child session "${entry.spec.sessionId}" was stopped`),
				);
			}
			this.#maybeReleaseSlot(entry);
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
		entry.relaunchPending = true;
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
			entry.relaunchPending = false;
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

	/**
	 * Best-effort stop used while another failure is already being reported (a
	 * failed launch, a failed relaunch). The caller is deciding the child's fate
	 * either way, so the stop error is logged rather than layered on top —
	 * `stopChild()`, where the stop outcome IS the result, calls the process
	 * directly so the failure reaches the caller.
	 */
	async #stopProcess(entry: ChildEntry): Promise<void> {
		try {
			await entry.process.stop();
		} catch (error) {
			logger.error("Child session could not be reaped and is still running", {
				sessionId: entry.spec.sessionId,
				pid: entry.process.pid,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#terminalize(entry: ChildEntry, status: TerminalStatus): void {
		if (isTerminal(entry.status)) return;
		entry.status = status;
		entry.stopping = true;
		entry.relaunchPending = false;
		entry.controller.abort();
		entry.settleStart();
		this.#maybeReleaseSlot(entry);
	}

	/**
	 * Release the slot when — and only when — this child no longer consumes capacity:
	 * it is in a terminal state *and* its process is gone.
	 *
	 * A child that ignored the stop ladder is terminal (`failed`) but still alive,
	 * so it keeps its slot until it dies on its own; counting it as free capacity
	 * would let the supervisor oversubscribe the machine it is still sitting on.
	 */
	#maybeReleaseSlot(entry: ChildEntry): void {
		if (!isTerminal(entry.status)) return;
		if (entry.process.state !== "exited") return;
		this.#releaseSlot(entry);
	}

	#releaseSlot(entry: ChildEntry): void {
		if (!entry.slotHeld) return;
		entry.slotHeld = false;
		this.#slots.release();
	}
}
