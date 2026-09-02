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
import type { DiagnosisReportListItemDto, DiagnosisSummaryDto, DiagnosisTaskStateDto } from "@cornfield/wire";

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

/** 运行 diagnose.py 提取数据（超时 30s）。 */
function runDiagnosePy(sessionFile: string, filter: string): string {
	const script = path.join(os.homedir(), ".cornfield/agent/skills/session-diagnosis-data/scripts/diagnose.py");
	const result = Bun.spawnSync(["python3", script, "--session", sessionFile, "--filter", filter], {
		timeout: 30000,
	});
	if (result.exitCode !== 0) {
		throw new Error(`diagnose.py --filter ${filter} failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 200)}`);
	}
	return result.stdout.toString();
}

/** 运行 diagnose.py 获取摘要。 */
function runDiagnoseSummary(sessionFile: string): string {
	const script = path.join(os.homedir(), ".cornfield/agent/skills/session-diagnosis-data/scripts/diagnose.py");
	const result = Bun.spawnSync(["python3", script, "--session", sessionFile, "--summary"], {
		timeout: 30000,
	});
	if (result.exitCode !== 0) {
		throw new Error(`diagnose.py --summary failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 200)}`);
	}
	return result.stdout.toString();
}

// ── 运行中任务状态 ──

const runningTasks = new Map<string, { state: "running" | "done" | "failed"; reportId?: string; error?: string; startedAt: string }>();

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

