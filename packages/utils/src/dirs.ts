/**
 * Centralized path helpers for cornfield config directories.
 *
 * Two roots, two owners — never one directory serving both:
 *
 *   - **Client root** (`getClientDir()`, default `~/.cornfield/agent`): state that belongs to
 *     the process/client and outlives any single Agent — credentials (`agent.db`), the Agent
 *     registry, the Project store, caches (history/models/autoqa/diagnosis), blobs, terminal
 *     breadcrumbs, extension installs. Overridable with `CORNFIELD_CLIENT_DIR`.
 *   - **Default Agent home** (`getDefaultAgentHome()`, fixed to `~/cf-workspace` by
 *     `docs/agent-task-control-plane-v1.md` §12): the default Agent's own agentDir — its
 *     sessions, config, memories and other Agent-scoped files. Other Agents pass their own
 *     agentDir explicitly.
 *
 * `CORNFIELD_CONFIG_DIR` (default `.cornfield`) names the config root (`getConfigRootDir()`).
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME are set, *client- and
 * root-scoped* paths are redirected to XDG-compliant locations under `$XDG_*_HOME/cornfield/`.
 * This requires running `cornfield config migrate` first to move data to the new locations.
 * No filesystem existence checks are performed — if the env var is set, cornfield trusts that
 * the migration has been done. The default Agent's home is a user-visible workspace and is
 * never XDG-relocated.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "cornfield") */
export const APP_NAME: string = "cornfield";

/** Config directory name (e.g. ".cornfield") */
export const CONFIG_DIR_NAME: string = ".cornfield";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

/** Directory name of the default Agent's home under the user's home. */
export const DEFAULT_AGENT_HOME_DIR_NAME: string = "cf-workspace";

// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/**
 * Absolute config root (`~/.cornfield` by default).
 *
 * `CORNFIELD_CONFIG_DIR` may be an absolute path, in which case it *is* the root — joining
 * it under `home` would put every path under a directory nobody writes. Otherwise it is a
 * name relative to `home`. The one place this rule lives, so `DirResolver` and callers that
 * must name the config root themselves (the Project store, session Agent resolution) agree
 * on where the client's files are.
 *
 * `home` is a parameter and resolved at call time, so a process (or a test) pointed at
 * another HOME reads that client's root.
 */
export function resolveConfigRootDir(home: string = os.homedir()): string {
	const dirName = getConfigDirName();
	return path.isAbsolute(dirName) ? dirName : path.join(home, dirName);
}

/** Get the config directory name relative to home (e.g. ".cornfield" or CORNFIELD_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return process.env.CORNFIELD_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Get the client dir name relative to home (e.g. ".cornfield/agent"). */
export function getConfigClientDirName(): string {
	return `${getConfigDirName()}/agent`;
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches the client-scoped cornfield directories. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/cornfield/. A new instance is
 * created whenever the client directory changes, which naturally invalidates all cached paths.
 *
 * Only the client root goes through this resolver: the default Agent's home is a plain
 * directory under the user's home (`getDefaultAgentHome()`), never XDG-relocated.
 */
class DirResolver {
	readonly configRoot: string;
	readonly clientDir: string;

	// Per-category base dirs. Without XDG, all three equal clientDir.
	// With XDG on Linux, they point to $XDG_*_HOME/cornfield/.
	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #clientDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #clientCache = new Map<string, string>();

	constructor(clientDirOverride?: string) {
		const dirName = getConfigDirName();
		// CORNFIELD_CONFIG_DIR may be absolute (e.g. /tmp/test-cornfield) — use it directly;
		// otherwise join it under the home directory (relative name like ".cornfield").
		this.configRoot = configRootOverride ?? (path.isAbsolute(dirName) ? dirName : path.join(os.homedir(), dirName));

		const defaultClientDir = path.join(this.configRoot, "agent");
		this.clientDir = clientDirOverride ? path.resolve(clientDirOverride) : defaultClientDir;
		const isDefault = this.clientDir === defaultClientDir;

		// XDG is a Linux convention. On other platforms, or for non-default
		// profiles, all categories resolve to the legacy paths.
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (value) {
					try {
						const joined = path.join(value, APP_NAME);
						if (fs.existsSync(joined)) {
							return joined;
						}
					} catch {}
				}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		// XDG flattens the agent/ prefix: ~/.cornfield/agent/sessions → $XDG_DATA_HOME/cornfield/sessions
		this.#clientDirs = {
			data: xdgData ?? this.clientDir,
			state: xdgState ?? this.clientDir,
			cache: xdgCache ?? this.clientDir,
		};
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	/** Client-dir subdirectory, with optional XDG override. */
	clientSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#clientCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#clientDirs[xdg] : this.clientDir;
		const result = path.join(base, subdir);
		this.#clientCache.set(subdir, result);
		return result;
	}
}

