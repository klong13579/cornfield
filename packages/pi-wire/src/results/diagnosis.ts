/**
 * 会话诊断结果形状 —— serve 端诊断 runner 的数据面（前端消费契约）。
 *
 * 诊断产物两个文件（同一 reportId 前缀）：
 * - `<reportId>.md` —— orchestrator skill 生成的完整 markdown 报告（人读）
 * - `<reportId>.summary.json` —— 结构化摘要（机器读，前端摘要卡/维度详情渲染）
 */

/** 诊断故障等级（P0 阻断 / P1 严重 / P2 轻微 / P3 优化）。 */
export type DiagnosisSeverityDto = "P0" | "P1" | "P2" | "P3";

/** 维度判定状态。 */
export type DiagnosisDimStateDto = "ok" | "warn" | "fail";

/** 维度内部的一条指标明细（token 统计 / 工具调用清单等维度特有数据）。 */
export interface DiagnosisDimRowDto {
	label: string;
	value: string;
}

/** 维度内部的一条证据片段（绑定轮次 + 原始日志引用）。 */
export interface DiagnosisDimEvidenceDto {
	turn: number;
	kind: string;
	quote: string;
}

/** 单个维度的判定详情（详情页点击展开的内容）。 */
export interface DiagnosisDimDetailDto {
	state: DiagnosisDimStateDto;
	/** 一句话结论。 */
	summary: string;
	/** 判定依据：为什么判 fail/warn/ok（量化理由，引用阈值或对比）。 */
	basis: string;
	/** 关键指标明细（可选，维度特有结构化数据）。 */
	rows?: DiagnosisDimRowDto[];
	/** 证据片段（绑定轮次）。 */
	evidence: DiagnosisDimEvidenceDto[];
	/** 修复建议。 */
	fix: string;
}

/** 结构化诊断摘要（<reportId>.summary.json 内容；list/get 返回）。 */
export interface DiagnosisSummaryDto {
	/** 报告 id（文件名去扩展名，如 `s1_20260901-091812`）。 */
	reportId: string;
	/** 被诊断会话 id（session header id）。 */
	sessionId: string;
	/** 被诊断会话文件绝对路径。 */
	sessionFile: string;
	severity: DiagnosisSeverityDto;
	delivery: "A" | "B" | "C" | "D" | "F";
	process: "A" | "B" | "C" | "D" | "F";
	/** 一句话问题标题。 */
	title: string;
	/** 根因 + 因果链叙述。 */
	rootCause: string;
	/** Top 2 可执行后续。 */
	topActions: [string, string];
	/** 六维度判定 key → 详情。 */
	dimensions: Record<string, DiagnosisDimDetailDto>;
	/** 诊断完成时间（ISO）。 */
	reportAt: string;
}

/** list_diagnosis_reports 的列表条目（轻量，不带 dimensions 全文）。 */
export interface DiagnosisReportListItemDto {
	reportId: string;
	sessionId: string;
	sessionFile: string;
	severity: DiagnosisSeverityDto;
	delivery: "A" | "B" | "C" | "D" | "F";
	process: "A" | "B" | "C" | "D" | "F";
	title: string;
	reportAt: string;
	/** 完整 markdown 报告文件路径。 */
	reportPath: string;
	/** 摘要文件是否完整可读（true = 结构化渲染；false = 仅有 markdown）。 */
	hasSummary: boolean;
}

/** 诊断进行中/失败的任务状态（前端轮询诊断按钮用）。 */
export interface DiagnosisTaskStateDto {
	sessionFile: string;
	state: "idle" | "running" | "done" | "failed";
	reportId?: string;
	error?: string;
	startedAt?: string;
}