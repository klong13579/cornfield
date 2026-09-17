/**
 * F6 + F2 真实现 e2e —— 一个 agent 的一份配置、模型可见性按 agent。
 *
 * 真 serve + 隔离 HOME + 隔离 project cwd（不 mock、不发 prompt、不产生费用）。
 *
 * F6（写侧跟随读侧优先级）：
 *   - 有 project 层（`<agentDir>/.cornfield/config.yml` 存在）时，`set_config`（不带 scope）写**它**；
 *     写完后 `<agentDir>/config.yml` 一字节都不动（同一个 agent 的一份配置不再被劈成两半）。
 *   - 读侧（`get_config` / `get_tool_switches`）读到的是刚写下去的那份（合并视图：project 压 global）。
 *   - 写 project 只动本次改过的键，文件里原有的键与注释不被整份覆盖。
 *
 * F2（模型可见性按 agent）：
 *   - default agent 停在停用名单里的 provider，不影响 registry agent（旧实现读全局单例，
 *     default 的停用对所有 agent 生效）；
 *   - 同一 provider 的停用名单按 agent 隔离，且 `set_model_disabled` 写在**目标 agent 自己的**
 *     配置里（default 的 config.yml 字节不变 = 没写错人）。
 *
 * F6-骨架：`ensureAgentDir` 写出的 `.cornfield/config.yml` 首次加载不被迁移重写
 * （活键 `modelRoutes` 已在文件里，不再靠 `modelRoles` 迁移；迁移会重写整个文件、丢注释）。
 *
 * 票 24 A′（配置/记忆的项目根按身份解析）：
 *   - default Agent：project 根 = **它的家**（→ project 层 = `<home>/.cornfield/config.yml`，写侧跟随读侧）；
 *     global 层 = **客户端目录那份** `~/.cornfield/agent/config.yml`（用户一直编辑的那份，改什么就生效什么）。
 *     `<home>/config.yml` **不是任何一层**，不许被创建，也不许压掉用户那份。
 *   - registry agent：一字不动（global = 它自己的 `<agentDir>/config.yml`，project = 工作根下的那份）。
 *   - 会话的**工作目录**不跟着走：default 会话的工具 cwd 仍是 serve 的启动目录（会话头记的就是它）。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { getMemoryRoot } from "@cornfield/self-evolution/paths";
import { getDefaultAgentHome, normalizePathForComparison } from "@cornfield/utils";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { YAML } from "bun";
import { migrateLegacyModelConfig } from "../src/config/model-routes";
import { ensureAgentDir, SKELETON_FILES } from "../src/skeleton";
import { waitForServe } from "./wait-for-serve";

/** 只在 models.yml 里声明的无 key provider：无 auth 即 keyless，隔离 HOME 下也能出现在可用列表里。 */
const PROBE_PROVIDER = "config-effective-probe";
const PROBE_MODELS = ["probe-a", "probe-b"];
/** agentDir 自带 project 层（`<agentDir>/.cornfield/config.yml`）的 agent —— 写侧优先级的直接受害者。 */
const PROJECT_LAYER_AGENT = "with-project";

let isolatedHome: string;
let savedHome: string | undefined;
let projectCwd: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";
let token = "";

/** default Agent 的家（agentDir = ~/.cornfield/agents/default，doc §12）。 */
const defaultAgentHome = (): string => path.join(isolatedHome, ".cornfield", "agents", "default");
/** 客户端目录（`~/.cornfield/agent`）：default Agent 的 **global 层** —— 用户一直编辑的那份。 */
const clientDir = (): string => path.join(isolatedHome, ".cornfield", "agent");
/** default Agent 的 global 层（`<clientDir>/config.yml`，Settings 的 configPath）。 */
const globalConfigPath = (): string => path.join(clientDir(), "config.yml");
/** default Agent 的 project 层（`<home>/.cornfield/config.yml`）—— 它自己的那份配置根。 */
const projectConfigPath = (): string => path.join(defaultAgentHome(), ".cornfield", "config.yml");
/** `<home>/config.yml`：**不是任何一层**，不许被创建、也不许压掉 client 那份（票 26 的定案）。 */
const unusedHomeConfigPath = (): string => path.join(defaultAgentHome(), "config.yml");
/** registry agent 的配置文件（没 project 层 → 就是它自己的 config.yml）。 */
const agentConfigPath = (name: string): string => path.join(isolatedHome, "agents", name, "config.yml");
/** agentDir 自带 project 层的 agent 的目录与 project 层文件。 */
const projectLayerAgentDir = (): string => path.join(isolatedHome, "agents", PROJECT_LAYER_AGENT);
const projectLayerAgentConfigPath = (): string => path.join(projectLayerAgentDir(), ".cornfield", "config.yml");

