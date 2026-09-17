/**
 * Session ↔ Agent resolution (WP4).
 *
 * The domain policy lives in `../agent-domain/default-agent`; this module composes the
 * world it judges — the Agent registry projection (`../agent-domain/agent-directory`),
 * the Project store (`../agent-domain/project-store`) and the process's own identity —
 * and produces the `ResolvedAgentRef` a session header persists (§10).
 *
 * Where the session's Agent comes from:
 *   1. a caller pin (CLI flag, gateway account, schedule record) — the session's intent;
 *   2. the Agent already recorded in the session header, when resuming or forking;
 *   3. the §10 chain: Project default > workspace default > user default;
 *   4. the process's own Agent (`bootstrap`) when nothing else is declared.
 *
 * Two invariants this module enforces so the recorded Agent is never a plausible lie:
 *
 *   - A session may only record the Agent the process actually runs as. If the chain
 *     resolves a *different* Agent than the process, the resolution fails loudly instead
 *     of writing a header that would not match the running configuration. Launching a
 *     process *as* the resolved Agent (config / model / skills follow it) is a later
 *     work package; until then WP4 refuses rather than pretends.
 *   - Nothing here reads UI or "current selection" state. The input has no channel for
 *     it, so a Schedule, a gateway webhook or a restore cannot inherit one (§10).
 *
 * `unverified` capabilities are reported, never absorbed as valid (see `default-agent`).
 */

import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger, resolveConfigRootDir } from "@cornfield/utils";
import { YAML } from "bun";
import {
	type AgentDirectoryEntry,
	findAgentRecord,
	findAgentRecordByDir,
	loadAgentDirectory,
	toCandidates,
} from "../agent-domain/agent-directory";
import {
	AGENT_CONFIG_FILE_NAME,
	type AgentCapability,
	type AgentSelectionFailure,
	type DefaultAgentDeclarations,
	type DefaultAgentSource,
	describeAgentSelectionFailure,
	describeAgentSource,
	firstDeclaredRung,
	isDefaultAgentSource,
	type ResolvedAgentRef,
	resolveDefaultAgent,
} from "../agent-domain/default-agent";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { AgentId, AgentRecord, WorkspaceContext } from "../agent-domain/types";
import { type SettingValue, USER_GLOBAL_DEFAULT_AGENT_KEY } from "../config/settings-schema";
import {
	readWorkspaceDeclaration,
	type WorkspaceDeclaration,
	type WorkspaceDeclarationRead,
	workspaceFilePath,
} from "../skeleton/workspace";
import type { SessionHeader } from "./session-manager";

/**
 * Agent id of a bare cornfield process that is not a registered Agent. Matches the
 * `default` Agent convention used by `omp serve` / the client (`agents.default`).
 */
export const DEFAULT_AGENT_ID = "default";

export interface ResolveSessionAgentInput {
	/** Working directory of the session; also selects the Project. */
	cwd: string;
	/**
	 * Directory this process runs its Agent config from (sdk's `agentDir`, a gateway
	 * account's agentDir). Its registered Agent, when it has one, is the process's own.
	 */
	processAgentDir: string;
	/** Agent pinned by the caller. Wins over the process directory; a conflict with a persisted header fails. */
	pinnedAgentId?: AgentId;
	/** Header of the session being resumed or forked, when there is one. */
	sessionHeader?: SessionHeader | null;
}

/** Where the resolved Agent came from in *this* call. */
export type SessionAgentOrigin = "persisted" | "resolved";

export interface ResolvedSessionAgent {
	ref: ResolvedAgentRef;
	/** Effective context of the Agent on the resolved Project — derived, never stored (§1). */
	workspaceContext: WorkspaceContext;
	/** Capabilities §10 requires but nobody probed (see `default-agent`). */
	unverified: readonly AgentCapability[];
	origin: SessionAgentOrigin;
}

/** A resolution failure, or a conflict between what is declared and what this process is. */
export type SessionAgentFailure =
	| AgentSelectionFailure
	| {
			kind: "agent-session-conflict";
			pinnedAgentId: AgentId;
			persistedAgentId: AgentId;
	  }
	| {
			kind: "agent-process-mismatch";
			agentId: AgentId;
			source: ResolvedAgentRef["source"];
			processAgentId: AgentId;
			processAgentDir: string;
	  }
	| {
			/**
			 * A declaration exists but cannot be interpreted, so the Agent it declares is unknown.
			 * Reading it as "nothing declared" would silently demote the resolution to a weaker rung.
			 */
			kind: "agent-declaration-unreadable";
			source: Extract<DefaultAgentSource, "workspace" | "user">;
			/** The file that could not be read. */
			path: string;
			reason: string;
	  };

