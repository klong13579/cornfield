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
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@cornfield/agent";
import { getBundledModel } from "@cornfield/ai";
import { AssistantMessageEventStream } from "@cornfield/ai/utils/event-stream";
import { upsertProject } from "@cornfield/coding-agent/agent-domain/project-store";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { Message, SessionInfo } from "@cornfield/coding-agent/intercom-extension/types";
import type { AgentMeta } from "@cornfield/coding-agent/server/session-registry";
import {
	bringBackChildResult,
	CHILD_RESULT_CUSTOM_TYPE,
	type DelegationHost,
	type DelegationHostInput,
	delegateChildSession,
	readSessionTree,
	ServeIntercomPresence,
	type SessionTreeWireOptions,
} from "@cornfield/coding-agent/server/session-tree-wire";
import { AgentSession } from "@cornfield/coding-agent/session/agent-session";
import {
	type ChildSessionSupervisor,
	ChildSessionSupervisor as Supervisor,
} from "@cornfield/coding-agent/session/child-session-supervisor";
import { convertToLlm } from "@cornfield/coding-agent/session/messages";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import type { ChildSessionRecord } from "@cornfield/coding-agent/session/session-tree";
import { SessionTreeManager } from "@cornfield/coding-agent/session/session-tree-manager";
import { SESSION_TREE_CUSTOM_TYPE, SessionLogTreeStore } from "@cornfield/coding-agent/session/session-tree-store";
import { TempDir } from "@cornfield/utils";
import { createFakeChildSession, type FakeChild, type FakeChildOptions } from "../session/fake-child-session";

class MockAssistantStream extends AssistantMessageEventStream {}

/**
 * 一条会重连的连接：`connected = false` 就是它掉了，下一次 `listSessions()` 会换一条新的。
 *
 * 只能靠事件发射器而不靠真 socket 才能把「连接对象被换掉」这条路径跑出来，而那正是上报
 * 收口会静默失效的地方。
 */
class FakePresenceClient extends EventEmitter {
	connected = false;

	async connect(): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async listSessions(): Promise<SessionInfo[]> {
		return [];
	}

	/** 子会话从自己那边发一条上报（父会话就是以 intercom 消息收到的）。 */
	report(text: string): void {
		const from: SessionInfo = {
			id: "child-1",
			cwd: "/tmp/child",
			model: "test-model",
			pid: 4_242,
			startedAt: 1,
			lastActivity: 1,
		};
		const message: Message = { id: "m1", timestamp: 1, content: { text } };
		this.emit("message", from, message);
	}
}

// agentDir 必须是一个真目录：委派的缺省 cwd 就是它（拿一个不存在的 home 当 cwd，子进程
// 在 spawn 处就失败 —— 那正是「home 真的是 cwd」的证明，见下面的坏 home 用例）。
let META: AgentMeta;

async function fakeChild(options: FakeChildOptions = {}): Promise<FakeChild> {
	// 缺省：这条 fixture 自称跑在父会话自己的 Agent 上（同 Agent 委派的用例）。
	// 跨 Agent 的用例必须显式说它自称是哪个 Agent —— 那就是被测的断言本身。
	const fixture = await createFakeChildSession({ reportsAgentId: META.id, ...options });
	fixtures.push(fixture);
	return fixture;
}

/** 子进程实际被 spawn 在哪个目录里（fixture 自己记下的，不是 spec 里写的）。 */
async function childCwd(child: FakeChild): Promise<string | undefined> {
	const boot = (await child.events()).find(entry => entry.event === "boot");
	return typeof boot?.cwd === "string" ? boot.cwd : undefined;
}

/** 子进程自己看到的 Agent 家（`CORNFIELD_AGENT_DIR`）—— 子进程自己记的，不是 spec 里写的。 */
async function childAgentDir(child: FakeChild): Promise<string | undefined> {
	const boot = (await child.events()).find(entry => entry.event === "boot");
	return typeof boot?.agentDir === "string" ? boot.agentDir : undefined;
}

/** `prompt` 请求带过去的原文（按到达顺序）。 */
async function childPrompts(child: FakeChild): Promise<string[]> {
	const prompts: string[] = [];
	for (const entry of await child.events()) {
		if (entry.event !== "request" || entry.command !== "prompt") continue;
		prompts.push(typeof entry.message === "string" ? entry.message : "");
	}
	return prompts;
}

