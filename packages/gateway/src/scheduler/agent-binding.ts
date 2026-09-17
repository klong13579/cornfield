/**
 * Schedule → Agent binding resolution (T10C).
 *
 * A `ScheduledTask` stores three generations of agent reference: `accountId` (deprecated),
 * `agentDir` (a path) and `agentId` (a registry key). This module is the one place that
 * turns whatever a row carries into the {@link ScheduleAgentBinding} the wire reports, so
 * the Tasks workbench never has to guess an identity from a path — and never has to render
 * "cannot resolve" as "unbound": those are different facts (`docs/client/agent-hub.md`
 * §1.6: “绑定目标失效时…不静默”, §1.7: “无绑定 agentDir 不执行”).
 *
 * Read-only, and deliberately **non-writing**: legacy rows that only carry `agentDir` (or
 * `accountId`) are resolved by reverse-lookup against the registry on every read. Rewriting
 * storage on read would turn a display into a migration.
 *
 * Precedence (mirrors `@cornfield/coding-agent/agent-domain`'s `resolveAgentBinding`):
 *   1. a declared `agentDir` — legacy rows and operator-pinned paths. When that directory
 *      is a registered Agent's home, the Agent's id wins (reverse resolution).
 *   2. a declared `agentId` — the registered home for that id.
 *   3. neither → `unbound`.
 *
 * The three resolution states are not two states plus a default:
 *   registered    the identity resolved (an `agentId` exists)
 *   unregistered  an execution home exists but names no registered Agent
 *   unbound       no agent reference at all — the task cannot run as anybody
 *
 * ## `accountId` (deprecated) — compat on read, cleared on write
 *
 * A row whose only reference is a pre-registry `accountId` resolves to `unregistered` with that
 * value as its home, so those tasks keep running without a migration. The write face is what
 * retires the field: any modern rebind (or an explicit unbind) clears it, because a leftover
 * `accountId` is a home fallback that would otherwise come back to life the moment the task is
 * unbound. “Cleared” in the API has to mean cleared in storage.
 */

import type { AgentDirectoryEntry } from "@cornfield/coding-agent/agent-domain/agent-directory";
import {
	findAgentRecord,
	findAgentRecordByDir,
	loadAgentDirectory,
} from "@cornfield/coding-agent/agent-domain/agent-directory";
import { logger } from "@cornfield/utils";

/** How a schedule's agent reference resolved. See the module doc. */
export type ScheduleAgentResolutionState = "registered" | "unregistered" | "unbound";

export interface ScheduleAgentBinding {
	/** Resolved registry key. Present exactly when {@link resolution} is `registered`. */
	agentId?: string;
	/** Execution home (`Bun.spawn` cwd for agent tasks). Present when the row declares one. */
	agentDir?: string;
	/**
	 * Where {@link agentDir} came from:
	 *   declared        the row's own `agentDir` (legacy rows and operator-pinned paths)
	 *   registry        the registered Agent's home, resolved from `agentId`
	 *   legacy-account  the deprecated `accountId` field, which older rows used to hold a home
	 *
	 * Same vocabulary as `agent-domain`'s `AgentDirSource`, plus `legacy-account` for the field
	 * this generation of rows predates. Not a display detail: it is the difference between
	 * “this path is the Agent's home” and “this path is what the old row happened to store”.
	 */
	agentDirSource?: "declared" | "registry" | "legacy-account";
	/** Registered Agent's declared display name (never the id dressed up as a name). */
	displayName?: string;
	/** Declared Project bindings; absent = unconstrained (not “no project”). */
	projectIds?: string[];
	/** Registered Agent whose agentDir is gone — the identity resolved, the home did not. */
	enabled?: boolean;
	resolution: ScheduleAgentResolutionState;
	/** Human-readable reason for `unregistered` / `unbound` / a disabled home. */
	error?: string;
}

/** The reference fields a task (or a write request) can carry. */
export interface ScheduleAgentRef {
	agentId?: string;
	agentDir?: string;
	/** @deprecated legacy field; used as a last-resort path claim, never as an identity. */
	accountId?: string;
}

/**
 * Resolve a schedule's agent binding from its persisted reference fields.
 *
 * Never throws: an unreadable registry degrades to `unregistered` **with an error** rather
 * than to `unbound` — “could not read” and “declared nothing” must not look the same.
 *
 * `loadEntries` is the only injection point: a caller (or a test) substitutes the *world* it
 * resolves against, never the rules. Swapping the whole resolver would let production and test
 * disagree about what “unbound” means — and the wire would then report a state the runner does
 * not act on.
 */
