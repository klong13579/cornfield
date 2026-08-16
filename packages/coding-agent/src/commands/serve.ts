/**
 * `omp serve` — multidevice host.
 *
 * 在本地把一个 omp 会话暴露为 WS 服务：TUI 继续进程内渲染，web/pc/mobile
 * 通过 ws://127.0.0.1:<port>/ws?token=<token> 连接同一会话（快照 + 增量事件）。
 *
 * 装配复用 main.ts 的启动序列（export 的 createSessionManager /
 * buildSessionOptions 与原交互/rpc 路径完全一致），零行为偏移。
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { buildSessionOptions, createSessionManager } from "../main";
import { initTheme } from "../modes/theme/theme";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import { startWireServer } from "../server/wire-server";
import { SessionStore } from "../session/session-store";

export default class Serve extends Command {
	static description = "Run omp as a multidevice host: share one session with TUI/web/pc/mobile over WS";

	static flags = {
		port: Flags.integer({ description: "WS server port", default: 7891 }),
		host: Flags.string({ description: "Bind address", default: "127.0.0.1" }),
		token: Flags.string({ description: "Auth token; random and printed if omitted" }),
		model: Flags.string({ description: "Model to use (fuzzy match)" }),
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
		const token: string = flags.token ?? randomToken();

		await logger.time("serve:boot", async () => {
			await initTheme();
			const authStorage = await discoverAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage);
			Bun.env.PI_NO_TITLE = "1";
			await Settings.init({ cwd });
			await modelRegistry.refresh("online-if-uncached");

			const parsed = parseArgs(buildLaunchArgv(flags));
			const sessionManager = await createSessionManager(parsed, cwd);
			const { options } = await buildSessionOptions(parsed, [], sessionManager, modelRegistry);
			options.cwd = cwd;
			const { session } = await createAgentSession(options);
			const store = SessionStore.attach(session);

			logger.info("serve:session", { sessionId: session.sessionId, sessionFile: session.sessionFile });
			await startWireServer({ host, port, token, session, store });
		});
	}
}

function randomToken(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

/** 把 serve 自己的 flags 映射为 launch 式 argv，交给 parseArgs 解析成 Args。 */
function buildLaunchArgv(flags: Record<string, unknown>): string[] {
	const argv: string[] = [];
	if (flags.model) argv.push("--model", String(flags.model));
	if (flags.thinking) argv.push("--thinking", String(flags.thinking));
	if (flags.resume) argv.push("--resume", String(flags.resume));
	if (flags["session-dir"]) argv.push("--session-dir", String(flags["session-dir"]));
	for (const ext of (flags.extension as string[] | undefined) ?? []) argv.push("--extension", ext);
	if (flags["no-extensions"]) argv.push("--no-extensions");
	return argv;
}
