/**
 * Canonical filesystem layout for OMP evolution (memory + self-evolution).
 *
 * All state lives under the evolution root:
 * - **User scope** (default): `~/.cornfield/self-evolution/{memory,skills,evolution.db}`
 * - **Project scope** (`--self-evolution-project-store`): `<cwd>/.cornfield/evolution/{memory,skills,evolution.db}`
 * - **User evolution utilities**: `~/.cornfield/agent/evolution` (fit / cross-project; not mixed with project dirs)
 *
 * **两把 key（票 27，用户裁定）**：记忆跟 Agent 走、演化数据跟项目走。它们以前共用同一个 `cwd` 参数，
 * 在 default Agent 跑 serve 时会分叉（会话在一个仓库里干活，配置项目根却是它的家）：
 *   - `memoryKey` → 只决定 `memoryDir`（记忆目录）：**配置/记忆的项目根**（`Settings#getCwd()`）
 *   - `evolutionKey` → 决定 `evolutionDir` / `skillsDir` / `dbPath` / `activityLogPath`（以及项目布局下
 *     这些路径的根）：今天的语义 = 会话 cwd
 * 缺省 `memoryKey = evolutionKey`，所以裸跑 CLI 与 registry agent（两者相等）逐字节不变。
 *
 * 数据不迁（用户裁定：未来重构整个记忆系统）—— 换 key 之后旧 key 下的记忆不再被读，
 * 也不存在「两边都读」的兼容层。
 */
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirName, getDefaultAgentHome, getMemoriesDir, getProjectAgentDir } from "@cornfield/utils";

/** Default: user-level `~/.cornfield/self-evolution` + encoded memory paths. */
export const DEFAULT_EVOLUTION_GLOBAL_STORE = true;

export function resolveGlobalStoreFromFlag(getFlag: (name: string) => boolean | string | undefined): boolean {
	if (getFlag("self-evolution-project-store") === true) {
		return false;
	}
	return getFlag("self-evolution-global-store") !== false;
}

export type EvolutionPathScope = "project" | "user";

export interface EvolutionPathLayout {
	scope: EvolutionPathScope;
	memoryDir: string;
	evolutionDir: string;
	skillsDir: string;
	dbPath: string;
	activityLogPath: string;
}

/** User-level evolution dir (cross-project utilities only; not project MEMORY). */
export function resolveUserEvolutionDir(agentDir?: string): string {
	return path.join(agentDir ?? getDefaultAgentHome(), "evolution");
}

export function resolveProjectConfigDir(cwd: string): string {
	return getProjectAgentDir(cwd);
}

export function resolveProjectMemoryDir(cwd: string): string {
	return path.join(resolveProjectConfigDir(cwd), "memory");
}

export function resolveProjectEvolutionDir(cwd: string): string {
	return path.join(resolveProjectConfigDir(cwd), "evolution");
}

export function resolveProjectSkillsDir(cwd: string): string {
	return path.join(resolveProjectConfigDir(cwd), "skills");
}

export function resolveProjectEvolutionDbPath(cwd: string): string {
	return path.join(resolveProjectEvolutionDir(cwd), "evolution.db");
}

function userHomeDir(): string {
	const fromEnv = process.env.HOME?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : os.homedir();
}

/** Global (user-level) evolution root at `~/.cornfield/self-evolution`. */
export function resolveGlobalEvolutionDir(): string {
	return path.join(userHomeDir(), getConfigDirName(), "self-evolution");
}

export function resolveExternalTraceDir(): string {
	return path.join(userHomeDir(), getConfigDirName(), "traces", "external");
}

