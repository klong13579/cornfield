/**
 * The Session Tree Manager — the parent half of the parent/child session loop.
 *
 * It owns four things, and nothing else:
 *
 *   1. **Delegation.** `delegate()` turns a request into a persisted ledger entry
 *      plus a real, isolated child process launched through the Child Session
 *      Process Supervisor (`./child-session-supervisor`, ticket 06). This module
 *      starts nothing itself and supervises nothing itself — it does not
 *      reimplement the supervisor, and it is not a second runtime for in-process
 *      work.
 *   2. **Status back.** `applyReport()` consumes the child's lifecycle reports
 *      (`./child-session-report`) and moves the ledger entry. A report that names
 *      a run this parent never launched, or that arrives from a process other than
 *      the one serving the child, or that tries to move a node that is already
 *      terminal, is refused with a reason — never matched to a nearby entry.
 *   3. **Escalations.** A child that is blocked on its parent reports `waiting` with
 *      what it is blocked on (`ask` or `permission`). The manager keeps that on the
 *      node (`waiting_user` plus the child's own words) and surfaces it through
 *      `pendingEscalations()`, so a parent can answer instead of watching a child
 *      sit still. Escalations reach the parent as reports and nothing else: the
 *      wire `permission_request` push is not a channel the current child mode
 *      produces (wire-stdio has no permission gate), and subscribing to a channel
 *      that cannot fire would be code pretending to be a mechanism.
 *   4. **The result.** `bringBack()` resolves the result the child pointed at and
 *      records that it was brought back. Bringing the same result back twice is
 *      allowed and reports `firstTime: false`, so a caller that injects results
 *      into its own context has a truthful signal to gate on and cannot inject
 *      the same result twice.
 *   5. **Recovery.** `reconcile()` is the restart path. A restarted parent has no
 *      supervisor, no processes and no memory — only the persisted ledger and
 *      whatever the broker can still see. Reconcile settles every non-terminal
 *      entry: adopted if its process is still registered, `failed` if it is gone.
 *
 * The ledger is persisted by `./session-tree-store` (the parent's own session
 * log); this class holds a working copy, writes on change, and reloads from the
 * store whenever reconcile runs.
 *
 * What this module is NOT: it does not decide *whether* to delegate (that is the
 * caller's policy), it does not deliver reports to a model or a UI (the caller
 * decides what a status change means for its own session), and it never writes
 * into a child's own session files.
 */

import { logger } from "@cornfield/utils";
import type { AgentId, ProjectId, SessionId, SessionNode } from "../agent-domain/types";
import { childSessionEnv } from "../intercom-extension/child-session-metadata";
import { type ChildSessionCommand, ChildSessionUnavailableError } from "./child-session-process";
import { hasChildSessionReportTag, parseChildSessionReport } from "./child-session-report";
import type { ChildSession, ChildSessionSpec, ChildSessionSupervisor } from "./child-session-supervisor";
import {
	applyChildSessionReport,
	applyReconcilePlan,
	type ChildSessionRecord,
	isTerminalSessionStatus,
	planReconcile,
	type ReconcileDecision,
	type ReconcilePlan,
	type ReportRejection,
} from "./session-tree";
import type { SessionTreeStore } from "./session-tree-store";

/** Identity of the session this manager delegates *from*. */
export interface SessionTreeSelf {
	sessionId: SessionId;
	agentId: AgentId;
	projectId?: ProjectId;
	/**
	 * The intercom session id a child registers as its `parentId`. Defaults to
	 * `sessionId`, which is right for a session whose tree identity and intercom
	 * identity are the same; a session that renames itself on the broker (stable
	 * id, gateway conversation id) must say so here.
	 */
	intercomSessionId?: string;
	/** Root ancestor's id. Omitted = this session is the root. */
	rootSessionId?: SessionId;
	/** Distance from the root. Omitted = 0 (this session is the root). */
	depth?: number;
}

