/**
 * wire-server 只读巡检 e2e（真机 serve 子进程 + bun WS/HTTP 客户端）——三组只读命令共用一个 serve。
 *
 * 覆盖命令：
 * - list_artifacts：产物提取/分类/mtime 倒序/过滤已删文件、sessionFile 维度隔离视图、未知 agent 报错；
 *   配套 /preview/<agentId>/<path> 静态预览（HTML 内容 + content-type、图片字节、路径越界 400、未知 agent 404）
 * - list_sessions：历史会话索引（结构字段、状态推断、时间倒序、agent 过滤、limit、标题来源优先级）
 * - get_memory：只读记忆投影三分区（user / project / memoryStore）
 *
 * fixture 全部在隔离 HOME 内、serve 启动前落盘（不依赖 serve 写状态）：
 * - agents/hr（id hr / name hr-agent）：6 条历史会话 JSONL —— 3 条带 header.title + 首条 user 消息推导
 *   + 文件名 slug 推导 + subagent 子会话任务名（list_sessions）
 * - agents/art（id art）：dashboard.html / dashboard_preview.png 真实产物文件 + 2 条含 write /
 *   puppeteer screenshot toolCall 的会话 JSONL（list_artifacts + /preview）
 * - .cornfield/user.md（user 区）+ .cornfield/self-evolution/memory/<encoded repoRoot>/
 *   {MEMORY.md,memory_summary.md}（project 区）
 *
 * 产物 fixture 刻意挂在独立 agent 上：indexSessions 与 listAgentArtifacts 都递归扫
 * <agentDir>/sessions，产物会话若与历史会话同处 hr，list_sessions 的精确条目断言（6 条 + 标题序列）会失真。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）；
 * 下面的 `seedHome` 在 spawn 前把 fixture 落进那个 HOME —— registry 是 serve 启动期快照，
 * 启动后写就读不到了。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

interface ArtifactRow {
	id: string;
	title: string;
	type: string;
	path: string;
	updatedAt: number;
	size: number;
}

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

interface MemoryFileDto {
	path: string;
	content: string;
	truncated: boolean;
}

interface MemoryResult {
	user: MemoryFileDto | null;
	project: {
		memoryRoot: string;
		memoryMd: MemoryFileDto | null;
		summaryMd: MemoryFileDto | null;
		rawMd: MemoryFileDto | null;
	} | null;
	memoryStore: { dbPath: string; sections: { namespace: string; entries: unknown[] }[]; totalEntries: number };
}

/** 构造一条 entry 行（与 session-manager 落盘结构同构）。 */
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

/** 与 self-evolution paths.encodeProjectPathForGlobalMemory 同规则。 */
function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

// ── 共享 WS 客户端（三个来源只有这一份实现）──

