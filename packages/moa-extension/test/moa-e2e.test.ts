import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../coding-agent/test/utilities";
import { MOA_ARCHIVE_ENTRY_TYPE } from "../src/types";

interface MoaWorkerTrace {
	name: string;
	role: string;
	ok: boolean;
	model?: string;
}

interface MoaTraceDetails {
	task: string;
	workerCount: number;
	workers: MoaWorkerTrace[];
	summary: string;
	synthesisModel?: string;
	runId: string;
	archiveChunks: number;
	archiveBytes: number;
}

type MoaResultMessage = Extract<AgentMessage, { role: "custom" }> & {
	customType: "moa-result";
	details?: unknown;
};

type MoaArchiveMessage = Extract<AgentMessage, { role: "custom" }> & {
	customType: typeof MOA_ARCHIVE_ENTRY_TYPE;
	details?: unknown;
};

const narwalApiKey = e2eApiKey("NARWAL_PLAN_API_KEY");
/** Cost-aware heterogeneous layout on a single provider (provider/id form). */
const heterogeneousNarwalModels = [
	"narwal-plan/minimax-m3",
	"narwal-plan/kimi-k2.5",
	"narwal-plan/glm-5-turbo",
] as const;
const heterogeneousNarwalSynthesisModel = "narwal-plan/qwen3.5-plus";

function isMoaResultMessage(message: AgentMessage): message is MoaResultMessage {
	return message.role === "custom" && message.customType === "moa-result";
}

function isMoaArchiveMessage(message: AgentMessage): message is MoaArchiveMessage {
	return message.role === "custom" && message.customType === MOA_ARCHIVE_ENTRY_TYPE;
}

function extractMessageText(message: MoaResultMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("")
		.trim();
}

function parseMoaDetails(value: unknown): MoaTraceDetails {
	if (!value || typeof value !== "object") {
		throw new Error("Expected MOA result details object");
	}
	return value as MoaTraceDetails;
}

async function waitForMoaResult(
	client: RpcClient,
	prompt: string,
	timeoutMs: number,
): Promise<{ result: MoaResultMessage; allMessages: AgentMessage[] }> {
	await client.prompt(prompt);
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const messages = await client.getMessages();
		const result = [...messages].reverse().find(isMoaResultMessage);
		if (result) {
			// Give archive chunks a brief window to land after the handoff.
			await Bun.sleep(300);
			return { result, allMessages: await client.getMessages() };
		}
		await Bun.sleep(500);
	}
	throw new Error(`Timed out waiting for moa-result after ${timeoutMs}ms`);
}

function buildMoaSettingsEnv(): string {
	return JSON.stringify({
		workers: [
			{ name: "divergent", role: "Generate distinct candidate routes", model: heterogeneousNarwalModels[0] },
			{
				name: "grounded",
				role: "Evaluate constraints and implementation realism",
				model: heterogeneousNarwalModels[1],
			},
			{
				name: "critical",
				role: "Attack weaknesses, edge cases, and failure modes",
				model: heterogeneousNarwalModels[2],
			},
		],
		synthesisModel: heterogeneousNarwalSynthesisModel,
		// RPC has no TUI — keep single-round + ask fallback explicit.
		maxRounds: 0,
		askEnabled: true,
		workerExecutionMode: "subprocess",
		// Avoid heuristic quality drops hiding the synthesis model on stub results.
		qualityMinScore: 0,
		resumeContextBytes: 32_000,
	});
}

async function seedIsolatedAgentDir(agentDir: string): Promise<void> {
	await Bun.write(
		path.join(agentDir, "config.yml"),
		await Bun.file(path.join(os.homedir(), ".omp", "agent", "config.yml")).text(),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		await Bun.file(path.join(os.homedir(), ".omp", "agent", "models.yml")).text(),
	);
}

describe.skipIf(!narwalApiKey)("moa extension e2e", () => {
	let client: RpcClient;
	let agentDir: string;

	beforeEach(async () => {
		agentDir = path.join(os.tmpdir(), `omp-moa-e2e-${Snowflake.next()}`);
		await seedIsolatedAgentDir(agentDir);
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, "..", "..", ".."),
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				NARWAL_PLAN_API_KEY: narwalApiKey!,
				PI_LOG_CONSOLE: "false",
				PI_MOA_SETTINGS_JSON: buildMoaSettingsEnv(),
			},
			provider: "narwal-plan",
			model: "minimax-m3",
			// MOA is inline via sdk.ts — do not pass --extension (avoids double registration).
			args: ["--no-color"],
		});
	});

	afterEach(() => {
		client.stop();
	});

	test("runs /moa through real rpc session and preserves heterogeneous worker models", async () => {
		await client.start();

		const task = [
			"Need a concise planning recommendation.",
			"Choose between launching Feature A this month or Feature B next month.",
			"No tools are required; reason from generic product tradeoffs only.",
		].join(" ");

		const { result: moaResult, allMessages } = await waitForMoaResult(client, `/moa run ${task}`, 240_000);
		const resultText = extractMessageText(moaResult);
		const details = parseMoaDetails(moaResult.details);

		expect(resultText).toContain("∪ moa transcript:");
		expect(resultText).toContain("## Worker conclusions");
		expect(resultText).toContain("/moa transcript");
		// Discovery/Ask TCO summary appears in handoff when discovery ran.
		expect(resultText).toMatch(/\*\*TCO\*\*:|## Worker conclusions/);

		expect(details.task).toBe(task);
		expect(details.workerCount).toBe(3);
		expect(details.workers).toHaveLength(3);
		expect(details.workers.map(worker => worker.model)).toEqual([...heterogeneousNarwalModels]);
		// Unbounded summary (not the resumeContextBytes-truncated handoff) carries synthesis.
		expect(details.summary).toContain("## MOA Run");
		expect(details.summary).toContain("### synthesis");
		expect(details.synthesisModel).toBe(heterogeneousNarwalSynthesisModel);
		expect(details.runId).toMatch(/^moa-/);
		expect(details.archiveChunks).toBeGreaterThan(0);
		expect(details.archiveBytes).toBeGreaterThan(0);

		const archives = allMessages.filter(isMoaArchiveMessage);
		expect(archives.length).toBeGreaterThanOrEqual(1 + details.archiveChunks);
		const manifest = archives.find(m => (m.details as { kind?: string } | undefined)?.kind === "manifest");
		expect(manifest).toBeDefined();
		expect((manifest!.details as { runId: string }).runId).toBe(details.runId);
	}, 300_000);
});