const readBytes = async (file: string): Promise<string> => await Bun.file(file).text();

async function writeDirectoryAgent(name: string): Promise<string> {
	const agentDir = path.join(isolatedHome, "agents", name);
	await fs.mkdir(path.join(agentDir, ".cornfield"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
	await Bun.write(
		path.join(agentDir, ".cornfield", "workspace.json"),
		JSON.stringify({
			schemaVersion: 2,
			id: name,
			name: `${name}-agent`,
			type: "agent",
			root: ".",
			projectRoot: ".",
			skillsDir: ".cornfield/skills/",
			sessionsDir: "sessions/",
		}),
	);
	return agentDir;
}

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-effective-config-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// serve 的 cwd：一个普通项目目录。default Agent 的配置**不**从这里读（它的家才是配置根）。
	projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });

	// default Agent 的 project 层（它自己家里的那份）：**预先存在的** project 文件
	// （层「存在」与否只看这个文件）。
	await fs.mkdir(path.join(defaultAgentHome(), ".cornfield"), { recursive: true });
	await Bun.write(
		projectConfigPath(),
		YAML.stringify({ theme: { dark: "anthracite" }, grep: { enabled: true } }, null, 2),
	);

	// default Agent 的 global 层（客户端目录那份）：自带停用名单（F2 的病灶：它不该影响别的 agent）。
	await fs.mkdir(defaultAgentHome(), { recursive: true });
	await fs.mkdir(clientDir(), { recursive: true });
	await Bun.write(
		globalConfigPath(),
		YAML.stringify({ shellPath: "/bin/zsh", disabledProviders: [PROBE_PROVIDER] }, null, 2),
	);

	// 无 key 的探针 provider：让「可用模型列表」在不同 agent 之间有可观测的差别。
	// models.yml 是**客户端级**的模型目录（ModelRegistry 从 client dir 读），不是某个 agent 的家。
	await fs.mkdir(clientDir(), { recursive: true });
	await Bun.write(
		path.join(clientDir(), "models.yml"),
		YAML.stringify(
			{
				providers: {
					[PROBE_PROVIDER]: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						auth: "none",
						models: PROBE_MODELS.map(id => ({
							id,
							name: id,
							// 有 Thinking 档位的模型：F6 的 thinking 面（set_thinking_level persist）需要有档位可选。
							reasoning: true,
							thinking: { minLevel: "low", maxLevel: "high", mode: "effort" },
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200_000,
							maxTokens: 8_000,
						})),
					},
				},
			},
			null,
			2,
		),
	);

	// registry agent：hr / ops 各自 agentDir（无 project 层）；with-project 的 agentDir 里有 project 层。
	for (const name of ["hr", "ops", PROJECT_LAYER_AGENT]) await writeDirectoryAgent(name);
	await Bun.write(
		path.join(projectLayerAgentDir(), ".cornfield", "config.yml"),
		YAML.stringify(
			{
				theme: { dark: "anthracite" },
				// 它自己的默认角色指向探针 provider —— 而探针 provider 正被 **default agent** 停用：
				// 解析自己会话的模型必须看**自己**的可见性，不是全局单例的。
				modelRoutes: { default: { primary: `${PROBE_PROVIDER}/probe-a` } },
			},
			null,
			2,
		),
	);
	const isolatedClientDir = clientDir();
	await Bun.write(
		path.join(isolatedClientDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: Object.fromEntries(
				["hr", "ops", PROJECT_LAYER_AGENT].map(name => [
					name,
					{
						path: path.join(isolatedHome, "agents", name),
						registeredAt: new Date().toISOString(),
						template: "default",
					},
				]),
			),
		}),
	);

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
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
	const info = await waitForServe(proc, port);
	url = info.url;
	token = info.token;
}, 70_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

