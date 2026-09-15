/**
 * View recently reported tool issues from automated QA.
 */
import { Command, Flags } from "@cornfield/utils/cli";
import { listGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = "View reported tool issues (auto-QA grievances)";

	static flags = {
		limit: Flags.integer({ char: "n", description: "Number of recent issues to show", default: 20 }),
		tool: Flags.string({ char: "t", description: "Filter by tool name" }),
		since: Flags.string({
			char: "s",
			description: "Only reports at/after this cutoff: a duration (7d, 36h, 90m, 2w) or a date (2026-09-01)",
		}),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
		markdown: Flags.boolean({
			char: "m",
			description: "Emit a markdown digest instead of the plain list",
			default: false,
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Grievances);
		try {
			await listGrievances({
				limit: flags.limit,
				tool: flags.tool,
				json: flags.json,
				since: flags.since,
				markdown: flags.markdown,
			});
		} catch (error) {
			console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
