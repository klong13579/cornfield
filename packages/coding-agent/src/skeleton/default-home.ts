/**
 * The default Agent's home — registry coherence and the one-time move out of the client dir.
 *
 * Two roots that used to be one directory now have separate owners
 * (`docs/agent-task-control-plane-v1.md` §3/§6、`docs/agent-task-control-plane-v1-implementation.md` §2):
 *
 *   - the **client dir** (`getClientDir()`, `~/.cornfield/agent`): credentials, the Agent
 *     registry, the Project store, caches, blobs, terminal breadcrumbs — state that belongs to
 *     the client and outlives any one Agent;
 *   - the **default Agent's home** (`getDefaultAgentHome()`, `~/cf-workspace`): that Agent's own
 *     agentDir — sessions, config, memories, commands.
 *
 * Two jobs live here, both about the seam between them:
 *
 *   1. {@link checkDefaultAgentHome} / {@link assertDefaultAgentHome} — the registry's `default`
 *      path and the home this process resolves must be the same directory. A session belongs to
 *      exactly one home; two candidates would mean silently running the Agent somewhere the
 *      registry does not point, so a mismatch is an error, never a coin flip.
 *   2. {@link migrateDefaultAgentHome} — move what the default Agent owned out of the client dir.
 *
 * What the migration deliberately does NOT move is documented in
 * `docs/agent-task-control-plane-v1-implementation.md` §2 and in the report it returns: the
 * client-scope half (`skills/`, `blobs/`, `extensions/`, `terminal-sessions/`, `intercom/`,
 * `*.db`, `registry.json`, `projects.json`, `mcp.json`, `models.yml`, caches) stays where it is,
 * because those readers resolve them through the client root, not through an Agent's home.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	APP_NAME,
	getClientDir,
	getDefaultAgentHome,
	isEnoent,
	logger,
	normalizePathForComparison,
} from "@cornfield/utils";
import { YAML } from "bun";
import { findAgent, REGISTRY_FILE_PATH } from "./registry";

/** Registry key of the built-in default Agent (see `session/session-agent`). */
const DEFAULT_AGENT_ID = "default";

// =============================================================================
// Registry ↔ home coherence
// =============================================================================

export interface DefaultHomeCheck {
	/** The home this process resolves (`~/cf-workspace` unless overridden). */
	home: string;
	/** `default`'s agentDir in `registry.json`, when the registry declares one. */
	registryPath?: string;
	/** True when there is nothing to disagree about, or the two agree. */
	ok: boolean;
	/** Human-readable, actionable description of a disagreement. */
	message?: string;
}

/**
 * Compare the registry's `default` entry with the home this process resolves.
 *
 * Three outcomes, kept apart on purpose:
 *   - the registry declares no `default` → nothing to compare (`ok`, no message);
 *   - the two paths are the same directory (normalized, symlinks resolved) → `ok`;
 *   - they differ → `ok: false` with the message {@link assertDefaultAgentHome} throws.
 *
 * Both sides are compared with `normalizePathForComparison` so `/private/tmp` and `/tmp`, or a
 * symlinked home, are not reported as a disagreement.
 */
export async function checkDefaultAgentHome(): Promise<DefaultHomeCheck> {
	const home = getDefaultAgentHome();
	const entry = await findAgent(DEFAULT_AGENT_ID);
	if (!entry) return { home, ok: true };
	const declared = path.resolve(entry.path);
	if (normalizePathForComparison(declared) === normalizePathForComparison(home)) {
		return { home, registryPath: declared, ok: true };
	}
	return {
		home,
		registryPath: declared,
		ok: false,
		message:
			`The registry (${REGISTRY_FILE_PATH()}) declares Agent "${DEFAULT_AGENT_ID}" at "${declared}", ` +
			`but this process resolves the default Agent's home to "${home}". ` +
			"A session belongs to exactly one home, so refusing to pick either: point the registry entry at " +
			`the resolved home (\`${APP_NAME} agent register ${DEFAULT_AGENT_ID} --dir "${home}"\`) or start the ` +
			"process in the Agent's own home. Nothing was started.",
	};
}

