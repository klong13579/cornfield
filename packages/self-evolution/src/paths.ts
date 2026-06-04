/**
 * Canonical filesystem layout for OMP evolution (memory + self-evolution).
 *
 * All state lives under the evolution root:
 * - **User scope** (default): `~/.omp/self-evolution/{memory,skills,evolution.db}`
 * - **Project scope** (`--self-evolution-project-store`): `<cwd>/.omp/evolution/{memory,skills,evolution.db}`
 * - **User evolution utilities**: `~/.omp/agent/evolution` (fit / cross-project; not mixed with project dirs)
 */
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getMemoriesDir, getProjectAgentDir } from "@oh-my-pi/pi-utils";

/** Default: user-level `~/.omp/self-evolution` + encoded memory paths. */
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
	return path.join(agentDir ?? getAgentDir(), "evolution");
}

export function resolveProjectOmpDir(cwd: string): string {
	return getProjectAgentDir(cwd);
}

export function resolveProjectMemoryDir(cwd: string): string {
	return path.join(resolveProjectOmpDir(cwd), "memory");
}

export function resolveProjectEvolutionDir(cwd: string): string {
	return path.join(resolveProjectOmpDir(cwd), "evolution");
}

export function resolveProjectSkillsDir(cwd: string): string {
	return path.join(resolveProjectOmpDir(cwd), "skills");
}

export function resolveProjectEvolutionDbPath(cwd: string): string {
	return path.join(resolveProjectEvolutionDir(cwd), "evolution.db");
}

function userHomeDir(): string {
	const fromEnv = process.env.HOME?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : os.homedir();
}

/** Global (user-level) evolution root at `~/.omp/self-evolution`. */
export function resolveGlobalEvolutionDir(): string {
	return path.join(userHomeDir(), ".omp", "self-evolution");
}

export function resolveExternalTraceDir(): string {
	return path.join(userHomeDir(), ".omp", "traces", "external");
}

/** Encode `cwd` for per-project memory under `~/.omp/self-evolution/memory/`. */
export function encodeProjectPathForGlobalMemory(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function isSystemPath(cwd: string): boolean {
	const home = userHomeDir();
	const normalizedCwd = path.normalize(cwd);
	return (
		normalizedCwd === home ||
		normalizedCwd.startsWith(path.join(home, ".omp")) ||
		normalizedCwd === path.join(home, ".omp", "self-evolution")
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
	const agent = agentDir ?? getAgentDir();
	const encoded = encodeProjectPathForGlobalMemory(cwd);
	return path.join(agent, "memories", encoded);
}

/** Prefer flat `memories/--encoded--` over `memories/state/--encoded--` when both exist. */
export function resolveGlobalMemoryRootCandidates(agentDir: string, cwd: string): string[] {
	if (isSystemPath(cwd)) {
		return [];
	}
	const encoded = encodeProjectPathForGlobalMemory(cwd);
	const agent = agentDir ?? getAgentDir();
	const flat = path.join(agent, "memories", encoded);
	const statePath = path.join(getMemoriesDir(agentDir), encoded);
	return flat === statePath ? [flat] : [flat, statePath];
}

export function resolveEvolutionPathLayout(cwd: string, globalStore?: boolean): EvolutionPathLayout {
	if (globalStore) {
		const root = resolveGlobalEvolutionDir();
		const encoded = encodeProjectPathForGlobalMemory(cwd);
		const memoryDir = isSystemPath(cwd) ? resolveProjectMemoryDir(cwd) : path.join(root, "memory", encoded);
		return {
			scope: "user",
			memoryDir,
			evolutionDir: root,
			skillsDir: path.join(root, "skills"),
			dbPath: path.join(root, "evolution.db"),
			activityLogPath: path.join(root, "activity.log"),
		};
	}

	const evolutionDir = resolveProjectEvolutionDir(cwd);
	return {
		scope: "project",
		memoryDir: path.join(evolutionDir, "memory"),
		evolutionDir,
		skillsDir: resolveProjectSkillsDir(cwd),
		dbPath: resolveProjectEvolutionDbPath(cwd),
		activityLogPath: path.join(evolutionDir, "activity.log"),
	};
}

/** Evolution DB + projection root (user `~/.omp/self-evolution` by default). */
export function resolveEvolutionRoot(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionPathLayout(cwd, globalStore).evolutionDir;
}

export function resolveEvolutionProjectionDir(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionRoot(cwd, globalStore);
}

export function getUnifiedSkillsDir(cwd: string, globalStore = DEFAULT_EVOLUTION_GLOBAL_STORE): string {
	return resolveEvolutionPathLayout(cwd, globalStore).skillsDir;
}

export function getMemoryRoot(_agentDir: string, cwd: string, options?: { globalStore?: boolean }): string {
	return resolveEvolutionPathLayout(cwd, options?.globalStore ?? DEFAULT_EVOLUTION_GLOBAL_STORE).memoryDir;
}
