/**
 * `cornfield agent <subcommand>` — manage agentDir workspaces.
 *
 * Subcommands (per `packages/coding-agent/docs/agent-design-v1.md` §6.2):
 *   - init <name>     create a new agentDir
 *   - list            list agentDirs under ~/.cornfield/agents/
 *   - show <name>     print identity / tools / skills / cron summary
 *   - validate <dir>  check always-on files + runtime artifacts
 *
 * The heavy lifting lives in `../cli/agent-cli.ts` so each handler can be
 * unit-tested without going through the Command parser.
 */

import * as path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@cornfield/utils/cli";
import {
	renderList,
	renderMigrateDefaultHome,
	renderReconcile,
	renderRegister,
	renderShow,
	renderUnregister,
	renderValidate,
	runAgentInit,
	runAgentList,
	runAgentMigrateDefaultHome,
	runAgentReconcile,
	runAgentRegister,
	runAgentShow,
	runAgentUnregister,
	runAgentValidate,
} from "../cli/agent-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS = [
	"init",
	"list",
	"show",
	"validate",
	"register",
	"unregister",
	"reconcile",
	"migrate-default-home",
	"help",
];

export default class Agent extends Command {
	static description =
		"Manage agentDir workspaces: create, list, show, validate, register, unregister, reconcile (per agent-design §6.2)";

