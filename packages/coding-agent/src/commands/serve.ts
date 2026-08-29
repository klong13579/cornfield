/**
 * `omp serve` — multidevice host（P3 多 Agent）。
 *
 * 在本地把 omp 会话暴露为 WS 服务：TUI 继续进程内渲染，web/pc/mobile
 * 通过 ws://127.0.0.1:<port>/ws?token=<token> 连接。
 *
 * P3：serve 从单 AgentSession 升级为会话注册表。
 * - default agent：启动即建（cwd 进程，P1 语义不变）
 * - 其它 agent：从 ~/.cornfield/agent/registry.json 只读加载元数据，收到 attach/switch_session
 *   时 lazy 实例化（每 agent 独立 agentDir + <agentDir>/sessions/）
 */

import * as path from "node:path";
import { logger, setProjectDir } from "@cornfield/utils";
import { Command, Flags } from "@cornfield/utils/cli";
import type { PermissionRequestPush } from "@cornfield/wire";
import { parseArgs } from "../cli/args";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { buildSessionOptions, createSessionManager } from "../main";
import { initTheme } from "../modes/theme/theme";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import { createApprovalCanUseTool, PermissionGate } from "../server/permission-gate";
import type { SessionFactory } from "../server/session-registry";
import { startWireServer } from "../server/wire-server";
import { SessionManager } from "../session/session-manager";
import { SessionStore } from "../session/session-store";
import { repo } from "../utils/git";

export default class Serve extends Command {
	static description = "Run omp as a multidevice host: share sessions with TUI/web/pc/mobile over WS";

	static flags = {
		port: Flags.integer({ description: "WS server port", default: 7891 }),
		host: Flags.string({ description: "Bind address", default: "127.0.0.1" }),
		token: Flags.string({
			description:
				"Auth token; empty = local no-auth (default, binds 127.0.0.1 only); pass a value to enable handshake auth",
		}),
		model: Flags.string({ description: "Model to use (fuzzy match); default narwal-plan/deepseek-v4-flash" }),
		thinking: Flags.string({ description: "Initial thinking level" }),
		resume: Flags.string({ description: "Resume session (ID prefix or path)" }),
		"session-dir": Flags.string({ description: "Session storage directory" }),
		extension: Flags.string({ description: "Load extension file", multiple: true }),
		"no-extensions": Flags.boolean({ description: "Disable extension discovery" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Serve);
		// default agent 根 = 启动目录的 git 仓库根（"当前项目"语义）。chdir 后
		// Settings / sessionManager / default session / wire-server 的 process.cwd()
		// 全部跟随，一处改动处处一致；非 git 目录回退启动目录（行为不变）。
		const startupCwd = process.cwd();
		const projectRoot = await resolveServeProjectRoot(startupCwd);
		if (projectRoot !== startupCwd) {
			setProjectDir(projectRoot);
		}
		const cwd = process.cwd();
		const host: string = flags.host ?? "127.0.0.1";
		const port: number = flags.port ?? 7891;
		const token: string = flags.token ?? "";

		await logger.time("serve:boot", async () => {
			await initTheme();
			const authStorage = await discoverAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage);
			Bun.env.PI_NO_TITLE = "1";
			// 初始化全局 settings（default agent 的配置根 = 全局 agent 目录；registry agent 各自
			// Settings.create({ agentDir }) 在 sessionFactory 内惰性创建）。后续 Settings.instance
			// 读取（如 get_available_models 的 disabled 名单）依赖此初始化。
			await Settings.init({ cwd });
			await modelRegistry.refresh("online-if-uncached");

			const parsed = parseArgs(buildLaunchArgv(flags));
			const sessionManager = await createSessionManager(parsed, cwd);
			const { options } = await buildSessionOptions(parsed, [], sessionManager, modelRegistry);
			options.cwd = cwd;
			// ── 审批挂起闸门：canUseTool → PermissionGate → 广播 permission_request ──
			const gate = new PermissionGate();
			let broadcastPermission: (push: PermissionRequestPush) => void = () => {};
			const canUseTool = createApprovalCanUseTool(gate, push => broadcastPermission(push));

			options.canUseTool = canUseTool;
			const { session } = await createAgentSession(options);
			const store = SessionStore.attach(session);

			// P3 lazy attach 工厂：每个 registry agent 独立 AgentSession + 独立 Settings
			// （per-agent 配置读写：工具开关 / modelRoles / thinking 落在 <agentDir>/config.yml，
			// 前端 get_config/set_config 定向到该文件。default agent 保持全局单例（P1 语义）。
			const sessionFactory: SessionFactory = async meta => {
				const agentSettings = await Settings.create({ cwd: meta.agentDir, agentDir: meta.agentDir });
				const agentSessionManager = SessionManager.create(meta.agentDir, path.join(meta.agentDir, "sessions"));
				const result = await createAgentSession({
					cwd: meta.agentDir,
					agentDir: meta.agentDir,
					sessionManager: agentSessionManager,
					settings: agentSettings,
					modelRegistry,
					authStorage,
					canUseTool,
				});
				return result.session;
			};

			logger.info("serve:session", { sessionId: session.sessionId, sessionFile: session.sessionFile });
			await startWireServer({
				host,
				port,
				token,
				defaultSession: { session, store },
				sessionFactory,
				permissionGate: gate,
				registerPermissionBroadcast: fn => {
					broadcastPermission = fn;
				},
			});
		});
	}
}

/** 把 serve 自己的 flags 映射为 launch 式 argv，交给 parseArgs 解析成 Args。 */
function buildLaunchArgv(flags: Record<string, unknown>): string[] {
	const argv: string[] = [];
	argv.push("--model", String(flags.model ?? "narwal-plan/deepseek-v4-flash"));
	if (flags.thinking) argv.push("--thinking", String(flags.thinking));
	if (flags.resume) argv.push("--resume", String(flags.resume));
	if (flags["session-dir"]) argv.push("--session-dir", String(flags["session-dir"]));
	for (const ext of (flags.extension as string[] | undefined) ?? []) argv.push("--extension", String(ext));
	if (flags["no-extensions"]) argv.push("--no-extensions");
	return argv;
}

/** 解析 serve 的 default agent 根：向上取 git 仓库根；非 git 目录/探测失败回退启动目录。 */
async function resolveServeProjectRoot(start: string): Promise<string> {
	try {
		return (await repo.root(start)) ?? start;
	} catch {
		return start;
	}
}
