/**
 * Daemon command — now delegates to the unified gateway.
 *
 * @deprecated Use `omp gateway start` instead.
 * Kept as a compatibility alias.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";

export default class Daemon extends Command {
	static description = "Manage the scheduler daemon (deprecated — use omp gateway)";
	static hidden = true;

	static args = {
		action: Args.string({
			description: "Daemon action",
			required: false,
			options: ["start", "stop", "status", "restart"],
		}),
	};

	static flags = {
		foreground: Flags.boolean({ description: "Run in foreground" }),
		verbose: Flags.boolean({ description: "Verbose output" }),
	};

	async run(): Promise<void> {
		console.error("omp daemon is deprecated. Use omp gateway instead.");
		console.error("  omp gateway start    — start unified gateway");
		console.error("  omp gateway status   — show status");
		console.error("  omp gateway cron ... — manage scheduled tasks");
		process.exitCode = 1;
	}
}
