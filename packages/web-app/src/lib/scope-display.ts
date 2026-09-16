import type { Scope } from "@cornfield/wire";

/**
 * 范围 scope 的显示词 —— 全应用**唯一**一份。
 *
 * 事实来自 wire 的 `Scope`（判定规则也在 wire：`classifyScope`），这里只把三态翻成词：
 * Agent 自己的家 / 会话所在的 Project / 两者之外。技能页、Agent 详情页的技能行、
 * composer 的上下文条目徽标都从这里取词 —— 同一件事在两个屏幕上必须说同一个词，
 * 各页自己维护一套映射迟早会让同一个 scope 出现两种说法。
 */
export const SCOPE_LABELS: Record<Scope, string> = { agent: "Agent", project: "Project", global: "全局" };
