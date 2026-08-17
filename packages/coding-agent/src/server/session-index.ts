import * as path from "node:path";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import type { WireSessionIndexEntry, WireSessionStatus } from "@oh-my-pi/pi-wire";
import type { AgentMeta } from "./session-registry";

/**
 * 历史会话索引（P4）——纯文件扫描，不实例化任何 session。
 *
 * 目录布局（两种都扫，递归扫全目录树里的 .jsonl）：
 * - default agent：getSessionsDir() 根（~/.omp/agent/sessions）→ <encoded-cwd>/by-date/<date>/ 下的 .jsonl
 * - registry agent：<agentDir>/sessions/ → by-date/<date>/ 下（serve 写）或 <safeConvId>.jsonl 扁平（gateway 写）
 *
 * 解析策略（不整读大文件，不逐行 JSON.parse）：
 * - 头部 4KB：拿 session header（id/title/timestamp/cwd）+ 早期 model_change
 * - 尾部 256KB：拿最后 entry timestamp、最后 assistant stopReason、末次 model_change
 * - messageCount/entryCount：流式字节扫描（计数 '"type":"message"' 子串与 '\n'），
 *   分块读不驻留内存；比逐行 parse 快一个量级
 */

const HEAD_BYTES = 4096;
const TAIL_BYTES = 256 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** 一个 agent 的索引源：注册名 + sessions 根目录。 */
export interface SessionIndexSource {
	agentId: string;
	agentName: string;
	/** sessions 根目录（递归扫描）。 */ sessionsRoot: string;
}

/** default agent 的全局 sessions 根。 */
export function defaultSessionsRoot(): string {
	return getSessionsDir();
}

/** registry agent 的 sessions 根（与 serve.ts sessionFactory 的写入路径一致）。 */
export function agentSessionsRoot(meta: AgentMeta): string {
	return path.join(meta.agentDir, "sessions");
}

/**
 * 扫描并索引会话。按 startTime 倒序，最多 limit 条（先按 mtime 取每源最新 N 个文件再解析）。
 * 单文件解析失败不影响整体（跳过并记 debug 日志）。
 */
export async function indexSessions(
	sources: SessionIndexSource[],
	limit = DEFAULT_LIMIT,
): Promise<WireSessionIndexEntry[]> {
	const cappedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
	// 每源最多取 cappedLimit 个最新文件（跨源合并后再截断）
	const filesPerSource = await Promise.all(
		sources.map(async source => {
			const jsonlFiles = await listJsonlFiles(source.sessionsRoot);
			// mtime 倒序，取前 cappedLimit
			const newest = jsonlFiles.slice(0, cappedLimit);
			return Promise.all(newest.map(file => indexOne(source, file)));
		}),
	);
	const entries = filesPerSource.flat().filter((e): e is WireSessionIndexEntry => e !== null);
	entries.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
	return entries.slice(0, cappedLimit);
}

interface JsonlFile {
	path: string;
	mtimeMs: number;
	size: number;
}

