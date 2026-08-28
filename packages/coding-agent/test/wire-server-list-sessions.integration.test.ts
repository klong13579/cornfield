/**
 * P4 e2e — list_sessions 历史会话索引（真机 serve + bun WS 客户端）。
 *
 * 预置 3 条 hr agent 会话 JSONL + default 无历史：
 *   1. complete：header + model_change + user + assistant(stopReason:"stop") → completed
 *   2. aborted：同上但 assistant stopReason:"aborted" → aborted
 *   3. truncated：以 toolUse 收尾（进程被杀/未回填）→ incomplete
 *
 * 验证：结构字段、状态推断、时间倒序、sessionId 过滤、limit、
 * messageCount/entryCount 计数、model 提取（头部 model_change）。
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

interface IndexEntry {
	sessionId: string;
	agentId: string;
	agentName: string;
	title?: string;
	startTime: string;
	endTime?: string;
	messageCount: number;
	entryCount: number;
	model?: string;
	status: string;
	sessionFile: string;
	fileSizeBytes: number;
}

/** 构造一条 entry 行（与 session-manager 落盘结构同构）。 */
function entryLine(type: string, extra: Record<string, unknown>, id = Math.random().toString(36).slice(2, 10)): string {
	return JSON.stringify({ type, id, parentId: null, timestamp: new Date().toISOString(), ...extra });
}

function userMessage(text: string): string {
	return entryLine("message", {
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	});
}

function assistantMessage(stopReason: string): string {
	return entryLine("message", {
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason, timestamp: Date.now() },
	});
}

