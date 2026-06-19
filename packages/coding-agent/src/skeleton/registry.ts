/**
 * agentDir registry.
 *
 * Persists a `name → path` map at `~/.omp/agent/registry.json` so that
 * `omp agent list` / `omp agent show <name>` can find agentDirs regardless
 * of where they live (default `~/.omp/agents/`, custom `--dir` paths,
 * nested account ids like `ops/hr`, etc.).
 *
 * Design:
 *   - `init` writes the new agentDir into the registry after the skeleton
 *     is on disk. If the name already exists, the path is overwritten.
 *   - `list` reads the registry. For backward compatibility with agents
 *     created before the registry existed, it also scans the default
 *     `~/.omp/agents/` location for entries not in the registry.
 *   - `show <name>` looks the name up in the registry first and falls
 *     back to `resolveAgentDir(name)` if missing.
 *   - `register` / `unregister` let the user add or remove entries
 *     without re-creating the underlying agentDir.
 *   - `reconcile` re-scans the default location and prunes entries
 *     whose path no longer exists.
 *
 * Concurrency: this is an interactive CLI, so a plain read-modify-write
 * is acceptable. If two `init` calls race the last writer wins.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REGISTRY_DIR_NAME = "agent";
const REGISTRY_FILE_NAME = "registry.json";
const REGISTRY_VERSION = 1;

/** Resolved at call time so tests can change HOME between calls. Uses process.env.HOME
 *  directly because `os.homedir()` caches its result on the first call. */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

/** Resolved at call time so tests can change HOME between calls. */
function registryPath(): string {
	return path.join(homeDir(), ".omp", REGISTRY_DIR_NAME, REGISTRY_FILE_NAME);
}

export interface AgentEntry {
	/** Absolute path to the agentDir. */
	path: string;
	/** ISO timestamp the entry was last written. */
	registeredAt: string;
	/** Template name used to create the agentDir. Only `default` today. */
	template: string;
}

export interface Registry {
	version: number;
	agents: Record<string, AgentEntry>;
}

const EMPTY_REGISTRY: Registry = { version: REGISTRY_VERSION, agents: {} };

/** Load the registry from disk. Returns an empty registry on ENOENT or corrupt JSON. */
export async function loadRegistry(): Promise<Registry> {
	let text: string;
	try {
		text = await Bun.file(registryPath()).text();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_REGISTRY);
		throw err;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			parsed &&
			typeof parsed === "object" &&
			"agents" in parsed &&
			typeof (parsed as Registry).agents === "object" &&
			(parsed as Registry).agents !== null
		) {
			return parsed as Registry;
		}
	} catch {
		// Corrupt JSON — start fresh. The user can recover via `omp agent reconcile`.
	}
	return structuredClone(EMPTY_REGISTRY);
}

/** Atomically write the registry (Bun.write uses tmp + rename under the hood). */
export async function saveRegistry(reg: Registry): Promise<void> {
	const p = registryPath();
	await fs.mkdir(path.dirname(p), { recursive: true });
	await Bun.write(p, JSON.stringify(reg, null, 2));
}

/** Add or update an entry. Returns the new entry. */
export async function registerAgent(name: string, agentDir: string, template = "default"): Promise<AgentEntry> {
	const reg = await loadRegistry();
	const entry: AgentEntry = {
		path: path.resolve(agentDir),
		registeredAt: new Date().toISOString(),
		template,
	};
	reg.agents[name] = entry;
	await saveRegistry(reg);
	return entry;
}

/** Remove an entry. Returns true if it existed. */
export async function unregisterAgent(name: string): Promise<boolean> {
	const reg = await loadRegistry();
	if (!(name in reg.agents)) return false;
	delete reg.agents[name];
	await saveRegistry(reg);
	return true;
}

/** Look up a single agent by name. Returns undefined if not registered. */
export async function findAgent(name: string): Promise<AgentEntry | undefined> {
	const reg = await loadRegistry();
	return reg.agents[name];
}

/** Return all registered entries. */
export async function listRegistered(): Promise<Array<{ name: string; entry: AgentEntry }>> {
	const reg = await loadRegistry();
	return Object.entries(reg.agents).map(([name, entry]) => ({ name, entry }));
}

/**
 * Return the names of entries whose path no longer exists on disk.
 * Does not modify the registry.
 */
export async function findStaleEntries(): Promise<string[]> {
	const reg = await loadRegistry();
	const stale: string[] = [];
	for (const [name, entry] of Object.entries(reg.agents)) {
		try {
			const stat = await fs.stat(entry.path);
			if (!stat.isDirectory()) stale.push(name);
		} catch {
			stale.push(name);
		}
	}
	return stale;
}

/** Prune stale entries from the registry. Returns the names that were removed. */
export async function pruneStaleEntries(): Promise<string[]> {
	const reg = await loadRegistry();
	const removed: string[] = [];
	for (const [name, entry] of Object.entries(reg.agents)) {
		let alive = false;
		try {
			const stat = await fs.stat(entry.path);
			alive = stat.isDirectory();
		} catch {
			alive = false;
		}
		if (!alive) {
			delete reg.agents[name];
			removed.push(name);
		}
	}
	if (removed.length > 0) await saveRegistry(reg);
	return removed;
}

/** Registry file path (for diagnostics). Resolved lazily. */
export function REGISTRY_FILE_PATH(): string {
	return registryPath();
}
