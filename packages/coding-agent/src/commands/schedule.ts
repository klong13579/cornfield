/**
 * Schedule command — now delegates to the unified gateway.
 *
 * @deprecated Use `omp gateway cron` instead.
 * Kept as a compatibility alias.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";
import * as path from "node:path";

const ACTIONS = ["add", "diagnose", "list", "remove", "run", "enable", "disable", "logs"];

export default class Schedule extends Command {
	static description = "Manage scheduled cron tasks (deprecated — use omp gateway cron)";
	static hidden = true;

	static args = {
		action: Args.string({
			description: "Schedule action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Task name",
			required: false,
		}),
		cron: Args.string({
			description: "Cron expression (for add)",
			required: false,
		}),
		command: Args.string({
			description: "Command to run (for add)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		description: Flags.string({ description: "Task description" }),
		type: Flags.string({ description: "Task type: shell (default) or agent", options: ["shell", "agent"] }),
		timeout: Flags.integer({ description: "Timeout in milliseconds" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		await initTheme();

		// Delegate to pi-gateway cron CLI
		const piGatewayPath = path.resolve(import.meta.dir, "../../pi-gateway/src/cli.ts");
		const args = process.argv.slice(process.argv.indexOf("schedule") + 1);

		// Map old action names to new
		const actionMapping: Record<string, string> = {
			add: "create",
			enable: "resume",
			disable: "pause",
			list: "list",
			remove: "remove",
			run: "run",
			logs: "logs",
			diagnose: "diagnose",
		};

		const mappedArgs = args.map((a, i) => {
			if (i === 0 && actionMapping[a]) return actionMapping[a]!;
			return a;
		});

		const proc = Bun.spawn([process.execPath, piGatewayPath, "cron", ...mappedArgs], {
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	}
}