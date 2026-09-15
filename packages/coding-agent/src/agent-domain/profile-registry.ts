/**
 * Agent Profile Registry (WP2).
 *
 * An Agent profile is the read-model projection of the two authorities that already
 * exist. This module is the one place both are read together, and therefore the only
 * place a caller should ask "which Agent is this, and where is its home?":
 *
 *   - `~/.cornfield/agent/registry.json` — the thin `name → path` index, written by
 *     `omp agent init/register` (`skeleton/registry.ts`) and by the gateway when it
 *     binds an account. Authority for *which Agents exist and where*.
 *   - `<agentDir>/.cornfield/workspace.json` — the schema-v2 declaration that travels
 *     with the directory (`skeleton/workspace.ts`). Authority for the display name and
 *     every semantic field.
 *
 * No store, no schema, no migration: nothing here writes a file, and `registry.json` /
 * `workspace.json` keep their existing owners. See `DOMAIN_AUTHORITY.agent` in `./types`
 * for the owner table and `./relations` for the invariant that one agentDir belongs to
 * exactly one Agent.
 *
 * ## Why a binding exists
 *
 * Every consumer outside this module holds a raw string today — a gateway `accountId`,
 * a scheduler `task.agentDir`, a workspace directory basename — and resolves it
 * independently, so one Agent is named differently in different places (measured: the
 * gateway account `algorithm` lives in the workspace `omp-atomix`). An
 * {@link AgentBinding} is the single resolution result: the Agent's id, its home, and
 * which authority produced that home. Callers keep their own key (a gateway account
 * stays an account) and read the Agent identity from the binding.
 *
 * ## What this module deliberately does NOT do
 *
 * - No default-Agent *policy* (§10's `session.agentId > project.defaultAgentId > …`
 *   chain) — that is WP4. This module resolves the Agent a caller already names.
 * - No Project / WorkspaceContext construction — WP4.
 * - No scheduler or gateway storage: a legacy `agentDir` on a task is resolved by the
 *   caller through {@link findAgentProfileByDir} / {@link resolveAgentBinding}; nothing
 *   here rewrites stored data.
 */

import { type AgentEntry, findAgent, listRegistered } from "../skeleton/registry";
import { resolveAgentDir } from "../skeleton/resolve";
import { loadWorkspace, type WorkspaceDeclaration } from "../skeleton/workspace";
import { normalizePath } from "./relations";
import type { AgentId, AgentRecord } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Binding
// ─────────────────────────────────────────────────────────────────────────────

/** Which authority produced an {@link AgentBinding.agentDir}. */
export type AgentDirSource =
	/** Declared by the caller (today: the gateway's `accounts.<id>.agentDir`). */
	| "declared"
	/** The Agent's registry entry — the normal path once an Agent is registered. */
	| "registry"
	/** Nothing declared anywhere: the conventional home `<agent-home>/agents/<agentId>`. */
	| "default";

/**
 * Two authorities disagree about one Agent's home: the caller declared a directory
 * while the registry registers the requested `agentId` somewhere else.
 *
 * The binding still resolves — a gateway must boot — preferring the caller's
 * declaration, because it is the operator's direct instruction. The disagreement is
 * *returned* rather than swallowed: one of the two is stale, and only the operator can
 * say which. Callers are expected to surface it (the gateway logs one warning).
 */
export interface AgentBindingConflict {
	requestedAgentId: AgentId;
	declaredAgentDir: string;
	registeredAgentDir: string;
}

/** One Agent, resolved: identity, home, and where the home came from. */
export interface AgentBinding {
	agentId: AgentId;
	agentDir: string;
	agentDirSource: AgentDirSource;
	/**
	 * Profile of the Agent that owns {@link agentDir}, or `null` when that directory is
	 * not a registered Agent's home (the legacy path: a configured directory the registry
	 * does not know about).
	 *
	 * Looked up **by the resolved directory**, so `profile.agentDir` and `agentDir`
	 * always name the same Agent: a binding can never carry a profile whose home
	 * contradicts the binding's own home.
	 */
	profile: AgentRecord | null;
	conflict?: AgentBindingConflict;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project a registry entry (plus its declaration) onto the domain {@link AgentRecord}.
 *
 * `enabled` is `true` for every registered Agent **on purpose**: there is no persisted
 * per-Agent disable flag today, so "registered" is the only enable signal that exists.
 * It is not a report that a flag was read. When a disable flag lands it belongs in the
 * registry entry, and both this projection and §10's candidate checks (`./relations`
 * `*-disabled` rules) must read it here instead of trusting this default.
 *
 * `projectIds` stays unset: no Project store exists yet (WP4), and an absent
 * `projectIds` is read as *unconstrained* by `agent.project-binding-violated`.
 */
