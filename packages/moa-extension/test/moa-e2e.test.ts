import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../coding-agent/test/utilities";

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
}

type MoaResultMessage = Extract<AgentMessage, { role: "custom" }> & {
	customType: "moa-result";
	details?: unknown;
};

const narwalApiKey = e2eApiKey("NARWAL_PLAN_API_KEY");
const heterogeneousNarwalModels = ["minimax-m3", "kimi-k2.5", "glm-5-turbo"] as const;
const heterogeneousNarwalSynthesisModel = "qwen3.5-plus";

function isMoaResultMessage(message: AgentMessage): message is MoaResultMessage {
	return message.role === "custom" && message.customType === "moa-result";
}

function extractMessageText(message: MoaResultMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
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

async function waitForMoaResult(client: RpcClient, prompt: string, timeoutMs: number): Promise<MoaResultMessage> {
	await client.prompt(prompt);
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const messages = await client.getMessages();
		const result = [...messages].reverse().find(isMoaResultMessage);
		if (result) return result;
		await Bun.sleep(500);
	}
	throw new Error(`Timed out waiting for moa-result after ${timeoutMs}ms`);
}


function buildMoaSettingsEnv(): string {
	return JSON.stringify({
		workers: [
			{ name: "divergent", role: "Generate distinct candidate routes", model: heterogeneousNarwalModels[0] },
			{ name: "grounded", role: "Evaluate constraints and implementation realism", model: heterogeneousNarwalModels[1] },
			{ name: "critical", role: "Attack weaknesses, edge cases, and failure modes", model: heterogeneousNarwalModels[2] },
		],
		synthesisModel: heterogeneousNarwalSynthesisModel,
	});
}

async function seedIsolatedAgentDir(agentDir: string): Promise<void> {
	await Bun.write(path.join(agentDir, "config.yml"), await Bun.file(path.join(os.homedir(), ".omp", "agent", "config.yml")).text());
	await Bun.write(path.join(agentDir, "models.yml"), await Bun.file(path.join(os.homedir(), ".omp", "agent", "models.yml")).text());
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
			args: ["--extension", path.join(import.meta.dir, "..", "src", "extension.ts"), "--no-color"],
		});
	});

	afterEach(() => {
		client.stop();
	});

	test(
		"runs /moa through real rpc session and preserves heterogeneous worker models",
		async () => {
			await client.start();

			const task = [
				"Need a concise planning recommendation.",
				"Choose between launching Feature A this month or Feature B next month.",
				"No tools are required; reason from generic product tradeoffs only.",
			].join(" ");

			const moaResult = await waitForMoaResult(client, `/moa run ${task}`, 240_000);
			const resultText = extractMessageText(moaResult);
			const details = parseMoaDetails(moaResult.details);

			expect(resultText).toContain("## MOA Run");
			expect(resultText).toContain("### synthesis");
			expect(details.task).toBe(task);
			expect(details.workerCount).toBe(3);
			expect(details.workers).toHaveLength(3);
			expect(details.workers.map(worker => worker.model)).toEqual([...heterogeneousNarwalModels]);
			expect(details.summary).toContain("## MOA Run");

		},
		300_000,
	);
});
