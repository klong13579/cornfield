import * as path from "node:path";
import { getSessionsDir, logger } from "@cornfield/utils";
import type { WireSessionIndexEntry, WireSessionSource, WireSessionStatus } from "@cornfield/wire";
import type { AgentMeta } from "./session-registry";

/**
 * 历史会话索引（P4）——纯文件扫描，不实例化任何 session。
 *
 * 目录布局（两种都扫，递归扫全目录树里的 .jsonl）：
 * - default agent：getSessionsDir() 根（默认 = 它的家 ~/.cornfield/agents/default/sessions）→ <encoded-cwd>/by-date/<date>/ 下的 .jsonl
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

/** 一个 agent 的索引源：注册名 + sessions 根目录 + 来源。 */
export interface SessionIndexSource {
	agentId: string;
	agentName: string;
	/** sessions 根目录（递归扫描）。 */ sessionsRoot: string;
	/** 来源：default agent 根 → cli；registry agent → agent。 */
	source: WireSessionSource;
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
 * 扫描并索引会话。同一 sessionId 只留一条，按 startTime 倒序，最多 limit 条
 * （先按 mtime 取每源最新 N 个文件再解析）。
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
	// 去重必须发生在截断之前：同一个会话的两份文件若留到 slice 之后合并，limit 会被这份重复
	// 白吃掉一条，真实会话反而被挤掉。
	const entries = dedupeBySessionId(filesPerSource.flat().filter((e): e is WireSessionIndexEntry => e !== null));
	entries.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
	return entries.slice(0, cappedLimit);
}

/**
 * 按 sessionId 去重，同一个会话只留一条。
 *
 * 为什么按 id 合并、而不是按文件名把 `.client-side.jsonl` 排除掉：两份文件不是固定的
 * 「主文件 + 后缀副本」关系。default agent 的 sessions 目录里
 * `<HHMMSS>__<8hex>.jsonl` 与其 `.client-side.jsonl` 实测逐字节相同，但 client-side 是旁路
 * 产物、内容可以与 agent 自己写的那份不同 —— 靠文件名后缀排除等于盲选一份，可能丢掉信息更全的。
 * id 是会话头里的权威身份（两份文件的 header.id 相同），按它合并再按信息量挑，对两种产物都成立。
 *
 * 取舍顺序（确定性，不依赖输入顺序）：
 * 1. entryCount 大的优先 —— 信息更全的那份；
 * 2. entryCount 相同则非 `.client-side.jsonl` 的优先 —— 那是 agent 自己写的会话日志；
 * 3. 仍相同则 sessionFile 字典序取第一个 —— 让结果与扫描顺序无关。
 */
function dedupeBySessionId(entries: WireSessionIndexEntry[]): WireSessionIndexEntry[] {
	const byId = new Map<string, WireSessionIndexEntry>();
	for (const entry of entries) {
		const kept = byId.get(entry.sessionId);
		if (!kept || shouldPreferEntry(entry, kept)) byId.set(entry.sessionId, entry);
	}
	return [...byId.values()];
}

/** candidate 是否比已留的那条更该留（取舍顺序见 dedupeBySessionId）。 */
function shouldPreferEntry(candidate: WireSessionIndexEntry, kept: WireSessionIndexEntry): boolean {
	if (candidate.entryCount !== kept.entryCount) return candidate.entryCount > kept.entryCount;
	const candidateIsClientSide = isClientSideFile(candidate.sessionFile);
	const keptIsClientSide = isClientSideFile(kept.sessionFile);
	if (candidateIsClientSide !== keptIsClientSide) return !candidateIsClientSide;
	return candidate.sessionFile < kept.sessionFile;
}

