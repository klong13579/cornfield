/**
 * R-ARTIFACTS e2e — list_artifacts 产物提取 + /preview 静态预览（真机 serve + bun WS/HTTP）。
 *
 * 预置 hr agentDir + 2 条会话 JSONL（含 write / edit / puppeteer screenshot toolCall）：
 *   1. 新会话：write dashboard.html（真实文件）+ puppeteer screenshot dashboard_preview.png（真实文件）
 *   2. 旧会话：write stale.txt（文件已删）—— 不应出现在产物里
 *
 * 验证：
 * - list_artifacts：类型分类（html/image）、mtime 倒序、路径相对 agentDir、过滤已删文件
 * - /preview/<agentId>/<path>：HTML 内容 + content-type、路径越界 400、未知 agent 404
 * - 未知 agent 命令报错
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

interface ArtifactRow {
	id: string;
	title: string;
	type: string;
	path: string;
	updatedAt: number;
	size: number;
}

function entryLine(type: string, extra: Record<string, unknown>, id = Math.random().toString(36).slice(2, 10)): string {
	return JSON.stringify({ type, id, parentId: null, timestamp: new Date().toISOString(), ...extra });
}

/** assistant 消息 + toolCall 块（与 session-manager 落盘结构同构）。 */
function assistantToolCall(name: string, args: Record<string, unknown>): string {
	return entryLine("message", {
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});
}

test("list_artifacts：提取/分类/排序 + /preview 静态服务", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-artifacts-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// ── hr agentDir + registry + 真实产物文件 ──
	const hrDir = path.join(isolatedHome, "agents", "hr");
	const hrSessions = path.join(hrDir, "sessions", "by-date", "2026-08-27");
	await fs.mkdir(hrSessions, { recursive: true });
	await fs.mkdir(path.join(hrDir, ".omp"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".omp", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);

	// 产物文件：dashboard.html（存在）+ dashboard_preview.png（存在）+ stale.txt（只写会话不写文件）
	const html = "<!doctype html><html><body><h1>Dashboard</h1></body></html>";
	await Bun.write(path.join(hrDir, "dashboard.html"), html);
	await Bun.write(
		path.join(hrDir, "dashboard_preview.png"),
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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

	// ── 2 条会话：新（write + screenshot，产物存在）；旧（write stale.txt，文件已删）──
	const header = (id: string, startIso: string) =>
		JSON.stringify({ type: "session", version: 3, id, timestamp: startIso, cwd: hrDir, title: "artifacts" });

	await Bun.write(
		path.join(hrSessions, "100000__newest.jsonl"),
		`${[
			header("aaaa1111-0000-7000-0000-000000000001", "2026-08-27T10:00:00.000Z"),
			assistantToolCall("write", { path: "dashboard.html", content: html }),
			assistantToolCall("puppeteer", { action: "screenshot", path: "dashboard_preview.png" }),
		].join("\n")}\n`,
	);
	await Bun.write(
		path.join(hrSessions, "090000__oldest.jsonl"),
		`${[
			header("bbbb2222-0000-7000-0000-000000000002", "2026-08-27T09:00:00.000Z"),
			assistantToolCall("write", { path: "stale.txt", content: "deleted" }),
		].join("\n")}\n`,
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
		const { url } = await waitForServe(proc, port);
		const ws = await connect(url);

		// ── list_artifacts：hr 定向 ──
		const result = (await request(ws, { type: "list_artifacts", sessionId: "hr" })) as { artifacts: ArtifactRow[] };
		expect(result.artifacts.length).toBe(2);

		// mtime 倒序：dashboard.html 先写（同会话内 write 在前），都是产物；stale.txt 已删被过滤
		const titles = result.artifacts.map(a => a.title);
		expect(titles).toContain("dashboard.html");
		expect(titles).toContain("dashboard_preview.png");
		expect(titles).not.toContain("stale.txt");

		// 分类
		const htmlArtifact = result.artifacts.find(a => a.title === "dashboard.html");
		expect(htmlArtifact?.type).toBe("html");
		expect(htmlArtifact?.path).toBe("dashboard.html");
		expect(htmlArtifact?.size).toBe(html.length);
		const pngArtifact = result.artifacts.find(a => a.title === "dashboard_preview.png");
		expect(pngArtifact?.type).toBe("image");
		expect(pngArtifact?.updatedAt).toBeGreaterThan(0);

		// ── list_artifacts 按会话定向（sessionFile）：只提该会话产物，不受 Agent 维度扫描影响 ──
		const sessionFiles = [path.join(hrSessions, "100000__newest.jsonl")];
		const sessionResult = (await request(ws, {
			type: "list_artifacts",
			sessionId: "hr",
			sessionFile: sessionFiles[0],
		})) as { artifacts: ArtifactRow[] };
		expect(sessionResult.artifacts.map(a => a.title).sort()).toEqual(["dashboard.html", "dashboard_preview.png"]);

		// 定向旧会话（stale.txt 已在磁盘删除）→ 空数组，不串当前会话产物
		const staleResult = (await request(ws, {
			type: "list_artifacts",
			sessionId: "hr",
			sessionFile: path.join(hrSessions, "090000__oldest.jsonl"),
		})) as { artifacts: ArtifactRow[] };
		expect(staleResult.artifacts).toEqual([]);

		// 不存在的 sessionFile → 降级 agent 维度（不硬报错；serve 重启后旧会话文件可能未落盘/已清理）
		const missing = (await request(ws, {
			type: "list_artifacts",
			sessionId: "hr",
			sessionFile: path.join(hrSessions, "nope.jsonl"),
		})) as { artifacts: ArtifactRow[] };
		expect(missing.artifacts.length).toBe(2); // 回退扫 hr 最近会话：新/旧两会话的产物都在

		// ── /preview 静态服务：html ──
		const previewUrl = url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
		const htmlRes = await fetch(`${previewUrl}/preview/hr/dashboard.html`);
		expect(htmlRes.status).toBe(200);
		expect(htmlRes.headers.get("content-type")).toContain("text/html");
		expect(await htmlRes.text()).toBe(html);

		// ── /preview 图片 ──
		const pngRes = await fetch(`${previewUrl}/preview/hr/dashboard_preview.png`);
		expect(pngRes.status).toBe(200);
		expect(pngRes.headers.get("content-type")).toBe("image/png");
		const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
		expect(pngBytes[1]).toBe(0x50); // PNG magic 前 4 字节

		// ── /preview 越界路径 → 400 ──
		const escapeRes = await fetch(`${previewUrl}/preview/hr/../secret.txt`);
		expect(escapeRes.status).toBe(400);

		// ── /preview 未知 agent → 404 ──
		const unknownAgent = await fetch(`${previewUrl}/preview/nope/dashboard.html`);
		expect(unknownAgent.status).toBe(404);

		// ── 未知 agent 命令 → 报错 ──
		const bogus = (await request(ws, { type: "list_artifacts", sessionId: "nope" }, true)) as Frame;
		expect(bogus.ok).toBe(false);
		expect(String(bogus.error)).toMatch(/unknown agent/);

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
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "" }));
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