export interface DelegationSpec {
	/** Tree identity of the child. Generated when omitted. */
	sessionId?: SessionId;
	/** Working directory the child process runs in. */
	cwd: string;
	/** Program to spawn; the `cornfield` binary and its args. */
	command: ChildSessionCommand;
	/** Opaque label for this delegation (a squad task id, a role name, …). */
	delegationRole?: string;
	/** What the child was started to do. */
	objective?: string;
	/** Extra environment, merged over the orchestrator edge. */
	env?: Record<string, string>;
	/** Cancel the launch before it happens. Only this caller's own abort means `cancelled`. */
	signal?: AbortSignal;
}

export interface DelegatedChild {
	child: ChildSession;
	record: ChildSessionRecord;
}

/** Resolves a result reference into the content a parent can use. */
export interface ChildSessionResultResolver {
	read(resultRef: string): Promise<string>;
}

/**
 * What the broker still shows as alive under this parent.
 *
 * Only pids: the parent matches them against the pid it recorded per child.
 * A name or a session id would be reusable by something that is not this child.
 */
export interface ChildSessionLivenessProbe {
	liveChildPids(): Promise<ReadonlySet<number>>;
}

/** Today's caller wants an absolute path read. Anything else supplies its own resolver. */
export class FileChildSessionResultResolver implements ChildSessionResultResolver {
	async read(resultRef: string): Promise<string> {
		return await Bun.file(resultRef).text();
	}
}

/** The node is not ready to be brought back. States which rule was broken. */
export class ChildSessionResultNotReadyError extends Error {
	readonly sessionId: SessionId;
	constructor(sessionId: SessionId, status: SessionNode["status"]) {
		super(
			`Child session "${sessionId}" is ${status} and has no resultRef; a result is ready before it is brought back (agent-domain session.result-not-ready)`,
		);
		this.name = "ChildSessionResultNotReadyError";
		this.sessionId = sessionId;
	}
}

export interface BroughtBackResult {
	record: ChildSessionRecord;
	resultRef: string;
	content: string;
	/**
	 * True exactly once per result: the first successful bring-back. `false` means
	 * this result was already brought back — the caller must not inject it again.
	 */
	firstTime: boolean;
	broughtBackAt: number;
}

export type ReportIngest =
	| { applied: true; record: ChildSessionRecord; changed: boolean }
	| { applied: false; reason: ReportRejection | "not-a-report" | "malformed" };

export interface ReconcileResult {
	plan: ReconcilePlan;
	/** The ledger after the plan was applied. */
	records: ChildSessionRecord[];
	/** The decisions that required a write. */
	applied: readonly ReconcileDecision[];
}

export interface SessionTreeManagerOptions {
	self: SessionTreeSelf;
	supervisor: ChildSessionSupervisor;
	store: SessionTreeStore;
	/** Defaults to a no-op probe: a host with no broker sees no child as alive. */
	liveness?: ChildSessionLivenessProbe;
	/** Defaults to {@link FileChildSessionResultResolver}. */
	results?: ChildSessionResultResolver;
	/** Injectable clock, for tests and for callers with a monotonic source. */
	now?: () => number;
}

const NO_LIVE_CHILDREN: ChildSessionLivenessProbe = {
	async liveChildPids(): Promise<ReadonlySet<number>> {
		return new Set<number>();
	},
};

/**
 * Build the ledger node for a child of `self`.
 *
 * The node must exist *before* the launch: a freshly registered child can send its
 * first report while `supervisor.start()` is still waiting for that very
 * registration, so a ledger entry created after `start()` would refuse the child's
 * opening statement.
 */