/** 旁路产物：`<会话名>.client-side.jsonl`（agent 自己写的那份不带该后缀）。 */
function isClientSideFile(filePath: string): boolean {
	return path.basename(filePath).endsWith(".client-side.jsonl");
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

		// title 优先级（与 session-manager 自动标题同源）：header.title → 首条 user 消息 → 文件名推导
		const firstPrompt = header.title ? undefined : extractFirstUserPrompt(headText);
		const title = header.title ?? sanitizeDisplayTitle(firstPrompt) ?? deriveSessionTitle(file.path);

		// 头部已含全文件（小文件）时直接用头文本解析尾部；否则读末 256KB
		const tailText = file.size <= HEAD_BYTES ? headText : await f.slice(Math.max(0, file.size - TAIL_BYTES)).text();
		const tailInfo = parseTail(tailText);
		const endTime = tailInfo.lastTimestamp;
		const status = tailInfo.status;
		const tailModel = tailInfo.model;

		return {
			sessionId: header.id,
			agentId: source.agentId,
			agentName: source.agentName,
			source: source.source,
			title,
			cwd: header.cwd,
			// 归属只从会话头读：旧会话没有 projectId 就是没有（undefined），**不**拿 cwd 猜一个
			// ——猜出来的归属会让前端分组把会话放到一个它自己从未声明过的 Project 下。
			projectId: header.projectId,
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
	cwd?: string;
	/** 会话头记录的权威归属（SessionHeader.projectId）；未记录 = undefined。 */
	projectId?: string;
	model?: string;
}

/** 从会话文件名推导可读名（header 无 title 时的兜底）。
 *
 * by-date 布局（session-paths.ts）：`<HHMMSS>[-<slug>]__<8hex>.jsonl`
 *   - `143205__a1b2c3d4.jsonl`               → "MM-DD 143205"
 *   - `143205-fix-login-bug__a1b2c3d4.jsonl` → "MM-DD 143205 fix login bug"
 * 无标题的 gateway 扁平文件（`<convId>.jsonl`）不匹配 → undefined（前端回落 id）。
 */
function deriveSessionTitle(filePath: string): string | undefined {
	const base = path.basename(filePath, ".jsonl");
	// by-date 布局：`<HHMMSS>[-<slug>]__<8hex>.jsonl`
	const m = base.match(/^(\d{6})(?:-([^_]+))?__[0-9a-f]{8}$/);
	if (m) {
		const stamp = m[1];
		const slug = m[2];
		const dateDir = path.basename(path.dirname(filePath));
		const day = /^\d{4}-\d{2}-\d{2}$/.test(dateDir) ? dateDir.slice(5) : undefined; // MM-DD
		const label = slug ? `${stamp} ${slug.replace(/[-_]+/g, " ")}` : stamp;
		return day ? `${day} ${label}` : label;
	}
	// subagent 子会话：`by-date/<date>/<主会话>/<NN>-<name>.jsonl` → 任务名
	const sub = base.match(/^\d{1,3}-(.+)$/);
	if (sub) return sub[1].replace(/[-_]+/g, " ");
	// 无标题的 gateway 扁平文件（`<convId>.jsonl`）不匹配 → undefined（前端回落 id）
	return undefined;
}

/** 显示用标题清洗：首行、去控制字符、trim、40 字符截断（与 RecentSessionInfo.name 同款）。 */
function sanitizeDisplayTitle(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "").trim();
	if (!stripped) return undefined;
	return stripped.length <= 40 ? stripped : `${stripped.slice(0, 39)}…`;
}

/** 从头部文本提取第一条 user 消息文本（与 session-manager extractFirstUserPrompt 同构）。 */
function extractFirstUserPrompt(headText: string): string | undefined {
	for (const line of headText.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // 截断行/坏行
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block !== null && "text" in block) {
					const text = (block as { text: unknown }).text;
					if (typeof text === "string" && text.trim().length > 0) return text;
				}
			}
		}
	}
	return undefined;
}

/** 头部解析：第一行必须是 {type:"session"...}；順便拿头部的 model_change（若有）。 */
function parseSessionHeader(headText: string): ParsedHeader | null {
	const firstNewline = headText.indexOf("\n");
	const firstLine = firstNewline >= 0 ? headText.slice(0, firstNewline) : headText;
	try {
		const parsed = JSON.parse(firstLine) as {
			type?: string;
			id?: string;
			timestamp?: string;
			title?: string;
			cwd?: string;
			projectId?: string;
		};
		if (parsed.type !== "session" || !parsed.id || !parsed.timestamp) return null;
		const header: ParsedHeader = { id: parsed.id, timestamp: parsed.timestamp };
		if (parsed.title) header.title = parsed.title;
		if (parsed.cwd) header.cwd = parsed.cwd;
		if (parsed.projectId && typeof parsed.projectId === "string") header.projectId = parsed.projectId;
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