async function connect(wsUrl: string): Promise<WebSocket> {
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const token = wsUrl.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
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

// ── 隔离 HOME（fixture 提供）+ 共享 serve ──

/** 产物 fixture 的 HTML 内容（seedHome 写入，测试体断言同源）。 */
const DASHBOARD_HTML = "<!doctype html><html><body><h1>Dashboard</h1></body></html>";

let fixture: ServeFixture | undefined;
let repoRoot = "";
/** 产物 fixture 的会话目录（sessionFile 维度断言用）。 */
let artSessions = "";

beforeAll(async () => {
	repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

	fixture = await spawnServeFixture({
		homePrefix: "omp-serve-inspection-",
		// serve 的 cwd = packages/coding-agent → 归一为 repo 根（project 区记忆锚点，与 fixture 编码一致）
		cwd: path.join(repoRoot, "packages", "coding-agent"),
		seed: seedHome,
	});
}, SERVE_BOOT_BUDGET_MS);

afterAll(async () => {
	await fixture?.dispose();
});

/**
 * 把全部 fixture 写进夹具的隔离 HOME。由 `spawnServeFixture` 在 `Bun.spawn` **之前** await
 * —— registry 是 serve 启动期的快照，启动后写就读不到了。
 */
async function seedHome(home: string): Promise<void> {
	// ── agent hr：6 条历史会话 JSONL（list_sessions）──
	const hrDir = path.join(home, "agents", "hr");
	const hrSessions = path.join(hrDir, "sessions", "by-date", "2026-08-18");
	await fs.mkdir(hrSessions, { recursive: true });
	await fs.mkdir(path.join(hrDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);

	// startTime 递增，最新的是 complete
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

	// ── agent art：真实产物文件 + 2 条会话（list_artifacts / /preview）──
	const artDir = path.join(home, "agents", "art");
	artSessions = path.join(artDir, "sessions", "by-date", "2026-08-27");
	await fs.mkdir(artSessions, { recursive: true });
	await fs.mkdir(path.join(artDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(artDir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "art", name: "art-agent", type: "agent", root: ".", projectRoot: "." }),
	);

	// 产物文件：dashboard.html（存在）+ dashboard_preview.png（存在）+ stale.txt（只写会话不写文件）
	await Bun.write(path.join(artDir, "dashboard.html"), DASHBOARD_HTML);
	await Bun.write(
		path.join(artDir, "dashboard_preview.png"),
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	);

	const artHeader = (id: string, startIso: string) =>
		JSON.stringify({ type: "session", version: 3, id, timestamp: startIso, cwd: artDir, title: "artifacts" });

	// 新（write + screenshot，产物存在）；旧（write stale.txt，文件已删）
	await Bun.write(
		path.join(artSessions, "100000__newest.jsonl"),
		`${[
			artHeader("aaaa1111-0000-7000-0000-000000000001", "2026-08-27T10:00:00.000Z"),
			assistantToolCall("write", { path: "dashboard.html", content: DASHBOARD_HTML }),
			assistantToolCall("puppeteer", { action: "screenshot", path: "dashboard_preview.png" }),
		].join("\n")}\n`,
	);
	await Bun.write(
		path.join(artSessions, "090000__oldest.jsonl"),
		`${[
			artHeader("bbbb2222-0000-7000-0000-000000000002", "2026-08-27T09:00:00.000Z"),
			assistantToolCall("write", { path: "stale.txt", content: "deleted" }),
		].join("\n")}\n`,
	);

	// ── registry：hr（历史会话）+ art（产物）──
	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" },
				art: { path: artDir, registeredAt: new Date().toISOString(), template: "default" },
			},
		}),
	);

	// ── get_memory：user 区 ~/.cornfield/user.md + project 区 canonical evolution 目录 ──
	await fs.mkdir(path.join(home, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(home, ".cornfield", "user.md"),
		"# 测试用户画像\n\n- name: 测试用户\n- note: seed content for wire e2e\n",
	);
	const memoryRoot = path.join(home, ".cornfield", "self-evolution", "memory", encodeProjectPath(repoRoot));
	await fs.mkdir(memoryRoot, { recursive: true });
	await Bun.write(path.join(memoryRoot, "MEMORY.md"), "# Memory Report\n\n## project\n\n- 项目记忆 seed\n");
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), "# Memory Summary\n\n- summary seed\n");
}

