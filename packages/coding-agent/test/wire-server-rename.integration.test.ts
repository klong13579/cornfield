/**
 * `rename_session` e2e（真 serve 子进程 + 隔离 HOME）：给列表里那些**不在本进程**的历史会话改名。
 *
 * 为什么不能复用 `set_session_name`：那条按**附件地址**定位，只能改本连接此刻挂着的那个会话；
 * 历史会话不在任何附件上，够不到。两条命令的分工就是这组用例在钉的东西 —— 磁盘上的会话文件走
 * `rename_session`，挂着的会话走 `set_session_name`（本文件只钉它的反例：挂着的文件走 rename_session 要被拒）。
 *
 * 三条拒绝规则各有一例（越界路径 / 挂着的会话 / 刚被写过），因为它们的失败模式都是**静默改错东西**：
 * 越界写是事故；改挂着的会话会让内存态与文件漂；替换一个正被别的进程写的文件，对方之后的追加会写进
 * 被摘掉的 inode（随它的句柄一起消失）。用例里也钉「拒绝时文件一个字节没动」——拒绝必须是干净的。
 *
 * fixture 全部在隔离 HOME 内、serve 启动前落盘（registry 是 serve 启动期快照）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

interface IndexEntry {
	sessionId: string;
	title?: string;
	sessionFile: string;
}

let fixture: ServeFixture | undefined;
/** 隔离 HOME 里 hr 的会话目录（fixture 与用例共用同一份路径推导）。 */
let hrSessions = "";
/** 两条预置历史会话的绝对路径（按名字取，不用猜顺序）。 */
const HR_FILES: Record<"titled" | "untitled", string> = { titled: "", untitled: "" };

function entryLine(type: string, extra: Record<string, unknown>, id = Math.random().toString(36).slice(2, 10)): string {
	return JSON.stringify({ type, id, parentId: null, timestamp: new Date().toISOString(), ...extra });
}

