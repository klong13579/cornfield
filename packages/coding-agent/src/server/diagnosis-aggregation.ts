/**
 * 多会话诊断聚合 —— SQLite 存储 + 查询。
 *
 * 职责：
 * 1. 诊断报告写入 SQLite（upsertDiagnosisReport，由 diagnosis-runner 在完成时调用）
 * 2. 多维度聚合查询（aggregateDiagnosis，供前端仪表盘使用）
 * 3. 单例 DB 连接管理（getAggregationDb）
 *
 * 设计原则：聚合写入路径永不抛出异常 —— 诊断本身应成功即使聚合失败。
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as path from "node:path";
import { getAgentDir, logger } from "@cornfield/utils";
import type { DiagnosisSummaryDto } from "@cornfield/wire";

// ── 类型导出 ──

/** 维度聚合统计（每维度计数 + 失败率）。 */
export interface DimAggregationDto {
	ok: number;
	warn: number;
	fail: number;
	failRate: number;
}

/** 诊断聚合结果（前端仪表盘渲染）。 */
export interface DiagnosisAggregationDto {
	totalSessions: number;
	severityDistribution: { P0: number; P1: number; P2: number; P3: number };
	dimensionReports?: Record<
		string,
		Array<{ reportId: string; sessionId: string; sessionFile: string; severity: string; title: string }>
	>;
	dimensionFailureRates: Record<string, DimAggregationDto>;
	deliveryDistribution: Record<string, number>;
	processDistribution: Record<string, number>;
	topIssues: Array<{ title: string; count: number; severity: string }>;
	weeklyTrend: Array<{ weekStart: string; total: number; p0: number; p1: number; p2: number; p3: number }>;
}

// ── 常量 ──

const DIMENSION_KEYS = ["meta", "performance", "intent", "reasoning", "tool", "output"] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS diagnosis_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  agent_id TEXT,
  severity TEXT NOT NULL,
  delivery TEXT NOT NULL,
  process TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  session_date INTEGER,
  dim_meta TEXT,
  dim_performance TEXT,
  dim_intent TEXT,
  dim_reasoning TEXT,
  dim_tools TEXT,
  dim_output TEXT,
  summary_path TEXT,
  report_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_dr_agent ON diagnosis_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_dr_created ON diagnosis_reports(created_at);
CREATE INDEX IF NOT EXISTS idx_dr_severity ON diagnosis_reports(severity);
`;

// ── 单例 DB ──

let _db: Database | null = null;

/** 获取聚合 DB 单例（惰性初始化，WAL 模式，建表）。 */
export function getAggregationDb(): Database {
	if (_db) return _db;

	const dbPath = path.join(getAgentDir(), "diagnosis-reports.db");
	_db = new Database(dbPath, { create: true });
	_db.exec("PRAGMA journal_mode=WAL;");
	// 逐条执行 DDL（SQLite 一次只能执行一条语句）
	for (const stmt of SCHEMA_SQL.split(";")
		.map(s => s.trim())
		.filter(s => s.length > 0)) {
		_db.exec(`${stmt};`);
	}
	return _db;
}

// ── 路径解析 ──

/** 从 sessionFile 路径提取 agentId。 */
function extractAgentId(sessionFile: string): string | null {
	const idx = sessionFile.indexOf("/sessions/");
	if (idx === -1) return null;
	const agentDir = sessionFile.slice(0, idx);
	return path.basename(agentDir) || null;
}

/** 从 sessionFile 路径提取 session_date（YYYY-MM-DD 格式的 Unix 时间戳）。 */
function extractSessionDate(sessionFile: string): number | null {
	const match = sessionFile.match(/\/by-date\/(\d{4}-\d{2}-\d{2})\//);
	if (!match) return null;
	// 返回该日期 00:00:00 UTC 的毫秒时间戳
	return new Date(`${match[1]}T00:00:00Z`).getTime();
}

/** 提取维度判定状态。 */
function extractDimState(summary: DiagnosisSummaryDto, dimKey: string): string | null {
	const dim = summary.dimensions?.[dimKey];
	if (!dim || typeof dim.state !== "string") return null;
	return dim.state as string;
}

// ── 写入 ──

/** 写入或更新一条诊断报告到聚合库。永不抛出。 */
export function upsertDiagnosisReport(summary: DiagnosisSummaryDto, reportPath: string): void {
	try {
		const db = getAggregationDb();
		const agentId = extractAgentId(summary.sessionFile);
		const sessionDate = extractSessionDate(summary.sessionFile);
		const createdMs = new Date(summary.reportAt).getTime();

		const dimMeta = extractDimState(summary, "meta");
		const dimPerf = extractDimState(summary, "performance");
		const dimIntent = extractDimState(summary, "intent");
		const dimReason = extractDimState(summary, "reasoning");
		const dimTools = extractDimState(summary, "tool");
		const dimOutput = extractDimState(summary, "output");

		const stmt = db.prepare(
			`INSERT OR REPLACE INTO diagnosis_reports
			 (id, session_id, session_file, agent_id, severity, delivery, process, title,
			  created_at, session_date,
			  dim_meta, dim_performance, dim_intent, dim_reasoning, dim_tools, dim_output,
			  summary_path, report_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		stmt.run(
			summary.reportId,
			summary.sessionId,
			summary.sessionFile,
			agentId,
			summary.severity,
			summary.delivery,
			summary.process,
			summary.title ?? null,
			createdMs,
			sessionDate,
			dimMeta,
			dimPerf,
			dimIntent,
			dimReason,
			dimTools,
			dimOutput,
			null, // summary_path — 由调用方填写
			reportPath,
		);
	} catch (err) {
		logger.warn("diagnosis-aggregation: upsert failed", {
			reportId: summary.reportId,
			error: String(err),
		});
	}
}