async function listJsonlFiles(root: string): Promise<JsonlFile[]> {
	const files: JsonlFile[] = [];
	try {
		for await (const rel of new Bun.Glob("**/*.jsonl").scan({ cwd: root, onlyFiles: true })) {
			try {
				const stat = await Bun.file(path.join(root, rel)).stat();
				files.push({ path: path.join(root, rel), mtimeMs: stat.mtimeMs, size: stat.size });
			} catch {
				// 竞态删除——跳过
			}
		}
	} catch {
		// 根目录不存在——该源无历史
		return [];
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files;
}

async function indexOne(source: SessionIndexSource, file: JsonlFile): Promise<WireSessionIndexEntry | null> {
	try {
		const f = Bun.file(file.path);
		const headText = await f.slice(0, Math.min(HEAD_BYTES, file.size)).text();
		const header = parseSessionHeader(headText);
		if (!header) return null; // 不是 session JSONL（或空文件）——跳过

		const counts = await countMessageEntries(file.path, file.size);

		let endTime: string | undefined;
		let status: WireSessionStatus = "unknown";
		let tailModel: string | undefined;
		// 头部已含全文件（小文件）时直接用头文本解析尾部；否则读末 256KB
		const tailText = file.size <= HEAD_BYTES ? headText : await f.slice(Math.max(0, file.size - TAIL_BYTES)).text();
		const tailInfo = parseTail(tailText);
		endTime = tailInfo.lastTimestamp;
		status = tailInfo.status;
		tailModel = tailInfo.model;

		return {
			sessionId: header.id,
			agentId: source.agentId,
			agentName: source.agentName,
			title: header.title,
			startTime: header.timestamp,
			endTime: endTime ?? header.timestamp,
			messageCount: counts.messages,
			entryCount: counts.entries,
			model: tailModel ?? header.model,
			status,
			sessionFile: file.path,
			fileSizeBytes: file.size,
		};
	} catch (err) {
		logger.debug("session index parse failed", {
			file: file.path,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

interface ParsedHeader {
	id: string;
	timestamp: string;
	title?: string;
	model?: string;
}

/** 头部解析：第一行必须是 {type:"session"...}；順便拿头部的 model_change（若有）。 */
function parseSessionHeader(headText: string): ParsedHeader | null {
	const firstNewline = headText.indexOf("\n");
	const firstLine = firstNewline >= 0 ? headText.slice(0, firstNewline) : headText;
	try {
		const parsed = JSON.parse(firstLine) as { type?: string; id?: string; timestamp?: string; title?: string };
		if (parsed.type !== "session" || !parsed.id || !parsed.timestamp) return null;
		const header: ParsedHeader = { id: parsed.id, timestamp: parsed.timestamp };
		if (parsed.title) header.title = parsed.title;
		header.model = findModelChange(headText);
		return header;
	} catch {
		return null;
	}
}

interface ParsedTail {
	lastTimestamp?: string;
	status: WireSessionStatus;
	model?: string;
}

/**
 * 尾部解析：从末尾向前逐行找最后一条可解析 entry。
 * status 取最后一个含 stopReason 的 assistant 消息；timestamp 取最后 entry 的 timestamp。
 * 注意尾块首行可能被截断——从第一个完整行（首个 '\n' 之后）开始。
 */
function parseTail(tailText: string): ParsedTail {
	const result: ParsedTail = { status: "unknown" };
	const lines = tailText.split("\n");
	// 倒序扫描；遇第一个解析出 stopReason 的即定 status；timestamp 取最后一个能解析出的
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // 截断行/坏行
		}
		if (!result.lastTimestamp && typeof entry.timestamp === "string") {
			result.lastTimestamp = entry.timestamp;
		}
		if (result.status === "unknown" && entry.type === "message") {
			const message = entry.message as { role?: string; stopReason?: string } | undefined;
			if (message?.role === "assistant" && typeof message.stopReason === "string") {
				result.status = stopReasonToStatus(message.stopReason);
			}
		}
		if (result.lastTimestamp && result.status !== "unknown") break;
	}
	result.model = findModelChange(tailText);
	return result;
}

function stopReasonToStatus(stopReason: string): WireSessionStatus {
	switch (stopReason) {
		case "stop":
		case "endTurn":
		case "length":
			return "completed";
		case "aborted":
			return "aborted";
		case "error":
			return "error";
		case "toolUse":
			return "incomplete";
		default:
			return "unknown";
	}
}

/** 从文本块中找最后一个 model_change（头尾各调一次；优先尾部的）。 */
function findModelChange(text: string): string | undefined {
	// 不逐行 parse：直接找最后一个 "type":"model_change" 行的 model 字段
	let last: string | undefined;
	const marker = '"type":"model_change"';
	let idx = text.indexOf(marker);
	while (idx >= 0) {
		const lineStart = text.lastIndexOf("\n", idx) + 1;
		const lineEnd = text.indexOf("\n", idx);
		const line = text.slice(lineStart, lineEnd >= 0 ? lineEnd : undefined);
		try {
			const parsed = JSON.parse(line) as { model?: string };
			if (typeof parsed.model === "string") last = parsed.model;
		} catch {
			// 行被块边界截断——忽略
		}
		idx = text.indexOf(marker, idx + marker.length);
	}
	return last;
}

interface EntryCounts {
	messages: number;
	entries: number;
}

/**
 * 流式字节扫描：计数 message 条目与总行数。分块读，不驻留内存，不 JSON.parse。
 * 跨块边界处理：上一块末尾若为不完整行，与新块拼接后再计数。
 */
async function countMessageEntries(filePath: string, fileSize: number): Promise<EntryCounts> {
	const MESSAGE_MARKER = '"type":"message"';
	let messages = 0;
	let entries = 0;
	let carry = "";
	const file = Bun.file(filePath);
	let offset = 0;
	while (offset < fileSize) {
		const chunk = await file.slice(offset, Math.min(offset + SCAN_CHUNK_BYTES, fileSize)).text();
		offset += SCAN_CHUNK_BYTES;
		const combined = carry + chunk;
		const lastNewline = combined.lastIndexOf("\n");
		const complete = lastNewline >= 0 ? combined.slice(0, lastNewline) : combined;
		carry = lastNewline >= 0 ? combined.slice(lastNewline + 1) : "";
		entries += countOccurrences(complete, "\n") + 1;
		messages += countOccurrences(complete, MESSAGE_MARKER);
	}
	if (carry.length > 0) {
		entries += 1;
		messages += countOccurrences(carry, MESSAGE_MARKER);
	}
	return { messages, entries };
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx >= 0) {
		count += 1;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}