function buildChildSessionNode(
	self: SessionTreeSelf,
	child: {
		sessionId: SessionId;
		agentId: AgentId;
		projectId?: ProjectId;
		delegationRole?: string;
		objective?: string;
	},
): SessionNode {
	const rootSessionId = self.rootSessionId ?? self.sessionId;
	const depth = (self.depth ?? 0) + 1;
	return {
		sessionId: child.sessionId,
		agentId: child.agentId,
		...(child.projectId ? { projectId: child.projectId } : {}),
		parentSessionId: self.sessionId,
		rootSessionId,
		depth,
		kind: "child",
		status: "running",
		executionPolicy: "isolated-process",
		...(child.delegationRole ? { delegationRole: child.delegationRole } : {}),
		...(child.objective ? { objective: child.objective } : {}),
	};
}

export class SessionTreeManager {
	readonly #self: SessionTreeSelf;
	readonly #supervisor: ChildSessionSupervisor;
	readonly #store: SessionTreeStore;
	readonly #liveness: ChildSessionLivenessProbe;
	readonly #results: ChildSessionResultResolver;
	readonly #now: () => number;

	#records = new Map<SessionId, ChildSessionRecord>();
	/** runId → sessionId. A report addresses a delegation, never a process. */
	#byRunId = new Map<string, SessionId>();
	#loaded: Promise<void> | null = null;
	/** Serializes ledger writes so two paths cannot interleave snapshots. */
	#writes: Promise<void> = Promise.resolve();
	#bringBacks = new Map<SessionId, Promise<BroughtBackResult>>();
	#delegationSeq = 0;

	constructor(options: SessionTreeManagerOptions) {
		this.#self = options.self;
		this.#supervisor = options.supervisor;
		this.#store = options.store;
		this.#liveness = options.liveness ?? NO_LIVE_CHILDREN;
		this.#results = options.results ?? new FileChildSessionResultResolver();
		this.#now = options.now ?? (() => Date.now());
	}

	/** The session this manager delegates from, as declared. */
	get self(): SessionTreeSelf {
		return this.#self;
	}

	/**
	 * Launch one Child Session and record it.
	 *
	 * The ledger entry is written **before** the launch, because the child's first
	 * report can arrive before `start()` resolves (see `buildChildSessionNode`). A
	 * launch that fails therefore leaves a `failed` entry rather than a phantom
	 * `running` one: the parent did delegate, and the ledger says what happened.
	 */
	async delegate(spec: DelegationSpec): Promise<DelegatedChild> {
		await this.#ensureLoaded();
		const sessionId = spec.sessionId ?? Bun.randomUUIDv7();
		if (!sessionId.trim()) throw new Error("A delegated child session needs a non-empty session id");
		if (this.#records.has(sessionId)) {
			throw new Error(
				`Session "${sessionId}" is already in this session's ledger; a follow-up is a new child session`,
			);
		}
		if (this.#supervisor.list().some(child => child.sessionId === sessionId)) {
			throw new Error(`Session "${sessionId}" is already supervised by this process`);
		}

		const runId = Bun.randomUUIDv7();
		this.#delegationSeq += 1;
		const env: Record<string, string> = {
			...childSessionEnv({
				parentTarget: this.#self.intercomSessionId ?? this.#self.sessionId,
				parentSessionId: this.#self.intercomSessionId ?? this.#self.sessionId,
				runId,
				agent: spec.delegationRole ?? "child-session",
				index: String(this.#delegationSeq),
			}),
			...(spec.env ?? {}),
		};
		const childSpec: ChildSessionSpec = {
			sessionId,
			parent: {
				sessionId: this.#self.sessionId,
				rootSessionId: this.#self.rootSessionId ?? this.#self.sessionId,
				depth: this.#self.depth ?? 0,
			},
			agentId: this.#self.agentId,
			...(this.#self.projectId ? { projectId: this.#self.projectId } : {}),
			cwd: spec.cwd,
			command: spec.command,
			env,
			...(spec.delegationRole ? { delegationRole: spec.delegationRole } : {}),
			...(spec.objective ? { objective: spec.objective } : {}),
		};

		const now = this.#now();
		const record: ChildSessionRecord = {
			node: buildChildSessionNode(this.#self, {
				sessionId,
				agentId: this.#self.agentId,
				...(this.#self.projectId ? { projectId: this.#self.projectId } : {}),
				...(spec.delegationRole ? { delegationRole: spec.delegationRole } : {}),
				...(spec.objective ? { objective: spec.objective } : {}),
			}),
			runId,
			createdAt: now,
			updatedAt: now,
		};
		this.#put(record);
		await this.#persist(record);

		let child: ChildSession;
		try {
			child = await this.#supervisor.start(childSpec, spec.signal ? { signal: spec.signal } : {});
		} catch (error) {
			const cancelled = spec.signal?.aborted === true;
			const detail = error instanceof Error ? error.message : String(error);
			// Read the entry back rather than reusing the local copy: a `started` report
			// may already have moved it while the launch was in flight.
			const current = this.#records.get(sessionId) ?? record;
			await this.#persist(
				this.#put({
					...current,
					node: { ...current.node, status: cancelled ? "cancelled" : "failed" },
					statusDetail: cancelled
						? "the launch was cancelled before the child started"
						: `the child did not start: ${detail}`,
					updatedAt: this.#now(),
				}),
			);
			throw error;
		}

