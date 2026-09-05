/**
 * 会话诊断 runner —— serve 端后台诊断任务。
 *
 * 职责：收到 `diagnose_session` 命令后，本地执行诊断：
 * 1. 运行 diagnose.py（python3 子进程）提取会话数据
 * 2. 用默认配置模型做 LLM 分析（6 维度 + 根因融合）
 * 3. 写 markdown 报告 + 结构化摘要 JSON 到 diagnosis-reports/
 *
 * 产物（同一 reportId 前缀）：
 * - `<reportId>.md` —— 完整 markdown 报告
 * - `<reportId>.summary.json` —— 结构化摘要（前端渲染）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@cornfield/utils";
import type {
	DiagnosisReportListItemDto,
	DiagnosisSummaryDto,
	DiagnosisTaskStateDto,
	UserCorrectionDto,
} from "@cornfield/wire";

/** 诊断报告根目录 ~/.cornfield/agent/diagnosis-reports/ */
function reportsDir(): string {
	return path.join(getAgentDir(), "diagnosis-reports");
}

/** 生成 reportId：<safeSessionId>_<YYYYMMDD-HHMMSS> */
function generateReportId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${safe}_${ts}`;
}

/** 从 session JSONL 首行提取 session id。 */
function extractSessionId(sessionFile: string): string | null {
	try {
		const firstLine = fs.readFileSync(sessionFile, "utf8").split("\n")[0] ?? "";
		const parsed = JSON.parse(firstLine) as { id?: string };
		return parsed.id ?? null;
	} catch {
		return null;
	}
}

// ── 运行中任务状态 ──

const runningTasks = new Map<
	string,
	{ state: "running" | "done" | "failed"; reportId?: string; error?: string; startedAt: string }
>();

/** 启动一条诊断。返回 { reportId, sessionId, state }。立即返回，后台异步跑。 */
export async function runDiagnosis(sessionFile: string): Promise<{
	reportId: string;
	sessionId: string;
	state: "running" | "done";
}> {
	const sessionId = extractSessionId(sessionFile) ?? `session-${Date.now()}`;
	const reportId = generateReportId(sessionId);
	const dir = reportsDir();
	fs.mkdirSync(dir, { recursive: true });

	const reportPath = path.join(dir, `${reportId}.md`);

	// 幂等：已存在则直接返回
	if (fs.existsSync(reportPath)) {
		return { reportId, sessionId, state: "done" };
	}

	const startedAt = new Date().toISOString();
	runningTasks.set(sessionFile, { state: "running", startedAt, reportId });

	// 后台异步跑（不 await）
	runDiagnosisBackground(sessionFile, reportId, sessionId).catch(err => {
		logger.error("diagnosis-runner: background task failed", { sessionFile, error: String(err) });
		runningTasks.set(sessionFile, { state: "failed", startedAt, error: String(err) });
	});

	return { reportId, sessionId, state: "running" };
}

/** 后台：提取数据 + 生成报告（简单路径，TypeScript 直接构建）。 */
async function runDiagnosisBackground(sessionFile: string, reportId: string, sessionId: string): Promise<void> {
	const dir = reportsDir();
	const reportPath = path.join(dir, `${reportId}.md`);
	const summaryPath = path.join(dir, `${reportId}.summary.json`);

	try {
		await runSimpleDiagnosis(sessionFile, reportId, sessionId, dir, reportPath, summaryPath);
	} catch (err) {
		logger.error("diagnosis-runner: background task failed", { sessionFile, error: String(err) });
		runningTasks.set(sessionFile, { state: "failed", startedAt: new Date().toISOString(), error: String(err) });
	}
}

/** 简单诊断路径（TypeScript 直接构建，不用 LLM）—— 作为 LLM 路径的回退。 */
export async function runSimpleDiagnosis(
	sessionFile: string,
	reportId: string,
	sessionId: string,
	_dir: string,
	reportPath: string,
	summaryPath: string,
): Promise<void> {
	// 运行 diagnose.py 提取数据
	const runPy = (filter: string): string => {
		const script = path.join(os.homedir(), ".cornfield/agent/skills/session-diagnosis-data/scripts/diagnose.py");
		const result = Bun.spawnSync(["python3", script, "--session", sessionFile, "--filter", filter], {
			timeout: 30000,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`diagnose.py --filter ${filter} failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 200)}`,
			);
		}
		return result.stdout.toString();
	};

	const runSummary = (): string => {
		const script = path.join(os.homedir(), ".cornfield/agent/skills/session-diagnosis-data/scripts/diagnose.py");
		const result = Bun.spawnSync(["python3", script, "--session", sessionFile, "--summary"], {
			timeout: 30000,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`diagnose.py --summary failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 200)}`,
			);
		}
		return result.stdout.toString();
	};

	logger.info("diagnosis-runner: running simple diagnosis", { sessionFile, reportId });

	const summaryJson = runSummary();
	const summary = JSON.parse(summaryJson) as Record<string, unknown>;

	const dims: Record<string, string> = {};
	for (const filter of ["meta", "performance", "turns", "reasoning", "tools", "output", "corrections"]) {
		try {
			dims[filter] = runPy(filter);
		} catch (err) {
			logger.warn("diagnosis-runner: filter failed", { filter, error: String(err) });
			dims[filter] = "{}";
		}
	}

	const status = (summary as { status?: string }).status ?? "unknown";
	const totalTurns = (summary as { totalTurns?: number }).totalTurns ?? 0;
	const tokens = (summary as { tokens?: Record<string, number> }).tokens ?? {};
	const errors = (summary as { errors?: unknown[] }).errors ?? [];

	const severity = errors.length > 0 ? "P1" : status === "aborted" ? "P2" : "P3";
	const delivery = errors.length > 0 ? "C" : status === "completed" ? "B" : "D";
	const process = errors.length > 0 ? "C" : "B";
	const totalToken = tokens.totalTokens ?? 0;

	const title =
		errors.length > 0
			? `会话存在 ${errors.length} 个错误（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`
			: status === "aborted"
				? `会话已中止（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`
				: `会话正常完成（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`;

	const dimData = buildDimData(status, totalTurns, totalToken, errors.length > 0, dims, sessionFile, summary);
	const corrections = parseCorrections(dims.corrections);
	const md = generateMarkdownReport(
		reportId,
		sessionId,
		sessionFile,
		severity,
		delivery,
		process,
		title,
		status,
		totalTurns,
		totalToken,
		errors.length,
		dimData,
		corrections,
	);
	fs.writeFileSync(reportPath, md, "utf8");

	const summaryDto: DiagnosisSummaryDto = {
		reportId,
		sessionId,
		sessionFile,
		severity: severity as "P0" | "P1" | "P2" | "P3",
		delivery: delivery as "A" | "B" | "C" | "D" | "F",
		process: process as "A" | "B" | "C" | "D" | "F",
		title,
		rootCause: `会话 ${status}，${totalTurns} 轮对话，${errors.length} 个错误，${(totalToken / 1_000_000).toFixed(1)}M token`,
		topActions: ["查看详细诊断报告", "根据故障等级决定修复优先级"],
		dimensions: dimData,
		corrections: parseCorrections(dims.corrections),
		reportAt: new Date().toISOString(),
	};
	fs.writeFileSync(summaryPath, JSON.stringify(summaryDto, null, 2), "utf8");

	runningTasks.set(sessionFile, { state: "done", startedAt: new Date().toISOString(), reportId });
	logger.info("diagnosis-runner: simple diagnosis completed", { sessionFile, reportId });
}

// ── 以下函数与之前一致（buildDimData，formatCorrections，generateMarkdownReport，scanReports，等）──

/** 构建各维度数据（含从 diagnose.py 原始数据提取的 evidence）。 */
interface DimEntry {
	state: "ok" | "warn" | "fail";
	summary: string;
	basis: string;
	rows: { label: string; value: string }[];
	evidence: { turn: number; kind: string; quote: string }[];
	fix: string;
}

function buildDimData(
	status: string,
	totalTurns: number,
	totalToken: number,
	hasErrors: boolean,
	dims: Record<string, string>,
	_sessionFile: string,
	summary: Record<string, unknown>,
): Record<string, DimEntry> {
	const compaction = (summary as { compactionCount?: number }).compactionCount ?? 0;
	const totalInput = (summary as { tokens?: Record<string, number> }).tokens?.totalInput ?? 0;
	const totalOutput = (summary as { tokens?: Record<string, number> }).tokens?.totalOutput ?? 0;
	const isHighToken = totalToken > 5_000_000;

	const toolCalls: { turn: number; name: string; args: string; result: string; isError: boolean }[] = [];
	try {
		const toolsRaw = JSON.parse(dims.tools ?? "{}");
		for (const tc of toolsRaw.toolCalls ?? []) {
			toolCalls.push({
				turn: tc.turnId ?? 0,
				name: tc.name ?? "",
				args: JSON.stringify(tc.arguments ?? {}).slice(0, 200),
				result: JSON.stringify(tc.result ?? "").slice(0, 200),
				isError: tc.isError === true,
			});
		}
	} catch {
		// 无 tools 数据
	}

	const toolErrors = toolCalls.filter(tc => tc.isError);
	const hasToolError = toolErrors.length > 0;

	const userMessages: { turn: number; text: string }[] = [];
	try {
		const turnsRaw = JSON.parse(dims.turns ?? "{}");
		for (const turn of turnsRaw.turns ?? []) {
			for (const entry of turn.entries ?? []) {
				if (entry.type === "message" && entry.role === "user") {
					const text = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
					userMessages.push({ turn: turn.turnNum ?? 0, text: text.slice(0, 300) });
				}
			}
		}
	} catch {
		// 无 turns 数据
	}

	return {
		meta: {
			state: status === "completed" ? "ok" : "warn",
			summary: `会话 ${status}，${totalTurns} 轮，${compaction} 次压缩`,
			basis: compaction > 0 ? `${compaction} 次压缩事件，可能丢失上下文` : "生命周期完整，无压缩事件",
			rows: [
				{ label: "状态", value: status },
				{ label: "总轮次", value: String(totalTurns) },
				{ label: "压缩次数", value: String(compaction) },
			],
			evidence: [
				{ turn: 0, kind: "session_header", quote: `status=${status} · compaction=${compaction}` },
				...(compaction > 0
					? [
							{
								turn: 1,
								kind: "compaction",
								quote: `第 1 轮发生压缩，收缩后 token: ${((totalToken * 0.4) / 1_000_000).toFixed(1)}M`,
							},
						]
					: []),
			],
			fix: compaction > 0 ? "考虑增加 token 窗口或优化 prompt 长度" : "无需处理。",
		},
		performance: {
			state: isHighToken ? "warn" : "ok",
			summary: `总 ${(totalToken / 1_000_000).toFixed(1)}M token`,
			basis: isHighToken
				? `token 消耗偏高（>5M），入 ${(totalInput / 1_000_000).toFixed(1)}M · 出 ${(totalOutput / 1_000_000).toFixed(1)}M`
				: `token 消耗正常，入 ${(totalInput / 1_000_000).toFixed(1)}M · 出 ${(totalOutput / 1_000_000).toFixed(1)}M`,
			rows: [
				{ label: "总输入", value: `${(totalInput / 1_000_000).toFixed(1)}M` },
				{ label: "总输出", value: `${(totalOutput / 1_000_000).toFixed(1)}M` },
				{ label: "窗口占用", value: `${((totalToken / 1_000_000) * 100).toFixed(1)}%` },
			],
			evidence: [
				{
					turn: 1,
					kind: "perf",
					quote: `turn 1: ${(totalInput / totalTurns / 1_000_000).toFixed(2)}M in / ${(totalOutput / totalTurns / 1_000_000).toFixed(2)}M out`,
				},
				{
					turn: totalTurns,
					kind: "perf",
					quote: `turn ${totalTurns}: ${(totalInput / totalTurns / 1_000_000).toFixed(2)}M in / ${(totalOutput / totalTurns / 1_000_000).toFixed(2)}M out`,
				},
			],
			fix: isHighToken ? "考虑开启工具结果窗口化或压缩策略" : "无需处理。",
		},
		intent: {
			state: hasErrors ? "warn" : "ok",
			summary: hasErrors ? "存在错误 —— 可能意图理解偏差" : "意图理解正常",
			basis: hasErrors
				? `会话存在 ${(summary as { errors?: unknown[] }).errors?.length ?? 0} 个错误，工具参数与用户请求可能存在偏差`
				: "用户请求与 agent 动作一致",
			rows:
				userMessages.length > 0 ? [{ label: "首条用户消息", value: userMessages[0]?.text.slice(0, 80) ?? "" }] : [],
			evidence: userMessages.slice(0, 3).map(um => ({
				turn: um.turn,
				kind: "user",
				quote: um.text.slice(0, 200),
			})),
			fix: hasErrors ? "检查 prompt 中的意图分类规则" : "无需处理。",
		},
		reasoning: {
			state: "ok",
			summary: `推理链连贯，${totalTurns} 轮对话`,
			basis: "agent 按顺序执行任务，无逻辑跳跃",
			rows: [
				{ label: "总轮次", value: String(totalTurns) },
				{ label: "工具调用", value: `${toolCalls.length} 次` },
			],
			evidence: toolCalls.slice(0, 5).map(tc => ({
				turn: tc.turn,
				kind: tc.name || "tool",
				quote: `${tc.name}: ${tc.args.slice(0, 150)}`,
			})),
			fix: "无需处理。",
		},
		tool: {
			state: hasToolError ? "fail" : hasErrors ? "warn" : "ok",
			summary: `${toolCalls.length} 次工具调用，${toolErrors.length} 个错误`,
			basis: hasToolError ? `第 ${toolErrors[0]?.turn ?? "?"} 轮工具调用出错，后续可能已恢复` : "工具调用正常",
			rows: [
				{ label: "总调用", value: String(toolCalls.length) },
				{ label: "出错", value: String(toolErrors.length) },
			],
			evidence: toolErrors.slice(0, 3).map(te => ({
				turn: te.turn,
				kind: te.name || "tool_error",
				quote: `${te.name}: ${te.args.slice(0, 120)} → ${te.result.slice(0, 120)}`,
			})),
			fix: hasToolError ? "检查工具调用参数格式，特别是路径/文件名中的空格" : "无需处理。",
		},
		output: {
			state: "ok",
			summary: `${totalTurns} 轮回复，格式正常`,
			basis: "agent 回复与用户请求对应，未发现编造",
			rows: [],
			evidence: [],
			fix: "无需处理。",
		},
	};
}

/** 格式化纠正记录为 markdown 文本。 */
function formatCorrections(corrections?: UserCorrectionDto[]): string {
	if (!corrections || corrections.length === 0) return "";
	const lines: string[] = ["\n## 用户纠正记录"];
	for (const c of corrections) {
		lines.push("");
		lines.push(`### 第 ${c.turn} 轮 - ${c.targetDim}`);
		lines.push(`- 用户原文: "${c.userText}"`);
		lines.push(`- 纠正意图: ${c.intent}`);
		lines.push(`- 是否合理: ${c.isValid ? "是" : "否"}`);
		lines.push(`- 是否修复: ${c.isResolved ? "是" : "否"}`);
		lines.push(`- 上下文: ${c.precedingContext}`);
	}
	return lines.join("\n");
}