async function seedHome(home: string): Promise<void> {
	const hrDir = path.join(home, "agents", "hr");
	hrSessions = path.join(hrDir, "sessions", "by-date", "2026-08-18");
	await fs.mkdir(hrSessions, { recursive: true });
	await fs.mkdir(path.join(hrDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);

	const mk = async (file: string, id: string, header: Record<string, unknown>): Promise<void> => {
		const target = path.join(hrSessions, file);
		await Bun.write(
			target,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id,
					timestamp: "2026-08-18T10:00:00.000Z",
					cwd: hrDir,
					...header,
				}),
				entryLine("model_change", { model: "test-provider/test-model" }),
				entryLine("message", {
					message: {
						role: "user",
						content: [{ type: "text", text: "q" }],
						timestamp: Date.now(),
					},
				}),
				entryLine("message", {
					message: {
						role: "assistant",
						content: [{ type: "text", text: "a" }],
						stopReason: "stop",
						timestamp: Date.now(),
						// usage 与真实落盘同形：`SessionManager.open` 读会话时会聚合用量，缺了它就报
						// 「undefined is not an object (evaluating 'usage.input')」—— 那是夹具不像真文件，不是产品缺陷。
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				}),
			].join("\n")}\n`,
		);
		// 年纪：新鲜的文件会被 rename 的「刚被改过」那道闸挡下（那条规则另有用例）。
		const old = new Date(Date.now() - 60 * 60 * 1000);
		await fs.utimes(target, old, old);
	};

	HR_FILES.titled = path.join(hrSessions, "100000__aaaa1111.jsonl");
	HR_FILES.untitled = path.join(hrSessions, "110000__bbbb2222.jsonl");
	await mk("100000__aaaa1111.jsonl", "aaaa1111-0000-7000-0000-000000000001", {
		title: "老名字",
		titleSource: "auto",
	});
	await mk("110000__bbbb2222.jsonl", "bbbb2222-0000-7000-0000-000000000002", {});

	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);
}

async function connect(wsUrl: string): Promise<WebSocket> {
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "" }));
	if (!(await nextFrame(ws, f => f.type === "hello_ack", 10_000))) throw new Error("no hello_ack");
	return ws;
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

let seq = 0;
/** 发一条命令；`raw` 时把响应帧原样交回（要看 ok:false 的原文）。 */
async function request(ws: WebSocket, command: Record<string, unknown>, raw = false): Promise<unknown> {
	const id = `r${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const frame = await nextFrame(ws, f => f.type === "response" && f.id === id, 30_000);
	if (!frame) throw new Error(`timeout: ${String(command.type)}`);
	if (raw) return frame;
	if (frame.ok !== true) throw new Error(`command failed: ${JSON.stringify(frame)}`);
	return frame.result;
}

/** 读一条会话文件的「头行 + 其余字节」——其余部分必须逐字节原样（改名只动第一行）。 */
async function readSplit(file: string): Promise<{ header: Record<string, unknown>; rest: string }> {
	const text = await Bun.file(file).text();
	const newline = text.indexOf("\n");
	return {
		header: JSON.parse(newline >= 0 ? text.slice(0, newline) : text) as Record<string, unknown>,
		rest: newline >= 0 ? text.slice(newline) : "",
	};
}

beforeAll(async () => {
	fixture = await spawnServeFixture({
		homePrefix: "omp-serve-rename-",
		cwd: home => home,
		seed: seedHome,
	});
}, SERVE_BOOT_BUDGET_MS);

afterAll(async () => {
	await fixture?.dispose();
});

describe("rename_session：改磁盘上的历史会话", () => {
	test("改成功：头行换名、titleSource=user、其余字节逐字不动、list_sessions 跟着变", async () => {
		const ws = await connect(fixture!.url);
		try {
			const before = await readSplit(HR_FILES.titled);
			expect(before.header.title).toBe("老名字");

			await request(ws, { type: "rename_session", sessionFile: HR_FILES.titled, name: "新名字" });

			const after = await readSplit(HR_FILES.titled);
			expect(after.header.title).toBe("新名字");
			expect(after.header.titleSource).toBe("user");
			// 头行里的其它事实没被顺手重写（改名不是一次「打开并重存」）
			expect(after.header.id).toBe(before.header.id);
			expect(after.header.timestamp).toBe(before.header.timestamp);
			expect(after.header.cwd).toBe(before.header.cwd);
			// 其余字节逐字一致
			expect(after.rest).toBe(before.rest);

			// 列表读的是同一条事实
			const listed = (await request(ws, { type: "list_sessions", sessionId: "hr" })) as { sessions: IndexEntry[] };
			const entry = listed.sessions.find(s => s.sessionFile === HR_FILES.titled);
			expect(entry?.title).toBe("新名字");
		} finally {
			ws.close();
		}
	});

	test("名字按会话头同一套规则清洗（控制字符 → 空格、折叠空白、trim）", async () => {
		const ws = await connect(fixture!.url);
		try {
			await request(ws, { type: "rename_session", sessionFile: HR_FILES.untitled, name: "  带   空白\t的 名字  " });
			const after = await readSplit(HR_FILES.untitled);
			expect(after.header.title).toBe("带 空白 的 名字");
			expect(after.header.titleSource).toBe("user");
		} finally {
			ws.close();
		}
	});

	test("拒绝必须是干净的：越界路径 / 非 jsonl / 不存在 / 空名字 —— 都不许动文件", async () => {
		const ws = await connect(fixture!.url);
		try {
			const before = await readSplit(HR_FILES.titled);
			const outside = path.join(fixture!.home, "outside.jsonl");
			await Bun.write(
				outside,
				`${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/" })}\n`,
			);
			const notJsonl = path.join(hrSessions, "note.txt");
			await Bun.write(notJsonl, "not a session\n");

			const cases: { command: Record<string, unknown>; error: RegExp }[] = [
				{ command: { sessionFile: outside, name: "x" }, error: /outside every agent's sessions root/ },
				{ command: { sessionFile: notJsonl, name: "x" }, error: /not a session file/ },
				{ command: { sessionFile: path.join(hrSessions, "nope.jsonl"), name: "x" }, error: /not found/ },
				{ command: { sessionFile: HR_FILES.titled, name: "   " }, error: /cannot be empty/ },
			];
			for (const { command, error } of cases) {
				const frame = (await request(ws, { type: "rename_session", ...command }, true)) as Frame;
				expect(frame.ok).toBe(false);
				expect(String(frame.error)).toMatch(error);
			}

			// 一个字节都没动
			const after = await readSplit(HR_FILES.titled);
			expect(after).toEqual(before);
			// 越界的那个也没被改名
			expect((await readSplit(outside)).header.title).toBeUndefined();
		} finally {
			ws.close();
		}
	});

	test("刚被改过的文件拒绝（别的进程可能正拿着它写，替换会摘掉 inode）", async () => {
		const ws = await connect(fixture!.url);
		try {
			await fs.utimes(HR_FILES.untitled, new Date(), new Date());
			const frame = (await request(
				ws,
				{ type: "rename_session", sessionFile: HR_FILES.untitled, name: "太急了" },
				true,
			)) as Frame;
			expect(frame.ok).toBe(false);
			expect(String(frame.error)).toMatch(/modified seconds ago/);

			// 把年纪还回去，后面的用例还要用它
			const old = new Date(Date.now() - 60 * 60 * 1000);
			await fs.utimes(HR_FILES.untitled, old, old);
		} finally {
			ws.close();
		}
	});

	test("挂着的会话拒绝：那条路属于 set_session_name（内存态与文件是同一份事实）", async () => {
		const ws = await connect(fixture!.url);
		try {
			await request(ws, { type: "switch_session", sessionId: "hr" });
			const agents = (await request(ws, { type: "list_agents" })) as {
				agents: { id: string; sessionFile?: string }[];
			};
			const attachedFile = agents.agents.find(a => a.id === "hr")?.sessionFile;
			expect(typeof attachedFile).toBe("string");

			const frame = (await request(
				ws,
				{ type: "rename_session", sessionFile: attachedFile as string, name: "改挂着的" },
				true,
			)) as Frame;
			expect(frame.ok).toBe(false);
			expect(String(frame.error)).toMatch(/open in this process/);
		} finally {
			ws.close();
		}
	});
});