/** Test-only override for the config root (~/.cornfield). When set, takes precedence over
 * the CORNFIELD_CONFIG_DIR-derived default. Pass `undefined` to reset to the default. */
let configRootOverride: string | undefined;

/** Test-only override for the default Agent's home (normally `~/cf-workspace`). */
let defaultAgentHomeOverride: string | undefined;

let dirs = new DirResolver(process.env.CORNFIELD_CLIENT_DIR);

// =============================================================================
// Root directories
// =============================================================================

/** Get the config root directory (~/.cornfield). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/** Set (or reset, when `dir` is undefined) the config root directory (~/.cornfield).
 * Rebuilds the resolver, invalidating all cached paths. */
export function setConfigRootDir(dir: string | undefined): void {
	configRootOverride = dir;
	dirs = new DirResolver(process.env.CORNFIELD_CLIENT_DIR);
}

/** Set the client directory. Creates a fresh resolver, invalidating all cached paths. */
export function setClientDir(dir: string): void {
	dirs = new DirResolver(dir);
	process.env.CORNFIELD_CLIENT_DIR = dir;
}

/** Get the client directory (~/.cornfield/agent): credentials, registries, caches, blobs. */
export function getClientDir(): string {
	return dirs.clientDir;
}

/**
 * Set (or reset, when `dir` is undefined) the default Agent's home.
 *
 * An override point, not a compatibility path: embedding (tests, a fork that ships another
 * default workspace) can point the default Agent somewhere other than `~/cf-workspace`.
 * Resolved at call time so a caller that changed HOME between calls is honoured.
 */
export function setDefaultAgentHome(dir: string | undefined): void {
	defaultAgentHomeOverride = dir ? path.resolve(dir) : undefined;
}

/**
 * The default Agent's home — its agentDir, fixed to `~/cf-workspace` by
 * `docs/agent-task-control-plane-v1.md` §12 ("default Agent 的 agentDir 固定为 ~/cf-workspace").
 *
 * Resolved through `process.env.HOME` first (like `skeleton/registry` and
 * `agent-domain/project-store`): a caller or test that points HOME at another client must get
 * *that* client's default home. `os.homedir()` caches on some runtimes, so it is the fallback.
 */
export function getDefaultAgentHome(): string {
	if (defaultAgentHomeOverride) return defaultAgentHomeOverride;
	const home = process.env.HOME ?? os.homedir();
	return path.join(home, DEFAULT_AGENT_HOME_DIR_NAME);
}