/**
 * 宿主接缝：真 `ChildSessionSupervisor`（真进程生命周期）+ 脚本化的注册门。
 *
 * 注册门是「子进程真的以本会话为 parent 挂上了 broker」的唯一证据，也是这条命令唯一
 * 会拒绝启动的地方；花名册那一半留给 E2E（`session-tree-e2e.test.ts`）。
 */
function delegationOptions(
	child: FakeChild,
	scripts: { refuseRegistration?: boolean; requestTimeoutMs?: number } = {},
): SessionTreeWireOptions {
	return {
		host: (input: DelegationHostInput): DelegationHost => {
			const supervisor = new Supervisor({
				maxConcurrent: 2,
				registration: {
					async awaitRegistration() {
						if (scripts.refuseRegistration) throw new Error("child never registered as a child of parent-1");
					},
				},
				restart: { maxRestarts: 0, baseBackoffMs: 10, maxBackoffMs: 20 },
				process: {
					readyTimeoutMs: 10_000,
					requestTimeoutMs: scripts.requestTimeoutMs ?? 5_000,
					abortTimeoutMs: 300,
					exitGraceMs: 1_000,
					termGraceMs: 500,
				},
			});
			supervisors.push(supervisor);
			return {
				manager: new SessionTreeManager({
					self: input.self,
					supervisor,
					store: new SessionLogTreeStore(sessionManager),
				}),
				command: { bin: child.path, args: [] },
				async open(): Promise<void> {},
			};
		},
	};
}

/**
 * 宿主接缝：只抓桥声明的委派身份，不真起子进程 —— 父边 id 是桥自己的事，没有进程也说得清。
 * 注册门与真进程归 `delegateChildSession` 的用例，`readSessionTree` 只读账本。
 */
function selfCapturingOptions(captured: Array<DelegationHostInput["self"]>): SessionTreeWireOptions {
	return {
		host: (input: DelegationHostInput): DelegationHost => {
			captured.push(input.self);
			const supervisor = new Supervisor({
				maxConcurrent: 1,
				registration: {
					async awaitRegistration() {},
				},
				restart: { maxRestarts: 0, baseBackoffMs: 10, maxBackoffMs: 20 },
				process: {
					readyTimeoutMs: 1_000,
					requestTimeoutMs: 1_000,
					abortTimeoutMs: 100,
					exitGraceMs: 100,
					termGraceMs: 50,
				},
			});
			supervisors.push(supervisor);
			return {
				manager: new SessionTreeManager({
					self: input.self,
					supervisor,
					store: new SessionLogTreeStore(sessionManager),
				}),
				command: { bin: process.execPath, args: [] },
				async open(): Promise<void> {},
			};
		},
	};
}

/**
 * 父边 id：本会话自己的 intercom 身份 + `-tree` 后缀。
 *
 * 身份只有一个来源（`resolveIntercomSessionId`：进程环境里的 `PI_INTERCOM_STABLE_ID`，否则会话 id），
 * 后缀不能省 —— 一个 id 只能有一个活着的连接（broker 会拒绝第二个），serve 这条边必须用另一个地址
 * 上线，否则会话自己的 intercom 先占住那个 id，这条边永远上不了线。
 */
describe("parent edge identity", () => {
	it("is the session's own intercom id plus the -tree suffix", async () => {
		const declared: Array<DelegationHostInput["self"]> = [];

		await readSessionTree(session, META, selfCapturingOptions(declared));

		expect(declared).toHaveLength(1);
		expect(declared[0]?.sessionId).toBe(session.sessionId);
		expect(declared[0]?.intercomSessionId).toBe(`${session.sessionId}-tree`);
	});

	it("follows a pinned PI_INTERCOM_STABLE_ID, keeping the suffix", async () => {
		const previous = process.env.PI_INTERCOM_STABLE_ID;
		process.env.PI_INTERCOM_STABLE_ID = "pinned-parent";
		const declared: Array<DelegationHostInput["self"]> = [];
		try {
			await readSessionTree(session, META, selfCapturingOptions(declared));
		} finally {
			if (previous === undefined) delete process.env.PI_INTERCOM_STABLE_ID;
			else process.env.PI_INTERCOM_STABLE_ID = previous;
		}

		expect(declared[0]?.intercomSessionId).toBe("pinned-parent-tree");
	});
});

