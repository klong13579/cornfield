import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_IDLE_TIMEOUT_MS, loadConfig } from "../src/lsp/config";

// 空闲超时的默认值只在一处：没有任何 lsp 配置文件给出 idleTimeoutMs 时回落到 DEFAULT_IDLE_TIMEOUT_MS。
// 回归的意义是这个回落本身 —— 它一度是「关闭」（undefined），一个只碰过一个 .ts 文件的长会话
// 会把整套 TypeScript 服务进程（≈150MB）留到进程结束。
//
// 隔离为什么还要 spy os.homedir：Bun 在启动时就把 homedir 缓存住了，只改 process.env.HOME
// 不会改变 os.homedir() 的返回，测试会静默读到开发机真实的 ~/.cornfield/agent/lsp.* 。
describe("lsp idle timeout 默认值", () => {
	let cwd: string;
	let home: string;
	let savedHome: string | undefined;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-idle-"));
		home = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-idle-home-"));
		savedHome = process.env.HOME;
		savedAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.HOME = home;
		delete process.env.CORNFIELD_AGENT_DIR;
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.HOME = savedHome;
		if (savedAgentDir === undefined) delete process.env.CORNFIELD_AGENT_DIR;
		else process.env.CORNFIELD_AGENT_DIR = savedAgentDir;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});

	test("没有任何配置文件时回落到 DEFAULT_IDLE_TIMEOUT_MS", () => {
		expect(loadConfig(cwd).idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
	});

	test("配置文件的显式值优先", () => {
		fs.writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({ idleTimeoutMs: 1234 }));
		expect(loadConfig(cwd).idleTimeoutMs).toBe(1234);
	});

	test("0 = 显式关闭，不被默认值兜底", () => {
		fs.writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({ idleTimeoutMs: 0 }));
		expect(loadConfig(cwd).idleTimeoutMs).toBe(0);
	});
});
