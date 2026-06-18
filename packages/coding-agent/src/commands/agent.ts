/**
 * `omp agent <subcommand>` — manage agentDir workspaces.
 *
 * Subcommands (per `packages/agent/docs/agent-design-v1.md` §6.2):
 *   - init <name>     create a new agentDir
 *   - list            list agentDirs under ~/.omp/agents/
 *   - show <name>     print identity / tools / skills / cron summary
 *   - validate <dir>  check always-on files + runtime artifacts
 *
 * The heavy lifting lives in `../cli/agent-cli.ts` so each handler can be
 * unit-tested without going through the Command parser.
 */

import * as path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	renderList,
	renderShow,
	renderValidate,
	runAgentInit,
	runAgentList,
	runAgentShow,
	runAgentValidate,
} from "../cli/agent-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = ["init", "list", "show", "validate", "help"];

export default class Agent extends Command {
	static description = "Manage agentDir workspaces: create, list, show, validate (per agent-design §6.2)";

	static args = {
		action: Args.string({
			description: `Agent action: ${ACTIONS.join(" | ")}`,
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Agent name (init/show)",
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({
			description: "Directory: parent for init/list/show, or full agentDir for validate (default: ~/.omp/agents)",
		}),
		template: Flags.string({ description: "Template name (init). Only `default` is supported." }),
		mission: Flags.string({ description: "Path to a custom mission.md (init)" }),
		force: Flags.boolean({ description: "Allow overwriting an existing agentDir (init)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"",
		"  ======== 创建 ========",
		"  omp agent init hr-bot                          Create ~/.omp/agents/hr-bot/ with default template",
		"  omp agent init hr-bot --dir /opt/agents         Custom parent directory",
		"  omp agent init hr-bot --mission ./mission.md    Seed from existing mission.md",
		"  omp agent init hr-bot --template default        Explicit template (default only, for now)",
		"",
		"  ======== 查看 ========",
		"  omp agent list                                  List all agentDirs under ~/.omp/agents/",
		"  omp agent list --json                           List as JSON",
		"  omp agent show hr-bot                           Show identity, tools, skills, cron, sessions",
		"  omp agent show hr-bot --json                    Show as JSON",
		"",
		"  ======== 校验 ========",
		"  omp agent validate ~/.omp/agents/hr-bot        Check always-on + runtime hard deps",
		"  omp agent validate .                            Check current directory",
		"  omp agent validate ~/.omp/agents/hr-bot --json  Output as JSON",
		"",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agent);
		await initTheme();
		try {
			await this.#dispatch(args.action, args.name, args.dir, flags as Record<string, unknown>);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`error: ${msg}`);
			process.exitCode = 1;
		}
	}

	async #dispatch(
		action: string | undefined,
		name: string | undefined,
		dir: string | undefined,
		flags: Record<string, unknown>,
	): Promise<void> {
		if (!action || action === "help") {
			renderCommandHelp("omp", "agent", Agent);
			return;
		}

		// flags.dir is the canonical source; the legacy positional is kept for back-compat.
		const dirFlag = flags.dir as string | undefined;
		const dirResolved = dirFlag ?? dir;

		switch (action) {
			case "init": {
				if (!name) {
					console.error("Usage: omp agent init <name> [--dir <path>] [--template default] [--mission <file>]");
					process.exitCode = 1;
					return;
				}
				const result = await runAgentInit({
					name,
					dir: dirResolved,
					template: flags.template as string | undefined,
					mission: flags.mission as string | undefined,
					force: flags.force as boolean | undefined,
					json: flags.json as boolean | undefined,
				});
				if (flags.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				console.log(
					result.created
						? `✓ Created agentDir at ${result.agentDir}`
						: `✓ AgentDir exists at ${result.agentDir} (additive update — existing files preserved)`,
				);
				if (result.created) console.log(`  ${result.filesWritten} content files written`);
				console.log(`  Next: edit ${path.join(result.agentDir, "mission.md")} and run \`omp agent show ${name}\``);
				return;
			}
			case "list": {
				const summaries = await runAgentList({ dir: dirResolved, json: flags.json as boolean | undefined });
				console.log(renderList(summaries, Boolean(flags.json)));
				return;
			}
			case "show": {
				if (!name) {
					console.error("Usage: omp agent show <name> [--dir <path>] [--json]");
					process.exitCode = 1;
					return;
				}
				const detail = await runAgentShow({
					name,
					dir: dirResolved,
					json: flags.json as boolean | undefined,
				});
				console.log(renderShow(detail, Boolean(flags.json)));
				return;
			}
			case "validate": {
				if (!dirResolved) {
					console.error("Usage: omp agent validate --dir <agentDir> [--json]");
					process.exitCode = 1;
					return;
				}
				const result = await runAgentValidate({ agentDir: dirResolved, json: flags.json as boolean | undefined });
				console.log(renderValidate(result, Boolean(flags.json)));
				process.exitCode = result.valid ? 0 : 1;
				return;
			}
			default:
				console.error(`Unknown action: ${action}`);
				console.error(`Valid actions: ${ACTIONS.join(", ")}`);
				process.exitCode = 1;
		}
	}
}