test("list_artifacts：提取/分类/排序 + /preview 静态服务", async () => {
	const html = DASHBOARD_HTML;
	const ws = await connect(fixture!.url);
	try {
		// ── list_artifacts：art 定向 ──
		const result = (await request(ws, { type: "list_artifacts", sessionId: "art" })) as { artifacts: ArtifactRow[] };
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
		const sessionFiles = [path.join(artSessions, "100000__newest.jsonl")];
		const sessionResult = (await request(ws, {
			type: "list_artifacts",
			sessionId: "art",
			sessionFile: sessionFiles[0],
		})) as { artifacts: ArtifactRow[] };
		expect(sessionResult.artifacts.map(a => a.title).sort()).toEqual(["dashboard.html", "dashboard_preview.png"]);

		// 定向旧会话（stale.txt 已在磁盘删除）→ 空数组，不串当前会话产物
		const staleResult = (await request(ws, {
			type: "list_artifacts",
			sessionId: "art",
			sessionFile: path.join(artSessions, "090000__oldest.jsonl"),
		})) as { artifacts: ArtifactRow[] };
		expect(staleResult.artifacts).toEqual([]);

		// 不存在的 sessionFile（fresh 会话未落盘）→ 诚实返回空数组，不降级 agent 维度
		const missing = (await request(ws, {
			type: "list_artifacts",
			sessionId: "art",
			sessionFile: path.join(artSessions, "nope.jsonl"),
		})) as { artifacts: ArtifactRow[] };
		expect(missing.artifacts).toEqual([]);

		// ── /preview 静态服务：html ──
		const previewUrl = fixture!.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
		const htmlRes = await fetch(`${previewUrl}/preview/art/dashboard.html`);
		expect(htmlRes.status).toBe(200);
		expect(htmlRes.headers.get("content-type")).toContain("text/html");
		expect(await htmlRes.text()).toBe(html);

		// ── /preview 图片 ──
		const pngRes = await fetch(`${previewUrl}/preview/art/dashboard_preview.png`);
		expect(pngRes.status).toBe(200);
		expect(pngRes.headers.get("content-type")).toBe("image/png");
		const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
		expect(pngBytes[1]).toBe(0x50); // PNG magic 前 4 字节

		// ── /preview 越界路径 → 400 ──
		const escapeRes = await fetch(`${previewUrl}/preview/art/../secret.txt`);
		expect(escapeRes.status).toBe(400);

		// ── /preview 未知 agent → 404 ──
		const unknownAgent = await fetch(`${previewUrl}/preview/nope/dashboard.html`);
		expect(unknownAgent.status).toBe(404);

		// ── 未知 agent 命令 → 报错 ──
		const bogus = (await request(ws, { type: "list_artifacts", sessionId: "nope" }, true)) as Frame;
		expect(bogus.ok).toBe(false);
		expect(String(bogus.error)).toMatch(/unknown agent/);
	} finally {
		ws.close();
	}
}, 60_000);

test("list_sessions：索引/状态推断/排序/过滤", async () => {
	const ws = await connect(fixture!.url);
	try {
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
	} finally {
		ws.close();
	}
}, 60_000);

describe("W3 D3 — serve get_memory 只读记忆投影", () => {
	test("get_memory: 三分区结构 + user/project 内容 + memory 区形状", async () => {
		const ws = await connect(fixture!.url);
		try {
			const result = (await request(ws, { type: "get_memory" })) as MemoryResult;

			// 结构
			expect(typeof result).toBe("object");
			expect(result.user).not.toBeNull();
			expect(result.project).not.toBeNull();
			expect(typeof result.memoryStore).toBe("object");

			// user 区：seeded user.md
			expect(result.user?.path.endsWith("user.md")).toBe(true);
			expect(result.user?.content).toContain("测试用户画像");

			// project 区：canonical evolution 目录（self-evolution/memory）优先；
			// 有效 cwd 经 resolveServeProjectRoot 归一到 repo 根。memoryRoot 应指向 seed 的 canonical 目录。
			expect(result.project?.memoryRoot).toBe(
				path.join(fixture!.home, ".cornfield", "self-evolution", "memory", encodeProjectPath(repoRoot)),
			);
			expect(result.project?.memoryMd?.content).toContain("项目记忆 seed");
			expect(result.project?.summaryMd?.content).toContain("summary seed");
			expect(result.project?.rawMd).toBeNull();

			// memory 区：形状齐全；隔离 HOME 下 0 条不崩
			expect(typeof result.memoryStore.dbPath).toBe("string");
			expect(Array.isArray(result.memoryStore.sections)).toBe(true);
			expect(typeof result.memoryStore.totalEntries).toBe("number");
			expect(result.memoryStore.totalEntries).toBe(0);
		} finally {
			ws.close();
		}
	});

	test("get_memory: 不依赖 attached session（registry 级命令可直接调，幂等）", async () => {
		const ws = await connect(fixture!.url);
		try {
			const again = (await request(ws, { type: "get_memory" })) as MemoryResult;
			expect(again.user?.content).toContain("测试用户画像");
			expect(again.memoryStore.totalEntries).toBe(0);
		} finally {
			ws.close();
		}
	});
});
