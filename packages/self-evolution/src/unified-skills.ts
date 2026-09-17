/**
 * Load skills for context injection from the canonical skills directory + SQLite.
 */
import { type UnifiedSkill, UnifiedSkillRegistry } from "@cornfield/cognitive-coordination";
import { getMemoryRoot } from "./paths";
import { ensureUnifiedSkillStorage } from "./skill-storage";
import type { SkillStore } from "./storage/types";
import type { EvolvedSkill } from "./types";

export { getUnifiedSkillsDir, resolveEvolutionRoot } from "./paths";

function evolvedSkillToUnified(skill: EvolvedSkill): UnifiedSkill {
	const confidence = (skill.qualityScore ?? 50) / 100;
	return {
		id: `evolution_extraction:${skill.name}`,
		source: "evolution_extraction",
		name: skill.name,
		content: skill.approach,
		confidenceScore: confidence,
		lastUsedAt: skill.lastUsedAt || Math.floor(Date.now() / 1000),
		version: String(skill.version),
		status: skill.deprecated ? "deprecated" : "active",
		metadata: {
			description: skill.description,
			taskPattern: skill.taskPattern,
		},
	};
}

function mergeByName(existing: UnifiedSkill, incoming: UnifiedSkill): UnifiedSkill {
	if (incoming.confidenceScore !== existing.confidenceScore) {
		return incoming.confidenceScore > existing.confidenceScore ? incoming : existing;
	}

	const sourcePriority = (s: UnifiedSkill): number => {
		switch (s.source) {
			case "evolution_extraction":
				return 2;
			case "memory_consolidation":
				return 1;
			default:
				return 0;
		}
	};

	return sourcePriority(incoming) >= sourcePriority(existing) ? incoming : existing;
}

/**
 * Load skills from ~/.cornfield/self-evolution/skills/ (single tree), then overlay SQLite.
 */
export async function loadUnifiedSkillsForInjection(
	cwd: string,
	skillStore: SkillStore,
	options?: { globalStore?: boolean; memoryKey?: string },
): Promise<UnifiedSkill[]> {
	const globalStore = options?.globalStore ?? true;
	// 这里的 memoryRoot 只是「嵌套在记忆树里的技能」的迁移来源，是**记忆**路径 ⇒ 跟记忆同一个 key
	//（缺省 = cwd：裸跑 CLI / registry agent 下两者相等，逐字节不变）。
	const memoryRoot = getMemoryRoot(options?.memoryKey ?? cwd);
	const skillsDir = await ensureUnifiedSkillStorage(cwd, memoryRoot, globalStore);

	const registry = new UnifiedSkillRegistry();
	const fromFiles = await registry.loadDir(skillsDir);

	const byName = new Map<string, UnifiedSkill>();
	for (const skill of fromFiles) {
		if (skill.status === "deprecated") continue;
		byName.set(skill.name, skill);
	}

	const dbSkills = await skillStore.list({ deprecated: false });
	for (const skill of dbSkills) {
		const unified = evolvedSkillToUnified(skill);
		const existing = byName.get(skill.name);
		byName.set(skill.name, existing ? mergeByName(existing, unified) : unified);
	}

	return [...byName.values()];
}
