/**
 * `omp acp` — ACP v1 JSON-RPC stdio server（Agent Client Protocol）。
 *
 * OMP 作为 ACP agent/server，Zed（或任意 ACP client）作为 client，通过
 * newline-delimited JSON-RPC 2.0 over stdin/stdout 通信（非 TCP）。
 *
 * 握手：client 发 `initialize` → OMP 回 `InitializeResponse`（protocolVersion
 * 协商）→ client 发 `initialized` 通知。之后走完整 ACP 会话生命周期
 * （newSession/loadSession/prompt/…），复用 `modes/acp` 的 `runAcpMode` +
 * `AcpAgent`（与 `omp --mode acp` 同一实现）。
 *
 * `ping` 是便捷 liveness 探针（非 ACP spec 方法）：client 发 `ping`，OMP 回
 * `{ pong: true }`，用于冒烟验证传输层与握手已通。
 */

import { logger } from "@cornfield/utils";
import { Command, Flags } from "@cornfield/utils/cli";
import { parseArgs } from "../cli/args";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { buildSessionOptions, createSessionManager } from "../main";
import { runAcpMode } from "../modes";
import { initTheme } from "../modes/theme/theme";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";

export default class Acp extends Command {
	static description = "Run omp as an ACP (Agent Client Protocol) stdio JSON-RPC server";

	static flags = {
		model: Flags.string({ description: "Model to use (fuzzy match)" }),
		thinking: Flags.string({ description: "Initial thinking level" }),
		"session-dir": Flags.string({ description: "Session storage directory" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Acp);
		const cwd = process.cwd();

		// ACP owns stdin/stdout for newline-delimited JSON-RPC framing — silence the
		// logger's console transport before any boot logging so the protocol stream
		// cannot be corrupted. File logging is unaffected.
		logger.silenceConsoleLogging();

		await logger.time("acp:boot", async () => {
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
			options.authStorage = authStorage;
			options.modelRegistry = modelRegistry;
			options.hasUI = false;

			const { session } = await createAgentSession(options);

			const createAcpSession = async (nextCwd: string) => {
				const nextSettings = await session.settings.cloneForCwd(nextCwd);
				const nextSessionManager = SessionManager.create(nextCwd, parsed.sessionDir);
				const { session: nextSession } = await createAgentSession({
					...options,
					cwd: nextCwd,
					sessionManager: nextSessionManager,
					settings: nextSettings,
					authStorage,
					modelRegistry,
					hasUI: false,
				});
				return nextSession;
			};

			await runAcpMode(session, createAcpSession);
		});
	}
}

/** 把 acp 自己的 flags 映射为 launch 式 argv，交给 parseArgs 解析成 Args。 */
function buildLaunchArgv(flags: Record<string, unknown>): string[] {
	const argv: string[] = [];
	if (flags.model) argv.push("--model", String(flags.model));
	if (flags.thinking) argv.push("--thinking", String(flags.thinking));
	if (flags["session-dir"]) argv.push("--session-dir", String(flags["session-dir"]));
	return argv;
}