/** {@link checkDefaultAgentHome}, but throws instead of returning the failure. */
export async function assertDefaultAgentHome(): Promise<DefaultHomeCheck> {
	const check = await checkDefaultAgentHome();
	if (!check.ok) throw new Error(check.message);
	return check;
}

// =============================================================================
// Migration: the default Agent's half of the client dir → its home
// =============================================================================

/** One entry of the ownership list: what it is, who owns it, and what the migration does. */
export interface DefaultHomeOwnership {
	/** Path relative to the client dir (a directory, or a single file). */
	name: string;
	owner: "client" | "agent";
	/** Where it goes for the `agent` owner; empty for `client`. */
	target?: string;
	/** Why it is classified this way — the reader that decides it. */
	reason: string;
}

/**
 * The ownership list this migration implements. It is data, not prose, so a reader can diff the
 * list against the code (`getXxxDir()` call sites) instead of trusting the migration's word.
 */
export const DEFAULT_HOME_OWNERSHIP: readonly DefaultHomeOwnership[] = [
	{
		name: "sessions",
		owner: "agent",
		target: "sessions",
		reason: "the session runtime stores them under its agentDir (sdk `getDefaultSessionDir(cwd, agentDir)`)",
	},
	{
		name: "memories",
		owner: "agent",
		target: "memories",
		reason: "`getMemoryRoot(agentDir, cwd)` — the session's memory zone follows its agentDir",
	},
	{
		name: "commands",
		owner: "agent",
		target: "commands",
		reason: "`discoverCustomCommands({ agentDir })` reads `<agentDir>/commands`",
	},
	{
		name: "config.yml",
		owner: "agent",
		target: path.join(".cornfield", "config.yml"),
		reason:
			"doc §12: the default Agent's config root is `~/cf-workspace/.cornfield/config.yml`; merged, never overwritten",
	},
	{
		name: "skills",
		owner: "client",
		reason:
			"read from `ctx.home` (`discovery/builtin.ts` PATHS.userAgent), i.e. as user-level skills for **every** Agent in the process — and the client materializes its built-in skills there (`intercom-extension`)",
	},
	{
		name: "blobs",
		owner: "client",
		reason: "the session artifact store is resolved through the client root (`getBlobsDir()`)",
	},
	{
		name: "extensions",
		owner: "client",
		reason: "extension discovery resolves the user extension dir through the client root",
	},
	{
		name: "terminal-sessions",
		owner: "client",
		reason: "terminal breadcrumbs are per terminal, not per Agent (`getTerminalSessionsDir()`)",
	},
	{
		name: "intercom",
		owner: "client",
		reason: "the intercom broker socket registry is per client, shared by every session",
	},
	{
		name: "registry.json / projects.json",
		owner: "client",
		reason: "client-scope indexes of Agents and Projects (`skeleton/registry`, `agent-domain/project-store`)",
	},
	{
		name: "agent.db / history.db / models.db / autoqa.db / diagnosis-reports.db",
		owner: "client",
		reason: "credentials and client-wide caches; `discoverAuthStorage()` reads the client's db",
	},
	{
		name: "mcp.json / models.yml / lsp.yaml / moa.yml / settings.json / browser-state.json / webcache / diagnosis-* / python-gateway / pycache / kimi-device-id",
		owner: "client",
		reason: "client-scope config and caches read through the client root",
	},
];

export interface MigratedEntry {
	name: string;
	/** Absolute source path (client dir). */
	from: string;
	/** Absolute destination path (the Agent's home). */
	to: string;
	/** `moved` — renamed into the home; `merged` — content merged; `absent` — nothing to move;
	 *  `kept` — left in the client dir on purpose (see {reason}). */
	status: "moved" | "merged" | "absent" | "kept" | "failed";
	/** Directory entries (or config keys) that landed in the home. */
	movedCount: number;
	/** Names that already existed in the home — left in the client dir, never overwritten. */
	conflicts: string[];
	/** Files still being written by a live process; left in place for the next run. */
	live: string[];
	/** Content hash of the source before / the target after (single-file entries). */
	sourceHash?: string;
	targetHash?: string;
	reason?: string;
	error?: string;
}