test("list_sessions：索引/状态推断/排序/过滤", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-p4-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// ── hr agentDir + registry ──
	const hrDir = path.join(isolatedHome, "agents", "hr");
	const hrSessions = path.join(hrDir, "sessions", "by-date", "2026-08-18");
	await fs.mkdir(hrSessions, { recursive: true });
	await fs.mkdir(path.join(hrDir, ".omp"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".omp", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);
	const registryDir = path.join(isolatedHome, ".omp", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);

	// ── 3 条预置会话（startTime 递增，最新的是 complete）──
	const mk = (id: string, startIso: string, title: string, lines: string[]) =>
		Bun.write(
			path.join(
				hrSessions,
				`${startIso.slice(11, 13)}${startIso.slice(14, 16)}${startIso.slice(17, 19)}__${id.slice(0, 8)}.jsonl`,
			),
			`${[JSON.stringify({ type: "session", version: 3, id, timestamp: startIso, cwd: hrDir, title, titleSource: "auto" }), entryLine("model_change", { model: "test-provider/test-model" }), ...lines].join("\n")}\n`,
		);

	await mk("aaaa1111-0000-7000-0000-000000000001", "2026-08-18T10:00:00.000Z", "oldest aborted", [
		userMessage("q1"),
		assistantMessage("aborted"),
	]);
	await mk("bbbb2222-0000-7000-0000-000000000002", "2026-08-18T11:00:00.000Z", "mid truncated", [
		userMessage("q2"),
		assistantMessage("toolUse"), // 以工具调用收尾——未回填
	]);
	await mk("cccc3333-0000-7000-0000-000000000003", "2026-08-18T12:00:00.000Z", "newest complete", [
		userMessage("q3"),
		assistantMessage("stop"),
	]);
	// 第 4 条：header 无 title + 有 user 消息 —— 应提取首条 user 消息为名（与 session-manager 自动标题同源）
	await Bun.write(
		path.join(hrSessions, `090000__ffff0001.jsonl`),
		`${[JSON.stringify({ type: "session", version: 3, id: "dddd4444-0000-7000-0000-000000000004", timestamp: "2026-08-18T09:00:00.000Z", cwd: hrDir }), entryLine("model_change", { model: "test-provider/test-model" }), userMessage("q4"), assistantMessage("stop")].join("\n")}\n`,
	);
	// 第 5 条：header 无 title 也无 user 消息（空会话）—— 回落文件名推导（slug 转空格）
	await Bun.write(
		path.join(hrSessions, `080000-empty-slug__ffff0002.jsonl`),
		`${[JSON.stringify({ type: "session", version: 3, id: "eeee5555-0000-7000-0000-000000000005", timestamp: "2026-08-18T08:00:00.000Z", cwd: hrDir }), entryLine("model_change", { model: "test-provider/test-model" })].join("\n")}\n`,
	);
	// 第 6 条：subagent 子会话（by-date/<主会话>/<NN>-<name>.jsonl）—— 文件名取任务名
	const subDir = path.join(hrSessions, "070000__aaaa9999");
	await fs.mkdir(subDir, { recursive: true });
	await Bun.write(
		path.join(subDir, `21-FixSettings.jsonl`),
		`${[JSON.stringify({ type: "session", version: 3, id: "ffff6666-0000-7000-0000-000000000006", timestamp: "2026-08-18T07:00:00.000Z", cwd: hrDir }), entryLine("model_change", { model: "test-provider/test-model" })].join("\n")}\n`,
	);

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = 57000 + Math.floor(Math.random() * 8000);
	const proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" } },
	);

	try {
		const match = (await waitForServe(proc, port)).url;
		const ws = await connect(match);

		// 全量：至少 3 条预置 hr 会话（default 的当前会话 JSONL 可能尚未 flush，不断言它）
		const all = (await request(ws, { type: "list_sessions" })) as { sessions: IndexEntry[] };
		expect(all.sessions.length).toBeGreaterThanOrEqual(3);

		// hr 的 6 条都在（3 条带 title + 首条 user 消息提取 + 文件名推导 + subagent 任务名）
		const hr = all.sessions.filter(s => s.agentId === "hr");
		expect(hr.length).toBe(6);

		// 时间倒序：newest → mid → oldest → user 消息提取（09:00）→ 文件名推导（08:00）→ subagent（07:00）
		expect(hr.map(s => s.title)).toEqual([
			"newest complete",
			"mid truncated",
			"oldest aborted",
			"q4",
			"08-18 080000 empty slug",
			"FixSettings",
		]);

		// 状态推断
		const byTitle = new Map(hr.map(s => [s.title as string, s]));
		expect(byTitle.get("newest complete")?.status).toBe("completed");
		expect(byTitle.get("mid truncated")?.status).toBe("incomplete");
		expect(byTitle.get("oldest aborted")?.status).toBe("aborted");
		expect(byTitle.get("q4")?.status).toBe("completed");
		expect(byTitle.get("08-18 080000 empty slug")?.status).toBe("unknown");
		expect(byTitle.get("FixSettings")?.status).toBe("unknown");

		// 结构字段
		const newest = byTitle.get("newest complete");
		expect(newest?.sessionId).toBe("cccc3333-0000-7000-0000-000000000003");
		expect(newest?.agentName).toBe("hr-agent");
		expect(newest?.model).toBe("test-provider/test-model");
		expect(newest?.startTime).toBe("2026-08-18T12:00:00.000Z");
		expect(newest?.messageCount).toBe(2); // user + assistant
		expect(newest?.entryCount).toBe(4); // header + model_change + 2 messages
		expect(newest?.sessionFile).toContain(path.join("agents", "hr"));
		expect(newest?.fileSizeBytes).toBeGreaterThan(0);

		// endTime：最后 entry 的 timestamp（ISO 可解析即可——预置数据的 entry 时间与 header 时间独立）
		expect(newest?.endTime && !Number.isNaN(Date.parse(newest.endTime))).toBe(true);

		// sessionId 过滤：只 hr
		const onlyHr = (await request(ws, { type: "list_sessions", sessionId: "hr" })) as { sessions: IndexEntry[] };
		expect(onlyHr.sessions.length).toBe(6);
		expect(onlyHr.sessions.every(s => s.agentId === "hr")).toBe(true);

		// 未知 agent 报错
		const bogus = (await request(ws, { type: "list_sessions", sessionId: "nope" }, true)) as Frame;
		expect(bogus.ok).toBe(false);
		expect(String(bogus.error)).toMatch(/unknown agent/);

		// limit（按 mtime 取每源前 N 个文件再按 startTime 倒序）
		const limited = (await request(ws, { type: "list_sessions", sessionId: "hr", limit: 2 })) as {
			sessions: IndexEntry[];
		};
		expect(limited.sessions.length).toBe(2);
		// 仍按时间倒序（具体是哪两条取决于 mtime，不断言具体条目）
		expect(limited.sessions[0]!.startTime >= limited.sessions[1]!.startTime).toBe(true);

		ws.close();
	} finally {
		proc.kill();
		await proc.exited;
		process.env.HOME = savedHome;
		await fs.rm(isolatedHome, { recursive: true, force: true });
	}
}, 60_000);

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const token = url.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await nextFrame(ws, f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return ws;
}

let seq = 0;
async function request(ws: WebSocket, command: Record<string, unknown>, raw = false): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await nextFrame(ws, fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${command.type}`);
	if (raw) return f;
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
}

function nextFrame(ws: WebSocket, pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(undefined);
		}, timeoutMs);
		const onMessage = (ev: MessageEvent) => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			if (!pred(frame)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(frame);
		};
		ws.addEventListener("message", onMessage as EventListener);
	});
}