/**
 * 委派身份里的归属（T27）。
 *
 * 会话树上子节点的 `projectId` 不是桥编的：它来自**父会话的权威归属**
 * （`session/session-workspace`：会话头记的优先，旧会话才按 cwd 匹配）。解析不出来就失败 ——
 * 不填等于把一个有归属的父会话委派出来的子会话记成游离的。
 *
 * 注册表是客户端级的（HOME 下的 projects.json），所以这条用例自己隔离 HOME：不隔离就是拿
 * 跑测试这台机器上真实的注册表当输入，「那个 Project 存不存在」会取决于开发机的状态。
 */
describe("delegation identity attribution", () => {
	it("carries the Project the parent session resolves to", async () => {
		const savedHome = process.env.HOME;
		const savedConfigDir = process.env.CORNFIELD_CONFIG_DIR;
		const home = TempDir.createSync("@cornfield-session-tree-home-");
		try {
			process.env.HOME = home.path();
			delete process.env.CORNFIELD_CONFIG_DIR;
			await upsertProject({ projectId: "tree-proj", root: tempDir.path(), name: "Tree" });
			const declared: Array<DelegationHostInput["self"]> = [];

			await readSessionTree(session, META, selfCapturingOptions(declared));

			expect(declared[0]?.projectId).toBe("tree-proj");
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedConfigDir === undefined) delete process.env.CORNFIELD_CONFIG_DIR;
			else process.env.CORNFIELD_CONFIG_DIR = savedConfigDir;
			await home[Symbol.asyncDispose]();
		}
	});
});

/**
 * fixture 靠进程环境选行为与日志位置，而桥**不**接受调用方给的子进程环境
 * （让客户端决定子进程环境就是把一条 IPC 请求变成任意代码执行），所以这里改进程环境。
 */
function useChildEnv(child: FakeChild): () => void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(child.env)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

let tempDir: TempDir;
let sessionManager: SessionManager;
let session: AgentSession;
let ledger: SessionLogTreeStore;

/** 委派测试起的子进程与 supervisor，在 afterEach 收尾（不留孤儿进程）。 */
const supervisors: ChildSessionSupervisor[] = [];
const fixtures: FakeChild[] = [];

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
	META = { id: "hr", name: "HR Agent", agentDir: tempDir.path() };
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
	for (const supervisor of supervisors.splice(0)) await supervisor.stopAll();
	for (const fixture of fixtures.splice(0)) {
		await fixture.requestExit();
		await fixture.awaitExit();
		await fixture.cleanup();
	}
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