export interface DefaultHomeMigrationReport {
	clientDir: string;
	home: string;
	/** Ownership list actually applied, with the reason for every `client` classification. */
	ownership: readonly DefaultHomeOwnership[];
	entries: MigratedEntry[];
	/** Entry counts before/after, per owner — the comparable evidence. */
	before: { clientDirEntries: number; homeEntries: number };
	after: { clientDirEntries: number; homeEntries: number };
	dryRun: boolean;
}

export interface MigrateDefaultAgentHomeOptions {
	/** Report what would happen without touching the filesystem. */
	dryRun?: boolean;
	/**
	 * Session files modified more recently than this stay where they are: a live process holds
	 * their path and would keep appending to the old location. Default 5 minutes.
	 */
	liveWindowMs?: number;
	now?: number;
}

/**
 * Move what the default Agent owns out of the client dir into its home.
 *
 * Idempotent: a second run finds the sources gone (`absent`) or fully merged. Never deletes:
 *   - a target entry that already exists wins, and the source copy is left in the client dir
 *     (reported under `conflicts`) — two files claiming the same session id are a decision for a
 *     human, not for a migration;
 *   - `config.yml` is merged key-by-key into `<home>/.cornfield/config.yml` with the source
 *     (the file that was in effect) winning, and the source file is kept where it is: it is still
 *     the client-level config layer (`session/session-agent#userConfigFilePath`, the gateway's
 *     user-level fallback), so removing it would silently drop a live reader's file.
 */
export async function migrateDefaultAgentHome(
	options: MigrateDefaultAgentHomeOptions = {},
): Promise<DefaultHomeMigrationReport> {
	const clientDir = getClientDir();
	const home = getDefaultAgentHome();
	const dryRun = options.dryRun ?? false;
	const now = options.now ?? Date.now();
	const liveWindowMs = options.liveWindowMs ?? 5 * 60 * 1000;

	const before = {
		clientDirEntries: await countEntries(clientDir),
		homeEntries: await countEntries(home),
	};

	const entries: MigratedEntry[] = [];
	for (const item of DEFAULT_HOME_OWNERSHIP) {
		const from = path.join(clientDir, item.name);
		if (item.owner === "client") {
			entries.push({
				name: item.name,
				from,
				to: "",
				status: (await pathExists(from)) ? "kept" : "absent",
				movedCount: 0,
				conflicts: [],
				live: [],
				reason: item.reason,
			});
			continue;
		}
		const to = path.join(home, item.target!);
		if (item.name === "config.yml") {
			entries.push(await mergeConfigFile({ from, to, dryRun }));
			continue;
		}
		entries.push(await moveDirectory({ name: item.name, from, to, dryRun, now, liveWindowMs }));
	}

	if (!dryRun) {
		// The home must be a usable Agent home whatever it already contains.
		await fs.mkdir(path.join(home, ".cornfield"), { recursive: true });
	}

	const after = {
		clientDirEntries: await countEntries(clientDir),
		homeEntries: await countEntries(home),
	};

	logger.info("default-home:migrated", {
		clientDir,
		home,
		dryRun,
		moved: entries.filter(e => e.status === "moved" || e.status === "merged").map(e => e.name),
		kept: entries.filter(e => e.status === "kept").map(e => e.name),
		conflicts: entries.flatMap(e => e.conflicts),
	});

	return { clientDir, home, ownership: DEFAULT_HOME_OWNERSHIP, entries, before, after, dryRun };
}

