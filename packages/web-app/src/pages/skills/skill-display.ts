import type {
	EvolvedSkillDto,
	EvolvedSkillsDto,
	SkillActivation,
	SkillBlockedDto,
	SkillScopeRowDto,
	SkillStatus,
} from "@cornfield/wire";

/**
 * 技能展示词表 —— 「技能」页与 Agent 详情页唯一的定义处。
 *
 * 事实全部来自 serve get_skills（@cornfield/wire 的 SkillScopeRowDto）：范围 scope / 激活态 activation /
 * 状态 status / 版本（声明 + 内容指纹）。前端只把事实翻成显示词，不重算事实，也不各自维护一套映射。
 *
 * 第二条事实源是 **get_evolved_skills**（演化系统的产出，见 {@link evolvedGroupState}）——
 * 它与 get_skills 是两件事，各有各的词，不合并成一张表。
 *
 * 域里**没有**的事实不得在这里出现：技能域没有「权限」，也没有一个叫「冲突状态」的状态 ——
 * 同名落选者只有 serve 给的原因（{@link skillBlockedDetail}）与覆盖规则（{@link SKILL_OVERRIDE_RULE}）。
 *
 * scope 的词不在这里：范围不是技能专有的事实（composer 的上下文条目也说同一种范围），
 * 词表在 `lib/scope-display.ts`，两处共用一份。
 */

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

/**
 * 一行技能「为什么是现在这个样子」的原文（serve 说的事实，前端不改写一个字）。
 *
 * 有值就必须显示出来 —— 停用来源（`settings.skills.ignoredSkills` / `settings.disabledExtensions`）
 * 与「磁盘上找不到它的 SKILL.md」都只在这一栏里，折叠掉就等于把 `unavailable` 与 `disabled`
 * 又合并了回去（那正是这两个状态当初被拆开的原因）。
 *
 * 空白串按「没有原因」处理：渲染一个空白栏是视觉噪声，不是事实。
 */
export function skillReasonText(row: SkillScopeRowDto): string | null {
	const reason = row.reason?.trim();
	return reason && reason.length > 0 ? reason : null;
}

/**
 * 同名技能的**覆盖规则**（唯一表述）—— 发现阶段同名时谁生效、谁落选。
 *
 * 来自 `loadSkills`：`skillMap` 先到先得，后到的同名条目只记一条 `name collision` 警告后跳过
 * （见 `extensibility/skills.ts`）；条目本身按 provider 优先级排序（`loadCapability` 去重时
 * 也是第一个赢）。所以落选者不是「坏掉的技能」，是**没轮到它**。
 */
export const SKILL_OVERRIDE_RULE = "同名技能先到者生效：发现阶段按来源优先级取第一个加载，后到的同名技能一律不加载。";

/**
 * 一条受阻技能的原文事实（路径 + serve 给的原因），不改写、不摘要。
 *
 * 原因里带着**胜出者**的 SKILL.md 路径（`already loaded from <path>`），那是这条技能为什么
 * 落选的唯一证据 —— 前端从英文句子里解析它是脆的，原样显示才是准的。
 */
export function skillBlockedDetail(blocked: SkillBlockedDto): string {
	return `${blocked.path} —— ${blocked.reason}`;
}

/** 毫秒时间戳 → 本地日期；缺省 / 0 / 非法值 = null（不把 0 渲染成 1970-01-01）。 */
export function skillDayText(ts: number | undefined): string | null {
	if (ts === undefined || ts <= 0) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────
// 演化技能（get_evolved_skills）：与上面那套磁盘技能是两条命令、两套事实
// ─────────────────────────────────────────────────────────────────────

/**
 * 演化技能分组的五态。
 *
 * 分成一个和类型而不是「一个数组 + 一个 error 字段」，是因为**读失败与空集必须长得不一样** ——
 * `[]` 只表示「库读到了，里面确实一条技能都没有」（含「库文件还没生成」）。若把读失败也落进
 * 空态，页面会显示「还没演化出技能」这个相反的结论（{@link EvolvedSkillsDto} 的注释里写明了
 * 这条边界）。类型上分开，调用方就没法把它们渲染成同一件事。
 *
 * `degraded` 是降级通道：清单有效，但有一项事实没读全（个别行 JSON 列坏了）。它**不是**失败，
 * 也不许被吞掉 —— 吞掉就是把一份残清单冒充成完整的。
 */
export type EvolvedGroupState =
	| { kind: "disconnected" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "empty"; degraded?: string }
	| { kind: "rows"; rows: EvolvedSkillDto[]; degraded?: string };

/**
 * 由「连接态 + 读到的东西 + 错误」定出分组该显示什么。
 *
 * 判决顺序即优先级，也是这份函数的全部价值：
 *   未连接 → 连接态说了算（没有命令可发）
 *   有错误 → **错误**（绝不落进空态；读失败不是「没有技能」）
 *   无数据 → 正在读（还没回来 ≠ 空）
 *   else   → 空集或清单，各自带上降级原因
 */
export function evolvedGroupState(input: {
	connected: boolean;
	dto: EvolvedSkillsDto | null;
	error: string | null;
}): EvolvedGroupState {
	if (!input.connected) return { kind: "disconnected" };
	if (input.error) return { kind: "error", message: input.error };
	const dto = input.dto;
	if (!dto) return { kind: "loading" };
	const degraded = dto.error;
	if (dto.skills.length === 0) return degraded ? { kind: "empty", degraded } : { kind: "empty" };
	return degraded ? { kind: "rows", rows: dto.skills, degraded } : { kind: "rows", rows: dto.skills };
}

/** 质量分（0-100）：从未评分 = null。`0` 是一个真实分数，与「没评过」不是一件事。 */
export function evolvedQualityText(skill: EvolvedSkillDto): string | null {
	return skill.qualityScore === undefined ? null : `质量 ${skill.qualityScore}/100`;
}

/** 使用统计：一次没用过就说没用过，不摆一排 0（0 次成功不代表失败）。 */
export function evolvedUsageText(skill: EvolvedSkillDto): string {
	if (skill.usageCount <= 0) return "从未使用";
	return `用过 ${skill.usageCount} 次 · 成功 ${skill.successCount} / 失败 ${skill.failureCount}`;
}

/**
 * 废弃三态 —— `false`（明确未废弃）与 `undefined`（没有这个事实）不是一件事。
 *
 * `EvolvedSkillDto.deprecated` 的注释写明了这条：`undefined` = 没记过，**不是**「未废弃」的
 * 另一种写法。当前 serve 侧的行映射把非空列统一成布尔，所以 `undefined` 今天出自别处；
 * 但把它渲染成「在用」就是在替一个没有记录的事实发言。
 */
export function evolvedDeprecationText(skill: EvolvedSkillDto): string {
	if (skill.deprecated === true) {
		return skill.deprecationReason ? `已废弃：${skill.deprecationReason}` : "已废弃";
	}
	if (skill.deprecated === false) return "在用";
	return "废弃状态无记录";
}

/** 人工评分（1-5 星）：没评过 = null（不编 0 星）。 */
export function evolvedRatingText(skill: EvolvedSkillDto): string | null {
	return skill.userRating === undefined ? null : `人工评分 ${skill.userRating}/5`;
}

/** 演化库里的整数版本（`skills.version`），与 frontmatter 声明的版本不是一回事。 */
export function evolvedVersionText(skill: EvolvedSkillDto): string {
	return `v${skill.version}`;
}
