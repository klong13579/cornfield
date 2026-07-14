import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { executePlan } from "./executor";
import { loadMoaConfigOverrides } from "./moa-config";
import { buildPlan } from "./planner";
import { createRenderMoaResult } from "./renderer";
import { resolveSettings } from "./settings";
import {
	buildMoaArchiveEntries,
	buildMoaHandoff,
	buildTraceDetails,
	createMoaRunId,
	listMoaArchiveRuns,
	reconstructMoaArchive,
} from "./trace";
import { formatTimingSummary } from "./timing";
import { MOA_ARCHIVE_ENTRY_TYPE } from "./types";

function usageText(): string {
	return [
		"MOA — Mixture-of-Agents planning extension",
		"",
		"  /moa run <task>             Run a planning panel",
		"  /moa status                 Show current defaults",
		"  /moa transcript [runId]     Show full archived transcript (default: latest)",
		"  /moa runs                   List archived runs in this workspace (cross-session)",
		"  /moa help                   Show this help",
	].join("\n");
}

async function handleRun(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const task = args.trim();
	if (!task) {
		ctx.ui.notify("Usage: /moa run <task>", "error");
		return;
	}

	const authStorage = await pi.pi.discoverAuthStorage();
	const configOverrides = (await loadMoaConfigOverrides(ctx.cwd)).overrides;
	const settings = resolveSettings(configOverrides);

	const result = await executePlan(buildPlan(task, settings), {
		cwd: ctx.cwd,
		authStorage,
		modelRegistry: ctx.modelRegistry,
		settings: pi.pi.settings,
		moaSettings: settings,
		ui: ctx.ui,
		hasUI: ctx.hasUI,
	});

	const runId = createMoaRunId();
	const { manifest, chunks } = buildMoaArchiveEntries({
		runId,
		task: result.plan.task,
		workers: result.workers,
		synthesis: result.synthesis,
		discovery: result.discovery,
		rewrite: result.rewrite,
		tco: result.tco,
		dispatchLog: result.dispatchLog,
		timings: result.timings,
	});

	const handoff = buildMoaHandoff({
		runId,
		archiveChunks: manifest.chunks,
		archiveBytes: manifest.bytes,
		workers: result.workers,
		synthesis: result.synthesis,
		task: result.plan.task,
		maxBytes: settings.resumeContextBytes,
		tco: result.tco,
	});

	// Tier 1: bounded handoff as the user-visible moa-result. This is what
	// subsequent LLM turns see, and it is what triggers session file
	// persistence (display: true + the first visible content in the session).
	pi.sendMessage(
		{
			customType: "moa-result",
			content: [{ type: "text", text: handoff }],
			display: true,
			details: buildTraceDetails(result, {
				runId,
				archiveChunks: manifest.chunks,
				archiveBytes: manifest.bytes,
			}),
			attribution: "agent",
		},
		{ triggerTurn: false },
	);

	// Tier 2: full transcript as a series of moa-archive custom entries.
	// display: false keeps them out of LLM context but they are still
	// persisted to the session JSONL (the file is already created by tier 1).
	// The manifest entry must be sent first so listMoaArchiveRuns /
	// reconstructMoaArchive can find the run before its chunks arrive.
	pi.sendMessage(
		{
			customType: MOA_ARCHIVE_ENTRY_TYPE,
			content: [{ type: "text", text: "" }],
			display: false,
			details: manifest,
			attribution: "agent",
		},
		{ triggerTurn: false },
	);
	for (const chunk of chunks) {
		pi.sendMessage(
			{
				customType: MOA_ARCHIVE_ENTRY_TYPE,
				content: [{ type: "text", text: chunk.content }],
				display: false,
				details: chunk,
				attribution: "agent",
			},
			{ triggerTurn: false },
		);
	}
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const configOverrides = (await loadMoaConfigOverrides(ctx.cwd)).overrides;
	const settings = resolveSettings(configOverrides);
	const modeNote =
		settings.workerExecutionMode === "in-process"
			? "(in-process: no extensions/MCP/LSP, read-only tools only)"
			: "";
	ctx.ui.notify(
		[
			`execution mode: ${settings.workerExecutionMode} ${modeNote}`,
			`workers: ${settings.workerCount}`,
			`discovery: ${settings.discoveryEnabled ? "on" : "off"}`,
			`rewrite: ${settings.rewriteEnabled ? "on" : "off"}`,
			`ask user: ${settings.askEnabled ? "on" : "off"} (max ${settings.maxMissingInputs})`,
			`max rounds: ${settings.maxRounds} (per-round ask ≤ ${settings.maxQuestionsPerRound})`,
			`quality min score: ${settings.qualityMinScore}`,
			`planner tools: ${settings.plannerToolMode}`,
			`archive chunk bytes: 48_000`,
		].join("\n"),
		"info",
	);
}

