import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "./executor";
import { buildPlan } from "./planner";
import { createRenderMoaResult } from "./renderer";
import { resolveSettings } from "./settings";
import { buildSummary, buildTraceDetails } from "./trace";

function usageText(): string {
	return [
		"MOA — Mixture-of-Agents planning extension",
		"",
		"  /moa run <task>         Run a planning panel",
		"  /moa status             Show current defaults",
		"  /moa help               Show this help",
	].join("\n");
}

async function handleRun(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const task = args.trim();
	if (!task) {
		ctx.ui.notify("Usage: /moa run <task>", "error");
		return;
	}

	const authStorage = await pi.pi.discoverAuthStorage();

	const result = await executePlan(buildPlan(task, resolveSettings()), {
		cwd: ctx.cwd,
		authStorage,
		modelRegistry: ctx.modelRegistry,
		settings: pi.pi.settings,
		runSubprocess: pi.pi.runSubprocess,
	});
	const summary = buildSummary(result);
	pi.sendMessage(
		{
			customType: "moa-result",
			content: [{ type: "text", text: summary }],
			display: true,
			details: buildTraceDetails(result),
			attribution: "agent",
		},
		{ triggerTurn: false },
	);
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const settings = resolveSettings();
	ctx.ui.notify(
		[
			`workers: ${settings.workerCount}`,
			`discovery: ${settings.discoveryEnabled ? "on" : "off"}`,
			`rewrite: ${settings.rewriteEnabled ? "on" : "off"}`,
			`planner tools: ${settings.plannerToolMode}`,
		].join("\n"),
		"info",
	);
}

export default function moaExtension(pi: ExtensionAPI): void {
	pi.setLabel("MOA Planner");
	pi.registerMessageRenderer("moa-result", createRenderMoaResult(pi.pi.getMarkdownTheme));
	pi.registerCommand("moa", {
		description: "Run a Mixture-of-Agents planning panel",
		getArgumentCompletions: prefix => {
			const subcommands = ["run", "status", "help"];
			if (!prefix) return subcommands.map(value => ({ label: value, value }));
			return subcommands.filter(value => value.startsWith(prefix)).map(value => ({ label: value, value }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			switch (subcommand ?? "help") {
				case "run":
					await handleRun(rest.join(" "), ctx, pi);
					return;
				case "status":
					await handleStatus(ctx);
					return;
				default:
					ctx.ui.notify(usageText(), "info");
			}
		},
	});
}