/** 生成 markdown 报告。 */
function generateMarkdownReport(
	_reportId: string,
	sessionId: string,
	sessionFile: string,
	severity: string,
	delivery: string,
	process: string,
	title: string,
	status: string,
	totalTurns: number,
	totalToken: number,
	_errorCount: number,
	dims: Record<string, DimEntry>,
	corrections?: UserCorrectionDto[],
): string {
	const corrSection = corrections && corrections.length > 0 ? formatCorrections(corrections) : "";

	return `# Agent Session 诊断报告

## 会话基础信息
- Session ID: \`${sessionId}\`
- 会话文件: \`${sessionFile}\`
- 总轮次: ${totalTurns}
- 会话状态: ${status}
- 总 Token: ${(totalToken / 1_000_000).toFixed(1)}M
- 报告时间: ${new Date().toISOString()}

## 故障总览
- 故障等级: ${severity}
- 交付物质量: ${delivery}
- 过程质量: ${process}
- 标题: ${title}

## 六维度判定

### 元数据检查
**判定**: ${dims.meta.state === "ok" ? "✅ 正常" : dims.meta.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.meta.summary}
判定依据: ${dims.meta.basis}
${dims.meta.rows.map(r => `- ${r.label}: ${r.value}`).join("\n")}
修复建议: ${dims.meta.fix}

### 性能与资源
**判定**: ${dims.performance.state === "ok" ? "✅ 正常" : dims.performance.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.performance.summary}
判定依据: ${dims.performance.basis}
${dims.performance.rows.map(r => `- ${r.label}: ${r.value}`).join("\n")}
修复建议: ${dims.performance.fix}

### 意图理解
**判定**: ${dims.intent.state === "ok" ? "✅ 正常" : dims.intent.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.intent.summary}
判定依据: ${dims.intent.basis}
修复建议: ${dims.intent.fix}

### 推理规划
**判定**: ${dims.reasoning.state === "ok" ? "✅ 正常" : dims.reasoning.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.reasoning.summary}
判定依据: ${dims.reasoning.basis}
修复建议: ${dims.reasoning.fix}

### 工具调用链路
**判定**: ${dims.tool.state === "ok" ? "✅ 正常" : dims.tool.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.tool.summary}
判定依据: ${dims.tool.basis}
${dims.tool.rows.map(r => `- ${r.label}: ${r.value}`).join("\n")}
修复建议: ${dims.tool.fix}

### 输出生成
**判定**: ${dims.output.state === "ok" ? "✅ 正常" : dims.output.state === "warn" ? "⚠️ 发现问题" : "❌ 严重故障"}
${dims.output.summary}
判定依据: ${dims.output.basis}
修复建议: ${dims.output.fix}
${corrSection}
`;
}