/** Thrown when a session's Agent cannot be resolved. Carries the machine-readable reason. */
export class SessionAgentError extends Error {
	readonly failure: SessionAgentFailure;

	constructor(failure: SessionAgentFailure, message: string) {
		super(message);
		this.name = "SessionAgentError";
		this.failure = failure;
	}
}

/**
 * Resolve the Agent for a session, or fail with an explicit reason.
 *
 * Callers that must not depend on UI state (Schedule, gateway webhook, session restore)
 * pass only persisted facts — `sessionHeader` / `pinnedAgentId` — and get the same
 * answer in any process, regardless of what a client has selected.
 */
export async function resolveSessionAgent(input: ResolveSessionAgentInput): Promise<ResolvedSessionAgent> {
	const directory = await loadAgentDirectory();
	const agents = directory.map(entry => entry.agent);
	const persisted = readPersistedRef(input.sessionHeader);

	if (input.pinnedAgentId && persisted && input.pinnedAgentId !== persisted.agentId) {
		throw new SessionAgentError(
			{
				kind: "agent-session-conflict",
				pinnedAgentId: input.pinnedAgentId,
				persistedAgentId: persisted.agentId,
			},
			`This session is recorded as Agent "${persisted.agentId}" but the caller pins Agent ` +
				`"${input.pinnedAgentId}". Re-pinning a session to another Agent is an explicit switch, not a resolution.`,
		);
	}

	const projects = await loadProjects();
	const project = matchProjectForPath(projects, input.cwd);

	// The declaration of the workspace this process runs in. It has two consumers — rung 3
	// below, and the derived `WorkspaceContext` that mirrors it — so it is read once, here,
	// carrying on the process's own entry the way the registry projection does for a
	// registered agentDir (an unregistered one must yield the same context).
	const processDirectory = resolveProcessAgent(directory, input);
	const workspace = await readProcessWorkspaceDeclaration(processDirectory, input.processAgentDir);
	const processAgent: AgentDirectoryEntry =
		workspace.state === "declared" ? { ...processDirectory, declaration: workspace.declaration } : processDirectory;

	const declarations: DefaultAgentDeclarations = {
		sessionAgentId: input.pinnedAgentId ?? persisted?.agentId,
		projectDefaultAgentId: project?.defaultAgentId,
		bootstrapAgentId: processAgent.agent.agentId,
	};

	// Rungs 3 and 4 each sit behind a file, and only the policy can say whether a file
	// matters. The declaration is read for the context regardless of which rung wins (the
	// context mirrors the declaration *in force*, exactly as a registered agentDir's does),
	// but neither its value nor its unreadable file may decide anything before the policy
	// reaches that rung: fill the rungs in order and stop at the first one that declares.
	if (firstDeclaredRung(declarations) === undefined) {
		if (workspace.state === "invalid") throw unreadableWorkspaceDeclaration(workspace.path, workspace.reason);
		const declaredDefault = workspace.state === "declared" ? workspace.declaration.defaultAgentId : undefined;
		if (declaredDefault !== undefined) declarations.workspaceDefaultAgentId = declaredDefault;
	}
	if (firstDeclaredRung(declarations) === undefined) {
		declarations.userDefaultAgentId = await readUserGlobalDefaultAgentId();
	}

	const resolution = resolveDefaultAgent({
		declarations,
		candidates: toCandidates(mergeDirectoryWithProcessAgent(directory, processAgent)),
		project,
		cwd: input.cwd,
		workspaceDeclaration: resolvedDeclaration(directory, processAgent, declarations),
	});
	if (!resolution.ok) {
		throw new SessionAgentError(resolution.failure, describeAgentSelectionFailure(resolution.failure, agents));
	}

	const { agent, source, workspaceContext, unverified } = resolution.resolved;
	if (agent.agentId !== processAgent.agent.agentId) {
		throw new SessionAgentError(
			{
				kind: "agent-process-mismatch",
				agentId: agent.agentId,
				source,
				processAgentId: processAgent.agent.agentId,
				processAgentDir: processAgent.agent.agentDir,
			},
			`${describeAgentSource(source)} resolves this session to Agent "${agent.agentId}", but this process ` +
				`runs as Agent "${processAgent.agent.agentId}" (${processAgent.agent.agentDir}). ` +
				"Start the session under that Agent's directory instead of recording the wrong Agent.",
		);
	}

	if (unverified.length > 0) {
		logger.debug("session-agent: capabilities not probed", { agentId: agent.agentId, unverified });
	}

	const usePersisted = persisted !== null && agent.agentId === persisted.agentId;
	return {
		ref: { agentId: agent.agentId, source: usePersisted ? persisted.source : source },
		workspaceContext,
		unverified,
		origin: usePersisted ? "persisted" : "resolved",
	};
}