describe("F6 写侧跟随读侧优先级", () => {
	test("set_config（不带 scope）写 project 层，global 文件一字节不动，且读得回来", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			const globalBefore = await readBytes(globalConfigPath());

			const set = await conn.request({ type: "set_config", key: "defaultThinkingLevel", value: "high" });
			expect(set.ok).toBe(true);
			// 回包报的是真的落到的那一层：project 层存在，所以就是它。
			expect((set.result as { scope: string }).scope).toBe("project");

			// 写进 project 文件；本次改过的键之外，文件原有的键不动（部分保存，不整份覆盖）。
			const projectFile = YAML.parse(await readBytes(projectConfigPath())) as Record<string, unknown>;
			expect(projectFile.defaultThinkingLevel).toBe("high");
			expect(projectFile.theme).toEqual({ dark: "anthracite" });

			// 同一个 agent 的另一层：字节级未变（一份配置不再被劈成两个文件）。
			expect(await readBytes(globalConfigPath())).toBe(globalBefore);

			// 读侧跟得上：写下去的那份就是读回来的那份。
			const get = await conn.request({ type: "get_config", key: "defaultThinkingLevel" });
			expect((get.result as { config: unknown }).config).toBe("high");

			// 合并视图：只在 project 层有的键（theme）与只在全局层有的键（shellPath）都读得到。
			expect((await conn.request({ type: "get_config", key: "theme.dark" })).result).toEqual({
				config: "anthracite",
			});
			expect((await conn.request({ type: "get_config", key: "shellPath" })).result).toEqual({
				config: "/bin/zsh",
			});

			// 整份读取也是合并视图，不是某一个文件。
			const whole = (await conn.request({ type: "get_config" })).result as { config: Record<string, unknown> };
			expect(whole.config.defaultThinkingLevel).toBe("high");
			expect(whole.config.shellPath).toBe("/bin/zsh");
		} finally {
			conn.close();
		}
	}, 60_000);

	test("配置看板的工具开关面读到的是同一个文件（写 = 读）", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			await conn.request({ type: "set_config", key: "grep.enabled", value: false });

			const sw = (await conn.request({ type: "get_tool_switches" })).result as {
				tools: Array<{ tool: string; enabled: boolean }>;
			};
			expect(sw.tools.find(t => t.tool === "grep")?.enabled).toBe(false);
			// 写侧落点没变：仍是 project 层（同一条规则，不因配置面不同而分裂）。
			const projectFile = YAML.parse(await readBytes(projectConfigPath())) as Record<string, unknown>;
			expect(projectFile.grep).toEqual({ enabled: false });
			expect(await readBytes(globalConfigPath())).not.toContain("grep");
		} finally {
			conn.close();
		}
	}, 60_000);

	test("另一个 agent（agentDir 自带 project 层）：工具开关与 thinking 落盘写同一个文件", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			expect((await conn.request({ type: "attach", sessionId: PROJECT_LAYER_AGENT })).ok).toBe(true);

			const set = await conn.request({
				type: "set_config",
				sessionId: PROJECT_LAYER_AGENT,
				key: "grep.enabled",
				value: false,
			});
			expect(set.ok).toBe(true);
			expect((set.result as { scope: string }).scope).toBe("project");

			// thinking 面（F3 的 persist 开关）走同一条落点规则：不为它另开一份配置。
			const levels = (await conn.request({ type: "get_available_thinking_levels", sessionId: PROJECT_LAYER_AGENT }))
				.result as { levels: string[] };
			const current = (await conn.request({ type: "get_state", sessionId: PROJECT_LAYER_AGENT })).result as {
				thinkingLevel?: string;
			};
			const target = levels.levels.find(level => level !== current.thinkingLevel);
			expect(target).toBeDefined();
			await conn.request({
				type: "set_thinking_level",
				sessionId: PROJECT_LAYER_AGENT,
				level: target,
				persist: true,
			});
			// 落盘走 Settings 的 100ms 防抖保存。
			await Bun.sleep(300);

			const projectFile = YAML.parse(await readBytes(projectLayerAgentConfigPath())) as Record<string, unknown>;
			expect(projectFile.grep).toEqual({ enabled: false });
			expect(projectFile.defaultThinkingLevel).toBe(target);
			// project 文件原有的键不被整份覆盖。
			expect(projectFile.theme).toEqual({ dark: "anthracite" });
			// agent 自己的 config.yml 从未被创建：一份配置就是一个文件。
			expect(await Bun.file(agentConfigPath(PROJECT_LAYER_AGENT)).exists()).toBe(false);

			// 读侧跟得上（两个面写下去的都在合并视图里读得到）。
			const readBack = await conn.request({
				type: "get_config",
				sessionId: PROJECT_LAYER_AGENT,
				key: "defaultThinkingLevel",
			});
			expect((readBack.result as { config: unknown }).config).toBe(target);
		} finally {
			conn.close();
		}
	}, 60_000);
});