describe("delegateChildSession", () => {
	it("delegates a real child process and answers with its ledger identity", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			const dto = await delegateChildSession(
				session,
				META,
				{ objective: "研究编辑器方案", label: "research" },
				delegationOptions(child),
			);

			expect(dto.objective).toBe("研究编辑器方案");
			expect(dto.delegationRole).toBe("research");
			expect(dto.agentId).toBe("hr");
			expect(dto.status).toBe("running");
			expect(dto.runId.trim()).not.toBe("");
			expect(dto.pid).toBeGreaterThan(0);
			// 真的起了一个进程：fixture 自己记下的 pid 与账本回执里的是同一个。
			expect(await child.recordedPid()).toBe(dto.pid ?? null);

			// 账本真的写进去了（不是只回了一条 DTO）；钻回来的树与回执同一个节点。
			const tree = await readSessionTree(session, META, delegationOptions(child));
			expect(tree.children.map(c => c.sessionId)).toEqual([dto.sessionId]);
			expect(tree.children[0]).toMatchObject({
				parentSessionId: session.sessionId,
				rootSessionId: session.sessionId,
				depth: 1,
				agentId: "hr",
				status: "running",
				objective: "研究编辑器方案",
				delegationRole: "research",
			});

			const sessionFile = session.sessionFile;
			expect(sessionFile).toBeDefined();
			expect(await Bun.file(sessionFile as string).text()).toContain(SESSION_TREE_CUSTOM_TYPE);
		} finally {
			restoreEnv();
		}
	});

	it("hands the objective to the child over its own request channel", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			await delegateChildSession(session, META, { objective: "研究编辑器方案" }, delegationOptions(child));

			// 子会话真的收到了那条派工（fixture 自己记的请求日志），而且收到的是这句话。
			expect(await child.receivedRequests()).toContain("prompt");
			expect(await childPrompts(child)).toEqual(["研究编辑器方案"]);

			// 派工是在命令返回之前完成的：返回时子会话已经拿着活了。
			const tree = await readSessionTree(session, META, delegationOptions(child));
			expect(tree.children[0]?.objective).toBe("研究编辑器方案");
		} finally {
			restoreEnv();
		}
	});

	it("fails the delegation and stops the child when the objective cannot be handed over", async () => {
		const child = await fakeChild({ behavior: "reject-requests" });
		const restoreEnv = useChildEnv(child);
		try {
			const options = delegationOptions(child);
			await expect(delegateChildSession(session, META, { objective: "研究编辑器方案" }, options)).rejects.toThrow(
				/never received its objective/,
			);

			// 没有「乐观 started 记录」：这条委派没产出任何东西，账本说 failed 而不是 running。
			const tree = await readSessionTree(session, META);
			expect(tree.children.map(c => c.status)).toEqual(["failed"]);
			expect(tree.children[0]?.statusDetail).toContain("the objective never reached the child");

			// 子进程真的被停掉了、并发额度还回来了：否则每次失败都白占一个槽位。
			expect(await child.awaitExit(8_000)).toBe(true);
			expect(supervisors.at(-1)?.concurrency()).toEqual({ active: 0, limit: 2, queued: 0 });
		} finally {
			restoreEnv();
		}
	});

	it("records a child that never answered and would not stop as still running", async () => {
		// 一条连 EOF / SIGTERM 都不理会的子会话：连第一个问题都答不上 → 判决 failed，
		// 但停不下来也是事实。
		const child = await fakeChild({ behavior: "eof-blind" });
		const restoreEnv = useChildEnv(child);
		try {
			const options = delegationOptions(child, { requestTimeoutMs: 300 });
			await expect(delegateChildSession(session, META, { objective: "研究编辑器方案" }, options)).rejects.toThrow(
				/does not run as Agent "hr"/,
			);

			const tree = await readSessionTree(session, META);
			expect(tree.children.map(c => c.status)).toEqual(["failed"]);
			// 两个事实都要在：这次委派没成，以及它的进程还占着一个槽位。
			expect(tree.children[0]?.statusDetail).toContain("the child never confirmed it runs as Agent");
			expect(tree.children[0]?.statusDetail).toContain("it is still running");
		} finally {
			restoreEnv();
		}
	});

	it("refuses a child that reports a different Agent than the one the ledger names", async () => {
		// 账本说 ops，子会话自称 hr：这正是一个「UI 报 ops、实际跑在别人配置下」的委派，
		// 账本条目本身永远看不出来。fixture 自己记的环境是唯一的证据。
		const child = await fakeChild({ reportsAgentId: "hr" });
		const restoreEnv = useChildEnv(child);
		// A real directory: the target Agent's home is also the child's default cwd, so a
		// home that does not exist would fail at spawn instead of at the identity check.
		const opsHome = path.join(tempDir.path(), "ops-home");
		await fs.mkdir(opsHome, { recursive: true });
		try {
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "跨 Agent 委派", agentId: "ops" },
					{
						...delegationOptions(child),
						resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: opsHome }),
					},
				),
			).rejects.toThrow(/does not run as Agent "ops"/);

			// 账本说清结局：一 failed，不是一条 running；整个调用也没回一条「已委派」。
			const tree = await readSessionTree(session, META);
			expect(tree.children.map(c => c.status)).toEqual(["failed"]);
			expect(tree.children[0]?.agentId).toBe("ops");
			expect(tree.children[0]?.statusDetail).toContain('reports Agent "hr"');

			// 活没交出去：子会话只被问过身份，一条 prompt 都没收到。
			expect(await childPrompts(child)).toEqual([]);
			expect(await child.receivedRequests()).toContain("get_state");
			// 而且它真的被停掉了（不留一个跑在错误 Agent 下的进程占槽位）。
			expect(await child.awaitExit(8_000)).toBe(true);
			expect(supervisors.at(-1)?.concurrency()).toEqual({ active: 0, limit: 2, queued: 0 });
		} finally {
			restoreEnv();
		}
	});

	it("fails the delegation when the target Agent has no directory to run in", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "跨 Agent 委派", agentId: "ghost" },
					{
						...delegationOptions(child),
						resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: "   " }),
					},
				),
			).rejects.toThrow(/has no agent directory to run a child in/);

			// 连进程都没起：解析不出家的 Agent 不能用「反正 cwd 对了」冒充它。
			const tree = await readSessionTree(session, META);
			expect(tree.children).toEqual([]);
			expect(await child.recordedPid()).toBeNull();
		} finally {
			restoreEnv();
		}
	});

	it("hands the target Agent's home to the child even when the cwd is this session's own directory", async () => {
		// 两个事实不能混：子进程在**哪个工作区**干活（cwd）与它是**哪个 Agent**（agentDir）。
		// 一条 cwd 覆盖的委派同样必须把目标 Agent 的家交给子进程。
		const child = await fakeChild({ reportsAgentId: "ops" });
		const restoreEnv = useChildEnv(child);
		const opsHome = path.join(tempDir.path(), "ops-home");
		try {
			const dto = await delegateChildSession(
				session,
				META,
				{ objective: "跨 Agent 委派", agentId: "ops", cwd: sessionManager.getCwd() },
				{
					...delegationOptions(child),
					resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: opsHome }),
				},
			);
			expect(dto.agentId).toBe("ops");
			expect(await childAgentDir(child)).toBe(opsHome);
			expect(await fs.realpath((await childCwd(child)) as string)).toBe(await fs.realpath(tempDir.path()));
		} finally {
			restoreEnv();
		}
	});

	it("fails with the registration reason and records no started child", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "研究编辑器方案" },
					delegationOptions(child, { refuseRegistration: true }),
				),
			).rejects.toThrow(/child never registered as a child of parent-1/);

			// 父会话确实委派过，账本要说清发生了什么：一条 failed，任何 running 都是谎言。
			const tree = await readSessionTree(session, META);
			expect(tree.children.map(c => c.status)).toEqual(["failed"]);
			expect(tree.children[0]?.statusDetail).toContain("child never registered");
		} finally {
			restoreEnv();
		}
	});

	it("refuses an unknown target Agent before anything is launched", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "研究编辑器方案", agentId: "ghost" },
					{ ...delegationOptions(child), resolveAgent: () => undefined },
				),
			).rejects.toThrow(/unknown agent "ghost"/);
			expect((await readSessionTree(session, META)).children).toEqual([]);
		} finally {
			restoreEnv();
		}
	});

	it("records the target Agent and runs the child in that Agent's home", async () => {
		const child = await fakeChild({ reportsAgentId: "ops" });
		const restoreEnv = useChildEnv(child);
		const home = tempDir.path();
		try {
			const dto = await delegateChildSession(
				session,
				META,
				{ objective: "跨 Agent 委派", agentId: "ops" },
				{
					...delegationOptions(child),
					resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: home }),
				},
			);
			expect(dto.agentId).toBe("ops");
			expect((await readSessionTree(session, META)).children[0]?.agentId).toBe("ops");

			// 子进程真的以那个 Agent 的家为运行目录（`CORNFIELD_AGENT_DIR`）：这是「它**是**
			// 哪个 Agent」的唯一决定者，而 cwd 不是。fixture 记的是它自己看到的进程环境，
			// 不是 spec 的字段。
			expect(await childAgentDir(child)).toBe(home);
			expect(await fs.realpath((await childCwd(child)) as string)).toBe(await fs.realpath(home));

			// home 真的被当作 cwd：一个不能当工作目录的 home（文件）在启动处就失败，
			// 而不是偷偷跑到本进程的 cwd 里。
			const notADirectory = path.join(tempDir.path(), "not-a-directory");
			await Bun.write(notADirectory, "");
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "坏 home", agentId: "broken" },
					{
						...delegationOptions(child),
						resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: notADirectory }),
					},
				),
			).rejects.toThrow();
		} finally {
			restoreEnv();
		}
	});

	it("refuses an empty objective and a relative cwd instead of launching something", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			await expect(
				delegateChildSession(session, META, { objective: "   " }, delegationOptions(child)),
			).rejects.toThrow(/non-empty objective/);
			await expect(
				delegateChildSession(session, META, { objective: "ok", cwd: "relative/dir" }, delegationOptions(child)),
			).rejects.toThrow(/cwd must be an absolute path/);
			expect((await readSessionTree(session, META)).children).toEqual([]);
		} finally {
			restoreEnv();
		}
	});

	it("refuses a caller-chosen cwd outside the locations the server authorizes", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		// 一个真实存在、但不在授权集里的目录：拒绝必须来自策略，而不是「这个目录不存在」。
		const outside = path.dirname(tempDir.path());
		try {
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "研究编辑器方案", cwd: outside },
					delegationOptions(child),
				),
			).rejects.toThrow(/not a location this server authorizes/);

			// 连父会话工作目录的子目录也不认：授权的是精确位置，不是一裸前缀。
			await expect(
				delegateChildSession(
					session,
					META,
					{ objective: "研究编辑器方案", cwd: path.join(tempDir.path(), "sub") },
					delegationOptions(child),
				),
			).rejects.toThrow(/not a location this server authorizes/);

			// 拒绝发生在 spawn 之前：没有子进程、没有账本条目。
			expect((await readSessionTree(session, META)).children).toEqual([]);
		} finally {
			restoreEnv();
		}
	});

	it("runs the child in an authorized cwd override — this session's own working directory", async () => {
		const child = await fakeChild({ reportsAgentId: "ops" });
		const restoreEnv = useChildEnv(child);
		// 目标 Agent 的 home 与父会话的工作目录是**两个不同**的授权位置：把子进程放到后者，
		// 它真的跑在那里（fixture 自己记的 cwd），而不是回到缺省的那个 home。
		const otherHome = path.join(tempDir.path(), "ops-home");
		try {
			const dto = await delegateChildSession(
				session,
				META,
				{ objective: "跨 Agent 委派", agentId: "ops", cwd: sessionManager.getCwd() },
				{
					...delegationOptions(child),
					resolveAgent: agentId => ({ id: agentId, name: agentId, agentDir: otherHome }),
				},
			);
			expect(dto.agentId).toBe("ops");
			const spawnedIn = await childCwd(child);
			expect(spawnedIn).toBeDefined();
			expect(await fs.realpath(spawnedIn as string)).toBe(await fs.realpath(tempDir.path()));
		} finally {
			restoreEnv();
		}
	});

	it("keeps one manager per session — a second delegation lands in the same ledger", async () => {
		const child = await fakeChild();
		const restoreEnv = useChildEnv(child);
		try {
			const options = delegationOptions(child);
			const firstDto = await delegateChildSession(session, META, { objective: "第一条" }, options);
			const secondDto = await delegateChildSession(session, META, { objective: "第二条" }, options);
			expect(firstDto.sessionId).not.toBe(secondDto.sessionId);
			expect(firstDto.runId).not.toBe(secondDto.runId);
			const tree = await readSessionTree(session, META);
			expect(tree.children.map(c => c.objective).sort()).toEqual(["第一条", "第二条"]);
		} finally {
			restoreEnv();
		}
	});
});