/** Move a directory entry-by-entry, skipping what must not move. */
async function moveDirectory(input: {
	name: string;
	from: string;
	to: string;
	dryRun: boolean;
	now: number;
	liveWindowMs: number;
}): Promise<MigratedEntry> {
	const { name, from, to, dryRun, now, liveWindowMs } = input;
	const base: MigratedEntry = { name, from, to, status: "absent", movedCount: 0, conflicts: [], live: [] };
	if (!(await pathExists(from))) return base;

	const sourceEntries = await fs.readdir(from, { withFileTypes: true }).catch(() => null);
	if (!sourceEntries) {
		return { ...base, status: "failed", error: `could not read ${from}` };
	}
	const targetEntries = await fs.readdir(to, { withFileTypes: true }).catch(() => []);
	const targetNames = new Set(targetEntries.map(e => e.name));

	const conflicts: string[] = [];
	const live: string[] = [];
	let movedCount = 0;
	for (const entry of sourceEntries) {
		const childFrom = path.join(from, entry.name);
		const childTo = path.join(to, entry.name);
		if (targetNames.has(entry.name)) {
			conflicts.push(entry.name);
			continue;
		}
		if (!entry.isDirectory() && (await isLive(childFrom, now, liveWindowMs))) {
			live.push(entry.name);
			continue;
		}
		if (entry.isDirectory() && (await dirHasLiveFile(childFrom, now, liveWindowMs))) {
			live.push(entry.name);
			continue;
		}
		movedCount += 1;
		if (dryRun) continue;
		try {
			await fs.mkdir(path.dirname(childTo), { recursive: true });
			await fs.rename(childFrom, childTo);
		} catch (err) {
			return {
				...base,
				status: "failed",
				movedCount,
				conflicts,
				live,
				error: `rename ${childFrom} → ${childTo} failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	if (!dryRun) {
		// Remove the now-empty source so the client dir stops advertising a second home. A
		// non-empty source (conflicts / live files) stays, visibly.
		await fs.rmdir(from).catch(() => {});
	}
	return {
		...base,
		status: movedCount > 0 ? "moved" : conflicts.length > 0 || live.length > 0 ? "kept" : "absent",
		movedCount,
		conflicts,
		live,
	};
}

/** Merge `from` into the target YAML file, source values winning; both keys and file stay. */
async function mergeConfigFile(input: { from: string; to: string; dryRun: boolean }): Promise<MigratedEntry> {
	const { from, to, dryRun } = input;
	const base: MigratedEntry = {
		name: "config.yml",
		from,
		to,
		status: "absent",
		movedCount: 0,
		conflicts: [],
		live: [],
	};
	const sourceText = await Bun.file(from)
		.text()
		.catch(() => null);
	if (sourceText === null) return base;
	const source = parseConfigObject(sourceText);
	if (!source) return { ...base, status: "failed", error: `${from} is not a YAML mapping` };
	const sourceHash = hash(sourceText);

	const targetText = await Bun.file(to)
		.text()
		.catch(() => null);
	const target = targetText === null ? {} : (parseConfigObject(targetText) ?? {});
	const targetHash = targetText === null ? undefined : hash(targetText);

	// Source wins: it is the file that was in effect (the client-level layer every read merged on
	// top of), so its values must survive the move. Keys the target alone declares are kept.
	const merged = deepMerge(target, source);
	const mergedText = YAML.stringify(merged, null, 2);
	if (!dryRun) {
		await fs.mkdir(path.dirname(to), { recursive: true });
		await Bun.write(to, mergedText);
	}
	const sourceKeys = Object.keys(source);
	return {
		...base,
		status: sourceKeys.length > 0 ? "merged" : "absent",
		movedCount: sourceKeys.length,
		sourceHash,
		targetHash: dryRun ? targetHash : hash(mergedText),
	};
}

function parseConfigObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = YAML.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Shallow-keyed deep merge where `winner` (the later argument) overrides `loser`. */
function deepMerge(loser: Record<string, unknown>, winner: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...loser };
	for (const [key, value] of Object.entries(winner)) {
		const previous = out[key];
		out[key] =
			isPlainObject(previous) && isPlainObject(value)
				? deepMerge(previous as Record<string, unknown>, value as Record<string, unknown>)
				: value;
	}
	return out;
}

function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isLive(file: string, now: number, windowMs: number): Promise<boolean> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) return false;
	return now - stat.mtimeMs < windowMs;
}

/** A directory counts as live when it holds a recently-written file at any depth (a session
 *  directory holds `by-date/<date>/<file>.jsonl`, and the file being appended to is the leaf). */
async function dirHasLiveFile(dir: string, now: number, windowMs: number): Promise<boolean> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (await dirHasLiveFile(child, now, windowMs)) return true;
			continue;
		}
		if (await isLive(child, now, windowMs)) return true;
	}
	return false;
}

async function countEntries(dir: string): Promise<number> {
	return (await fs.readdir(dir).catch(() => [])).length;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function hash(text: string): string {
	return Bun.hash.xxHash64(text).toString(16).padStart(16, "0");
}