		const current = this.#records.get(sessionId) ?? record;
		const live = this.#put({
			...current,
			...(child.transport.pid !== undefined ? { lastPid: child.transport.pid } : {}),
			updatedAt: this.#now(),
		});
		if (live.lastPid !== current.lastPid) await this.#persist(live);
		logger.debug("Child session delegated", { sessionId, runId, pid: child.transport.pid });
		return { child, record: live };
	}

	/**
	 * Every delegation this parent has recorded, oldest first.
	 *
	 * Reading brings the ledger up to date with the supervisor first: a child that
	 * crashed while the parent was busy is `failed` in this answer, not whenever
	 * something next writes. A read that reported `running` for a process that has
	 * been gone for minutes would be the exact stale view reconcile exists to end.
	 */
	async records(): Promise<ChildSessionRecord[]> {
		await this.#ensureLoaded();
		await this.#syncAllFromSupervisor();
		return [...this.#records.values()];
	}

	/** One ledger entry, or `undefined` when this parent never delegated that session. */
	async record(sessionId: SessionId): Promise<ChildSessionRecord | undefined> {
		await this.#ensureLoaded();
		return this.#records.get(sessionId);
	}

	/**
	 * Consume one report from a child.
	 *
	 * `from.pid` is the reporting process. When this manager still supervises that
	 * child AND the child is not terminal, the supervisor's process handle is
	 * current evidence about which process serves it — so a report from any other
	 * pid is refused rather than applied. After a restart there is no such handle
	 * and the report is the only evidence there is, so it is accepted and its pid
	 * recorded.
	 */
	async applyReport(from: { pid: number }, text: string): Promise<ReportIngest> {
		await this.#ensureLoaded();
		if (!hasChildSessionReportTag(text)) return { applied: false, reason: "not-a-report" };
		const envelope = parseChildSessionReport(text);
		if (!envelope) {
			logger.warn("Child session report did not parse", { text: text.slice(0, 400) });
			return { applied: false, reason: "malformed" };
		}
		const sessionId = this.#byRunId.get(envelope.report.runId);
		if (sessionId === undefined) {
			logger.warn("Child session report names a run this session never delegated", {
				runId: envelope.report.runId,
			});
			return { applied: false, reason: "unknown-run" };
		}
		// The pid a child reports from changes when the supervisor relaunches it, so
		// refresh from the supervisor before judging the sender.
		await this.#syncFromSupervisor(sessionId);
		const record = this.#records.get(sessionId);
		if (!record) return { applied: false, reason: "unknown-run" };

		const supervised = this.#supervisor.list().find(candidate => candidate.sessionId === sessionId);
		if (supervised && !isTerminalSessionStatus(supervised.status())) {
			const servingPid = supervised.transport.pid;
			if (servingPid !== undefined && servingPid !== from.pid) {
				logger.warn("Child session report came from a process that does not serve this child", {
					sessionId,
					runId: envelope.report.runId,
					expectedPid: servingPid,
					senderPid: from.pid,
				});
				return { applied: false, reason: "sender-mismatch" };
			}
		}

		const application = applyChildSessionReport(record, { envelope, senderPid: from.pid, now: this.#now() });
		if (!application.applied) {
			logger.debug("Child session report refused", {
				sessionId,
				runId: envelope.report.runId,
				lifecycle: envelope.report.lifecycle,
				reason: application.reason,
			});
			return { applied: false, reason: application.reason };
		}
		this.#put(application.record);
		if (application.changed) await this.#persist(application.record);
		return { applied: true, record: application.record, changed: application.changed };
	}

	/** Children blocked on this parent right now, newest first. */
	async pendingEscalations(): Promise<ChildSessionRecord[]> {
		await this.#ensureLoaded();
		await this.#syncAllFromSupervisor();
		return [...this.#records.values()]
			.filter(record => record.escalation !== undefined)
			.sort((a, b) => (b.escalation?.at ?? 0) - (a.escalation?.at ?? 0));
	}

	/**
	 * Resolve a child's result and record that it was brought back.
	 *
	 * Idempotent by construction: the first call reads and stamps the node; a
	 * second call (or a concurrent one, which joins the first) reports
	 * `firstTime: false` and returns the same content rather than a fresh one the
	 * caller might inject a second time.
	 */
	async bringBack(sessionId: SessionId): Promise<BroughtBackResult> {
		await this.#ensureLoaded();
		const inFlight = this.#bringBacks.get(sessionId);
		if (inFlight) {
			const settled = await inFlight;
			return { ...settled, firstTime: false };
		}
		const attempt = this.#runBringBack(sessionId);
		this.#bringBacks.set(sessionId, attempt);
		try {
			return await attempt;
		} finally {
			this.#bringBacks.delete(sessionId);
		}
	}

	async #runBringBack(sessionId: SessionId): Promise<BroughtBackResult> {
		const record = this.#records.get(sessionId);
		if (!record) throw new Error(`Session "${sessionId}" is not in this session's ledger`);
		const resultRef = record.node.resultRef;
		if (resultRef === undefined) throw new ChildSessionResultNotReadyError(sessionId, record.node.status);

		const alreadyBroughtBackAt = record.node.resultBroughtBackAt;
		const content = await this.#results.read(resultRef);
		if (alreadyBroughtBackAt !== undefined) {
			return { record, resultRef, content, firstTime: false, broughtBackAt: alreadyBroughtBackAt };
		}
		const broughtBackAt = this.#now();
		const next = this.#put({
			...record,
			node: { ...record.node, resultRef, resultBroughtBackAt: broughtBackAt },
			updatedAt: broughtBackAt,
		});
		await this.#persist(next);
		return { record: next, resultRef, content, firstTime: true, broughtBackAt };
	}

	/** Stop a child and mark the node `cancelled`. Idempotent once terminal. */
	async stop(sessionId: SessionId): Promise<ChildSessionRecord> {
		await this.#ensureLoaded();
		const record = this.#records.get(sessionId);
		if (!record) throw new Error(`Session "${sessionId}" is not in this session's ledger`);
		if (isTerminalSessionStatus(record.node.status)) return record;
		const child = this.#supervisor.list().find(candidate => candidate.sessionId === sessionId);
		if (!child) {
			throw new ChildSessionUnavailableError(
				`Session "${sessionId}" is ${record.node.status} but this process does not supervise it; run reconcile() to settle it`,
			);
		}
		try {
			await child.stop();
		} catch (error) {
			// The supervisor reports a stop it could not complete as `failed`, and it
			// keeps the slot because the child is still running. The ledger must say
			// the same thing the supervisor says.
			await this.#syncFromSupervisor(sessionId);
			throw error;
		}
		const next = this.#put({
			...record,
			node: { ...record.node, status: "cancelled" },
			statusDetail: "stopped by the parent",
			updatedAt: this.#now(),
		});
		await this.#persist(next);
		return next;
	}

	/**
	 * Settle the ledger after a (re)start.
	 *
	 * Reads the ledger from the store, asks what the broker can still see, and
	 * applies `planReconcile`. Children this process still supervises count as
	 * alive by definition — the supervisor is the authority on processes it owns,
	 * and a relaunching child is briefly absent from the roster.
	 */
	async reconcile(): Promise<ReconcileResult> {
		await this.#writes;
		const persisted = await this.#store.load();
		const live = new Set<number>(await this.#liveness.liveChildPids());
		for (const child of this.#supervisor.list()) {
			if (isTerminalSessionStatus(child.status())) continue;
			const pid = child.transport.pid;
			if (pid !== undefined) live.add(pid);
		}
		const plan = planReconcile(persisted, live);
		const { records, applied } = applyReconcilePlan(persisted, plan, this.#now());
		this.#reset(records);
		for (const decision of applied) {
			const record = this.#records.get(decision.sessionId);
			if (record) await this.#persist(record);
		}
		if (applied.length > 0) {
			logger.warn("Session tree reconciled orphaned children", {
				orphaned: applied.map(decision => decision.sessionId),
			});
		}
		return { plan, records: [...this.#records.values()], applied };
	}

	// ── internals ────────────────────────────────────────────────────────────

	async #ensureLoaded(): Promise<void> {
		this.#loaded ??= (async () => {
			this.#reset(await this.#store.load());
		})();
		await this.#loaded;
	}

	#reset(records: readonly ChildSessionRecord[]): void {
		this.#records = new Map(records.map(record => [record.node.sessionId, record]));
		this.#byRunId = new Map(records.map(record => [record.runId, record.node.sessionId]));
	}

	#put(record: ChildSessionRecord): ChildSessionRecord {
		this.#records.set(record.node.sessionId, record);
		this.#byRunId.set(record.runId, record.node.sessionId);
		return record;
	}

	#persist(record: ChildSessionRecord): Promise<void> {
		const next = this.#writes.then(() => this.#store.save(record));
		// Keep the chain alive after a failed write, so one failure cannot make every
		// later ledger write reject with the previous error.
		this.#writes = next.catch(() => {});
		return next;
	}

	/** Move the ledger to whatever the supervisor now says, for every child it still holds. */
	async #syncAllFromSupervisor(): Promise<void> {
		for (const child of this.#supervisor.list()) await this.#syncFromSupervisor(child.sessionId);
	}

	/** Move the ledger to whatever the supervisor now says, when it says something new. */
	async #syncFromSupervisor(sessionId: SessionId): Promise<void> {
		const child = this.#supervisor.list().find(candidate => candidate.sessionId === sessionId);
		const record = this.#records.get(sessionId);
		if (!child || !record) return;
		const status = child.status();
		const pid = child.transport.pid;
		const pidMoved = pid !== undefined && pid !== record.lastPid;
		const becameTerminal = isTerminalSessionStatus(status) && !isTerminalSessionStatus(record.node.status);
		if (!pidMoved && !becameTerminal) return;
		const next = this.#put({
			...record,
			...(pid !== undefined ? { lastPid: pid } : {}),
			...(becameTerminal ? { node: { ...record.node, status } } : {}),
			...(becameTerminal ? { statusDetail: describeSupervisorTerminal(status, pid) } : {}),
			updatedAt: this.#now(),
		});
		await this.#persist(next);
	}
}

function describeSupervisorTerminal(status: SessionNode["status"], pid: number | undefined): string {
	const where = pid === undefined ? "the child process" : `child process ${pid}`;
	return status === "failed"
		? `${where} is gone and the restart budget is exhausted`
		: `${where} exited after the parent stopped it`;
}