/** Encode `cwd` for per-project memory under `~/.cornfield/self-evolution/memory/`. */
export function encodeProjectPathForGlobalMemory(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function isSystemPath(cwd: string): boolean {
	const home = userHomeDir();
	const normalizedCwd = path.normalize(cwd);
	return (
		normalizedCwd === home ||
		normalizedCwd.startsWith(path.join(home, getConfigDirName())) ||
		normalizedCwd === path.join(home, getConfigDirName(), "self-evolution")
	);
}

/**
 * Global-store memory root: encoded path under agent `memories/`.
 * Returns undefined for system paths that should not have per-project memory.
 */
export function resolveGlobalMemoryRoot(agentDir: string, cwd: string): string | undefined {
	if (isSystemPath(cwd)) {
		return undefined;
	}
	const agent = agentDir ?? getDefaultAgentHome();
	const encoded = encodeProjectPathForGlobalMemory(cwd);
	return path.join(agent, "memories", encoded);
}

/** Prefer flat `memories/--encoded--` over `memories/state/--encoded--` when both exist. */
export function resolveGlobalMemoryRootCandidates(agentDir: string, cwd: string): string[] {
	if (isSystemPath(cwd)) {
		return [];
	}
	const encoded = encodeProjectPathForGlobalMemory(cwd);
	const agent = agentDir ?? getDefaultAgentHome();
	const flat = path.join(agent, "memories", encoded);
	const statePath = path.join(getMemoriesDir(agentDir), encoded);
	return flat === statePath ? [flat] : [flat, statePath];
}

export function resolveEvolutionPathLayout(
	evolutionKey: string,
	globalStore?: boolean,
	memoryKey: string = evolutionKey,
): EvolutionPathLayout {
	if (globalStore) {
		const root = resolveGlobalEvolutionDir();
		// memoryDir 只由 memoryKey 算（含系统路径那条分支）；其余四项都在 root 下、与 key 无关。
		const memoryDir = isSystemPath(memoryKey)
			? resolveProjectMemoryDir(memoryKey)
			: path.join(root, "memory", encodeProjectPathForGlobalMemory(memoryKey));
		return {
			scope: "user",
			memoryDir,
			evolutionDir: root,
			skillsDir: path.join(root, "skills"),
			dbPath: path.join(root, "evolution.db"),
			activityLogPath: path.join(root, "activity.log"),
		};
	}

	const evolutionDir = resolveProjectEvolutionDir(evolutionKey);
	return {
		scope: "project",
		// 项目布局的**形状**不变（`…/evolution/memory`），只是按 memoryKey 定位：两个 key 相等时与今天逐字节相同。
		memoryDir: path.join(resolveProjectEvolutionDir(memoryKey), "memory"),
		evolutionDir,
		skillsDir: resolveProjectSkillsDir(evolutionKey),
		dbPath: resolveProjectEvolutionDbPath(evolutionKey),
		activityLogPath: path.join(evolutionDir, "activity.log"),
	};
}

/** Evolution DB + projection root (user `~/.cornfield/self-evolution` by default). */
export function resolveEvolutionRoot(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionPathLayout(cwd, globalStore).evolutionDir;
}

export function resolveEvolutionProjectionDir(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionRoot(cwd, globalStore);
}

export function getUnifiedSkillsDir(cwd: string, globalStore = DEFAULT_EVOLUTION_GLOBAL_STORE): string {
	return resolveEvolutionPathLayout(cwd, globalStore).skillsDir;
}

/**
 * 记忆目录的根（`memoryDir`）—— 只由 **memoryKey**（配置/记忆的项目根）派生。
 *
 * 旧签名是 `getMemoryRoot(agentDir, cwd, options)`，第一个参数从来没被用过（`_agentDir`）：记忆根与
 * agentDir 无关、与「拿哪个目录当 key」有关。说谎的那一半已删（票 27）——agent 级布局
 * （`<agentDir>/memories/<encoded>`）仍由 `resolveGlobalMemoryRoot*` 提供，那两个函数的 agentDir 是真用的。
 */
export function getMemoryRoot(memoryKey: string, options?: { globalStore?: boolean }): string {
	const globalStore = options?.globalStore ?? DEFAULT_EVOLUTION_GLOBAL_STORE;
	return resolveEvolutionPathLayout(memoryKey, globalStore, memoryKey).memoryDir;
}