// ── 查询 ──

/** 聚合查询参数。 */
export interface AggregationOpts {
	since?: number;
	until?: number;
	agentId?: string;
}

/** 运行聚合查询，返回前端仪表盘所需数据。永不抛出 —— 失败时返回空聚合。 */
export function aggregateDiagnosis(opts: AggregationOpts = {}): DiagnosisAggregationDto {
	const empty = (): DiagnosisAggregationDto => ({
		totalSessions: 0,
		severityDistribution: { P0: 0, P1: 0, P2: 0, P3: 0 },
		dimensionReports: {},

		dimensionFailureRates: {},
		deliveryDistribution: {},
		processDistribution: {},
		topIssues: [],
		weeklyTrend: [],
	});

	try {
		const db = getAggregationDb();

		// ── 构建 WHERE 子句 ──
		const whereClauses: string[] = [];
		const params: SQLQueryBindings[] = [];

		if (opts.since !== undefined) {
			whereClauses.push("created_at >= ?");
			params.push(opts.since);
		}
		if (opts.until !== undefined) {
			whereClauses.push("created_at <= ?");
			params.push(opts.until);
		}
		if (opts.agentId !== undefined) {
			whereClauses.push("agent_id = ?");
			params.push(opts.agentId);
		}

		const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
		// 条件追加：无过滤（where=""）时也要产出合法 WHERE 子句，避免 `FROM t AND …` 语法错误
		const whereAnd = (cond: string): string => (where ? `${where} AND ${cond}` : `WHERE ${cond}`);

		// ── totalSessions ──
		const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM diagnosis_reports ${where}`).get(...params) as
			| { cnt: number }
			| undefined;
		const totalSessions = countRow?.cnt ?? 0;

		if (totalSessions === 0) return empty();

		// ── severityDistribution ──
		const severityRows = db
			.prepare(
				`SELECT severity, COUNT(*) as cnt FROM diagnosis_reports ${where} GROUP BY severity ORDER BY severity`,
			)
			.all(...params) as { severity: string; cnt: number }[];
		const severityDistribution: DiagnosisAggregationDto["severityDistribution"] = {
			P0: 0,
			P1: 0,
			P2: 0,
			P3: 0,
		};
		for (const row of severityRows) {
			const key = row.severity as keyof typeof severityDistribution;
			if (key in severityDistribution) severityDistribution[key] = row.cnt;
		}

		// ── dimensionFailureRates ──
		const dimensionFailureRates: Record<string, DimAggregationDto> = {};
		for (const dim of DIMENSION_KEYS) {
			const col = dim === "tool" ? "dim_tools" : `dim_${dim}`;
			const dimRows = db
				.prepare(`SELECT ${col} as state, COUNT(*) as cnt FROM diagnosis_reports ${where} GROUP BY ${col}`)
				.all(...params) as { state: string | null; cnt: number }[];
			let ok = 0;
			let warn = 0;
			let fail = 0;
			for (const row of dimRows) {
				if (row.state === "ok") ok = row.cnt;
				else if (row.state === "warn") warn = row.cnt;
				else if (row.state === "fail") fail = row.cnt;
			}
			const total = ok + warn + fail;
			dimensionFailureRates[dim] = {
				ok,
				warn,
				fail,
				failRate: total > 0 ? fail / total : 0,
			};
		}

		// ── dimensionReports：支持从聚合维度卡片下钻到具体报告 ──

		const dimensionReports: DiagnosisAggregationDto["dimensionReports"] = {};
		const reportRows = db
			.prepare(
				`SELECT id, session_id, session_file, severity, title, dim_meta, dim_performance, dim_intent, dim_reasoning, dim_tools, dim_output FROM diagnosis_reports ${where} ORDER BY created_at DESC`,
			)
			.all(...params) as Array<Record<string, string | null>>;
		for (const row of reportRows) {
			for (const dim of DIMENSION_KEYS) {
				const state = row[dim === "tool" ? "dim_tools" : `dim_${dim}`];
				if (state !== "ok" && state !== "warn" && state !== "fail") continue;
				const reports = dimensionReports[dim] ?? [];
				reports.push({
					reportId: row.id ?? "",
					sessionId: row.session_id ?? "",
					sessionFile: row.session_file ?? "",
					severity: row.severity ?? "P3",
					title: row.title ?? "诊断报告",
				});
				dimensionReports[dim] = reports;
			}
		}

		// ── deliveryDistribution ──
		const deliveryRows = db
			.prepare(
				`SELECT delivery, COUNT(*) as cnt FROM diagnosis_reports ${where} GROUP BY delivery ORDER BY delivery`,
			)
			.all(...params) as { delivery: string; cnt: number }[];
		const deliveryDistribution: Record<string, number> = {};
		for (const row of deliveryRows) {
			deliveryDistribution[row.delivery] = row.cnt;
		}

		// ── processDistribution ──
		const processRows = db
			.prepare(`SELECT process, COUNT(*) as cnt FROM diagnosis_reports ${where} GROUP BY process ORDER BY process`)
			.all(...params) as { process: string; cnt: number }[];
		const processDistribution: Record<string, number> = {};
		for (const row of processRows) {
			processDistribution[row.process] = row.cnt;
		}

		// ── topIssues ──
		const topIssuesRows = db
			.prepare(
				`SELECT title, COUNT(*) as count, severity FROM diagnosis_reports
				 ${whereAnd("title IS NOT NULL")}
				 GROUP BY title ORDER BY count DESC LIMIT 10`,
			)
			.all(...params) as { title: string; count: number; severity: string }[];
		const topIssues = topIssuesRows.map(r => ({
			title: r.title,
			count: r.count,
			severity: r.severity,
		}));

		// ── weeklyTrend ──
		// 使用 session_date 字段（毫秒时间戳）按周分组
		const weeklyRows = db
			.prepare(
				`SELECT
					strftime('%Y-%W', datetime(session_date / 1000, 'unixepoch')) as week_start,
					COUNT(*) as total,
					SUM(CASE WHEN severity = 'P0' THEN 1 ELSE 0 END) as p0,
					SUM(CASE WHEN severity = 'P1' THEN 1 ELSE 0 END) as p1,
					SUM(CASE WHEN severity = 'P2' THEN 1 ELSE 0 END) as p2,
					SUM(CASE WHEN severity = 'P3' THEN 1 ELSE 0 END) as p3
				 FROM diagnosis_reports
				 ${whereAnd("session_date IS NOT NULL")}
				 GROUP BY week_start ORDER BY week_start DESC LIMIT 52`,
			)
			.all(...params) as {
			week_start: string;
			total: number;
			p0: number;
			p1: number;
			p2: number;
			p3: number;
		}[];
		const weeklyTrend = weeklyRows.map(r => ({
			weekStart: r.week_start,
			total: r.total,
			p0: r.p0,
			p1: r.p1,
			p2: r.p2,
			p3: r.p3,
		}));

		return {
			totalSessions,
			severityDistribution,
			dimensionFailureRates,
			dimensionReports,

			deliveryDistribution,
			processDistribution,
			topIssues,
			weeklyTrend,
		};
	} catch (err) {
		logger.warn("diagnosis-aggregation: aggregate failed", { error: String(err) });
		return empty();
	}
}
