/**
 * View, export, or clean the auto-QA grievance store.
 */
import { Args, Command, Flags } from "@cornfield/utils/cli";
import { cleanGrievances, exportGrievances, listGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = "View reported tool issues (auto-QA grievances)";

	static args = {
		action: Args.string({
			description: "What to do with the store",
			options: ["list", "clean", "export"] as const,
			required: false,
		}),
	};

	static flags = {
		limit: Flags.integer({
			char: "n",
			description:
				"list: how many recent issues to show (default 20); export: cap the number exported (default all)",
		}),
		tool: Flags.string({ char: "t", description: "Filter by tool name" }),
		since: Flags.string({
			char: "s",
			description: "Only reports at/after this cutoff: a duration (7d, 36h, 90m, 2w) or a date (2026-09-01)",
		}),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
		markdown: Flags.boolean({
			char: "m",
			description: "list: emit a markdown digest instead of the plain list",
			default: false,
		}),
		out: Flags.string({ char: "o", description: "export: write the digest to this path (stdout when omitted)" }),
		id: Flags.integer({ char: "i", description: "clean: delete one grievance by id" }),
		all: Flags.boolean({ char: "a", description: "clean: delete every grievance", default: false }),
	};

	static examples = [
		"$ cornfield grievances",
		"$ cornfield grievances -n 50 -t write",
		"$ cornfield grievances -s 7d -m",
		"$ cornfield grievances export --out ~/autoqa-week.md -s 7d",
		"$ cornfield grievances clean -t yield",
		"$ cornfield grievances clean --all",
	];

	async run(): Promise<void> {
		const { flags, args } = await this.parse(Grievances);
		const action = args.action ?? "list";
		try {
			switch (action) {
				case "clean":
					await cleanGrievances({ id: flags.id, tool: flags.tool, all: flags.all, json: flags.json });
					return;
				case "export":
					if (flags.markdown) {
						throw new Error("--markdown applies to the list action; export always writes the digest.");
					}
					await exportGrievances({
						out: flags.out,
						since: flags.since,
						tool: flags.tool,
						limit: flags.limit,
						json: flags.json,
					});
					return;
				default:
					await listGrievances({
						limit: flags.limit ?? 20,
						tool: flags.tool,
						json: flags.json,
						since: flags.since,
						markdown: flags.markdown,
					});
			}
		} catch (error) {
			process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