export async function resolveScheduleAgentBinding(
	ref: ScheduleAgentRef,
	loadEntries: () => Promise<AgentDirectoryEntry[]> = loadAgentDirectory,
): Promise<ScheduleAgentBinding> {
	const declaredDir = trimmed(ref.agentDir);
	const declaredId = trimmed(ref.agentId);
	// The deprecated field is a *directory* claim in the readers that still look at it
	// (`attach-to-session.resolveMirrorSessionPath`; `cron-service.resolveAgentDir` is the
	// registry-blind accessor for callers that must not consult the registry), so it stays
	// usable as a home — but never as an identity.
	//
	// Policy (why the read fallback survives while the write face clears it): a row whose only
	// reference is a pre-registry `accountId` must keep running — we do not migrate storage on
	// read. But once a row is **rewritten** (a modern rebind, or an explicit unbind) the write
	// path clears `accountId` together with `agentId`/`agentDir`; otherwise the deprecated field
	// would resurrect the old home on the next unbind, i.e. “cleared” rows would keep executing
	// in the previous Agent's directory. See `wire-endpoint.ts` `cron_update`.
	const legacyDir = declaredDir ? undefined : trimmed(ref.accountId);

	if (!declaredDir && !declaredId && !legacyDir) {
		return {
			resolution: "unbound",
			error: "调度没有绑定 Agent（既无 agentId 也无 agentDir）——不会执行；请为它指定一个 Agent。",
		};
	}

	let entries: AgentDirectoryEntry[];
	try {
		entries = await loadEntries();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn("schedule:agent-registry-unreadable", {
			agentId: declaredId,
			agentDir: declaredDir,
			error: reason,
		});
		// Still report the declared home so the row is not silently unbound.
		const broken: ScheduleAgentBinding = {
			agentDir: declaredDir ?? legacyDir,
			agentDirSource: declaredDir ? "declared" : "legacy-account",
			resolution: "unregistered",
			error: `Agent registry 读不出来，绑定无法解析：${reason}`,
		};
		if (declaredId) broken.error = `agentId「${declaredId}」无法校验（registry 读不出来）：${reason}`;
		return broken;
	}

	return bindFromDirectory(entries, declaredDir ?? legacyDir, declaredId, legacyDir !== undefined);
}

/**
 * Pure part of the resolution, so the rules are testable without touching the filesystem.
 * Precedence: the declared directory wins (it is the operator's direct instruction), and
 * when it is a registered Agent's home that Agent's identity is adopted.
 *
 * `fromLegacyAccount` only changes how the home is labelled — a row whose path came from the
 * deprecated `accountId` field reports `agentDirSource: "legacy-account"` instead of claiming
 * the row declared it as an `agentDir`.
 */
export function bindFromDirectory(
	entries: readonly AgentDirectoryEntry[],
	declaredDir: string | undefined,
	declaredId: string | undefined,
	fromLegacyAccount = false,
): ScheduleAgentBinding {
	if (declaredDir) {
		const byDir = findAgentRecordByDir(entries, declaredDir);
		// The home came from the row's own declared directory, even when that directory is a
		// registered Agent's home: `agentDirSource` describes where the *path* came from, not
		// where the identity came from.
		if (byDir) return fromRecord(byDir, declaredDir, fromLegacyAccount ? "legacy-account" : "declared");
		// Not a registered home. An unknown declared id is worth naming in the reason,
		// because it is the difference between “legacy path” and “stale identity”.
		const unknownId = declaredId && !findAgentRecord(entries, declaredId) ? declaredId : undefined;
		return {
			agentDir: declaredDir,
			agentDirSource: fromLegacyAccount ? "legacy-account" : "declared",
			resolution: "unregistered",
			error: unknownId
				? `agentDir「${declaredDir}」不是任何已注册 Agent 的家，声明的 agentId「${unknownId}」也未注册。`
				: `agentDir「${declaredDir}」不是任何已注册 Agent 的家（身份未知，按路径执行）。`,
		};
	}

	const byId = findAgentRecord(entries, declaredId!);
	if (!byId) {
		return {
			resolution: "unregistered",
			error: `声明的 agentId「${declaredId}」未注册。`,
		};
	}
	return fromRecord(byId, byId.agent.agentDir, "registry");
}

function fromRecord(
	entry: AgentDirectoryEntry,
	agentDir: string,
	agentDirSource: "declared" | "registry" | "legacy-account",
): ScheduleAgentBinding {
	const record = entry.agent;
	const binding: ScheduleAgentBinding = {
		agentId: record.agentId,
		agentDir,
		agentDirSource,
		displayName: record.displayName,
		enabled: record.enabled,
		resolution: "registered",
	};
	if (record.projectIds) binding.projectIds = [...record.projectIds];
	if (!record.enabled) {
		binding.error = `Agent「${record.agentId}」的 agentDir 不存在（${agentDir}），调度不会执行。`;
	}
	return binding;
}

function trimmed(value: string | undefined): string | undefined {
	const t = value?.trim();
	return t ? t : undefined;
}

/**
 * What a write asks for the binding to become. An explicit union, because “no field sent”
 * and “clear the field” are different intentions and a resolver that guesses between them
 * silently changes who a schedule runs as.
 *
 *   keep    leave the stored binding alone (update that only touches other fields)
 *   unbind  clear both fields — the row stays, it just will not execute until rebound
 *   bind    resolve and persist this identity/home
 */