export function toAgentProfile(
	agentId: AgentId,
	entry: AgentEntry,
	declaration: WorkspaceDeclaration | null,
): AgentRecord {
	return {
		agentId,
		agentDir: entry.path,
		// The declaration travels with the directory, so it outranks the registry's
		// cached copy of the name; the cache is what lets enumeration avoid opening
		// every agentDir (see skeleton/workspace.ts).
		displayName: declaration?.name ?? entry.displayName ?? agentId,
		enabled: true,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every registered Agent, projected, ordered by `agentId`.
 *
 * Reads each entry's declaration and falls back to the registry's cached `displayName`
 * when the file is missing or unreadable, so list and single lookups agree on a name.
 * The filesystem is not scanned for unregistered directories: the registry is the
 * enumeration authority (`omp agent reconcile` is what finds orphans).
 */
export async function listAgentProfiles(): Promise<AgentRecord[]> {
	const registered = await listRegistered();
	const profiles = await Promise.all(
		registered.map(async ({ name, entry }) => toAgentProfile(name, entry, await loadWorkspace(entry.path))),
	);
	return profiles.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** One Agent by registry key, or `null` when the id is not registered. */
export async function findAgentProfile(agentId: AgentId): Promise<AgentRecord | null> {
	const entry = await findAgent(agentId);
	if (!entry) return null;
	return toAgentProfile(agentId, entry, await loadWorkspace(entry.path));
}

/**
 * Reverse lookup: the Agent whose home is `agentDir`, or `null` when no registered
 * Agent lives there.
 *
 * Paths are compared with the domain's path identity ({@link normalizePath}), so a
 * trailing separator or a backslash spelling still finds the Agent. Two Agents sharing
 * one agentDir is the `agent.dir-shared` violation (`./relations`); this lookup returns
 * the lowest `agentId` deterministically and must not be used to paper over that
 * violation — it exists to read existing data, not to legitimise it.
 */
export async function findAgentProfileByDir(agentDir: string): Promise<AgentRecord | null> {
	const target = normalizePath(agentDir);
	// `listAgentProfiles()` is sorted by agentId, so the first match is deterministic.
	for (const profile of await listAgentProfiles()) {
		if (normalizePath(profile.agentDir) === target) return profile;
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve one Agent binding from the identity a caller already has.
 *
 * Precedence, in order, and why:
 *
 *   1. **declared `agentDir`** — the caller's own configuration (a gateway account that
 *      has no `agentId`, or an operator-pinned path). It is used verbatim, including a
 *      directory the registry does not know: the legacy `OMP-workspace-test` accounts
 *      must keep working with no migration. When the declared directory *is* a
 *      registered Agent's home, that Agent wins the identity — this is the reverse
 *      resolution that turns a legacy `agentDir` back into an `agentId`.
 *   2. **registry** — the declared `agentId`'s registered home. The normal path for a
 *      caller that names its Agent instead of its directory.
 *   3. **default** — `<agent-home>/agents/<agentId>` ({@link resolveAgentDir}), what the
 *      gateway did before this module existed, so an unconfigured account is not
 *      relocated.
 *
 * A whitespace-only `agentDir` is not a declaration (today's gateway passes the raw
 * string through as a process cwd, so a path with stray spaces is still used as given).
 */
export async function resolveAgentBinding(input: { agentId: AgentId; agentDir?: string }): Promise<AgentBinding> {
	const requestedAgentId = input.agentId;
	const declaredAgentDir = input.agentDir?.trim() ? input.agentDir : undefined;

	if (declaredAgentDir !== undefined) {
		const owner = await findAgentProfileByDir(declaredAgentDir);
		if (owner) {
			return { agentId: owner.agentId, agentDir: owner.agentDir, agentDirSource: "declared", profile: owner };
		}
		const binding: AgentBinding = {
			agentId: requestedAgentId,
			agentDir: declaredAgentDir,
			agentDirSource: "declared",
			profile: null,
		};
		const registered = await findAgentProfile(requestedAgentId);
		if (registered) {
			binding.conflict = {
				requestedAgentId,
				declaredAgentDir,
				registeredAgentDir: registered.agentDir,
			};
		}
		return binding;
	}

	const registered = await findAgentProfile(requestedAgentId);
	if (registered) {
		return {
			agentId: requestedAgentId,
			agentDir: registered.agentDir,
			agentDirSource: "registry",
			profile: registered,
		};
	}

	return {
		agentId: requestedAgentId,
		agentDir: resolveAgentDir(requestedAgentId),
		agentDirSource: "default",
		profile: null,
	};
}