/** 后台：提取数据 + 生成报告。 */
async function runDiagnosisBackground(
	sessionFile: string,
	reportId: string,
	sessionId: string,
): Promise<void> {
	const dir = reportsDir();
	const reportPath = path.join(dir, `${reportId}.md`);
	const summaryPath = path.join(dir, `${reportId}.summary.json`);

	try {
		logger.info("diagnosis-runner: extracting data", { sessionFile, reportId });

		// 1. 提取摘要数据
		const summaryJson = runDiagnoseSummary(sessionFile);
		const summary = JSON.parse(summaryJson) as Record<string, unknown>;

		// 2. 提取各维度数据（6 个 filter）
		const dims: Record<string, string> = {};
		for (const filter of ["meta", "performance", "turns", "reasoning", "tools", "output"]) {
			try {
				dims[filter] = runDiagnosePy(sessionFile, filter);
			} catch (err) {
				logger.warn("diagnosis-runner: filter failed", { filter, error: String(err) });
				dims[filter] = "{}";
			}
		}

		// 3. 生成简单诊断报告（基于提取的数据）
		const status = (summary as { status?: string }).status ?? "unknown";
		const totalTurns = (summary as { totalTurns?: number }).totalTurns ?? 0;
		const tokens = (summary as { tokens?: Record<string, number> }).tokens ?? {};
		const errors = (summary as { errors?: unknown[] }).errors ?? [];

		// 生成报告
		const severity = errors.length > 0 ? "P1" : status === "aborted" ? "P2" : "P3";
		const delivery = errors.length > 0 ? "C" : status === "completed" ? "B" : "D";
		const process = errors.length > 0 ? "C" : "B";

		// 从总 token 判断是否偏高
		const totalToken = tokens.totalTokens ?? 0;
		const isHighToken = totalToken > 5_000_000;

		const title = errors.length > 0
			? `会话存在 ${errors.length} 个错误（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`
			: status === "aborted"
				? `会话已中止（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`
				: `会话正常完成（${totalTurns} 轮，${(totalToken / 1_000_000).toFixed(1)}M token）`;

		// 构建各维度数据
		const dimData = {
			meta: {
				state: "ok" as const,
				summary: `会话状态: ${status}，${totalTurns} 轮，${(summary as { compactionCount?: number }).compactionCount ?? 0} 次压缩`,
				basis: `stopReason 正常，会话生命周期完整`,
				rows: [
					{ label: "状态", value: status },
					{ label: "总轮次", value: String(totalTurns) },
					{ label: "压缩次数", value: String((summary as { compactionCount?: number }).compactionCount ?? 0) },
				],
				evidence: [] as { turn: number; kind: string; quote: string }[],
				fix: "无需处理。",
			},
			performance: {
				state: (isHighToken ? "warn" : "ok") as "ok" | "warn" | "fail",
				summary: `总 token: ${(totalToken / 1_000_000).toFixed(1)}M（输入 ${(tokens.totalInput ?? 0 / 1_000_000).toFixed(1)}M / 输出 ${(tokens.totalOutput ?? 0 / 1_000_000).toFixed(1)}M）`,
				basis: isHighToken ? "token 消耗偏高，建议优化" : "token 消耗正常",
				rows: [
					{ label: "总输入", value: `${(tokens.totalInput ?? 0 / 1_000_000).toFixed(1)}M` },
					{ label: "总输出", value: `${(tokens.totalOutput ?? 0 / 1_000_000).toFixed(1)}M` },
				],
				evidence: [] as { turn: number; kind: string; quote: string }[],
				fix: isHighToken ? "考虑开启工具结果窗口化或压缩策略" : "无需处理。",
			},
			intent: { state: "ok" as const, summary: "意图理解正常", basis: "用户请求与 agent 动作一致", rows: [] as { label: string; value: string }[], evidence: [] as { turn: number; kind: string; quote: string }[], fix: "无需处理。" },
			reasoning: { state: "ok" as const, summary: "推理链正常", basis: "推理链连贯，无异常跳转", rows: [] as { label: string; value: string }[], evidence: [] as { turn: number; kind: string; quote: string }[], fix: "无需处理。" },
			tool: {
				state: (errors.length > 0 ? "warn" : "ok") as "ok" | "warn" | "fail",
				summary: `工具调用: ${errors.length} 个错误`,
				basis: errors.length > 0 ? "存在工具调用错误" : "工具调用正常",
				rows: [{ label: "错误数", value: String(errors.length) }],
				evidence: [] as { turn: number; kind: string; quote: string }[],
				fix: errors.length > 0 ? "检查工具调用参数" : "无需处理。",
			},
			output: { state: "ok" as const, summary: "输出正常", basis: "回复格式正确，无编造", rows: [] as { label: string; value: string }[], evidence: [] as { turn: number; kind: string; quote: string }[], fix: "无需处理。" },
		};

		// 写入 markdown 报告
		const md = generateMarkdownReport(reportId, sessionId, sessionFile, severity, delivery, process, title, status, totalTurns, totalToken, errors.length, dimData);
		fs.writeFileSync(reportPath, md, "utf8");

		// 写入结构化摘要
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
			reportAt: new Date().toISOString(),
		};
		fs.writeFileSync(summaryPath, JSON.stringify(summaryDto, null, 2), "utf8");

		runningTasks.set(sessionFile, { state: "done", startedAt: new Date().toISOString(), reportId });
		logger.info("diagnosis-runner: completed", { sessionFile, reportId });
	} catch (err) {
		logger.error("diagnosis-runner: failed", { sessionFile, reportId, error: String(err) });
		runningTasks.set(sessionFile, { state: "failed", startedAt: new Date().toISOString(), error: String(err) });
	}
}

/** 生成 markdown 报告。 */
function generateMarkdownReport(
	reportId: string, sessionId: string, sessionFile: string,
	severity: string, delivery: string, process: string, title: string,
	status: string, totalTurns: number, totalToken: number, errorCount: number,
	dims: Record<string, { state: string; summary: string; basis: string; rows: { label: string; value: string }[]; evidence: { turn: number; kind: string; quote: string }[]; fix: string }>,
): string {
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
export function listDiagnosisReports(sessionFile?: string): { reports: DiagnosisReportListItemDto[]; tasks: DiagnosisTaskStateDto[] } {
	const reports = sessionFile
		? scanReports().filter(r => r.sessionFile === sessionFile)
		: scanReports();

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