function readEntries(ctx: ExtensionCommandContext): unknown[] {
	const sm = (ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
	return sm?.getEntries?.() ?? [];
}

/**
 * Read moa-archive + moa-result entries from the current session AND every
 * other session JSONL in the same encoded-cwd directory. Returns entries in
 * (newest-session-first, in-file-order) sequence.
 *
 * Rationale: `/moa runs` and `/moa transcript` previously only saw the
 * current session's moa-archive, so a run launched in a tmux pane (different
 * omp instance, different session JSONL) was invisible. Cross-session
 * aggregation matches the user's mental model — "I ran moa, I should be
 * able to find it" — and the IO cost is bounded (one workspace's session
 * files, typically < 1 MB total).
 */
async function readAllSessionEntries(ctx: ExtensionCommandContext): Promise<unknown[]> {
	const currentFile = ctx.sessionManager.getSessionFile();
	const current = readEntries(ctx);
	if (!currentFile) return current;

	// currentFile = `<sessionsRoot>/<encodedCwd>/by-date/YYYY-MM-DD/HHMMSS__hash.jsonl`
	// 3 levels up = `<sessionsRoot>/<encodedCwd>/`
	const encodedCwdDir = path.dirname(path.dirname(path.dirname(currentFile)));

	let relFiles: string[];
	try {
		const glob = new Bun.Glob("**/*.jsonl");
		const out: string[] = [];
		for await (const rel of glob.scan({ cwd: encodedCwdDir, onlyFiles: true })) {
			out.push(rel);
		}
		relFiles = out;
	} catch {
		return current;
	}
	relFiles.sort();

	const other: unknown[] = [];
	for (const rel of relFiles) {
		const full = path.join(encodedCwdDir, rel);
		if (full === currentFile) continue;
		let text: string;
		try {
			text = await Bun.file(full).text();
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				other.push(JSON.parse(trimmed));
			} catch {
				// skip malformed lines from a partially-flushed session file
			}
		}
	}
	return [...current, ...other];
}

async function handleTranscript(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const runId = args.trim() || undefined;
	const entries = await readAllSessionEntries(ctx);
	const result = reconstructMoaArchive(entries, runId);
	if (!result) {
		ctx.ui.notify(
			runId
				? `No moa archive found for runId "${runId}" in this workspace.`
				: "No moa archive found in this workspace. Run `/moa run <task>` first.",
			"error",
		);
		return;
	}
	const headerLines = [
		`# moa run ${result.manifest.runId}`,
		`- created: ${result.manifest.createdAt}`,
		`- task: ${result.manifest.task || "(empty)"}`,
		`- workers: ${result.manifest.completedWorkers}/${result.manifest.workerCount} completed`,
		`- archive: ${result.manifest.chunks} chunk(s), ${result.manifest.bytes} bytes`,
	];
	if (result.manifest.timings && Object.keys(result.manifest.timings).length > 0) {
		headerLines.push("", formatTimingSummary(result.manifest.timings));
	}
	headerLines.push("");
	const header = headerLines.join("\n");
	pi.sendMessage(
		{
			customType: "moa-transcript",
			content: [
				{ type: "text", text: header },
				{ type: "text", text: result.content },
			],
			display: true,
			details: {
				runId: result.manifest.runId,
				chunks: result.manifest.chunks,
				bytes: result.manifest.bytes,
			},
			attribution: "agent",
		},
		{ triggerTurn: false },
	);
}

async function handleRuns(ctx: ExtensionCommandContext): Promise<void> {
	const entries = await readAllSessionEntries(ctx);
	const runs = listMoaArchiveRuns(entries);
	if (runs.length === 0) {
		ctx.ui.notify("No moa archive runs in this workspace.", "info");
		return;
	}
	const lines = runs
		.slice()
		.reverse()
		.map(
			run =>
				`${run.runId}  workers=${run.completedWorkers}/${run.workerCount}  chunks=${run.chunks}  bytes=${run.bytes}  ${run.task.slice(0, 60)}`,
		);
	ctx.ui.notify(`moa runs (most recent first):\n${lines.join("\n")}`, "info");
}

export default function moaExtension(pi: ExtensionAPI): void {
	// Prevent recursive moa in worker subprocesses: every worker spawned by
	// /moa run sets PI_MOA_SUBAGENT=1 in its env (see subprocess.ts). When
	// the worker process loads the moa extension, we no-op so the worker
	// never spawns its own workers.
	if (process.env.PI_MOA_SUBAGENT === "1") return;

	pi.setLabel("MOA Planner");
	pi.registerMessageRenderer("moa-result", createRenderMoaResult(pi.pi.getMarkdownTheme));
	pi.registerCommand("moa", {
		description: "Run a Mixture-of-Agents planning panel",
		getArgumentCompletions: prefix => {
			const subcommands = ["run", "status", "transcript", "runs", "help"];
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
				case "transcript":
					await handleTranscript(rest.join(" "), ctx, pi);
					return;
				case "runs":
					await handleRuns(ctx);
					return;
				default:
					ctx.ui.notify(usageText(), "info");
			}
		},
	});
}