	static args = {
		action: Args.string({
			description: `Agent action: ${ACTIONS.join(" | ")}`,
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Agent name (init/show/register/unregister)",
			required: false,
		}),
		// Positional shortcut for `--dir` (init action). Lets users write
		// `cornfield agent init hr-bot ./` instead of `cornfield agent init hr-bot --dir ./`.
		// For other actions, this is ignored — use `--dir` flag.
		dir: Args.string({
			description: "Positional shortcut for --dir (init only)",
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({
			description:
				"Directory: parent for init/list/show, or full agentDir for validate (default: ~/.cornfield/agents)",
		}),
		template: Flags.string({ description: "Template name (init). Only `default` is supported." }),
		mission: Flags.string({ description: "Path to a custom mission.md (init)" }),
		root: Flags.string({
			description:
				"Extra read/write root to declare on the agentDir (init; repeatable). Must be an existing directory.",
			multiple: true,
		}),
		force: Flags.boolean({ description: "Allow overwriting an existing agentDir (init)" }),
		fix: Flags.boolean({ description: "Auto-repair MECE violations (validate)" }),
		semantic: Flags.boolean({ description: "Run LLM semantic audit (validate)" }),

		deleteFiles: Flags.boolean({ description: "Also rm -rf the agentDir on disk (unregister). Off by default." }),
		dryRun: Flags.boolean({
			description: "Report what would move without touching the filesystem (migrate-default-home)",
		}),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"",
		"  ======== 创建 ========",
		"  cornfield agent init hr-bot                          Create ~/.cornfield/agents/hr-bot/ with default template",
		"  cornfield agent init hr-bot --dir /opt/agents         Custom parent directory",
		"  cornfield agent init hr-bot --mission ./mission.md    Seed from existing mission.md",
		"  cornfield agent init hr-bot --root /srv/shared          Declare an extra read/write root (repeatable)",
		"  cornfield agent init hr-bot --template default        Explicit template (default only, for now)",
		"",
		"  ======== 查看 ========",
		"  cornfield agent list                                  List all agentDirs under ~/.cornfield/agents/",
		"  cornfield agent list --json                           List as JSON",
		"  cornfield agent show hr-bot                           Show identity, tools, skills, cron, sessions",
		"  cornfield agent show hr-bot --json                    Show as JSON",
		"",
		"  ======== 校验 ========",
		"  cornfield agent validate --dir ~/.cornfield/agents/hr-bot        Check always-on + runtime hard deps",
		"  cornfield agent validate --dir .                            Check current directory",
		"  cornfield agent validate --dir ~/.cornfield/agents/hr-bot --json  Output as JSON",
		"  cornfield agent validate --dir . --fix                         Auto-repair MECE violations + skeleton gaps",
		"  cornfield agent validate --dir . --semantic                   Run LLM semantic audit (needs model+key)",
		"",
		"  ======== 注册表 ========",
		"  cornfield agent register hr3 --dir /path/to/hr3       Add an existing agentDir to ~/.cornfield/agent/registry.json",
		"  cornfield agent register hr3 /path/to/hr3              Positional shortcut for --dir",
		"  cornfield agent unregister hr3                          Remove hr3 from the registry (does not delete files)",
		"  cornfield agent unregister hr3 --delete-files           Also rm -rf the agentDir on disk",
		"  cornfield agent reconcile                               Prune stale entries; re-register any in default location",
		"",
		"  ======== default agent 的家 ========",
		"  cornfield agent migrate-default-home --dry-run          Show what would move out of ~/.cornfield/agent",
		"  cornfield agent migrate-default-home                    Move the default Agent's own state into ~/cf-workspace",
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
			renderCommandHelp("cornfield", "agent", Agent);
			return;
		}

		// flags.dir is the canonical source; the legacy positional is kept for back-compat.
		const dirFlag = flags.dir as string | undefined;
		const dirResolved = dirFlag ?? dir;

		switch (action) {
			case "init": {
				if (!name) {
					console.error(
						"Usage: cornfield agent init <name> [--dir <path>] [--template default] [--mission <file>] [--root <path>]...",
					);
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
					roots: flags.root as string[] | undefined,
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
				if (result.attachedRoots?.length) console.log(`  Extra roots: ${result.attachedRoots.join(", ")}`);
				console.log(
					`  Next: edit ${path.join(result.agentDir, "mission.md")} and run \`cornfield agent show ${name}\``,
				);
				return;
			}
			case "list": {
				const summaries = await runAgentList({ dir: dirResolved, json: flags.json as boolean | undefined });
				console.log(renderList(summaries, Boolean(flags.json)));
				return;
			}
			case "show": {
				if (!name) {
					console.error("Usage: cornfield agent show <name> [--dir <path>] [--json]");
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
					console.error("Usage: cornfield agent validate --dir <agentDir> [--fix] [--json]");
					process.exitCode = 1;
					return;
				}
				const result = await runAgentValidate({
					agentDir: dirResolved,
					json: flags.json as boolean | undefined,
					fix: flags.fix as boolean | undefined,
					semantic: flags.semantic as boolean | undefined,
				});
				console.log(renderValidate(result, Boolean(flags.json)));
				process.exitCode = result.valid ? 0 : 1;
				return;
			}
			case "register": {
				if (!name) {
					console.error(
						"Usage: cornfield agent register <name> --dir <path>  (or positional: cornfield agent register <name> <dir>)",
					);
					process.exitCode = 1;
					return;
				}
				const result = await runAgentRegister({ name, dir: dirResolved, json: flags.json as boolean | undefined });
				console.log(renderRegister(result, Boolean(flags.json)));
				process.exitCode = result.registered ? 0 : 1;
				return;
			}
			case "unregister": {
				if (!name) {
					console.error("Usage: cornfield agent unregister <name> [--delete-files]");
					process.exitCode = 1;
					return;
				}
				const result = await runAgentUnregister({
					name,
					deleteFiles: flags.deleteFiles as boolean | undefined,
					json: flags.json as boolean | undefined,
				});
				console.log(renderUnregister(result, Boolean(flags.json)));
				return;
			}
			case "reconcile": {
				const result = await runAgentReconcile({ json: flags.json as boolean | undefined });
				console.log(renderReconcile(result, Boolean(flags.json)));
				return;
			}
			case "migrate-default-home": {
				const result = await runAgentMigrateDefaultHome({
					dryRun: flags.dryRun as boolean | undefined,
					json: flags.json as boolean | undefined,
				});
				console.log(renderMigrateDefaultHome(result, Boolean(flags.json)));
				const failed = result.entries.filter(entry => entry.status === "failed");
				process.exitCode = failed.length > 0 ? 1 : 0;
				return;
			}
			default:
				console.error(`Unknown action: ${action}`);
				console.error(`Valid actions: ${ACTIONS.join(", ")}`);
				process.exitCode = 1;
		}
	}
}