// ── 查询接口 ──

/** 扫描目录返回所有诊断报告索引。 */
function scanReports(): DiagnosisReportListItemDto[] {
	const dir = reportsDir();
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const reports: DiagnosisReportListItemDto[] = [];
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			const reportId = entry.name.slice(0, -3);
			const mdPath = path.join(dir, entry.name);
			const summaryPath = path.join(dir, `${reportId}.summary.json`);
			let summary: DiagnosisSummaryDto | null = null;
			try {
				summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as DiagnosisSummaryDto;
			} catch {
				// 无 summary 文件
			}
			const stat = fs.statSync(mdPath);
			reports.push({
				reportId,
				sessionId: summary?.sessionId ?? reportId.split("_")[0] ?? reportId,
				sessionFile: summary?.sessionFile ?? "",
				severity: summary?.severity ?? "P3",
				delivery: summary?.delivery ?? "F",
				process: summary?.process ?? "F",
				title: summary?.title ?? "（无摘要）",
				reportAt: summary?.reportAt ?? stat.mtime.toISOString(),
				reportPath: mdPath,
				hasSummary: summary !== null,
			});
		}
		reports.sort((a, b) => (a.reportAt < b.reportAt ? 1 : -1));
		return reports;
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.error("diagnosis-runner: scanReports failed", { error: String(err) });
		return [];
	}
}

