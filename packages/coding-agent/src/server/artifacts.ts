import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, pathIsWithin, relativePathWithinRoot } from "@cornfield/utils";
import type { ArtifactDto, ArtifactKind, ArtifactSource } from "@cornfield/wire";

/**
 * 产物提取（R-ARTIFACTS）—— 一本会话账，两个来源合一。
 *
 * 来源 1（`source: "agent"`）：agent 会话 JSONL 里工具调用写出的文件。
 * - write / edit：arguments.path（新建/修改文件）
 * - puppeteer：arguments.action === "screenshot" 时的 arguments.path（截图产物）
 *
 * 来源 2（`source: "user"`）：用户发给这个会话的文件。
 * 当前只有贴/选进来的图。serve 把图交给 agent 时写进会话 artifacts 目录的 `uploads/`
 * （见 `server/wire-server` 的 `materializePromptImages`）。这些文件不来自任何工具调用，
 * 所以只有这一条来源看得见它们。
 *
 * 路径语义：两个来源走同一套 —— toolCall 的 path 相对会话 cwd（= agentDir），绝对路径 /
 * file:// URL 归一化后再校验；产物必须解析在会话的**声明过的根**内 —— 与 `fs_read`、`/preview`
 * 同一条边界（Project root + agentDir 声明的额外根 + agentDir）。包含判定与相对路径都用
 * `@cornfield/utils` 的同一份事实（`pathIsWithin` / `relativePathWithinRoot`，realpath 归一）。
 * 相对路径算成**相对它所属的那个根**（前端拿它拼 /preview 的 URL）。
 *
 * 结果按 mtime 倒序，去重（同 path 只保留一条），上限 ARTIFACT_LIMIT。
 * 产物分类：html → html；图片扩展 → image；md → markdown；其余 → text。
 */

const ARTIFACT_LIMIT = 50;
/** 扫描最近几个会话文件（mtime 倒序）。两个来源共用同一个窗口。 */
const SCAN_SESSION_LIMIT = 5;
const TOOL_NAMES = new Set(["write", "edit", "puppeteer"]);
/** 会话 artifacts 目录下用户上传图的子目录（与 serve 的落点约定同名）。 */
const UPLOADS_SUBDIR = "uploads";

const HTML_EXT = /\.html?$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** 一条待报告的产物。`source` 说明它从哪个来源进来的。 */
interface ArtifactMeta {
	title: string;
	type: ArtifactKind;
	path: string;
	source: ArtifactSource;
}

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
 * 一条路径落在哪个根里 —— 产物清单的边界。
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

/** 会话 artifacts 目录 = 会话文件路径去掉 `.jsonl`（与 `session/artifacts.ts` 同一条规则）。 */
function artifactsDirOf(sessionFile: string): string {
	return sessionFile.slice(0, -6);
}

/** 来源 1：从会话文件的工具调用提取产物路径（根内去重：同一条相对路径只留第一个命中的根）。 */
async function collectToolArtifacts(
	roots: readonly string[],
	sessionFiles: string[],
): Promise<Map<string, ArtifactMeta>> {
	const byPath = new Map<string, ArtifactMeta>();
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
				source: "agent",
			});
		}
	}
	return byPath;
}

/**
 * 来源 2：会话 artifacts 目录 `uploads/` 里用户发进来的图。
 *
 * 没有 uploads 目录是常态（这个会话没收过图），不算失败；其它原因（权限等）留一行 warn ——
 * 把「读不到」静默成「没有」，用户就会以为自己的图根本没进会话。
 */
async function collectUploadArtifacts(
	roots: readonly string[],
	sessionFiles: string[],
): Promise<Map<string, ArtifactMeta>> {
	const byPath = new Map<string, ArtifactMeta>();
	for (const sessionFile of sessionFiles) {
		const uploadsDir = path.join(artifactsDirOf(sessionFile), UPLOADS_SUBDIR);
		let names: string[];
		try {
			names = await fs.readdir(uploadsDir);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("artifacts: uploads dir unreadable", {
					dir: uploadsDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			continue;
		}
		for (const name of names) {
			const target = await fileWithinRoots(roots, path.join(uploadsDir, name));
			if (!target.ok) continue;
			if (byPath.has(target.path)) continue;
			byPath.set(target.path, {
				title: path.basename(target.path),
				type: classifyArtifact(target.path),
				path: target.relative,
				source: "user",
			});
		}
	}
	return byPath;
}

/**
 * 两个来源合成一本账。
 *
 * 同一条绝对路径被两个来源都报时以**先到的**为准（工具产物在前）—— 实际不会发生（上传图在
 * `uploads/` 下、名字带内容 hash，工具产物要写进那个目录还得同名），这是防御性的，不制造
 * 「同一行有两个说法」。
 */
async function collectArtifacts(roots: readonly string[], sessionFiles: string[]): Promise<Map<string, ArtifactMeta>> {
	const byPath = await collectToolArtifacts(roots, sessionFiles);
	for (const [abs, meta] of await collectUploadArtifacts(roots, sessionFiles)) {
		if (!byPath.has(abs)) byPath.set(abs, meta);
	}
	return byPath;
}

/** stat 过滤 + 排序 + 上限（共享收尾）。byPath 的 key 已是绝对路径。 */
async function finalizeArtifacts(byPath: Map<string, ArtifactMeta>): Promise<ArtifactDto[]> {
	const artifacts: ArtifactDto[] = [];
	for (const [abs, meta] of byPath) {
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile()) continue;
			artifacts.push({
				id: meta.path,
				title: meta.title,
				type: meta.type,
				source: meta.source,
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
 *
 * 扫描窗口（最近 SCAN_SESSION_LIMIT 个会话文件）对两个来源同时生效。
 */
export async function listAgentArtifacts(roots: readonly string[], sessionsRoot: string): Promise<ArtifactDto[]> {
	const sessionFiles = await listRecentSessionFiles(sessionsRoot, SCAN_SESSION_LIMIT);
	if (sessionFiles.length === 0) return [];
	return finalizeArtifacts(await collectArtifacts(roots, sessionFiles));
}

/**
 * 提取单个会话的产物（按会话隔离视图，前端产物 tab 随当前会话切换）。
 * sessionFile 为会话 JSONL 绝对路径；roots 是会话工作面的边界（同 fs_*）。
 * 不存在/解析失败 → 空数组（调用方已校验存在性，这里双保险）。
 */
export async function listSessionArtifacts(roots: readonly string[], sessionFile: string): Promise<ArtifactDto[]> {
	const byPath = await collectArtifacts(roots, [sessionFile]);
	return finalizeArtifacts(byPath);
}
