import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@cornfield/agent";
import { getBundledModel } from "@cornfield/ai";
import { ModelRegistry } from "@cornfield/coding-agent/config/model-registry";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { AgentSession } from "@cornfield/coding-agent/session/agent-session";
import { AuthStorage } from "@cornfield/coding-agent/session/auth-storage";
import { maybeAutoTitle, type TitleGenerator } from "@cornfield/coding-agent/session/auto-title";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import { TempDir } from "@cornfield/utils";

/**
 * maybeAutoTitle 是「首条消息自动起名」规则的唯一实现，CLI / wire-stdio / serve 三处共用。
 * 这里用真 SessionManager（临时目录）和注入的假起名器验证规则本身，不打网络。
 */

/** 假起名器：原样记下每次调用，既能断言「一次都没被调用」，也能断言入参确实是本会话的模型与配置。 */
function recordingGenerator(title: string | null): {
	calls: Parameters<TitleGenerator>[];
	generator: TitleGenerator;
} {
	const calls: Parameters<TitleGenerator>[] = [];
	const generator: TitleGenerator = async (...args) => {
		calls.push(args);
		return title;
	};
	return { calls, generator };
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

describe("maybeAutoTitle", () => {
	const originalNoTitle = process.env.PI_NO_TITLE;
	const originalSessionName = process.env.PI_SESSION_NAME;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession;

	beforeEach(async () => {
		// 两条环境开关按用例单独控制：PI_NO_TITLE 是起名硬开关，PI_SESSION_NAME 是 getSessionName 的兜底，
		// 都会被外面的 shell 污染，所以每个用例先在干净基线上跑。
		delete process.env.PI_NO_TITLE;
		delete process.env.PI_SESSION_NAME;

		tempDir = TempDir.createSync("@pi-auto-title-");
		const cwd = path.join(tempDir.path(), "cwd");
		const sessionDir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// 真 SessionManager + 临时 sessionDir：标题落盘走的是真路径，只是不碰 ~/.cornfield。
		sessionManager = SessionManager.create(cwd, sessionDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		restoreEnv("PI_NO_TITLE", originalNoTitle);
		restoreEnv("PI_SESSION_NAME", originalSessionName);
	});

	it("首条消息 + 无名 + 生成成功：以 auto 落上并返回该名字", async () => {
		const { calls, generator } = recordingGenerator("修复内存泄漏");

		const applied = await maybeAutoTitle(session, "帮我看下这个内存泄漏", generator);

		expect(applied).toBe("修复内存泄漏");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("帮我看下这个内存泄漏");
		// 起名器必须拿到本会话自己的注册表/配置/模型——这正是当年内联版本逐参数传的那几样。
		expect(calls[0]?.[1]).toBe(session.modelRegistry);
		expect(calls[0]?.[2]).toBe(session.settings);
		expect(calls[0]?.[3]).toBe(session.sessionId);
		expect(calls[0]?.[4]).toBe(session.model);
		expect(sessionManager.getSessionName()).toBe("修复内存泄漏");
		expect(sessionManager.titleSource).toBe("auto");
	});

	it("已经有 user 消息：生成器一次都没被调用", async () => {
		session.agent.appendMessage({ role: "user", content: "前面说过的话", timestamp: Date.now() });
		const { calls, generator } = recordingGenerator("不该被写上的名字");

		const applied = await maybeAutoTitle(session, "第二条消息", generator);

		expect(applied).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(sessionManager.getSessionName()).toBeUndefined();
		expect(sessionManager.titleSource).toBeUndefined();
	});

	it("用户已手动命名：不覆盖，名字不变", async () => {
		await sessionManager.setSessionName("我的会话", "user");
		const { calls, generator } = recordingGenerator("自动名字");

		const applied = await maybeAutoTitle(session, "随便说点什么", generator);

		expect(applied).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(sessionManager.getSessionName()).toBe("我的会话");
		expect(sessionManager.titleSource).toBe("user");
	});

	it("gateway 子进程（PI_SESSION_NAME 兜底 + 没落过盘的名字）：照常起名", async () => {
		// gateway 把 accountId 注进 PI_SESSION_NAME 当子进程的 intercom 身份（gateway.ts →
		// agent-transport-wire.ts），env 兜底不该被当成「这个会话已经有名字」——否则 wire-stdio
		// 那处调用对所有 IM 会话都是死代码。
		process.env.PI_SESSION_NAME = "hr";
		const { calls, generator } = recordingGenerator("季度复盘");

		const applied = await maybeAutoTitle(session, "帮我把这个季度的复盘整理一下", generator);

		expect(calls).toHaveLength(1);
		expect(applied).toBe("季度复盘");
		// 落盘的名字优先于 env 兜底：env 继续只服务未命名的会话。
		expect(sessionManager.getSessionName()).toBe("季度复盘");
		expect(sessionManager.titleSource).toBe("auto");
	});

	it("没有可用 title 模型：默认起名器返回 null，不起名、不发网络请求", async () => {
		// 默认起名器（真 generateSessionTitle）在没有可用模型时直接返回 null（title-generator.ts
		// 的 getTitleModel），连 API key 都不去取——gateway 那种「配了会话但没配 smol 模型」的
		// 环境必须静默：不写名字、不抛、不产生请求。
		const availableSpy = vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const applied = await maybeAutoTitle(session, "第一条消息");

		expect(availableSpy).toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(applied).toBeUndefined();
		expect(sessionManager.getSessionName()).toBeUndefined();
		expect(sessionManager.titleSource).toBeUndefined();
	});

	it("生成期间用户抢着命名：auto 名不覆盖用户名字", async () => {
		// 守卫在生成前判过一次，但生成要花一次模型调用，这中间用户可能已经 /rename 了——
		// 所以 setSessionName 拒绝时也不能算落上。
		const generator: TitleGenerator = async () => {
			await sessionManager.setSessionName("用户抢在前面", "user");
			return "自动名字";
		};

		const applied = await maybeAutoTitle(session, "随便说点什么", generator);

		expect(applied).toBeUndefined();
		expect(sessionManager.getSessionName()).toBe("用户抢在前面");
		expect(sessionManager.titleSource).toBe("user");
	});

	it("PI_NO_TITLE=1：生成器一次都没被调用", async () => {
		process.env.PI_NO_TITLE = "1";
		const { calls, generator } = recordingGenerator("不该被写上的名字");

		const applied = await maybeAutoTitle(session, "第一条消息", generator);

		expect(applied).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(sessionManager.getSessionName()).toBeUndefined();
	});

	it("生成器返回 null 或空串：不写名字、不抛", async () => {
		const nullGen = recordingGenerator(null);
		await expect(maybeAutoTitle(session, "第一条消息", nullGen.generator)).resolves.toBeUndefined();
		expect(nullGen.calls).toHaveLength(1);
		expect(sessionManager.getSessionName()).toBeUndefined();
		expect(sessionManager.titleSource).toBeUndefined();

		const emptyGen = recordingGenerator("");
		await expect(maybeAutoTitle(session, "第二条消息", emptyGen.generator)).resolves.toBeUndefined();
		expect(sessionManager.getSessionName()).toBeUndefined();
	});

	it("名字被清洗成空：视为没落上", async () => {
		const { generator } = recordingGenerator("   ");

		const applied = await maybeAutoTitle(session, "第一条消息", generator);

		expect(applied).toBeUndefined();
		expect(sessionManager.getSessionName()).toBeUndefined();
		expect(sessionManager.titleSource).toBeUndefined();
	});

	it("生成器抛异常或 reject：不抛给调用方", async () => {
		await expect(
			maybeAutoTitle(session, "第一条消息", async () => {
				throw new Error("model down");
			}),
		).resolves.toBeUndefined();
		expect(sessionManager.getSessionName()).toBeUndefined();

		await expect(
			maybeAutoTitle(session, "第二条消息", () => Promise.reject(new Error("network error"))),
		).resolves.toBeUndefined();
		expect(sessionManager.getSessionName()).toBeUndefined();
	});

	it("规则在调用那一刻同步判定：起名途中提交的消息不影响本次起名", async () => {
		// CLI / wire-stdio 都是「先发起名、再提交消息」。守卫必须在这一刻（prompt 落库之前）
		// 就判完，否则第一条消息一进 history，起名就永远不会触发。
		const { calls, generator } = recordingGenerator("自动名字");

		const pending = maybeAutoTitle(session, "第一条消息", generator);
		session.agent.appendMessage({ role: "user", content: "刚刚提交的第一条消息", timestamp: Date.now() });

		expect(calls).toHaveLength(1);
		await expect(pending).resolves.toBe("自动名字");
		expect(sessionManager.titleSource).toBe("auto");
	});
});
