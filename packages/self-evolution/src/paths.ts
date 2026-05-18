/**
 * Canonical filesystem layout for OMP evolution (memory + self-evolution).
 *
 * - **Project scope** (default): `<cwd>/.omp/memory`, `evolution`, `skills`
 * - **User scope** (legacy `globalStore`): `~/.omp/self-evolution` + encoded memory under agent dir
 * - **User evolution utilities**: `~/.omp/agent/evolution` (fit / cross-project; not mixed with project dirs)
 */
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getMemoriesDir, getProjectAgentDir } from "@oh-my-pi/pi-utils";

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

/** @deprecated Legacy global store at ~/.omp/self-evolution */
export function resolveLegacyGlobalEvolutionDir(): string {
	return path.join(userHomeDir(), ".omp", "self-evolution");
}

export function encodeProjectPathForLegacyMemory(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** @deprecated Legacy per-project memory under ~/.omp/agent/memories/... */
export function resolveLegacyMemoryRoot(agentDir: string, cwd: string): string {
	const agent = agentDir ?? getAgentDir();
	const encoded = encodeProjectPathForLegacyMemory(cwd);
	const flat = path.join(agent, "memories", encoded);
	const _statePath = path.join(getMemoriesDir(agentDir), encoded);
	return flat;
}

/** Prefer flat `memories/--encoded--` (older layout) over `memories/state/--encoded--`. */
export function resolveLegacyMemoryRootCandidates(agentDir: string, cwd: string): string[] {
	const encoded = encodeProjectPathForLegacyMemory(cwd);
	const agent = agentDir ?? getAgentDir();
	const flat = path.join(agent, "memories", encoded);
	const statePath = path.join(getMemoriesDir(agentDir), encoded);
	return flat === statePath ? [flat] : [flat, statePath];
}

export function resolveEvolutionPathLayout(cwd: string, globalStore?: boolean, agentDir?: string): EvolutionPathLayout {
	if (globalStore) {
		const root = resolveLegacyGlobalEvolutionDir();
		const mem = resolveLegacyMemoryRoot(agentDir ?? getAgentDir(), cwd);
		return {
			scope: "user",
			memoryDir: mem,
			evolutionDir: root,
			skillsDir: path.join(root, "skills"),
			dbPath: path.join(root, "evolution.db"),
			activityLogPath: path.join(root, "activity.log"),
		};
	}

	const evolutionDir = resolveProjectEvolutionDir(cwd);
	return {
		scope: "project",
		memoryDir: resolveProjectMemoryDir(cwd),
		evolutionDir,
		skillsDir: resolveProjectSkillsDir(cwd),
		dbPath: resolveProjectEvolutionDbPath(cwd),
		activityLogPath: path.join(evolutionDir, "activity.log"),
	};
}

/** Evolution DB + projection root (project `.omp/evolution` by default). */
export function resolveEvolutionRoot(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionPathLayout(cwd, globalStore).evolutionDir;
}

export function resolveEvolutionProjectionDir(cwd: string, globalStore?: boolean): string {
	return resolveEvolutionRoot(cwd, globalStore);
}

export function getUnifiedSkillsDir(cwd: string, globalStore = false): string {
	return resolveEvolutionPathLayout(cwd, globalStore).skillsDir;
}

export function getMemoryRoot(agentDir: string, cwd: string, options?: { globalStore?: boolean }): string {
	return resolveEvolutionPathLayout(cwd, options?.globalStore ?? false, agentDir).memoryDir;
}
