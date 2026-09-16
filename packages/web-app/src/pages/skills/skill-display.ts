import type { SkillActivation, SkillScope, SkillScopeRowDto, SkillStatus } from "@cornfield/wire";

/**
 * 技能展示词表 —— 「技能」页与 Agent 详情页唯一的定义处。
 *
 * 事实全部来自 serve get_skills（@cornfield/wire 的 SkillScopeRowDto）：范围 scope / 激活态 activation /
 * 状态 status / 版本（声明 + 内容指纹）。前端只把事实翻成显示词，不重算事实，也不各自维护一套映射。
 */

/** 范围 scope：Agent 自己的家 / 会话所在的 Project / 两者之外（全局用户库等发现源）。 */
export const SKILL_SCOPE_LABELS: Record<SkillScope, string> = { agent: "Agent", project: "Project", global: "全局" };

/** 激活态 activation：进没进这次会话。 */
export const SKILL_ACTIVATION_LABELS: Record<SkillActivation, string> = {
	loaded: "已加载",
	discoverable: "可发现",
	blocked: "受阻",
};

/** 状态 status：可用 / 被 settings 停用 / 已标记废弃 / 文件读不到。 */
export const SKILL_STATUS_LABELS: Record<SkillStatus, string> = {
	enabled: "启用",
	disabled: "停用",
	deprecated: "废弃",
	unavailable: "读不到",
};

/** 版本显示：声明优先，否则内容指纹（把「没声明」说清，不把指纹冒充成版本号）。 */
export function skillVersionText(row: SkillScopeRowDto): string {
	if (row.version) return `v${row.version}`;
	if (row.fingerprint) return `指纹 ${row.fingerprint}`;
	return "版本未知";
}

/** 状态徽标配色（读不到与「停用」不是一件事，颜色也不同）。 */
export function skillStatusClass(status: SkillStatus): string {
	if (status === "unavailable") return "bg-danger/10 text-danger";
	if (status === "deprecated") return "bg-surface-2 text-ink-faint line-through";
	if (status === "disabled") return "bg-surface-2 text-ink-faint";
	return "bg-success/10 text-success";
}