describe("ServeIntercomPresence", () => {
	it("rebinds child report ingestion when the broker connection is replaced", async () => {
		const first = new FakePresenceClient();
		const second = new FakePresenceClient();
		const queue = [first, second];
		const presence = new ServeIntercomPresence({
			session,
			meta: META,
			sessionId: "parent-edge",
			createClient: () => {
				const next = queue.shift();
				if (!next) throw new Error("the presence asked for a third connection; this test only provides two");
				return next;
			},
		});
		const received: string[] = [];
		const sink = {
			async applyReport(_from: { pid: number }, text: string): Promise<void> {
				received.push(text);
			},
		};
		/** `open()` 每次委派做的事：先确保在线，再把上报收口接到当下这条连接上。 */
		const open = async (): Promise<void> => {
			await presence.listSessions();
			presence.attachReports(sink);
		};

		await open();
		expect(first.connected).toBe(true);
		first.report('[child-session] {"runId":"run-1","lifecycle":"progress"}');
		expect(received).toHaveLength(1);

		// 连接掉了：下一次 open() 会拿一条**新连接**（同一个 presence 继续用）。先把重连
		// 单独跑出来（open() 的第一步），才能看见「新连接上暂时没人听」这一段。
		first.connected = false;
		await presence.listSessions();
		expect(second.connected).toBe(true);
		second.report('[child-session] {"runId":"run-1","lifecycle":"waiting"}');
		expect(received).toHaveLength(1);

		// open() 的第二步：重挂到新连接上。此后就再也不能丢了。
		presence.attachReports(sink);
		second.report('[child-session] {"runId":"run-1","lifecycle":"completed"}');
		first.report('[child-session] {"runId":"run-1","lifecycle":"failed"}');
		expect(received.map(text => JSON.parse(text.slice("[child-session] ".length)).lifecycle)).toEqual([
			"progress",
			"completed",
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
