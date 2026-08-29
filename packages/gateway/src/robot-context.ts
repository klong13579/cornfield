/**
 * Robot context generation — keeps each IM agent aware of its own identity
 * and reachable conversations.
 *
 * For every DingTalk account the gateway maintains `<agentDir>/robot-context.md`
 * (registered in the agentDir's prompt-includes.json so it is injected into the
 * agent's system context). Content is regenerated from the session store:
 *
 * - robot identity (account id, robotName/robotCode from gateway.json)
 * - group conversations the robot has seen (title + conversationId + last active)
 * - DM conversations (userId + last sender nickname + last active)
 *
 * Regeneration is idempotent: the file is only rewritten when content changes.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@cornfield/utils";
import type { SQLiteSessionStore } from "./session-store";
import type { SessionRecord } from "./types";

/** Robot identity per account (from gateway.json account config). */
export interface RobotMeta {
	robotCode?: string;
	robotName?: string;
}

const ROBOT_CONTEXT_FILE = "robot-context.md";

export class RobotContextWriter {
	#store: SQLiteSessionStore;
	#agentDirs: Map<string, string>;
	#robotMeta: Map<string, RobotMeta>;
	/** Accounts with an in-flight refresh (prevents concurrent duplicate writes). */
	#inFlight = new Set<string>();

	constructor(opts: {
		store: SQLiteSessionStore;
		agentDirs: Map<string, string>;
		robotMeta: Map<string, RobotMeta>;
	}) {
		this.#store = opts.store;
		this.#agentDirs = opts.agentDirs;
		this.#robotMeta = opts.robotMeta;
	}

	/** Regenerate robot-context.md for every registered account. */
	async refreshAll(): Promise<void> {
		for (const accountId of this.#agentDirs.keys()) {
			await this.refresh(accountId);
		}
	}

	/**
	 * Regenerate robot-context.md for one account. Cheap to call per message:
	 * no-op when the rendered content is unchanged.
	 */
	async refresh(accountId: string): Promise<void> {
		if (this.#inFlight.has(accountId)) return;
		this.#inFlight.add(accountId);
		try {
			const agentDir = this.#agentDirs.get(accountId);
			if (!agentDir) return;
			const sessions = (await this.#store.getActiveSessions()).filter(s => s.accountId === accountId);
			const md = renderRobotContext(accountId, this.#robotMeta.get(accountId) ?? {}, sessions);
			const filePath = path.join(agentDir, ROBOT_CONTEXT_FILE);
			let existing: string | null = null;
			try {
				existing = await fs.readFile(filePath, "utf8");
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			if (existing !== md) {
				await fs.writeFile(filePath, md, "utf8");
				logger.debug("robot-context.md updated", { accountId });
			}
			await ensurePromptInclude(agentDir);
		} catch (err) {
			logger.error("Failed to refresh robot context", { accountId, error: String(err) });
		} finally {
			this.#inFlight.delete(accountId);
		}
	}
}

function fmtDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function renderRobotContext(accountId: string, meta: RobotMeta, sessions: SessionRecord[]): string {
	const groups = sessions.filter(s => s.isGroup).sort((a, b) => b.updatedAt - a.updatedAt);
	const dms = sessions.filter(s => !s.isGroup).sort((a, b) => b.updatedAt - a.updatedAt);
	const robotLabel = meta.robotName
		? `${meta.robotName} (${meta.robotCode ?? "unknown robotCode"})`
		: (meta.robotCode ?? "unknown");

	const lines: string[] = [
		"# Robot Context（机器人上下文，自动生成）",
		"",
		"> 本文件由 cornfield-gateway 自动维护（机器人身份 + 可触达的会话）。手动编辑会被覆盖。",
		"",
		"## 我的身份",
		"",
		`- 钉钉机器人：${robotLabel}`,
		`- 网关账号：${accountId}`,
		"- 部署形态：oh-my-pi gateway（钉钉 Stream 多账号模式）",
		"",
	];

	if (groups.length > 0) {
		lines.push("## 我所在的群（按最近活跃排序）", "", "| 群名 | conversationId | 最近活跃 |", "|---|---|---|");
		for (const g of groups) {
			lines.push(`| ${g.conversationTitle ?? "(未知群名)"} | ${g.conversationId} | ${fmtDate(g.updatedAt)} |`);
		}
		lines.push("");
	} else {
		lines.push("## 我所在的群", "", "（暂无已知群会话——收到群消息后自动补充）", "");
	}

	if (dms.length > 0) {
		lines.push("## 与我单聊的用户", "", "| 用户 | userId | 最近发言人 | 最近活跃 |", "|---|---|---|---|");
		for (const d of dms) {
			lines.push(
				`| ${d.conversationTitle ?? d.userName ?? "(未知)"} | ${d.userId} | ${d.userName ?? "-"} | ${fmtDate(d.updatedAt)} |`,
			);
		}
		lines.push("");
	} else {
		lines.push("## 与我单聊的用户", "", "（暂无）", "");
	}

	lines.push(
		"## 使用说明",
		"",
		"- 群/单聊列表随消息动态补充，conversationId 可直接用于拉取历史消息：",
		'  `dws chat message list --group <conversationId> --time "YYYY-MM-DD HH:mm:ss"`',
		"- 群里 @ 我或私聊我即触发会话。",
		"",
	);

	return lines.join("\n");
}

/**
 * Ensure prompt-includes.json lists robot-context.md. Tolerates (and repairs)
 * double-encoded JSON content. Never removes user entries.
 */
async function ensurePromptInclude(agentDir: string): Promise<void> {
	const filePath = path.join(agentDir, "prompt-includes.json");
	let text: string | null = null;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	if (text === null) {
		// No manifest yet — create a minimal one so the context is injected.
		await fs.writeFile(filePath, `${JSON.stringify({ files: [ROBOT_CONTEXT_FILE] }, null, "\t")}\n`, "utf8");
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
		// Repair double-encoded content: JSON.parse returned a string
		if (typeof parsed === "string") parsed = JSON.parse(parsed);
	} catch {
		logger.warn("prompt-includes.json is not valid JSON; skipping robot-context registration", { agentDir });
		return;
	}
	const files =
		parsed && typeof parsed === "object" && Array.isArray((parsed as { files?: unknown }).files)
			? (parsed as { files: string[] }).files
			: null;
	if (!files) {
		logger.warn("prompt-includes.json missing files array; skipping robot-context registration", { agentDir });
		return;
	}
	if (files.includes(ROBOT_CONTEXT_FILE)) return;
	files.push(ROBOT_CONTEXT_FILE);
	await fs.writeFile(filePath, `${JSON.stringify({ files }, null, "\t")}\n`, "utf8");
}
