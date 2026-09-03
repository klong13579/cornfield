import type { ConfigScopeKeyDto } from "@cornfield/wire";

/**
 * 逐键配置的展示策展（运行配置页 #05 UX 改进）：
 * - 精选高频键置顶，配中文人话标签与说明（schema 的英文 label 不满足本页中文语境）；
 * - 其余键不丢失——全部进入「高级」折叠组，展开后保持完整的三层展示与编辑能力。
 * 纯展示层策展，不改协议、不改 schema。
 */

export interface FeaturedScopeKeyMeta {
	/** 中文标签（展示为主标题，原键名以 mono 副标题保留）。 */
	label: string;
	/** 一句话说明这个键控制什么。 */
	description: string;
}

/** 置顶精选键（有序）：模型行为 / 上下文维护 / 重试回退 / 交互恢复。 */
export const FEATURED_SCOPE_KEY_ORDER = [
	"defaultThinkingLevel",
	"temperature",
	"compaction.enabled",
	"compaction.thresholdPercent",
	"compaction.strategy",
	"contextPromotion.enabled",
	"streaming.doomLoop.enabled",
	"retry.maxRetries",
	"retry.fallbackRevertPolicy",
	"followUpMode",
	"autoResume",
	"python.toolMode",
] as const;

export const FEATURED_SCOPE_KEY_META: ReadonlyMap<string, FeaturedScopeKeyMeta> = new Map([
	["defaultThinkingLevel", { label: "思考档位", description: "思考型模型的推理深度（off/min/high 等），影响回答质量与耗时" }],
	["temperature", { label: "采样温度", description: "0=稳定确定，1=更有创造性；编码任务建议低温" }],
	["compaction.enabled", { label: "自动压缩", description: "上下文过大时自动压缩历史，防止会话爆窗" }],
	["compaction.thresholdPercent", { label: "压缩触发阈值", description: "上下文占用达到窗口的百分之多少时触发压缩" }],
	["compaction.strategy", { label: "压缩策略", description: "原地压缩 / 自动交接 / 混合，决定压缩后如何延续会话" }],
	["contextPromotion.enabled", { label: "上下文自动升级", description: "上下文溢出时自动换更大窗口的模型，而不是直接报错" }],
	["streaming.doomLoop.enabled", { label: "卡死检测", description: "检测模型输出陷入重复循环并自动中断重试" }],
	["retry.maxRetries", { label: "API 重试次数", description: "接口报错时最多重试几次再放弃" }],
	["retry.fallbackRevertPolicy", { label: "回退回归策略", description: "降级到备用模型后，什么条件下切回主模型" }],
	["followUpMode", { label: "跟进模式", description: "回合结束后如何处理排队的新消息（立即追加 / 等确认等）" }],
	["autoResume", { label: "自动恢复", description: "会话中断后自动恢复执行" }],
	["python.toolMode", { label: "Python 工具模式", description: "Python 相关工具的启用方式" }],
]);

/** 按精选清单拆分：featured 保持精选顺序（schema 里不存在的键自动跳过），advanced 保持原顺序。 */
export function splitScopeKeys(keys: ConfigScopeKeyDto[]): {
	featured: ConfigScopeKeyDto[];
	advanced: ConfigScopeKeyDto[];
} {
	const byKey = new Map(keys.map(k => [k.key, k]));
	const featured: ConfigScopeKeyDto[] = [];
	for (const key of FEATURED_SCOPE_KEY_ORDER) {
		const dto = byKey.get(key);
		if (dto) {
			featured.push(dto);
			byKey.delete(key);
		}
	}
	return { featured, advanced: [...byKey.values()] };
}
