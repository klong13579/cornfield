/**
 * W3 D5 e2e — serve `get_skills` 只读技能列表（真实 serve 子进程 + bun WS 客户端）。
 *
 * 预置：用户级技能（$HOME/.omp/agent/skills/）+ 项目级技能（serve cwd 的 .omp/skills/），
 * SKILL.md frontmatter 同真机格式。验证 session.skills 同源列表 + level 分类。
 *
 * 验证：
 *   1. get_skills ok，返回两个预置技能（name/description/source/level/provider）
 *   2. level 分类正确：用户级 = user / 项目级 = project
 *   3. 不依赖任何 attached session 之外的进程态（定向默认 active agent）
 *
 * 隔离 HOME + 临时项目 cwd（serve 以绝对路径启动），不污染仓库。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

type Frame = { type: string; [k: string]: unknown };

import * as net from "node:net";

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

interface SkillEntry {
	name: string;
	description: string;
	source: string;
	level: "user" | "project" | "native";
	provider: string;
}

let isolatedHome: string;
let projectCwd: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

async function waitForServe(p: ReturnType<typeof Bun.spawn>): Promise<string> {
	const deadline = Date.now() + 30_000;
	const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`serve exited; log:\n${buf.slice(-1500)}`);
		buf += dec.decode(value);
		const m = buf.match(URL_RE);
		if (m) {
			reader.releaseLock();
			return m[0];
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready; log:\n${buf.slice(-1500)}`);
}

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
async function request(ws: WebSocket, command: Record<string, unknown>): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await nextFrame(ws, fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${command.type}`);
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
}

async function rawRequest(ws: WebSocket, command: Record<string, unknown>): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await nextFrame(ws, fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${command.type}`);
	return f;
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

function skillMd(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: |\n  ${description}\ntriggers:\n  - "test trigger"\n---\n`;
}

describe("P2-W3-3 — set_skill_enabled（B3 技能写协议）", () => {
	test("停用 → get_skills 移除 + config.yml 写入；启用 → 恢复", async () => {
		const ws = await connect(url);
		try {
			// 初始：demo-user-skill 在已加载集
			const before = (await request(ws, { type: "get_skills" })) as { skills: SkillEntry[] };
			expect(before.skills.some(s => s.name === "demo-user-skill")).toBe(true);

			// 停用
			const off = (await rawRequest(ws, {
				type: "set_skill_enabled",
				name: "demo-user-skill",
				enabled: false,
			})) as Frame;
			expect(off.ok).toBe(true);
			const offRes = off.result as { enabled: boolean };
			expect(offRes.enabled).toBe(false);

			// get_skills 立即移除（重发现热重载），且 disabled 名单带上描述（SKILL.md 元数据）
			const afterOff = (await request(ws, { type: "get_skills" })) as {
				skills: SkillEntry[];
				disabled?: { name: string; description?: string }[];
			};
			expect(afterOff.skills.some(s => s.name === "demo-user-skill")).toBe(false);
			expect(Array.isArray(afterOff.disabled)).toBe(true);
			const dropped = afterOff.disabled?.find(d => d.name === "demo-user-skill");
			expect(dropped).toBeDefined();
			expect(dropped?.description).toContain("用户级技能 seed");

			// config.yml 落盘（settings.ignoredSkills 含 demo-user-skill）——后台异步保存，轮询等写入
			const cfgPath = path.join(isolatedHome, ".omp", "agent", "config.yml");
			let cfg = "";
			const cfgDeadline = Date.now() + 3000;
			while (Date.now() < cfgDeadline) {
				cfg = await Bun.file(cfgPath)
					.text()
					.catch(() => "");
				if (cfg.includes("demo-user-skill")) break;
				await Bun.sleep(100);
			}
			expect(cfg).toContain("demo-user-skill");

			// 启用 → 恢复
			const on = (await rawRequest(ws, {
				type: "set_skill_enabled",
				name: "demo-user-skill",
				enabled: true,
			})) as Frame;
			expect(on.ok).toBe(true);
			const afterOn = (await request(ws, { type: "get_skills" })) as {
				skills: SkillEntry[];
				disabled?: { name: string }[];
			};
			expect(afterOn.skills.some(s => s.name === "demo-user-skill")).toBe(true);
			expect(afterOn.disabled?.some(d => d.name === "demo-user-skill")).toBe(false);
		} finally {
			ws.close();
		}
	}, 30_000);

	test("非法技能名（含路径分隔符）→ 结构化错误 internal", async () => {
		const ws = await connect(url);
		try {
			const bad = (await rawRequest(ws, {
				type: "set_skill_enabled",
				name: "../evil",
				enabled: false,
			})) as Frame;
			expect(bad.ok).toBe(false);
			const err = bad.error as { code?: string; message?: string };
			expect(typeof err).toBe("object");
			expect(err.code).toBe("internal");
		} finally {
			ws.close();
		}
	});
});

describe("W3 D5 — serve get_skills 只读技能列表", () => {
	test("get_skills: 用户级 + 项目级技能（level 分类正确）", async () => {
		const ws = await connect(url);
		try {
			const result = (await request(ws, { type: "get_skills" })) as { skills: SkillEntry[] };
			expect(Array.isArray(result.skills)).toBe(true);

			const userSkill = result.skills.find(s => s.name === "demo-user-skill");
			expect(userSkill).toBeDefined();
			expect(userSkill?.description).toContain("用户级技能 seed");
			expect(userSkill?.level).toBe("user");

			const projectSkill = result.skills.find(s => s.name === "demo-project-skill");
			expect(projectSkill).toBeDefined();
			expect(projectSkill?.description).toContain("项目级技能 seed");
			expect(projectSkill?.level).toBe("project");

			for (const skill of [userSkill, projectSkill]) {
				expect(typeof skill?.source).toBe("string");
				expect(skill?.source.length ?? 0).toBeGreaterThan(0);
				expect(typeof skill?.provider).toBe("string");
			}
		} finally {
			ws.close();
		}
	});

	test("get_skills: 幂等（重复调用同结果，无副作用）", async () => {
		const ws = await connect(url);
		try {
			const again = (await request(ws, { type: "get_skills" })) as { skills: SkillEntry[] };
			expect(again.skills.some(s => s.name === "demo-user-skill")).toBe(true);
			expect(again.skills.some(s => s.name === "demo-project-skill")).toBe(true);
		} finally {
			ws.close();
		}
	});
});

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-skills-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// 用户级技能：$HOME/.omp/agent/skills/<name>/SKILL.md
	const userSkillDir = path.join(isolatedHome, ".omp", "agent", "skills", "demo-user-skill");
	await fs.mkdir(userSkillDir, { recursive: true });
	await Bun.write(path.join(userSkillDir, "SKILL.md"), skillMd("demo-user-skill", "用户级技能 seed for wire e2e"));

	// 项目级技能：<serve cwd>/.omp/skills/<name>/SKILL.md——serve 以临时项目为 cwd 启动
	projectCwd = path.join(isolatedHome, "project");
	const projectSkillDir = path.join(projectCwd, ".omp", "skills", "demo-project-skill");
	await fs.mkdir(projectSkillDir, { recursive: true });
	await Bun.write(
		path.join(projectSkillDir, "SKILL.md"),
		skillMd("demo-project-skill", "项目级技能 seed for wire e2e"),
	);

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await freePort();
	proc = Bun.spawn(
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
		{
			cwd: projectCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	url = await waitForServe(proc);
}, 30_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});
