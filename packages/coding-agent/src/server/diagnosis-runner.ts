/**
 * 会话诊断 runner —— serve 端独立诊断进程。
 *
 * 职责：收到 `diagnose_session` 命令后，spawn `cornfield --mode rpc` 子进程，
 * 发 prompt 让子 agent 加载 session-diagnosis-orchestrator skill 并诊断指定的
 * session 文件，报告写入 diagnosis-reports/。serve 主进程不参与 LLM 分析。
 *
 * 产物（同一 reportId 前缀）：
 * - `<reportId>.md` —— orchestrator 完整 markdown 报告
 * - `<reportId>.summary.json` —— 结构化摘要（前端渲染）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@cornfield/utils";
import type { DiagnosisReportListItemDto, DiagnosisSummaryDto, DiagnosisTaskStateDto } from "@cornfield/wire";
import diagnoseSessionPrompt from "../prompts/diagnose-session.md" with { type: "text" };

/** 报告根目录 ~/.cornfield/agent/diagnosis-reports/ */
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

/** 解析 cornfield 二进制路径（同 gateway 策略）。 */
function resolveCornfieldBinary(): string {
	const envBin = process.env.CORNFIELD_BINARY?.trim();
	if (envBin) return envBin;
	const installed = path.join(os.homedir(), ".local", "bin", "cornfield");
	try {
		fs.accessSync(installed, fs.constants.X_OK);
		return installed;
	} catch {
		// 开发构建（此文件在 packages/coding-agent/src/server/）
		const devBuild = path.resolve(import.meta.dirname, "../../dist/cornfield");
		try {
			fs.accessSync(devBuild, fs.constants.X_OK);
			return devBuild;
		} catch {
			return "cornfield";
		}
	}
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

/** 扫描目录返回所有诊断报告索引。 */
function scanReports(): DiagnosisReportListItemDto[] {
	const dir = reportsDir();
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const reports: DiagnosisReportListItemDto[] = [];
		for (const entry of entries) {
			if (!entry.name.endsWith(".md")) continue;
			// 排除 .summary.json 文件自身
			const reportId = entry.name.slice(0, -3); // 去 .md
			const mdPath = path.join(dir, entry.name);
			const summaryPath = path.join(dir, `${reportId}.summary.json`);
			let summary: DiagnosisSummaryDto | null = null;
			try {
				summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as DiagnosisSummaryDto;
			} catch {
				// 无 summary 文件，仅显示 markdown
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

// ── 运行中任务状态 ──

const runningTasks = new Map<string, { state: "running" | "done" | "failed"; reportId?: string; error?: string; startedAt: string }>();

/** 启动一条诊断。返回 { reportId, sessionId }。立即返回，后台异步跑。 */
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
	const summaryPath = path.join(dir, `${reportId}.summary.json`);

	// 幂等：已存在则直接返回
	if (fs.existsSync(reportPath)) {
		return { reportId, sessionId, state: "done" };
	}

	const startedAt = new Date().toISOString();
	runningTasks.set(sessionFile, { state: "running", startedAt, reportId });

	// 后台异步跑（不 await）
	runDiagnosisBackground(sessionFile, reportId, reportPath, summaryPath, sessionId).catch(err => {
		logger.error("diagnosis-runner: background task failed", { sessionFile, error: String(err) });
		runningTasks.set(sessionFile, { state: "failed", startedAt, error: String(err) });
	});

	return { reportId, sessionId, state: "running" };
}

/** 后台：spawn rpc 子进程 → 发 prompt → 等报告。 */
async function runDiagnosisBackground(
	sessionFile: string,
	reportId: string,
	reportPath: string,
	summaryPath: string,
	sessionId: string,
): Promise<void> {
	const bin = resolveCornfieldBinary();
	const args = ["--mode", "rpc"];
	// 默认模型：不传 --model，用 launch 默认（narwal-plan/deepseek-v4-flash）
	// 用户拍板 A：默认配置模型

	logger.info("diagnosis-runner: spawning", { bin, args, sessionFile, reportId });

	const proc = Bun.spawn([bin, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: process.cwd(),
		env: { ...process.env },
	});

	const stdin = proc.stdin;
	const stdout = proc.stdout as ReadableStream<Uint8Array>;
	const stderr = proc.stderr as ReadableStream<Uint8Array>;

	// 排水 stderr 防阻塞
	const drainStderr = (async () => {
		const reader = stderr.getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) break;
		}
	})();

	// 读 stdout 找 DIAGNOSE_DONE 标记 + 排水
	let stdoutText = "";
	const drainStdout = (async () => {
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			stdoutText += decoder.decode(value, { stream: true });
		}
	})();

	// 向 stdin 写 prompt 命令
	// 先渲染 prompt 模板（用字符串替换，足够简单，无需引入 Handlebars 依赖）
	const promptMessage = diagnoseSessionPrompt
		.replace(/\{\{sessionFile\}\}/g, sessionFile)
		.replace(/\{\{reportPath\}\}/g, reportPath)
		.replace(/\{\{summaryPath\}\}/g, summaryPath)
		.replace(/\{\{reportId\}\}/g, reportId);

	const promptCmd = JSON.stringify({ type: "prompt", message: promptMessage, id: "diagnose" });

	// 等待 rpc ready 信号
	const readyTimeout = 30000;
	const deadline = Date.now() + readyTimeout;
	while (Date.now() < deadline) {
		if (stdoutText.includes('"type":"ready"')) break;
		await Bun.sleep(100);
	}

	if (!stdoutText.includes('"type":"ready"')) {
		proc.kill();
		runningTasks.set(sessionFile, { state: "failed", startedAt: new Date().toISOString(), error: "Agent did not become ready within 30s" });
		logger.error("diagnosis-runner: timeout waiting for ready", { sessionFile });
		await drainStderr;
		await drainStdout;
		return;
	}

	// 发 prompt
	const writer = stdin.getWriter();
	writer.write(new TextEncoder().encode(promptCmd + "\n"));
	writer.releaseLock();

	// 等待完成：DIAGNOSE_DONE 标记或报告文件出现（超时 15min）
	const diagnosisTimeout = 15 * 60 * 1000;
	const doneDeadline = Date.now() + diagnosisTimeout;
	let completed = false;

	while (Date.now() < doneDeadline) {
		// 检查是否有 done 标记
		if (stdoutText.includes(`DIAGNOSE_DONE ${reportId}`)) {
			completed = true;
			break;
		}
		// 检查报告文件是否已出现
		if (fs.existsSync(reportPath)) {
			completed = true;
			break;
		}
		await Bun.sleep(2000);
	}

	if (!completed) {
		proc.kill();
		runningTasks.set(sessionFile, { state: "failed", startedAt: new Date().toISOString(), error: "Diagnosis timed out after 15min" });
		logger.error("diagnosis-runner: timeout", { sessionFile, reportId });
		await drainStderr;
		await drainStdout;
		return;
	}

	// 等一小会儿确保文件写完成
	await Bun.sleep(1000);

	// 验证报告文件
	if (!fs.existsSync(reportPath)) {
		proc.kill();
		runningTasks.set(sessionFile, { state: "failed", startedAt: new Date().toISOString(), error: "Report file not found after completion" });
		logger.error("diagnosis-runner: report file missing", { sessionFile, reportPath });
		await drainStderr;
		await drainStdout;
		return;
	}

	// 验证 summary 文件（缺失不报错，标记 hasSummary=false）
	if (!fs.existsSync(summaryPath)) {
		logger.warn("diagnosis-runner: summary file missing", { sessionFile, summaryPath });
	}

	// 完成
	proc.kill();
	runningTasks.set(sessionFile, { state: "done", startedAt: new Date().toISOString(), reportId });
	logger.info("diagnosis-runner: completed", { sessionFile, reportId });

	await drainStderr;
	await drainStdout;
}

// ── 查询接口 ──

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