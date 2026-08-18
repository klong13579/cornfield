import * as fs from "node:fs";
import {
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	getCostTimeSeries,
	getCatalogCost,
	getFileOffset,
	getMessageById,
	getMessageCount,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getOverallStats,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	initDb,
	insertMessageStats,
	setFileOffset,
} from "./db";
import { getSessionEntry, listAllSessionFiles, parseSessionFile } from "./parser";
import type { DashboardStats, MessageStats, ModelPriceEntry, RequestDetails } from "./types";

/**
 * Sync a single session file to the database.
 * Only processes new entries since the last sync.
 */
async function syncSessionFile(sessionFile: string): Promise<number> {
	// Get file stats
	let fileStats: fs.Stats;
	try {
		fileStats = await fs.promises.stat(sessionFile);
	} catch {
		return 0;
	}

	const lastModified = fileStats.mtimeMs;

	// Check if file has changed since last sync
	const stored = getFileOffset(sessionFile);
	if (stored && stored.lastModified >= lastModified) {
		return 0; // File hasn't changed
	}

	// Parse file from last offset
	const fromOffset = stored?.offset ?? 0;
	const { stats, newOffset } = await parseSessionFile(sessionFile, fromOffset);

	if (stats.length > 0) {
		insertMessageStats(stats);
	}

	// Update offset tracker
	setFileOffset(sessionFile, newOffset, lastModified);

	return stats.length;
}

/**
 * Sync all session files to the database.
 * Returns the number of new entries processed.
 */
export async function syncAllSessions(): Promise<{ processed: number; files: number }> {
	await initDb();

	const files = await listAllSessionFiles();
	let totalProcessed = 0;
	let filesProcessed = 0;

	for (const file of files) {
		const count = await syncSessionFile(file);
		if (count > 0) {
			totalProcessed += count;
			filesProcessed++;
		}
	}

	return { processed: totalProcessed, files: filesProcessed };
}

/**
 * Get all dashboard stats.
 * @param sinceMs 可选时间下限（毫秒时间戳）；省略 = 全量聚合。
 * 时间序列固定窗口不变：timeSeries 24h 小时桶 / modelSeries+performance 14 天 / costSeries 90 天。
 */
export async function getDashboardStats(sinceMs?: number): Promise<DashboardStats> {
	await initDb();

	return {
		overall: getOverallStats(sinceMs),
		byModel: getStatsByModel(sinceMs),
		byFolder: getStatsByFolder(sinceMs),
		timeSeries: getTimeSeries(24),
		modelSeries: getModelTimeSeries(14),
		modelPerformanceSeries: getModelPerformanceSeries(14),
		costSeries: getCostTimeSeries(90),
	};
}

/**
 * 模型单价目录（美元 / 1M tokens）——w3 D2 模型成本表的「单价」列数据源。
 * 取自 models.json 目录（getBundledModel），仅含 stats 里实际出现的模型；
 * 目录里查不到的模型（自定义/未收录）不出现——UI 侧显示「—」。
 */
export function buildModelPriceCatalog(byModel: { model: string; provider: string }[]): ModelPriceEntry[] {
	const seen = new Set<string>();
	const entries: ModelPriceEntry[] = [];
	for (const { model, provider } of byModel) {
		const key = `${provider}\u0000${model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const price = getCatalogCost(provider, model);
		if (!price) continue;
		entries.push({ provider, model, price: { ...price } });
	}
	return entries;
}
export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentErrors(limit);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
	await initDb();
	const msg = getMessageById(id);
	if (!msg) return null;

	const entry = await getSessionEntry(msg.sessionFile, msg.entryId);
	if (entry?.type !== "message") return null;

	// TODO: Get parent/context messages?
	// For now we return the single entry which contains the assistant response.
	// The user prompt is likely the parent.

	return {
		...msg,
		messages: [entry],
		output: (entry as any).message,
	};
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}