describe("F2 模型可见性按 agent", () => {
	const probeModelsOf = (frame: Frame): Array<{ provider: string; id: string }> => {
		const models = (frame.result as { models?: Array<{ provider: string; id: string }> }).models ?? [];
		return models.filter(m => m.provider === PROBE_PROVIDER);
	};
	const disabledProvidersOf = (frame: Frame): string[] =>
		(frame.result as { disabledProviders?: string[] }).disabledProviders ?? [];

	test("default 的停用名单不影响别的 agent；停用按 agent 隔离，且写在目标 agent 自己的配置里", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			// 定向命令前先显式 attach（serve 的预挂载是后台的，不赌时序；attach 幂等）。
			expect((await conn.request({ type: "attach", sessionId: "hr" })).ok).toBe(true);
			expect((await conn.request({ type: "attach", sessionId: "ops" })).ok).toBe(true);

			const globalBefore = await readBytes(globalConfigPath());

			// default：自己的停用名单生效。
			const defaultModels = await conn.request({ type: "get_available_models" });
			expect(disabledProvidersOf(defaultModels)).toContain(PROBE_PROVIDER);
			expect(probeModelsOf(defaultModels)).toHaveLength(0);

			// hr：同一份 provider，default 停用它不该让 hr 也看不见（旧实现读全局单例 → 这里为空）。
			const hrBefore = await conn.request({ type: "get_available_models", sessionId: "hr" });
			expect(disabledProvidersOf(hrBefore)).toEqual([]);
			expect(
				probeModelsOf(hrBefore)
					.map(m => m.id)
					.sort(),
			).toEqual([...PROBE_MODELS].sort());

			// hr 停用同一 provider：写自己的配置，读回来的列表/名单同源。
			const disabled = await conn.request({
				type: "set_model_disabled",
				sessionId: "hr",
				provider: PROBE_PROVIDER,
				disabled: true,
			});
			expect(disabled.ok).toBe(true);
			expect(disabledProvidersOf(disabled)).toContain(PROBE_PROVIDER);

			const hrAfter = await conn.request({ type: "get_available_models", sessionId: "hr" });
			expect(disabledProvidersOf(hrAfter)).toContain(PROBE_PROVIDER);
			expect(probeModelsOf(hrAfter)).toHaveLength(0);

			// 隔离：ops 不受 hr 影响。
			const opsModels = await conn.request({ type: "get_available_models", sessionId: "ops" });
			expect(disabledProvidersOf(opsModels)).toEqual([]);
			expect(
				probeModelsOf(opsModels)
					.map(m => m.id)
					.sort(),
			).toEqual([...PROBE_MODELS].sort());

			// 落点：hr 自己的 config.yml（没有 project 层 → 就是它），不是 default 的。
			// set_model_disabled 走 Settings 的 100ms 防抖保存（与 set_config 的显式 flush 不同）。
			await Bun.sleep(300);
			const hrFile = YAML.parse(await readBytes(agentConfigPath("hr"))) as Record<string, unknown>;
			expect(hrFile.disabledProviders).toContain(PROBE_PROVIDER);
			expect(await readBytes(globalConfigPath())).toBe(globalBefore);
			expect(await Bun.file(agentConfigPath("ops")).exists()).toBe(false);
		} finally {
			conn.close();
		}
	}, 60_000);

	test("agent 自己的默认角色在**自己的**可见性里解析（default 的停用不挡它）", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			// with-project 的 modelRoutes.default.primary = 探针 provider，而它被 default agent 停用了。
			// 解析这个会话的模型必须看它自己那份 Settings（合并视图里有 modelRoutes、停用名单为空）。
			expect((await conn.request({ type: "attach", sessionId: PROJECT_LAYER_AGENT })).ok).toBe(true);
			const state = (await conn.request({ type: "get_state", sessionId: PROJECT_LAYER_AGENT })).result as {
				model?: { provider: string; id: string };
			};
			expect(state.model?.provider).toBe(PROBE_PROVIDER);
			expect(state.model?.id).toBe("probe-a");

			// 它的可用列表里也真的看得到这个 provider（列表与模型解析同一份可见性）。
			const models = await conn.request({ type: "get_available_models", sessionId: PROJECT_LAYER_AGENT });
			expect(probeModelsOf(models)).toHaveLength(2);
		} finally {
			conn.close();
		}
	}, 60_000);
});