export type ScheduleAgentWrite =
	| { kind: "keep" }
	| { kind: "unbind" }
	| { kind: "bind"; agentId?: string; agentDir?: string };

/**
 * Resolve the binding a write should persist.
 *
 * The rules, and why each one is a refusal rather than a silent choice:
 *
 * 1. **A declared `agentId` must be registered.** Silently keeping a usable directory would
 *    bind a different Agent than the caller named (`docs/client/agent-hub.md` §1.6).
 * 2. **`agentId` + `agentDir` must agree.** Two authorities naming two homes for one Agent is
 *    a caller error; persisting the directory while dropping the id (or vice versa) hides it.
 * 3. **`agentDir` alone replaces the identity** — it is the whole binding, not a patch. A legacy
 *    directory (no registered Agent owns it) persists with `agentId` cleared, so a rebind never
 *    leaves the old Agent's key pointing at a new home.
 * 4. **A resolved Agent whose home is gone is refused** — the row would never fire.
 *
 * `{ kind: "bind" }` with neither field is a caller error (use `unbind` to clear, `keep` for a
 * no-op) — an empty bind is exactly the ambiguous case this union exists to remove.
 *
 * The directory is always persisted when it resolved, even when it duplicates the registry home:
 * a firing schedule must not depend on the registry being readable at fire time.
 */
export async function resolveScheduleAgentForWrite(
	write: ScheduleAgentWrite,
	loadEntries: () => Promise<AgentDirectoryEntry[]> = loadAgentDirectory,
): Promise<{ ok: true; binding: ScheduleAgentBinding } | { ok: false; error: string }> {
	if (write.kind === "keep") {
		return { ok: false, error: "keep 不需要解析：调用方应在无绑定变更时跳过本函数。" };
	}
	if (write.kind === "unbind") {
		return {
			ok: true,
			binding: {
				resolution: "unbound",
				error: "调度未绑定 Agent——不会执行；绑一个 Agent 后即恢复。",
			},
		};
	}

	const declaredId = trimmed(write.agentId);
	const declaredDir = trimmed(write.agentDir);
	if (!declaredId && !declaredDir) {
		return { ok: false, error: "绑定变更需要 agentId 或 agentDir（清空绑定用 unbind）。" };
	}

	let entries: AgentDirectoryEntry[];
	try {
		entries = await loadEntries();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// Fail closed: a declared identity cannot be validated without the registry, and writing
		// it unvalidated is how a schedule ends up bound to something that does not exist.
		return { ok: false, error: `Agent registry 读不出来，无法校验绑定：${reason}` };
	}

	const byId = declaredId ? findAgentRecord(entries, declaredId) : undefined;
	if (declaredId && !byId) {
		return { ok: false, error: `agentId「${declaredId}」未注册，无法绑定（先用 cornfield agent 注册它）。` };
	}

	if (declaredId && declaredDir) {
		const owner = findAgentRecordByDir(entries, declaredDir);
		if (owner && owner.agent.agentId !== declaredId) {
			return {
				ok: false,
				error: `agentId「${declaredId}」与 agentDir「${declaredDir}」指向不同 Agent（该目录是「${owner.agent.agentId}」的家）。只传其中一个字段来改绑，不要同时给不一致的两个。`,
			};
		}
		if (!owner) {
			return {
				ok: false,
				error: `agentDir「${declaredDir}」不是 Agent「${declaredId}」注册的家（${byId!.agent.agentDir}）。`,
			};
		}
		return finish(byId!, declaredDir);
	}

	if (byId) {
		return finish(byId, byId.agent.agentDir);
	}

	// `agentDir` alone: the whole binding. A registered home resolves to its Agent's identity;
	// a legacy directory (no registered owner) keeps the path and clears the identity.
	const owner = findAgentRecordByDir(entries, declaredDir!);
	if (!owner) {
		return {
			ok: true,
			binding: {
				agentDir: declaredDir,
				agentDirSource: "declared",
				resolution: "unregistered",
				error: `agentDir「${declaredDir}」不是任何已注册 Agent 的家（身份未知，按路径执行）。`,
			},
		};
	}
	return finish(owner, declaredDir!);
}

/** 已注册身份的收尾（enabled 检查 + 绑定对象）：id-only 与 id/dir 一致两条路径共用。 */
function finish(
	entry: AgentDirectoryEntry,
	agentDir: string,
): { ok: true; binding: ScheduleAgentBinding } | { ok: false; error: string } {
	if (!entry.agent.enabled) {
		return {
			ok: false,
			error: `Agent「${entry.agent.agentId}」的 agentDir 不存在（${entry.agent.agentDir}），调度不会执行。`,
		};
	}
	const binding: ScheduleAgentBinding = {
		agentId: entry.agent.agentId,
		agentDir,
		agentDirSource: "declared",
		displayName: entry.agent.displayName,
		enabled: true,
		resolution: "registered",
	};
	if (entry.agent.projectIds) binding.projectIds = [...entry.agent.projectIds];
	return { ok: true, binding };
}
