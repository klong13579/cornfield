/**
 * 六维诊断共享常量 —— RecordsView 大盘与维度聚合页共用，避免 label/order 双份漂移。
 */

export const DIMENSION_ORDER = ["meta", "performance", "intent", "reasoning", "tool", "output"] as const;

export type DimensionKey = (typeof DIMENSION_ORDER)[number];

export const DIMENSION_LABELS: Record<string, string> = {
	meta: "元数据",
	performance: "性能",
	intent: "意图",
	reasoning: "推理",
	tool: "工具",
	output: "输出",
};

/** 维度判定状态 → 语义文案。 */
export const DIM_STATE_LABELS: Record<"ok" | "warn" | "fail", string> = {
	ok: "正常",
	warn: "警告",
	fail: "失败",
};

/** 维度判定状态 → badge class。 */
export const DIM_STATE_BADGE: Record<"ok" | "warn" | "fail", string> = {
	ok: "badge done",
	warn: "badge run",
	fail: "badge fail",
};

/** 维度判定状态 → 文字色 class。 */
export const DIM_STATE_TEXT: Record<"ok" | "warn" | "fail", string> = {
	ok: "text-success",
	warn: "text-warning",
	fail: "text-danger",
};

export function dimensionLabel(key: string): string {
	return DIMENSION_LABELS[key] ?? key;
}
