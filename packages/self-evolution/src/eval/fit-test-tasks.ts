/**
 * 「懂我程度」测试数据集 — 覆盖 5 大维度，共 20 个测试任务。
 */

export interface FitTestTask {
	id: string;
	dimension: FitDimension;
	weight: number;
	prompt: string;
	userContext?: string;
	expectedBehavior: {
		mustInclude: string[];
		mustNotInclude: string[];
		styleRequirements: string[];
	};
	scoring: {
		criteria: string[];
		rubric: string;
	};
}

export type FitDimension = "memory" | "thinking" | "style" | "prediction" | "history";

export const FIT_TEST_TASKS: FitTestTask[] = [
	// ─── Dimension 1: 个人记忆留存 (25 pts) ───
	{
		id: "MEMORY-001",
		dimension: "memory",
		weight: 5,
		prompt: "我的技术栈是什么？",
		expectedBehavior: {
			mustInclude: ["具体技术/框架名称"],
			mustNotInclude: ["通用性回答如'常用技术栈有'"],
			styleRequirements: ["直接给出技术栈，不加废话开头"],
		},
		scoring: {
			criteria: ["是否给出具体技术栈而非通用回答", "准确性", "是否无需用户重复介绍"],
			rubric:
				"21-25: 完整记住职业、技术栈、业务方向；16-20: 记住大部分核心信息；11-15: 只记得基础人设；6-10: 零星信息；0-5: 完全没记忆",
		},
	},
	{
		id: "MEMORY-002",
		dimension: "memory",
		weight: 5,
		prompt: "我关注哪些业务方向？",
		expectedBehavior: {
			mustInclude: ["具体业务/赛道名称"],
			mustNotInclude: ["通用性回答如'通常关注的方向有'"],
			styleRequirements: ["分点列出，结论前置"],
		},
		scoring: {
			criteria: ["是否列出具体业务方向", "是否贴合实际关注点", "是否结构化输出"],
			rubric: "同上",
		},
	},
	{
		id: "MEMORY-003",
		dimension: "memory",
		weight: 5,
		prompt: "我做事的风格偏好是什么？",
		expectedBehavior: {
			mustInclude: ["风格关键词（如精简、结论前置、架构先行）"],
			mustNotInclude: ["通用性格描述"],
			styleRequirements: ["精简、分点"],
		},
		scoring: {
			criteria: ["是否准确描述做事风格", "是否避免泛泛而谈", "回答本身体现该风格"],
			rubric: "同上",
		},
	},
	{
		id: "MEMORY-004",
		dimension: "memory",
		weight: 5,
		prompt: "我之前做过的核心项目有哪些？",
		expectedBehavior: {
			mustInclude: ["具体项目/产品名称"],
			mustNotInclude: ["'你没有提过项目'（如果 persona 中已有）"],
			styleRequirements: ["列表式"],
		},
		scoring: {
			criteria: ["是否记住历史项目", "描述是否准确"],
			rubric: "同上",
		},
	},
	{
		id: "MEMORY-005",
		dimension: "memory",
		weight: 5,
		prompt: "我对资产和投资有什么关注点？",
		expectedBehavior: {
			mustInclude: ["具体关注领域"],
			mustNotInclude: ["理财通用建议"],
			styleRequirements: ["结论前置，不堆砌"],
		},
		scoring: {
			criteria: ["是否准确反映关注点", "是否避免通用理财建议"],
			rubric: "同上",
		},
	},

	// ─── Dimension 2: 思维模式适配 (25 pts) ───
	{
		id: "THINK-001",
		dimension: "thinking",
		weight: 5,
		prompt: "我想做一个自动化报表系统，帮我想想方案",
		expectedBehavior: {
			mustInclude: ["架构分层（数据源/处理/展示）", "模块拆分", "落地路径"],
			mustNotInclude: ["直接跳进代码实现", "单一方案无对比"],
			styleRequirements: ["先给整体框架，再展开细节"],
		},
		scoring: {
			criteria: ["是否主动拆架构", "是否分层设计", "是否给落地路径", "是否有利弊对比"],
			rubric:
				"21-25: 自动匹配思维，主动给架构、分模块、利弊、落地路径；16-20: 大体匹配，需轻微提醒；11-15: 常规回答；6-10: 逻辑散乱；0-5: 完全跑偏",
		},
	},
	{
		id: "THINK-002",
		dimension: "thinking",
		weight: 5,
		prompt: "这个方案有什么风险",
		expectedBehavior: {
			mustInclude: ["风险分类（技术/业务/运维）", "缓解措施"],
			mustNotInclude: ["只说'有好处也有风险'的废话"],
			styleRequirements: ["分点、表格或结构化输出"],
		},
		scoring: {
			criteria: ["是否分类风险", "是否给缓解方案", "是否结构化"],
			rubric: "同上",
		},
	},
	{
		id: "THINK-003",
		dimension: "thinking",
		weight: 5,
		prompt: "方案A和方案B对比一下",
		expectedBehavior: {
			mustInclude: ["对比维度（成本/效率/维护/扩展）", "推荐结论"],
			mustNotInclude: ["'各有利弊'无实质对比"],
			styleRequirements: ["表格或分点对比", "结论前置"],
		},
		scoring: {
			criteria: ["是否给多维度对比", "是否给明确推荐", "是否表格化"],
			rubric: "同上",
		},
	},
	{
		id: "THINK-004",
		dimension: "thinking",
		weight: 5,
		prompt: "帮我优化一下现有系统的性能",
		expectedBehavior: {
			mustInclude: ["优化层次（架构/算法/缓存/IO）", "量化指标"],
			mustNotInclude: ["通用优化建议如'减少数据库查询'"],
			styleRequirements: ["分层拆解，给优先级"],
		},
		scoring: {
			criteria: ["是否分层拆解优化点", "是否给优先级排序", "是否量化"],
			rubric: "同上",
		},
	},
	{
		id: "THINK-005",
		dimension: "thinking",
		weight: 5,
		prompt: "我想重构一个老项目，怎么规划",
		expectedBehavior: {
			mustInclude: ["阶段规划", "风险缓解", "回退方案"],
			mustNotInclude: ["直接给技术选型"],
			styleRequirements: ["先框架后细节"],
		},
		scoring: {
			criteria: ["是否给阶段规划", "是否考虑风险和回退", "是否框架先行"],
			rubric: "同上",
		},
	},

	// ─── Dimension 3: 输出风格贴合 (20 pts) ───
	{
		id: "STYLE-001",
		dimension: "style",
		weight: 5,
		prompt: "帮我看看这个方案",
		expectedBehavior: {
			mustInclude: ["直接结论"],
			mustNotInclude: ["'让我来帮你分析'类废话开头", "大段铺垫"],
			styleRequirements: ["结论前置，精简"],
		},
		scoring: {
			criteria: ["是否结论前置", "是否有废话开头", "是否精简"],
			rubric: "17-20: 极简、结论前置、条理清晰；13-16: 风格接近，偶尔啰嗦；9-12: 中规中矩；5-8: 冗长；0-4: 文风杂乱",
		},
	},
	{
		id: "STYLE-002",
		dimension: "style",
		weight: 5,
		prompt: "总结一下今天的工作",
		expectedBehavior: {
			mustInclude: ["分点短句"],
			mustNotInclude: ["大段落", "形容词堆砌"],
			styleRequirements: ["短句、分点、无废话"],
		},
		scoring: {
			criteria: ["是否分点短句", "是否无废话", "是否简洁"],
			rubric: "同上",
		},
	},
	{
		id: "STYLE-003",
		dimension: "style",
		weight: 5,
		prompt: "这个 bug 怎么修",
		expectedBehavior: {
			mustInclude: ["修复步骤"],
			mustNotInclude: ["先解释 bug 原理", "长篇大论"],
			styleRequirements: ["直接给修复方案，不铺垫"],
		},
		scoring: {
			criteria: ["是否直接给方案", "是否不铺垫", "是否步骤清晰"],
			rubric: "同上",
		},
	},
	{
		id: "STYLE-004",
		dimension: "style",
		weight: 5,
		prompt: "写一个技术方案文档",
		expectedBehavior: {
			mustInclude: ["结构化大纲"],
			mustNotInclude: ["散文式写作", "无层级"],
			styleRequirements: ["大纲先行，层级分明"],
		},
		scoring: {
			criteria: ["是否结构化大纲", "是否层级分明", "是否条理清晰"],
			rubric: "同上",
		},
	},

	// ─── Dimension 4: 隐含需求预判 (15 pts) ───
	{
		id: "PREDICT-001",
		dimension: "prediction",
		weight: 5,
		prompt: "我想优化一下性能",
		expectedBehavior: {
			mustInclude: ["主动追问（哪个模块/什么指标/当前瓶颈）", "预判性建议"],
			mustNotInclude: ["只给通用优化清单"],
			styleRequirements: ["先问关键问题，再给框架"],
		},
		scoring: {
			criteria: ["是否主动追问关键上下文", "是否给预判性建议", "是否超出字面需求"],
			rubric:
				"13-15: 精准补全真实需求，主动给超出预期的方案；10-12: 预判大部分隐含需求；7-9: 只听懂字面；4-6: 理解片面；0-3: 完全不懂言外之意",
		},
	},
	{
		id: "PREDICT-002",
		dimension: "prediction",
		weight: 5,
		prompt: "这个方案有什么风险",
		expectedBehavior: {
			mustInclude: ["风险清单", "缓解方案", "影响程度评估"],
			mustNotInclude: ["只列风险不给缓解"],
			styleRequirements: ["结构化风险矩阵"],
		},
		scoring: {
			criteria: ["是否主动给缓解方案", "是否评估影响程度", "是否结构化"],
			rubric: "同上",
		},
	},
	{
		id: "PREDICT-003",
		dimension: "prediction",
		weight: 5,
		prompt: "帮我看看代码有没有问题",
		expectedBehavior: {
			mustInclude: ["安全检查", "边界条件", "性能隐患"],
			mustNotInclude: ["只看语法错误"],
			styleRequirements: ["分类列出问题，按严重度排序"],
		},
		scoring: {
			criteria: ["是否多维度审查", "是否按严重度排序", "是否给修复建议"],
			rubric: "同上",
		},
	},

	// ─── Dimension 5: 历史对话联动 (15 pts) ───
	{
		id: "HISTORY-001",
		dimension: "history",
		weight: 5,
		prompt: "上次说的那个方案怎么样了？",
		expectedBehavior: {
			mustInclude: ["关联到具体历史话题", "给出当前状态"],
			mustNotInclude: ["'你指的是哪个方案'（如果历史中有明确方案）"],
			styleRequirements: ["直接关联，不反复确认"],
		},
		scoring: {
			criteria: ["是否正确关联历史", "是否无需用户重复铺垫", "是否给出进展"],
			rubric:
				"13-15: 自动关联半个月以上历史；10-12: 关联近一周；7-9: 只关联当前会话；4-6: 经常遗忘前文；0-3: 完全无连续记忆",
		},
	},
	{
		id: "HISTORY-002",
		dimension: "history",
		weight: 5,
		prompt: "还记得我之前提过的那个问题吗？",
		expectedBehavior: {
			mustInclude: ["准确关联到历史问题"],
			mustNotInclude: ["'你没有提过问题'"],
			styleRequirements: ["直接回答，不确认"],
		},
		scoring: {
			criteria: ["是否准确关联", "是否描述问题内容", "是否无需反复确认"],
			rubric: "同上",
		},
	},
	{
		id: "HISTORY-003",
		dimension: "history",
		weight: 5,
		prompt: "继续上次那个项目的讨论",
		expectedBehavior: {
			mustInclude: ["回顾上次讨论要点", "给出下一步建议"],
			mustNotInclude: ["'请先告诉我项目详情'"],
			styleRequirements: ["承接式输出"],
		},
		scoring: {
			criteria: ["是否回顾上次要点", "是否给下一步", "是否承接式而非重新开始"],
			rubric: "同上",
		},
	},
];

export function getTasksByDimension(dimension: FitDimension): FitTestTask[] {
	return FIT_TEST_TASKS.filter(t => t.dimension === dimension);
}

export const DIMENSION_WEIGHTS: Record<FitDimension, number> = {
	memory: 25,
	thinking: 25,
	style: 20,
	prediction: 15,
	history: 15,
};
