/**
 * agentDir registry.
 *
 * Persists a `name → path` map at `~/.cornfield/agent/registry.json` so that
 * `cornfield agent list` / `cornfield agent show <name>` can find agentDirs regardless
 * of where they live (default `~/.cornfield/agents/`, custom `--dir` paths,
 * nested account ids like `ops/hr`, etc.).
 *
 * Design:
 *   - `init` writes the new agentDir into the registry after the skeleton
 *     is on disk. If the name already exists, the path is overwritten.
 *   - `list` reads the registry. For backward compatibility with agents
 *     created before the registry existed, it also scans the default
 *     `~/.cornfield/agents/` location for entries not in the registry.
 *   - `show <name>` looks the name up in the registry first and falls
 *     back to `resolveAgentDir(name)` if missing.
 *   - `register` / `unregister` let the user add or remove entries
 *     without re-creating the underlying agentDir.
 *   - `reconcile` re-scans the default location and prunes entries
 *     whose path no longer exists.
 *
 * Concurrency: every read-modify-write runs under a file lock on registry.json.
 *
 * The old note here said a plain read-modify-write was fine because "this is an
 * interactive CLI". That is false now: `cornfield serve` handles commands frame by
 * frame (two clients can create an agent at the same moment) and the gateway
 * registers accounts on startup. Unlocked, the later writer silently drops the
 * earlier entry — both agentDirs exist on disk while one is missing from the list.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";

const REGISTRY_DIR_NAME = "agent";
const REGISTRY_FILE_NAME = "registry.json";
const REGISTRY_VERSION = 2;

/** Resolved at call time so tests can change HOME between calls. Uses process.env.HOME
 *  directly because `os.homedir()` caches its result on the first call. */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

/** Resolved at call time so tests can change HOME between calls. */
function registryPath(): string {
	return path.join(homeDir(), ".cornfield", REGISTRY_DIR_NAME, REGISTRY_FILE_NAME);
}

export interface AgentEntry {
	/** Absolute path to the agentDir. */
	path: string;
	/** ISO timestamp the entry was last written. */
	registeredAt: string;
	/** Template name used to create the agentDir. Only `default` today. */
	template: string;
	/** Cached display name from `.cornfield/workspace.json` (v2). Optional for v1 entries. */
	displayName?: string;
	/** Cached declaration schema version from `.cornfield/workspace.json` (v2). */
	workspaceVersion?: number;
	/** Cached declaration `updatedAt` from `.cornfield/workspace.json` (v2). */
	workspaceUpdatedAt?: string;
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
		// Corrupt JSON — start fresh. The user can recover via `cornfield agent reconcile`.
	}
	return structuredClone(EMPTY_REGISTRY);
}

/** Atomically write the registry (Bun.write uses tmp + rename under the hood). */
export async function saveRegistry(reg: Registry): Promise<void> {
	const p = registryPath();
	await fs.mkdir(path.dirname(p), { recursive: true });
	await Bun.write(p, JSON.stringify(reg, null, 2));
}

/**
 * registry.json 的 read-modify-write 一律在文件锁里跑。
 *
 * 锁放在注册表自己身上，而不是每个调用方各串一次：知道这条不变式的是这个文件 ——
 * CLI、serve 的 wire 命令、gateway 的账号注册都是它的写方。
 */
/** Add or update an entry. Returns the new entry. */
export async function registerAgent(name: string, agentDir: string, template = "default"): Promise<AgentEntry> {
	return withFileLock(registryPath(), async () => {
		const reg = await loadRegistry();
		const resolved = path.resolve(agentDir);
		// Best-effort cache fill from the workspace declaration (v2). Read-only:
		// creating/updating `.cornfield/workspace.json` is the caller's job (ensureWorkspace),
		// so the gateway account path stays side-effect free on registration.
		let displayName: string | undefined;
		let workspaceVersion: number | undefined;
		let workspaceUpdatedAt: string | undefined;
		try {
			const { loadWorkspace } = await import("./workspace");
			const decl = await loadWorkspace(resolved);
			if (decl) {
				displayName = decl.name;
				workspaceVersion = decl.schemaVersion;
				workspaceUpdatedAt = decl.updatedAt;
			}
		} catch {
			// Declarations are optional; fall back to registry-only entry.
		}
		const entry: AgentEntry = {
			// 从盘上的旧条目起手，而不是按当前类型重建一个：条目里可能有本版本不认识的键
			//（旧版本 / 别的工具写的，例如 default 条目的 `domain`），重建会**静默**删掉它们。
			// 与 workspace.ts 的 attachRoots 同一条规矩：read-modify-write 不许丢自己看不懂的东西。
			...reg.agents[name],
			path: resolved,
			registeredAt: new Date().toISOString(),
			template,
		};
		// 本版本认识的缓存字段仍按本轮声明读数重算：读到就写，读不到就清
		//（留着上一轮的旧值，等于把一个已删除 / 改名的声明缓存成事实）。
		if (displayName === undefined) delete entry.displayName;
		else entry.displayName = displayName;
		if (workspaceVersion === undefined) delete entry.workspaceVersion;
		else entry.workspaceVersion = workspaceVersion;
		if (workspaceUpdatedAt === undefined) delete entry.workspaceUpdatedAt;
		else entry.workspaceUpdatedAt = workspaceUpdatedAt;
		reg.agents[name] = entry;
		// Writing v2 entries: bump the file version so legacy v1 registries are
		// migrated on the next write (their entries are preserved unchanged).
		reg.version = REGISTRY_VERSION;
		await saveRegistry(reg);
		return entry;
	});
}

/** Remove an entry. Returns true if it existed. */
export async function unregisterAgent(name: string): Promise<boolean> {
	return withFileLock(registryPath(), async () => {
		const reg = await loadRegistry();
		if (!(name in reg.agents)) return false;
		delete reg.agents[name];
		await saveRegistry(reg);
		return true;
	});
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
	return withFileLock(registryPath(), async () => {
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
	});
}

/** Registry file path (for diagnostics). Resolved lazily. */
export function REGISTRY_FILE_PATH(): string {
	return registryPath();
}
