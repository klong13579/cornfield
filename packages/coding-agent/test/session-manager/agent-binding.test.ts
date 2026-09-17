/**
 * 会话头里的 Agent 归属：分支会话随行（WP4 —— 会话的 Agent 是历史，不是每次重新决议的值）。
 *
 * 契约与 Project 归属同规（实现里那两段复制就在相邻几行，见 `project-binding.test.ts`）：
 *   - 源头 header 记了 Agent → 分支**读盘后的 header** 记同一份 id 与 source；
 *   - 源头没记 → 分支也**没有这两个键**（不是值为 undefined，也不拿当前默认顶上）；
 *   - 老会话只记了 agentId、没记 agentSource → 缺什么少什么，不替它编一个 source。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
} from "@cornfield/coding-agent/session/session-manager";
import { getConfigRootDir, setDefaultAgentHome } from "@cornfield/utils";

import { makeAssistantMessage } from "./helpers";

function headerOf(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader =>
			typeof e === "object" && e !== null && "type" in e && (e as SessionHeader).type === "session",
	);
}

describe("会话头的 Agent 归属：分支随行", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentHome = process.env.CORNFIELD_CLIENT_DIR;
	const fallbackAgentHome = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cornfield-agent-binding-"));
		setDefaultAgentHome(testAgentDir);
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentHome) {
			setDefaultAgentHome(originalAgentHome);
		} else {
			setDefaultAgentHome(fallbackAgentHome);
			delete process.env.CORNFIELD_CLIENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("源头记了 Agent → 分支读盘后的 header 也记同一份（id 与 source）", async () => {
		const session = SessionManager.create(cwd, undefined, undefined, { agentId: "hr", source: "project" });
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		expect(headerOf(await loadEntriesFromFile(session.getSessionFile()!))?.agentId).toBe("hr");

		const branchFile = session.createBranchedSession(leaf);

		const header = headerOf(await loadEntriesFromFile(branchFile!));
		expect(header?.agentId).toBe("hr");
		expect(header?.agentSource).toBe("project");
	});

	it("源头没记 Agent → 分支头上就没有这两个键（不是 undefined 值）", async () => {
		const session = SessionManager.create(cwd);
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const branchFile = session.createBranchedSession(leaf);

		const header = headerOf(await loadEntriesFromFile(branchFile!));
		expect(header).toBeDefined();
		expect("agentId" in (header as SessionHeader)).toBe(false);
		expect("agentSource" in (header as SessionHeader)).toBe(false);
	});

	it("老会话只记了 agentId、没记 agentSource → 只带 id，不给 source 编值", async () => {
		const session = SessionManager.create(cwd, undefined, undefined, { agentId: "hr", source: "project" });
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		// 盘上的头去掉 agentSource：模拟 agent pinning 之前写下的会话。
		const file = session.getSessionFile()!;
		const lines = (await Bun.file(file).text()).trimEnd().split("\n");
		const legacyHeader = JSON.parse(lines[0]) as SessionHeader;
		delete legacyHeader.agentSource;
		await Bun.write(file, `${[JSON.stringify(legacyHeader), ...lines.slice(1)].join("\n")}\n`);

		const reopened = await SessionManager.open(file);
		expect(reopened.getHeader()?.agentSource).toBeUndefined();

		const branchFile = reopened.createBranchedSession(leaf);

		const header = headerOf(await loadEntriesFromFile(branchFile!));
		expect(header?.agentId).toBe("hr");
		expect("agentSource" in (header as SessionHeader)).toBe(false);
	});

	it("非持久化 manager：没有文件可读，分支在内存里的 header 同样带着源头的 Agent", async () => {
		const session = SessionManager.inMemory(cwd);
		expect(await session.setResolvedAgent({ agentId: "hr", source: "project" })).toBe(true);
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		expect(session.createBranchedSession(leaf)).toBeUndefined();

		const header = session.getHeader();
		expect(header?.agentId).toBe("hr");
		expect(header?.agentSource).toBe("project");
	});

	it("非持久化 manager：源头没记 Agent，分支也没有这两个键", async () => {
		const session = SessionManager.inMemory(cwd);
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		expect(session.createBranchedSession(leaf)).toBeUndefined();

		const header = session.getHeader() as SessionHeader;
		expect("agentId" in header).toBe(false);
		expect("agentSource" in header).toBe(false);
	});
});