describe("F6 骨架：新建的 agentDir 首次加载不被重写", () => {
	test("骨架文件里没有旧键 modelRoles（发出的就是活键）", () => {
		// `cornfield agent validate --semantic` 读的也是这份文件：旧键要靠读入迁移才认得，
		// 发出去的骨架不该欠那一笔迁移。
		const withLegacyKey = SKELETON_FILES.filter(file => file.content.includes("modelRoles")).map(
			file => file.relPath,
		);
		expect(withLegacyKey).toEqual([]);
	});

	test("modelRoutes 已在骨架文件里：加载原样保留（modelRoles 不存在，注释不丢）", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skeleton-effective-"));
		try {
			await ensureAgentDir(agentDir);
			const configPath = path.join(agentDir, ".cornfield", "config.yml");
			const before = await readBytes(configPath);
			expect(before).toContain("modelRoutes:");
			expect(before).not.toContain("modelRoles");

			const settings = await Settings.create({ cwd: agentDir, agentDir });
			await settings.flush();

			// 首次加载不被迁移重写：字节相同（注释、排版都在），且活键真的被读进来了。
			expect(await readBytes(configPath)).toBe(before);
			expect(settings.getModelRole("default")).toBe("narwal-plan/minimax-m3");
			expect(settings.getEffectiveScope()).toBe("project");

			// `runSemanticPhaseInner`（agent validate --semantic）用同一个迁移函数取默认模型：
			// 活键写下的骨架无需先落盘迁移就能被它认出来。
			const parsed = YAML.parse(before) as Record<string, unknown>;
			const { routes, changed } = migrateLegacyModelConfig(parsed);
			expect(changed).toBe(false);
			expect(routes.default?.primary).toBe("narwal-plan/minimax-m3");
			expect(routes.smol?.primary).toBe("narwal-plan/minimax-m3");
			expect(routes.slow?.primary).toBe("narwal-plan/glm-5.2");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("A′ 配置/记忆的项目根按身份解析（票 24）", () => {
	test("default 的活跃配置：project 根 = 它的家，global 层 = 客户端那份，`<home>/config.yml` 不参与", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			const scope = (await conn.request({ type: "get_config_scope" })).result as {
				hasProjectConfig?: boolean;
				projectConfigPath?: string;
				globalConfigPath: string;
			};
			// 两个路径都来自 default 的 live Settings（配置项目根 = 它的家），不是 serve 的启动目录。
			expect(scope.hasProjectConfig).toBe(true);
			expect(scope.projectConfigPath).toBe(projectConfigPath());
			expect(scope.globalConfigPath).toBe(globalConfigPath());
			// 用户一直编辑的那份就是它的 global 层：改什么就读到什么。
			expect((await conn.request({ type: "get_config", key: "shellPath" })).result).toEqual({
				config: "/bin/zsh",
			});
			// `<home>/config.yml` 不是任何一层，也不许被创建（否则它会静默压掉用户那份）。
			await expect(Bun.file(unusedHomeConfigPath()).exists()).resolves.toBe(false);
		} finally {
			conn.close();
		}
	}, 60_000);

	test("default 会话的工具 cwd 仍是 serve 的启动目录（改配置根不许把工具落点带走）", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			// `resolution.sessionCwd` 就是会话的工作目录（附件会话的 `sessionManager.getCwd()`），
			// `resolution.agentDir` 是它的身份根 —— 两个事实分得开才是「没被带走」。
			const projection = (await conn.request({ type: "get_memory" })).result as {
				resolution: { sessionCwd: string; agentDir: string };
			};
			expect(normalizePathForComparison(projection.resolution.sessionCwd)).toBe(
				normalizePathForComparison(projectCwd),
			);
			expect(normalizePathForComparison(projection.resolution.sessionCwd)).not.toBe(
				normalizePathForComparison(getDefaultAgentHome()),
			);
			expect(normalizePathForComparison(projection.resolution.agentDir)).toBe(
				normalizePathForComparison(getDefaultAgentHome()),
			);
		} finally {
			conn.close();
		}
	}, 60_000);

	test("default 会话的记忆区跟着配置项目根（= 家）走，不跟会话 cwd", async () => {
		const conn = await WireConn.connect(url, token);
		try {
			const projection = (await conn.request({ type: "get_memory" })).result as {
				project?: { memoryRoot?: string } | null;
			};
			// canonical 根 = getMemoryRoot(配置项目根) —— 与运行时、与 pipeline 同一个根。
			// 拿会话 cwd 当参数会得到另一个根（就是这条断言要摁住的那个错）。
			expect(projection.project?.memoryRoot).toBe(getMemoryRoot(getDefaultAgentHome()));
		} finally {
			conn.close();
		}
	}, 60_000);

	test("wire 面：get_config_scope 报的 project 文件 === set_config(scope:project) 写的 === restore 删的", async () => {
		const conn = await WireConn.connect(url, token);
		const KEY = "custom.cfgRootProbe";
		try {
			await conn.request({ type: "set_config", key: KEY, value: "from-global", scope: "global" });
			await conn.request({ type: "set_config", key: KEY, value: "from-project", scope: "project" });

			const scope = (await conn.request({ type: "get_config_scope" })).result as {
				projectConfigPath?: string;
				globalConfigPath: string;
			};
			expect(scope.globalConfigPath).toBe(globalConfigPath());
			expect(scope.projectConfigPath).toBe(projectConfigPath());
			// 报的路径就是真正落盘的那两个文件（写 = 读 = 页面报的）。
			const globalFile = YAML.parse(await readBytes(scope.globalConfigPath)) as Record<string, unknown>;
			const projectFile = YAML.parse(await readBytes(scope.projectConfigPath!)) as Record<string, unknown>;
			expect((globalFile.custom as Record<string, unknown>)?.cfgRootProbe).toBe("from-global");
			expect((projectFile.custom as Record<string, unknown>)?.cfgRootProbe).toBe("from-project");

			// 「恢复继承」删的是同一个文件，删除后跌回低层的值。
			const restored = (await conn.request({ type: "restore_config_inheritance", key: KEY })).result as {
				removed: boolean;
				effectiveValue: unknown;
			};
			expect(restored.removed).toBe(true);
			expect(restored.effectiveValue).toBe("from-global");
			const projectAfter = YAML.parse(await readBytes(projectConfigPath())) as Record<string, unknown>;
			expect((projectAfter.custom as Record<string, unknown>)?.cfgRootProbe).toBeUndefined();
			const globalAfter = YAML.parse(await readBytes(globalConfigPath())) as Record<string, unknown>;
			expect((globalAfter.custom as Record<string, unknown>)?.cfgRootProbe).toBe("from-global");
			// 「恢复继承」的已知边界（wire-server 的注释、票 24 的现象 2）：它只删 project **文件**里的键，
			// 活着的 Settings 实例仍持有那份覆盖直到重载 —— 所以这里不断言 `get_config` 立刻跟上来
			// （那是另一张票的事），只钉住本命令自己的契约：删的是这个文件 + 报回低层的值。
		} finally {
			conn.close();
		}
	}, 60_000);
});

