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
 * The Agent reference a write should persist, resolved from the request's own fields.
 *
 * Two failure modes are refused rather than persisted, because “ok, but it will never fire”
 * is exactly the plausible lie this workbench exists to remove (`docs/client/agent-hub.md` §1.6):
 *   - a **declared** `agentId` that is not registered;
 *   - a **declared** Agent whose `agentDir` is gone (identity resolved, home did not).
 *
 * An **undeclared** binding (no `agentId`, no `agentDir`) is allowed through: the row keeps its
 * `agentResolution: "unbound"` state and the run path refuses to execute it, so the operator can
 * stage a schedule first and bind it later. Blocking creation would make that state unrepresentable
 * in the API while it still exists in storage (legacy rows).
 *
 * `agentDir` is always persisted when it resolved, even when it duplicates the registry home:
 * a firing schedule must not depend on the registry being readable at fire time.
 */
export async function resolveScheduleAgentForWrite(
	ref: ScheduleAgentRef,
	resolve: (ref: ScheduleAgentRef) => Promise<ScheduleAgentBinding> = resolveScheduleAgentBinding,
): Promise<{ ok: true; binding: ScheduleAgentBinding } | { ok: false; error: string }> {
	const binding = await resolve(ref);
	const declaredId = trimmed(ref.agentId);

	if (binding.resolution === "unbound") {
		// Undeclared: legal to persist, never executed (the run path refuses it).
		return { ok: true, binding };
	}
	// An explicitly declared id that does not exist is a caller error, even when a usable
	// directory was supplied — silently keeping the directory would bind a different Agent
	// than the caller asked for.
	if (declaredId && !binding.agentId) {
		return { ok: false, error: `agentId「${declaredId}」未注册，无法绑定（先用 cornfield agent 注册它）。` };
	}
	// A bare `agentDir` that no Agent owns stays legal: those are the pre-registry bindings
	// (`agent-profile.ts` compat rules — they must keep working with no migration). The row
	// reports `agentResolution: "unregistered"`, so the workbench shows an unknown identity
	// instead of guessing one. Only a *resolved* Agent that is unusable blocks the write.
	if (binding.enabled === false) {
		return { ok: false, error: binding.error ?? "绑定的 Agent 的 agentDir 不存在，调度不会执行。" };
	}
	return { ok: true, binding };
}
