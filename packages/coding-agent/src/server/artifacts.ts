import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, pathIsWithin, relativePathWithinRoot } from "@cornfield/utils";
import type { ArtifactDto, ArtifactKind } from "@cornfield/wire";

/**
 * 产物提取（R-ARTIFACTS）——从 agent 最近会话 JSONL 的工具调用中提取写出文件。
 *
 * 数据源：assistant 消息 content 里的 toolCall 块。收集写出文件的工具：
 * - write / edit：arguments.path（新建/修改文件）
 * - puppeteer：arguments.action === "screenshot" 时的 arguments.path（截图产物）
 *
 * 路径语义：toolCall 的 path 相对 agent 会话 cwd（= agentDir）。绝对路径 /
 * file:// URL 归一化后再校验。产物必须解析在会话的**声明过的根**内——与 `fs_read` 同一条边界
 * （Project root + agentDir 声明的额外根 + agentDir）。包含判定与 `src/server/wire-server.ts` 共用同一份
 * 事实（`@cornfield/utils` 的 `pathIsWithin`，realpath 归一）；本模块与 `fs_read` 的区别只有两点：只收
 * **已经存在的文件**，且相对路径算成**相对它所属的那个根**（前端拿它拼 /preview 的 URL）。
 *
 * 结果按 mtime 倒序，去重（同 path 只保留最新），上限 ARTIFACT_LIMIT。
 * 产物分类：html → html；图片扩展 → image；md → markdown；其余 → text。
 */

const ARTIFACT_LIMIT = 50;
/** 扫描最近几个会话文件（mtime 倒序）。 */
const SCAN_SESSION_LIMIT = 5;
const TOOL_NAMES = new Set(["write", "edit", "puppeteer"]);

const HTML_EXT = /\.html?$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** 提取一条 assistant 消息 content 中的 toolCall 路径（相对/绝对均可，未归一）。 */
function toolCallPaths(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; name?: string; arguments?: unknown; action?: string };
		if (b.type !== "toolCall" || typeof b.name !== "string") continue;
		if (!TOOL_NAMES.has(b.name)) continue;
		const args = b.arguments;
		if (!args || typeof args !== "object") continue;
		// puppeteer 的 action 在 arguments 里（{ action: "screenshot", path }）——非截图不入产物。
		if (b.name === "puppeteer" && (args as { action?: unknown }).action !== "screenshot") continue;
		const p = (args as { path?: unknown }).path;
		if (typeof p === "string" && p.trim()) out.push(p.trim());
	}
	return out;
}

/** 归一化工具路径：file:// → 绝对路径；绝对路径原样；相对路径留给 `fileWithinRoots` 落根。 */
function normalizeToolPath(raw: string): string {
	if (raw.startsWith("file://")) {
		try {
			return new URL(raw).pathname;
		} catch {
			return raw;
		}
	}
	return raw;
}

