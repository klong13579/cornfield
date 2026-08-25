/**
 * get_skills / set_skill_enabled 结果形状（W3 D5 + B3）。
 */

/** 技能项（session.skills 同源；level 供分类折叠）。 */
export interface SkillDto {
	name: string;
	description: string;
	source: string;
	/** user（用户级）/ project（项目级）/ native（内置）。 */
	level: "user" | "project" | "native";
	provider: string;
}

/** 已停用技能（settings.skills.ignoredSkills 名单 + SKILL.md 元数据；回切入口）。 */
export interface DisabledSkillDto {
	name: string;
	description?: string;
}