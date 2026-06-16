/**
 * Manage bundled task agents.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: AgentsAction[] = ["unpack", "setup"];

export default class Agents extends Command {
	static description = "Manage bundled task agents and setup agent workspaces";

	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.omp/agents" }),
	};

	static examples = [
		"# Export bundled agents into user config (default)\n  omp agents unpack",
		"# Export bundled agents into project config\n  omp agents unpack --project",
		"# Overwrite existing local agent files\n  omp agents unpack --project --force",
		"# Export into a custom directory\n  omp agents unpack --dir ./tmp/agents --json",
		"# Set up an agent workspace for DingTalk gateway\n  omp agents setup --dir ./my-robot",
		"# Set up with a custom system prompt\n  omp agents setup --dir ./my-robot --mission ./mission.md",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp", "agents", Agents);
			return;
		}

	if (args.action === "setup") {
			await this.#handleSetup(flags as { dir?: string; json?: boolean });
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}

	async #handleSetup(flags: { dir?: string; json?: boolean }): Promise<void> {
		const dir = flags.dir || process.cwd();
		const root = path.resolve(dir);

		console.log(`Setting up agent workspace in: ${root}`);

		// Create directory structure
		const dirs = [
			root,
			path.join(root, ".pi-gateway"),
			path.join(root, ".omp-agent"),
			path.join(root, "evolution"),
			path.join(root, "knowledge"),
		];

		for (const d of dirs) {
			await fs.promises.mkdir(d, { recursive: true });
			console.log(`  Created: ${d}`);
		}

		// Create gateway.json with DingTalk config placeholder
		const gatewayConfig = {
			channels: {
				dingtalk: {
					enabled: false,
					appKey: "",
					appSecret: "",
				},
			},
			agent: {
				ompPath: "omp",
				maxConcurrentSessions: 3,
			},
			dataDir: path.join(root, ".pi-gateway"),
		};

		await Bun.write(path.join(root, "gateway.json"), JSON.stringify(gatewayConfig, null, 2));
		console.log(`  Created: ${path.join(root, "gateway.json")}`);

		// Create mission.md
		const mission = `# Agent Mission

You are an AI assistant powered by Oh My Pi (OMP).

## Identity
- Name: OMP Agent
- You respond via DingTalk (and potentially other IM platforms)
- You have access to OMP's full tool set

## Behavior
- Be concise and helpful
- Use Markdown for formatting
- When you generate images/files, use the appropriate sharing syntax
- Respect user privacy and security settings
`;

		await Bun.write(path.join(root, "mission.md"), mission);
		console.log(`  Created: ${path.join(root, "mission.md")}`);

		// Create .gitkeep in knowledge
		await Bun.write(path.join(root, "knowledge", ".gitkeep"), "");
		console.log(`  Created: ${path.join(root, "knowledge", ".gitkeep")}`);

		console.log(`
✅ Agent workspace setup complete!

Next steps:
  1. Edit gateway.json with your DingTalk credentials
  2. Customize mission.md to set the agent's personality
  3. Run: pi-gateway start --config ${path.join(root, "gateway.json")}
`);
	}
}
