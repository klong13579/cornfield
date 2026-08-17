/**
 * `omp serve` — multidevice host（P3 多 Agent）。
 *
 * 在本地把 omp 会话暴露为 WS 服务：TUI 继续进程内渲染，web/pc/mobile
 * 通过 ws://127.0.0.1:<port>/ws?token=<token> 连接。
 *
 * P3：serve 从单 AgentSession 升级为会话注册表。
 * - default agent：启动即建（cwd 进程，P1 语义不变）
 * - 其它 agent：从 ~/.omp/agent/registry.json 只读加载元数据，收到 attach/switch_session
 *   时 lazy 实例化（每 agent 独立 agentDir + <agentDir>/sessions/）
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { buildSessionOptions, createSessionManager } from "../main";
import { initTheme } from "../modes/theme/theme";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { SessionFactory } from "../server/session-registry";
import { startWireServer } from "../server/wire-server";
import { SessionManager } from "../session/session-manager";
import { SessionStore } from "../session/session-store";

export default class Serve extends Command {
	static description = "Run omp as a multidevice host: share sessions with TUI/web/pc/mobile over WS";

	static flags = {
		port: Flags.integer({ description: "WS server port", default: 7891 }),
		host: Flags.string({ description: "Bind address", default: "127.0.0.1" }),
		token: Flags.string({ description: "Auth token; empty = local no-auth (default, binds 127.0.0.1 only); pass a value to enable handshake auth" }),
		model: Flags.string({ description: "Model to use (fuzzy match); default narwal-plan/deepseek-v4-flash" }),
		thinking: Flags.string({ description: "Initial thinking level" }),
		resume: Flags.string({ description: "Resume session (ID prefix or path)" }),
		"session-dir": Flags.string({ description: "Session storage directory" }),
		extension: Flags.string({ description: "Load extension file", multiple: true }),
		"no-extensions": Flags.boolean({ description: "Disable extension discovery" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Serve);
		const cwd = process.cwd();
		const host: string = flags.host ?? "127.0.0.1";
		const port: number = flags.port ?? 7891;
		const token: string = flags.token ?? "";

		await logger.time("serve:boot", async () => {
			await initTheme();
			const authStorage = await discoverAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage);
			Bun.env.PI_NO_TITLE = "1";
			const settings = await Settings.init({ cwd });
			await modelRegistry.refresh("online-if-uncached");

			const parsed = parseArgs(buildLaunchArgv(flags));
			const sessionManager = await createSessionManager(parsed, cwd);
			const { options } = await buildSessionOptions(parsed, [], sessionManager, modelRegistry);
			options.cwd = cwd;
			const { session } = await createAgentSession(options);
			const store = SessionStore.attach(session);

			// P3 lazy attach 工厂：每个 registry agent 独立 AgentSession，
			// cwd/agentDir = 其 agentDir，session 落 <agentDir>/sessions/。
			const sessionFactory: SessionFactory = async meta => {
				const agentSessionManager = SessionManager.create(meta.agentDir, path.join(meta.agentDir, "sessions"));
				const result = await createAgentSession({
					cwd: meta.agentDir,
					agentDir: meta.agentDir,
					sessionManager: agentSessionManager,
					settings,
					modelRegistry,
					authStorage,
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