export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.cornfield/*)
// =============================================================================

/** Get the reports directory (~/.cornfield/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.cornfield/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.cornfield/logs/cornfield.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/** Get the plugins directory (~/.cornfield/plugins). */
export function getPluginsDir(): string {
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (~/.cornfield/plugins/node_modules). */
export function getPluginsNodeModules(): string {
	return path.join(getPluginsDir(), "node_modules");
}

/** Plugin manifest (~/.cornfield/plugins/package.json). */
export function getPluginsPackageJson(): string {
	return path.join(getPluginsDir(), "package.json");
}

/** Plugin lock file (~/.cornfield/plugins/cornfield-plugins.lock.json). */
export function getPluginsLockfile(): string {
	return path.join(getPluginsDir(), "cornfield-plugins.lock.json");
}

/** Get the remote mount directory (~/.cornfield/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/** Get the PR worktrees directory (~/.cornfield/wt). */
export function getWorktreesDir(): string {
	return dirs.rootSubdir("wt", "data");
}

/** Get the SSH control socket directory (~/.cornfield/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (~/.cornfield/remote-host). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.cornfield/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the puppeteer sandbox directory (~/.cornfield/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get the worktree base directory (~/.cornfield/wt). */
export function getWorktreeBaseDir(): string {
	return dirs.rootSubdir("wt", "data");
}

/** Get the path to a worktree directory (~/.cornfield/wt/<project>/<id>). */
export function getWorktreeDir(encodedProject: string, id: string): string {
	return path.join(getWorktreeBaseDir(), encodedProject, id);
}

/** Get the GPU cache path (~/.cornfield/gpu_cache.json). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/** Get the natives directory (~/.cornfield/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the stats database path (~/.cornfield/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the GitHub view cache database path (~/.cornfield/github-cache.db). */
export function getGithubCacheDbPath(): string {
	return dirs.rootSubdir("github-cache.db", "cache");
}

// =============================================================================
// Client-scope subdirectories (~/.cornfield/agent/*)
//
// Process/client state: it belongs to the client, not to any one Agent. Credentials are read
// from here for every Agent; caches (models, history, diagnosis) are per client, not per Agent.
// =============================================================================

/** A subdirectory of the client root. The escape hatch for client-scope state that has no
 *  named helper yet (e.g. `extensions`, `diagnosis-reports`); prefer a named helper. */
export function getClientSubdir(subdir: string, xdg?: XdgCategory): string {
	return dirs.clientSubdir(subdir, xdg);
}

/** Credentials/settings database of the client (`<client dir>/agent.db`). */
export function getAgentDbPath(): string {
	return dirs.clientSubdir("agent.db", "data");
}

/** An Agent's own storage database (`<agentHome>/agent.db`) — every Agent keeps its own. */
export function getAgentStorageDbPath(agentHome: string): string {
	return path.join(agentHome, "agent.db");
}

/** Get the path to history.db (SQLite database for session history), a client-scope cache. */
export function getHistoryDbPath(): string {
	return dirs.clientSubdir("history.db", "data");
}

/** Get the path to models.db (client-scope model cache database). */
export function getModelDbPath(): string {
	return dirs.clientSubdir("models.db", "data");
}

/** Get the content-addressed blob store directory (`<client dir>/blobs`). */
export function getBlobsDir(): string {
	return dirs.clientSubdir("blobs", "data");
}

/** Get the terminal breadcrumb directory (`<client dir>/terminal-sessions`). */
export function getTerminalSessionsDir(): string {
	return dirs.clientSubdir("terminal-sessions", "state");
}

/** Get the crash log path (`<client dir>/cornfield-crash.log`). */
export function getCrashLogPath(): string {
	return dirs.clientSubdir("cornfield-crash.log", "state");
}

/** Get the debug log path (`<client dir>/cornfield-debug.log`). */
export function getDebugLogPath(): string {
	return dirs.clientSubdir(`${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Agent-scope subdirectories (<agentHome>/*)
//
// Everything here belongs to one Agent and travels with its agentDir. The default Agent's
// home is `getDefaultAgentHome()`; other Agents pass their own agentDir.
// =============================================================================

/** Get the sessions directory of an Agent (`<agentHome>/sessions`). */
export function getSessionsDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "sessions");
}

/** Get the custom themes directory of an Agent (`<agentHome>/themes`). */
export function getCustomThemesDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "themes");
}

/** Get the tools directory of an Agent (`<agentHome>/tools`). */
export function getToolsDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "tools");
}

/** Get the slash commands directory of an Agent (`<agentHome>/commands`). */
export function getCommandsDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "commands");
}

/** Get the prompts directory of an Agent (`<agentHome>/prompts`). */
export function getPromptsDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "prompts");
}

/** Get the Python modules directory of an Agent (`<agentHome>/modules`). */
export function getAgentModulesDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "modules");
}

/** Get the memories directory of an Agent (`<agentHome>/memories`). */
export function getMemoriesDir(agentHome: string = getDefaultAgentHome()): string {
	return path.join(agentHome, "memories");
}

// =============================================================================
// Project subdirectories (.cornfield/*)
// =============================================================================

/** Get the project-level Python modules directory (.cornfield/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.cornfield/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.cornfield/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). User scope is client-scope: one
 *  MCP server list for the client, shared by every Agent in the process. */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getClientDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. User scope is client-scope (same reason as MCP). */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getClientDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}