/**
 * The Agent this process runs as: the registered Agent whose agentDir is the process
 * config dir, else the client's built-in default identity for a bare process.
 *
 * A bare `cornfield` in a repo is not a registered Agent — it runs with the client's own
 * config dir. Recording that as Agent `default` is the §10 bootstrap rung, and it is a
 * statement about the process, not an invented identity.
 */
function resolveProcessAgent(
	directory: readonly AgentDirectoryEntry[],
	input: ResolveSessionAgentInput,
): AgentDirectoryEntry {
	const registered = findAgentRecordByDir(directory, input.processAgentDir);
	if (registered) return registered;
	const agent: AgentRecord = {
		agentId: DEFAULT_AGENT_ID,
		agentDir: input.processAgentDir,
		displayName: DEFAULT_AGENT_ID,
		enabled: true,
	};
	return { agent };
}

/** The candidate set the policy judges: the registry projection plus the process's own Agent. */
function mergeDirectoryWithProcessAgent(
	directory: readonly AgentDirectoryEntry[],
	processAgent: AgentDirectoryEntry,
): AgentDirectoryEntry[] {
	if (findAgentRecord(directory, processAgent.agent.agentId)) return [...directory];
	return [...directory, processAgent];
}

/** The declaration of whichever Agent the chain is about to consider. */
function resolvedDeclaration(
	directory: readonly AgentDirectoryEntry[],
	processAgent: AgentDirectoryEntry,
	declarations: DefaultAgentDeclarations,
): AgentDirectoryEntry["declaration"] {
	const candidateId =
		declarations.sessionAgentId ??
		declarations.projectDefaultAgentId ??
		declarations.workspaceDefaultAgentId ??
		declarations.userDefaultAgentId ??
		declarations.bootstrapAgentId;
	if (candidateId === undefined) return undefined;
	const entry = findAgentRecord(directory, candidateId) ?? processAgent;
	return entry.agent.agentId === candidateId ? entry.declaration : undefined;
}

/**
 * What the process's own agentDir declares, in the three states `readWorkspaceDeclaration`
 * defines — with the uninterpretable one carrying the path it failed on. The read never
 * throws: whether "this declaration cannot be read" is fatal depends on whether the
 * precedence policy reaches rung 3, and only `resolveSessionAgent` knows that. A file
 * behind a rung nobody consults must not veto a declaration that already won.
 */
type ProcessWorkspaceDeclaration =
	| { state: "declared"; declaration: WorkspaceDeclaration }
	| { state: "absent" }
	| { state: "invalid"; path: string; reason: string };

/**
 * Read the declaration of the workspace this process runs in — its own agentDir.
 *
 * Rung 3 takes its `defaultAgentId` from here, and the derived `WorkspaceContext` mirrors
 * the declaration itself (`WorkspaceContext.defaultAgentId`, `.memoryDir`, `.skillsDir`).
 * The declaration is therefore returned whole, not reduced to the id: the context a bare
 * process derives must be the one a registered agentDir derives, and the relations rules
 * judge a declared default from that context.
 *
 * A registered agentDir's declaration comes from the directory projection, which already
 * read the same file (tolerantly) for the candidate record. An unregistered one — and a
 * registered one whose file only became unreadable since — is read here.
 */
async function readProcessWorkspaceDeclaration(
	processAgent: AgentDirectoryEntry,
	processAgentDir: string,
): Promise<ProcessWorkspaceDeclaration> {
	if (processAgent.declaration) return { state: "declared", declaration: processAgent.declaration };

	const file = workspaceFilePath(processAgentDir);
	let read: WorkspaceDeclarationRead;
	try {
		read = await readWorkspaceDeclaration(processAgentDir);
	} catch (err) {
		// "I could not look" is not "nothing declared" — but it is not fatal until the policy
		// reaches this rung either (a permission error on a lower rung is not a broken intent).
		return { state: "invalid", path: file, reason: err instanceof Error ? err.message : String(err) };
	}
	switch (read.state) {
		case "declared":
			return { state: "declared", declaration: read.declaration };
		case "absent":
			return { state: "absent" };
		case "invalid":
			return { state: "invalid", path: file, reason: read.reason };
	}
}