type Frame = { type: string; [k: string]: unknown };

class WireConn {
	static async connect(socketUrl: string, authToken: string): Promise<WireConn> {
		const ws = new WebSocket(socketUrl);
		const conn = new WireConn(ws);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
		});
		ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: authToken }));
		const ack = await conn.next(f => f.type === "hello_ack", 10_000);
		if (ack === undefined) throw new Error("no hello_ack");
		return conn;
	}

	readonly #ws: WebSocket;
	readonly #frames: Frame[] = [];
	readonly #waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

	constructor(ws: WebSocket) {
		this.#ws = ws;
		this.#ws.onmessage = ev => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			const idx = this.#waiters.findIndex(w => w.pred(frame));
			if (idx >= 0) {
				const [waiter] = this.#waiters.splice(idx, 1);
				waiter.resolve(frame);
			} else {
				this.#frames.push(frame);
			}
		};
	}

	async next(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
		const idx = this.#frames.findIndex(pred);
		if (idx >= 0) return this.#frames.splice(idx, 1)[0];
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				const i = this.#waiters.indexOf(waiter);
				if (i >= 0) this.#waiters.splice(i, 1);
				resolve(undefined);
			}, timeoutMs);
			const waiter = {
				pred: (f: Frame) => {
					if (!pred(f)) return false;
					clearTimeout(timer);
					return true;
				},
				resolve,
			};
			this.#waiters.push(waiter);
		});
	}

	async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> {
		const id = `r${++this.#seq}`;
		this.#ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
		const f = await this.next(fr => fr.type === "response" && fr.id === id, timeoutMs);
		if (!f) throw new Error(`request timeout: ${command.type}`);
		return f;
	}

	#seq = 0;

	close(): void {
		this.#ws.close();
	}
}