/** 提取一个会话文件里的所有工具写出路径。 */
async function extractSessionToolPaths(sessionFile: string): Promise<string[]> {
	try {
		const text = await Bun.file(sessionFile).text();
		const out: string[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg?.role !== "assistant") continue;
			out.push(...toolCallPaths(msg.content));
		}
		return out;
	} catch (err) {
		logger.debug("artifacts: session parse failed", {
			file: sessionFile,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

/**
 * 一条工具路径落在哪个根里 —— 产物清单的边界。
 *
 * 产物只在**已经存在**的文件里挑（不存在的写完再删就是不用列），所以就是 `fs_read` 那条规则：
 * 挨个根试，`pathIsWithin` 用 realpath 归一后仍在根内的第一个胜出（`..` 与符号链接逃逸都过不了），
 * 相对路径相对**它所属的那个根**给出——前端拿它拼 `/preview/<agentId>/<rel>`，根写错了就点不开。
 */
async function fileWithinRoots(
	roots: readonly string[],
	raw: string,
): Promise<{ ok: true; path: string; relative: string } | { ok: false }> {
	for (const root of roots) {
		const candidate = path.resolve(root, raw);
		if (!pathIsWithin(root, candidate)) continue;
		const stat = await fs.stat(candidate).catch(() => null);
		if (!stat?.isFile()) continue;
		const relative = relativePathWithinRoot(root, candidate);
		if (relative === null) continue;
		return { ok: true, path: candidate, relative };
	}
	return { ok: false };
}

function classifyArtifact(filePath: string): ArtifactKind {
	if (HTML_EXT.test(filePath)) return "html";
	if (IMAGE_EXT.test(filePath)) return "image";
	if (MARKDOWN_EXT.test(filePath)) return "markdown";
	return "text";
}

/** 列出最近的 jsonl 会话文件（mtime 倒序，最多 n 个）。 */
async function listRecentSessionFiles(sessionsRoot: string, n: number): Promise<string[]> {
	const files: { path: string; mtimeMs: number }[] = [];
	try {
		for await (const rel of new Bun.Glob("**/*.jsonl").scan({ cwd: sessionsRoot, onlyFiles: true })) {
			try {
				const full = path.join(sessionsRoot, rel);
				const stat = await fs.stat(full);
				files.push({ path: full, mtimeMs: stat.mtimeMs });
			} catch {
				// 竞态删除——跳过
			}
		}
	} catch {
		return [];
	}
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return files.slice(0, n).map(f => f.path);
}

/** 从一组会话文件的 toolCall 提取产物路径（根内去重：同一条相对路径只留第一个命中的根）。 */
async function collectArtifactPaths(
	roots: readonly string[],
	sessionFiles: string[],
): Promise<Map<string, { title: string; type: ArtifactKind; path: string }>> {
	const byPath = new Map<string, { title: string; type: ArtifactKind; path: string }>();
	for (const sessionFile of sessionFiles) {
		const rawPaths = await extractSessionToolPaths(sessionFile);
		for (const raw of rawPaths) {
			const target = await fileWithinRoots(roots, normalizeToolPath(raw));
			if (!target.ok) continue;
			if (byPath.has(target.path)) continue; // 去重：同 path 只保留首个（会话按 mtime 倒序，首个即最新）
			byPath.set(target.path, {
				title: path.basename(target.path),
				type: classifyArtifact(target.path),
				path: target.relative,
			});
		}
	}
	return byPath;
}

/** stat 过滤 + 排序 + 上限（共享收尾）。byPath 的 key 已是绝对路径。 */
async function finalizeArtifacts(
	byPath: Map<string, { title: string; type: ArtifactKind; path: string }>,
): Promise<ArtifactDto[]> {
	const artifacts: ArtifactDto[] = [];
	for (const [abs, meta] of byPath) {
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile()) continue;
			artifacts.push({
				id: meta.path,
				title: meta.title,
				type: meta.type,
				path: meta.path,
				updatedAt: stat.mtimeMs,
				size: stat.size,
			});
		} catch {
			// 文件已删（产物落在临时路径）——跳过
		}
	}
	artifacts.sort((a, b) => b.updatedAt - a.updatedAt);
	return artifacts.slice(0, ARTIFACT_LIMIT);
}

/**
 * 提取 agent 产物（agent 维度）。roots 是会话工作面的边界（同 fs_*）；sessionsRoot 是会话根——
 * default 必须传 cwd 编码子目录（getSessionsDir(<home>)/<encoded-cwd>，否则全局根下
 * 其它项目的新会话会挤掉本 agent 的会话）；registry 传 <agentDir>/sessions。
 */
export async function listAgentArtifacts(roots: readonly string[], sessionsRoot: string): Promise<ArtifactDto[]> {
	const sessionFiles = await listRecentSessionFiles(sessionsRoot, SCAN_SESSION_LIMIT);
	if (sessionFiles.length === 0) return [];
	return finalizeArtifacts(await collectArtifactPaths(roots, sessionFiles));
}

/**
 * 提取单个会话的产物（按会话隔离视图，前端产物 tab 随当前会话切换）。
 * sessionFile 为会话 JSONL 绝对路径；roots 是会话工作面的边界（同 fs_*）。
 * 不存在/解析失败 → 空数组（调用方已校验存在性，这里双保险）。
 */
export async function listSessionArtifacts(roots: readonly string[], sessionFile: string): Promise<ArtifactDto[]> {
	const byPath = await collectArtifactPaths(roots, [sessionFile]);
	return finalizeArtifacts(byPath);
}
