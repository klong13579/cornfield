/**
 * `get_evolved_skills` 的 serve 侧投影 —— `evolution.db` 里 `skills` 表的**只读**读面。
 *
 * 与 `get_skills` 是两件事，不合并：那个答「这次会话加载了哪些技能」（磁盘发现 + 启用/停用），
 * 这个答「演化系统沉淀了哪些技能」（提炼、评分、使用统计）。同名不同源的两行可以同时存在。
 *
 * ## 权威不在本模块
 *
 * 行形状、SQL、JSON 列的读法都在 `@cornfield/self-evolution/storage/skills`（写它的人也是
 * 读它的那一份实现）；本模块只做三件它不该管的事：**库在哪**、**按什么错误语义答**、
 * **投影成 wire 形状**。所以这里不写第二条 SQL、不另写一套 row→对象映射 —— 那会让「技能页
 * 显示的」与「进化系统自己用的」变成两个可以各自漂移的答案。
 *
 * ## 不建库
 *
 * 用 `openEvolutionDbReadOnly`（只读连接，不 mkdir、不建表、不迁移）。用 `getEvolutionDb`
 * 会把「还没演化过」变成一个刚建的空库，然后答「有库、没有技能」——那是编出来的。
 *
 * ## 失败模型（本模块存在的另一半理由）
 *
 * - **库文件不在** → `{ skills: [] }`：明确的空集（还没生成），不是错误；
 * - **库在但读不出来**（不是库 / 表结构不对 / 权限）→ **抛**，命令回 `ok:false`；
 * - **读到了但有个别行没读全**（JSON 列坏了）→ 正常返回 + `error`。
 *
 * 空数组只用来表示第一种。把第二、三种退化成它，技能页会把「读不出来」显示成「还没演化出技能」。
 */

import { resolveMemoryDbPath } from "@cornfield/self-evolution/memory/storage";
import { openEvolutionDbReadOnly } from "@cornfield/self-evolution/storage/db";
import { buildSkillListSql, projectSkillRows, type RawSkillRow } from "@cornfield/self-evolution/storage/skills";
import type { EvolvedSkill } from "@cornfield/self-evolution/types";
import type { EvolvedSkillDto, EvolvedSkillsDto } from "@cornfield/wire";

/**
 * 读演化技能清单。
 *
 * `sessionCwd` 只用来解析库路径（与 `get_memory` 同一条解析规则，两个页面读同一个库）；当前
 * 全局库模式下它不改变路径，但按解析器给的 cwd 算，将来切到项目库时这里不用改。
 */
export async function readEvolvedSkills(sessionCwd: string): Promise<EvolvedSkillsDto> {
	const db = await openEvolutionDbReadOnly(resolveMemoryDbPath(sessionCwd));
	if (!db) return { skills: [] };
	try {
		// 表不在 / 不是库 → 这里抛，由命令回 ok:false（不当成空清单）。
		const rows = db.prepare(buildSkillListSql()).all() as RawSkillRow[];
		const projection = projectSkillRows(rows);
		const dto: EvolvedSkillsDto = { skills: projection.skills.map(toEvolvedSkillDto) };
		if (projection.degradations.length > 0) {
			dto.error = `${projection.degradations.length} 条演化技能没读全：${projection.degradations.join("；")}`;
		}
		return dto;
	} finally {
		db.close();
	}
}

/**
 * 逐字段投影，不 spread。
 *
 * `EvolvedSkill` 上有一个 `optimizationCount`，但它**没有进 `skills` 表**（写入语句与行映射
 * 都不含它），spread 会把它一并带出去，让「从没优化过」与「没记录」在客户端长得一样。字段逐个
 * 列出来的另一个好处：DTO 与实体将来各自变动时，这里是编译器会拦住的那个点。
 */
function toEvolvedSkillDto(skill: EvolvedSkill): EvolvedSkillDto {
	const dto: EvolvedSkillDto = {
		name: skill.name,
		description: skill.description,
		taskPattern: skill.taskPattern,
		approach: skill.approach,
		tools: skill.tools,
		pitfalls: skill.pitfalls,
		createdAt: skill.createdAt,
		usageCount: skill.usageCount,
		lastUsedAt: skill.lastUsedAt,
		successCount: skill.successCount,
		failureCount: skill.failureCount,
		version: skill.version,
	};
	// 可选字段只在真有值时出现：缺省是「没记过」，不是「零 / 空」。
	if (skill.qualityScore !== undefined) dto.qualityScore = skill.qualityScore;
	if (skill.optimizedPrompt !== undefined) dto.optimizedPrompt = skill.optimizedPrompt;
	if (skill.deprecated !== undefined) dto.deprecated = skill.deprecated;
	if (skill.deprecationReason !== undefined) dto.deprecationReason = skill.deprecationReason;
	if (skill.autonomyNotes !== undefined) dto.autonomyNotes = skill.autonomyNotes;
	if (skill.lastOptimizedAt !== undefined) dto.lastOptimizedAt = skill.lastOptimizedAt;
	if (skill.userRating !== undefined) dto.userRating = skill.userRating;
	return dto;
}
