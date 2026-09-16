/**
 * 会话头里的 Project 归属（T24）。
 *
 * 契约：Project 由 caller 解析后传入，store **只记不推**（与 `agentId` / `agentSource` 同一条规矩，
 * 见 WP4 与 `session-manager.ts` 里那段注释）。所以这里验的是四件事：
 *   - 传了就落盘、没传就**没有这个键**（不是落一个空串或默认 Project）；
 *   - `setResolvedProject` 只补不覆盖（归属是历史，不是可改的偏好）；
 *   - 同 cwd 的派生会话（fork / branch）把它带走，换 cwd 的派生（forkFrom）不带；
 *   - `moveTo` 之后不残留（搬迁那条测试在 `move-to.test.ts`，属于既有 CLI 能力）。
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
import { getConfigRootDir, setAgentDir } from "@cornfield/utils";

import { makeAssistantMessage } from "./helpers";

function headerOf(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader =>
			typeof e === "object" && e !== null && "type" in e && (e as SessionHeader).type === "session",
	);
}

/** 新建会话 + 一条 assistant 消息 + flush：文件落盘，header 就是盘上的那一份。 */
async function persist(session: SessionManager): Promise<void> {
	session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
}

describe("会话头的 Project 归属", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.CORNFIELD_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cornfield-project-binding-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.CORNFIELD_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("caller 传了 project（NewSessionOptions）= 落盘，且 provenance 一起落", async () => {
		const session = SessionManager.create(cwd);
		await session.newSession({ project: { projectId: "repo", source: "session" } });

		await persist(session);

		const header = headerOf(await loadEntriesFromFile(session.getSessionFile()!));
		expect(header?.projectId).toBe("repo");
		expect(header?.projectSource).toBe("session");
	});

	it("没传 project = 头上就没有这个键（不是空串，也不是某个默认 Project）", async () => {
		const session = SessionManager.create(cwd);

		await persist(session);

		const header = headerOf(await loadEntriesFromFile(session.getSessionFile()!));
		expect(header).toBeDefined();
		expect("projectId" in (header as SessionHeader)).toBe(false);
		expect("projectSource" in (header as SessionHeader)).toBe(false);
	});

	it("setResolvedProject 补上归属；已有归属时不动它（历史不可改写）", async () => {
		const session = SessionManager.create(cwd);
		await persist(session);

		expect(await session.setResolvedProject({ projectId: "repo", source: "cwd" })).toBe(true);
		expect(session.getHeader()?.projectId).toBe("repo");
		expect(session.getHeader()?.projectSource).toBe("cwd");
		// 文件已在盘上：写回是**重写头**，条目不变
		const header = headerOf(await loadEntriesFromFile(session.getSessionFile()!));
		expect(header?.projectId).toBe("repo");

		expect(await session.setResolvedProject({ projectId: "other", source: "session" })).toBe(false);
		expect(session.getHeader()?.projectId).toBe("repo");
		expect(session.getHeader()?.projectSource).toBe("cwd");
	});

	it("fork：同 cwd 的派生把归属带走（记录的断言仍然成立）", async () => {
		const session = SessionManager.create(cwd);
		await session.newSession({ project: { projectId: "repo", source: "session" } });
		await persist(session);

		const forked = await session.fork();

		const header = headerOf(await loadEntriesFromFile(forked!.newSessionFile));
		expect(header?.projectId).toBe("repo");
		expect(header?.projectSource).toBe("session");
		expect(header?.cwd).toBe(session.getCwd());
	});

	it("createBranchedSession：同 cwd 的派生同样带走归属", async () => {
		const session = SessionManager.create(cwd);
		await session.newSession({ project: { projectId: "repo", source: "session" } });
		const leaf = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const branchFile = session.createBranchedSession(leaf);

		const header = headerOf(await loadEntriesFromFile(branchFile!));
		expect(header?.projectId).toBe("repo");
		expect(header?.projectSource).toBe("session");
	});

	it("forkFrom：cwd 是调用方的，所以源会话的归属**不**跟着走（不能替它断言）", async () => {
		const sourceCwd = path.join(testAgentDir, "source-cwd");
		const targetCwd = path.join(testAgentDir, "target-cwd");
		fs.mkdirSync(sourceCwd, { recursive: true });
		fs.mkdirSync(targetCwd, { recursive: true });

		const source = SessionManager.create(sourceCwd);
		await source.newSession({ project: { projectId: "repo", source: "session" } });
		await persist(source);

		const forked = await SessionManager.forkFrom(source.getSessionFile()!, targetCwd);

		const header = forked.getHeader();
		expect(header?.cwd).toBe(path.resolve(targetCwd));
		expect("projectId" in (header as SessionHeader)).toBe(false);
	});
});
