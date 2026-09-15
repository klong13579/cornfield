/**
 * serve 侧 Session Tree 桥的测试（T8）。
 *
 * 全部用**真实**部件：真 SessionManager（落盘 JSONL）、真 AgentSession、真
 * `SessionLogTreeStore`（账本写进去的方式与 `SessionTreeManager` 用的完全一致）、
 * 真结果文件。唯一没起的是子会话进程 —— 桥本来也不起进程。
 *
 * 覆盖的是「桥会不会撒谎」，不是「账本状态机对不对」（那在 session-tree*.test.ts 里）：
 * 空账本不是错误、坏条目不是空账本、第二次带回不再注入、缺父边不补假值。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@cornfield/agent";
import { getBundledModel } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { AgentMeta } from "@cornfield/coding-agent/server/session-registry";
import {
	bringBackChildResult,
	CHILD_RESULT_CUSTOM_TYPE,
	readSessionTree,
} from "@cornfield/coding-agent/server/session-tree-wire";
import { AgentSession } from "@cornfield/coding-agent/session/agent-session";
import { convertToLlm } from "@cornfield/coding-agent/session/messages";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import type { ChildSessionRecord } from "@cornfield/coding-agent/session/session-tree";
import { SESSION_TREE_CUSTOM_TYPE, SessionLogTreeStore } from "@cornfield/coding-agent/session/session-tree-store";
import { TempDir } from "@cornfield/utils";

class MockAssistantStream extends AssistantMessageEventStream {}

const META: AgentMeta = { id: "hr", name: "HR Agent", agentDir: "/tmp/hr-agent" };

let tempDir: TempDir;
let sessionManager: SessionManager;
let session: AgentSession;
let ledger: SessionLogTreeStore;

function childRecord(overrides: Partial<ChildSessionRecord["node"]> = {}, runId = "run-1"): ChildSessionRecord {
	return {
		node: {
			sessionId: "child-1",
			agentId: "hr",
			parentSessionId: session.sessionId,
			rootSessionId: session.sessionId,
			depth: 1,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
			...overrides,
		},
		runId,
		createdAt: 1_000,
		updatedAt: 1_000,
	};
}

/** 桥写进父会话的 custom message 文本（`sessionManager.getEntries()` 里的原始条目）。 */
function resultEntries(): string[] {
	const out: string[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== CHILD_RESULT_CUSTOM_TYPE) continue;
		out.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
	}
	return out;
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@cornfield-session-tree-wire-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	// AuthStorage / ModelRegistry 不能静态导入：organize-imports 会把 model-registry 排到
	// settings 前面，而 settings-schema 与 model-registry 是循环依赖，从 model-registry 一侧
	// 进入时 settings-schema 会在 MODEL_ROLE_IDS 初始化前读到它（TDZ）。同一手法见
	// agent-session-openai-responses-replay.test.ts。
	const { AuthStorage } = await import("@cornfield/coding-agent/session/auth-storage");
	const { ModelRegistry } = await import("@cornfield/coding-agent/config/model-registry");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

	sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [], messages: [] },
		convertToLlm,
		streamFn: () => new MockAssistantStream(),
	});
	session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });
	ledger = new SessionLogTreeStore(sessionManager);
});

afterEach(async () => {
	await tempDir[Symbol.asyncDispose]();
});