/** Rung 3's loud failure: the declaration exists but cannot be interpreted. */
function unreadableWorkspaceDeclaration(file: string, reason: string): SessionAgentError {
	return new SessionAgentError(
		{ kind: "agent-declaration-unreadable", source: "workspace", path: file, reason },
		`The workspace declaration at "${file}" cannot be read (${reason}), so the Agent it declares as ` +
			"default is unknown. Fix or remove that file: a session must not start as an Agent this workspace " +
			"may not have asked for.",
	);
}

/**
 * The client-level settings file, `<config root>/agent/config.yml` — the global file
 * `Settings` reads. The root comes from the directory authority (`resolveConfigRootDir`),
 * because `CORNFIELD_CONFIG_DIR` may be an *absolute* path; joining that under HOME would
 * name a file nobody writes and silently skip this rung.
 *
 * Resolved at call time (like `../skeleton/registry` and `../agent-domain/project-store`)
 * so a process pointed at another HOME reads that client's declarations. Exported so
 * callers and tests name the same file.
 */
export function userConfigFilePath(): string {
	return path.join(resolveConfigRootDir(homeDir()), "agent", AGENT_CONFIG_FILE_NAME);
}

/** `process.env.HOME` first, as in `../skeleton/registry` and `../agent-domain/project-store`:
 *  a caller (or a test) that points HOME at another client must read *that* client's files. */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

/**
 * Rung 4: `USER_GLOBAL_DEFAULT_AGENT_KEY` from the user's own config.yml.
 *
 * Read from the file rather than through the `Settings` singleton: a resolution runs in
 * processes that never initialize settings (a scheduled or gateway-driven session), and
 * its answer must not depend on init order.
 *
 * States as in rung 3: no file = nothing declared; a file that cannot be interpreted = a
 * hard failure; declared = its value, which must be an Agent id — a non-string is a
 * declaration we cannot honour, not an absent one.
 */
async function readUserGlobalDefaultAgentId(): Promise<AgentId | undefined> {
	const file = userConfigFilePath();
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		throw unreadableUserConfig(file, `not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
	}
	// A document that cannot hold keys declares nothing here (the same reading `Settings`
	// gives a non-object config).
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

	const [group, key] = USER_GLOBAL_DEFAULT_AGENT_KEY.split(".") as [string, string];
	const section = (parsed as Record<string, unknown>)[group];
	if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;

	const declared = (section as Record<string, unknown>)[key];
	// Only a *truly absent* key is "nothing declared". A key that is present but is not an
	// Agent id — YAML `null`, a number, a list — is a declaration that cannot be honoured,
	// and reading it as absent would silently demote the rung to the process's own Agent.
	if (declared === undefined) return undefined;
	if (typeof declared !== "string") {
		throw unreadableUserConfig(
			file,
			`"${USER_GLOBAL_DEFAULT_AGENT_KEY}" must be an Agent id (a string), found ${describeDeclaredValue(declared)}`,
		);
	}
	// The typed slot is the tie to the settings table: the constant must be a real
	// `SettingPath`, so a schema rename cannot leave this reader reading a key nobody writes.
	const value: SettingValue<typeof USER_GLOBAL_DEFAULT_AGENT_KEY> = declared;
	return value;
}

function unreadableUserConfig(file: string, reason: string): SessionAgentError {
	return new SessionAgentError(
		{ kind: "agent-declaration-unreadable", source: "user", path: file, reason },
		`The user settings file at "${file}" cannot be read (${reason}), so the default Agent it declares is ` +
			`unknown. Fix that file (or drop "${USER_GLOBAL_DEFAULT_AGENT_KEY}") instead of letting the session ` +
			"resolve to a different Agent.",
	);
}

/** What a declared value turned out to be, for the "must be an Agent id" message. */
function describeDeclaredValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	switch (typeof value) {
		case "object":
			return "an object";
		case "number":
			return "a number";
		case "boolean":
			return "a boolean";
		default:
			return typeof value;
	}
}

/** The Agent a session header recorded, if any. Absence is not an error (pre-agent sessions). */
export function readPersistedRef(header: SessionHeader | null | undefined): ResolvedAgentRef | null {
	const agentId = header?.agentId;
	if (!agentId) return null;
	const source = header?.agentSource;
	return { agentId, source: isDefaultAgentSource(source) ? source : "session" };
}