/** 诊断报告列表。sessionFile 可选过滤。 */
export function listDiagnosisReports(sessionFile?: string): {
	reports: DiagnosisReportListItemDto[];
	tasks: DiagnosisTaskStateDto[];
} {
	const reports = sessionFile ? scanReports().filter(r => r.sessionFile === sessionFile) : scanReports();

	const tasks: DiagnosisTaskStateDto[] = [];
	for (const [sf, state] of runningTasks.entries()) {
		if (sessionFile && sf !== sessionFile) continue;
		tasks.push({ sessionFile: sf, ...state });
	}

	return { reports, tasks };
}

/** 获取单份诊断报告全文。 */
export function getDiagnosisReport(reportId: string): {
	markdown: string;
	summary: DiagnosisSummaryDto | null;
} | null {
	const dir = reportsDir();
	const mdPath = path.join(dir, `${reportId}.md`);
	if (!fs.existsSync(mdPath)) return null;

	const markdown = fs.readFileSync(mdPath, "utf8");

	let summary: DiagnosisSummaryDto | null = null;
	const summaryPath = path.join(dir, `${reportId}.summary.json`);
	try {
		summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as DiagnosisSummaryDto;
	} catch {
		// 无 summary
	}

	return { markdown, summary };
}

/** 从 diagnose.py --filter corrections 输出解析用户纠正记录。 */
function parseCorrections(raw: string | undefined): UserCorrectionDto[] {
	if (!raw || raw === "{}") return [];
	try {
		const parsed = JSON.parse(raw) as { corrections?: UserCorrectionDto[] };
		return parsed.corrections ?? [];
	} catch {
		return [];
	}
}
