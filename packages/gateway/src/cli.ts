#!/usr/bin/env bun
import { APP_NAME, MIN_BUN_VERSION, VERSION } from "@cornfield/utils";
/**
 * cornfield-gateway CLI entry point — the standalone gateway daemon binary.
 *
 * Split from the single `omp` binary (see docs/gateway-binary-split-plan.md):
 * cornfield-gateway hosts IM channels (DingTalk), the cron scheduler, the agent
 * bridge, and the launchd/systemd service installer. Agent execution stays in
 * `omp` (the coding-agent binary), spawned on demand via `omp --mode rpc`.
 *
 * Command model: every gateway action is a root subcommand
 * (`cornfield-gateway start`, `cornfield-gateway cron list`, ...) implemented by the
 * single Gateway command class with an `action` argument. The argv rewrite
 * below maps `cornfield-gateway <action> ...` to the command class so the action
 * name is parsed as its first positional arg.
 */
import { type CommandEntry, run } from "@cornfield/utils/cli";

function parseSemver(version: string): [number, number, number] {
	function toint(value: string): number {
		const int = Number.parseInt(value, 10);
		if (Number.isNaN(int) || !Number.isFinite(int)) return 0;
		return int;
	}
	const [majorRaw, minorRaw, patchRaw] = version.split(".").map(toint);
	return [majorRaw, minorRaw, patchRaw];
}

function isAtLeastBunVersion(minimum: string): boolean {
	const ver = parseSemver(Bun.version);
	const min = parseSemver(minimum);
	for (let i = 0; i < 3; i++) {
		if (ver[i] !== min[i]) {
			return ver[i] > min[i];
		}
	}
	return true;
}

if (!isAtLeastBunVersion(MIN_BUN_VERSION)) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please update Bun: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

const GATEWAY_ACTIONS = new Set([
	"start",
	"stop",
	"status",
	"reload",
	"doctor",
	"config",
	"cron",
	"robot-context",
	"service",
	"setup",
	"test-longtask",
	"help",
]);

const commands: CommandEntry[] = [{ name: "gateway", load: () => import("./commands/gateway").then(m => m.default) }];

async function showHelp(): Promise<void> {
	const { default: GatewayCommand } = await import("./commands/gateway");
	const lines: string[] = [];
	lines.push(`${APP_NAME} gateway v${VERSION}\n`);
	lines.push("USAGE");
	lines.push("  $ cornfield-gateway <action> [FLAGS]\n");
	if (GatewayCommand.examples && GatewayCommand.examples.length > 0) {
		lines.push("ACTIONS");
		lines.push(GatewayCommand.examples.join("\n"));
		lines.push("");
	}
	process.stdout.write(lines.join("\n"));
}

/**
 * Route `cornfield-gateway <action> ...` to the Gateway command class. The action
 * name becomes the command's first positional arg (`args.action`); a bare
 * `cornfield-gateway` or `cornfield-gateway --help` falls through to `run()`'s own help
 * handling by skipping the rewrite.
 */
function runCli(argv: string[]): Promise<void> {
	const first = argv[0];
	const runArgv = first !== undefined && GATEWAY_ACTIONS.has(first) ? ["gateway", ...argv] : argv;
	return run({ bin: "cornfield-gateway", version: VERSION, argv: runArgv, commands, help: showHelp });
}

await runCli(process.argv.slice(2));