describe("readSessionTree", () => {
	it("answers an empty children list for a session that delegated nothing", async () => {
		const tree = await readSessionTree(session, META);
		expect(tree.sessionId).toBe(session.sessionId);
		expect(tree.agentId).toBe("hr");
		expect(tree.agentName).toBe("HR Agent");
		expect(tree.children).toEqual([]);
	});

	it("projects a ledger node field for field", async () => {
		await ledger.save(
			childRecord({
				status: "waiting_user",
				delegationRole: "research",
				objective: "研究编辑器方案",
				resultRef: "/tmp/result.md",
				resultBroughtBackAt: 2_000,
			}),
		);
		const stored = (await ledger.load())[0];
		await ledger.save({ ...stored, lastPid: 4_242, statusDetail: "child asked a question" });

		const tree = await readSessionTree(session, META);
		expect(tree.children).toHaveLength(1);
		const child = tree.children[0];
		expect(child.sessionId).toBe("child-1");
		expect(child.parentSessionId).toBe(session.sessionId);
		expect(child.rootSessionId).toBe(session.sessionId);
		expect(child.depth).toBe(1);
		expect(child.status).toBe("waiting_user");
		expect(child.delegationRole).toBe("research");
		expect(child.objective).toBe("研究编辑器方案");
		expect(child.resultRef).toBe("/tmp/result.md");
		expect(child.resultBroughtBackAt).toBe(2_000);
		expect(child.lastPid).toBe(4_242);
		expect(child.statusDetail).toBe("child asked a question");
	});

	it("keeps a readable ledger when one entry cannot be read — it fails instead of dropping it", async () => {
		sessionManager.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, { version: 99, record: {} });
		await expect(readSessionTree(session, META)).rejects.toThrow(/version 99/);
	});

	it("refuses to invent a parent edge for a node that has none", async () => {
		const record = childRecord();
		delete record.node.parentSessionId;
		await ledger.save(record);
		await expect(readSessionTree(session, META)).rejects.toThrow(/no parent edge/);
	});

	it("answers every delegation the session's ledger holds", async () => {
		await ledger.save(childRecord({ sessionId: "child-a" }, "run-a"));
		await ledger.save(childRecord({ sessionId: "child-b" }, "run-b"));
		expect((await readSessionTree(session, META)).children.map(c => c.sessionId).sort()).toEqual([
			"child-a",
			"child-b",
		]);
	});
});

describe("bringBackChildResult", () => {
	it("reads the result, stamps the ledger on disk, and injects it once into the parent", async () => {
		const resultFile = path.join(tempDir.path(), "result.md");
		await Bun.write(resultFile, "# 结论\n保留首页快速会话");
		await ledger.save(childRecord({ status: "completed", resultRef: resultFile, delegationRole: "research" }));

		const first = await bringBackChildResult(session, META, "child-1");
		expect(first.firstTime).toBe(true);
		expect(first.injected).toBe(true);
		expect(first.resultRef).toBe(resultFile);
		expect(first.content).toContain("保留首页快速会话");

		// 注入的内容带着来源，父会话的模型分得清「子会话带回来的产物」与「用户说的话」
		const injected = resultEntries();
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain("[child-session-result]");
		expect(injected[0]).toContain('"childSessionId":"child-1"');
		expect(injected[0]).toContain("保留首页快速会话");

		// 落盘：会话文件里既有账本条目，也有带回时间戳
		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		const text = await Bun.file(sessionFile as string).text();
		expect(text).toContain(SESSION_TREE_CUSTOM_TYPE);
		expect(text).toContain(String(first.broughtBackAt));
	});

	it("does not inject a second time — the same result is one piece of work", async () => {
		const resultFile = path.join(tempDir.path(), "result.md");
		await Bun.write(resultFile, "done");
		await ledger.save(childRecord({ status: "completed", resultRef: resultFile }));

		const first = await bringBackChildResult(session, META, "child-1");
		const second = await bringBackChildResult(session, META, "child-1");

		expect(second.firstTime).toBe(false);
		expect(second.injected).toBe(false);
		expect(second.broughtBackAt).toBe(first.broughtBackAt);
		expect(second.content).toBe(first.content);
		expect(resultEntries()).toHaveLength(1);
	});

	it("refuses a child that has no result yet instead of returning an empty one", async () => {
		await ledger.save(childRecord({ status: "running" }));
		await expect(bringBackChildResult(session, META, "child-1")).rejects.toThrow(/result is ready before/);
		expect(resultEntries()).toHaveLength(0);
	});

	it("refuses a child this session never delegated", async () => {
		await expect(bringBackChildResult(session, META, "child-nope")).rejects.toThrow(/not in this session's ledger/);
	});

	it("fails loudly when the result pointer cannot be read", async () => {
		await ledger.save(childRecord({ status: "completed", resultRef: path.join(tempDir.path(), "missing.md") }));
		await expect(bringBackChildResult(session, META, "child-1")).rejects.toThrow();
		expect(resultEntries()).toHaveLength(0);
	});
});
