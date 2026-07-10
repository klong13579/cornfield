import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../coding-agent/test/utilities";

interface MoaWorkerTrace {
	name: string;
	role: string;
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	model?: string;
}

interface MoaTraceDetails {
	task: string;
	workerCount: number;
	workers: MoaWorkerTrace[];
	synthesis: MoaWorkerTrace;
	summary: string;
}

type MoaResultMessage = Extract<AgentMessage, { role: "custom" }> & {
	customType: "moa-result";
	details?: unknown;
};

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

async function waitForMoaResult(client: RpcClient, timeoutMs: number): Promise<MoaResultMessage> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const messages = await client.getMessages();
		const result = [...messages].reverse().find(isMoaResultMessage);
		if (result) return result;
		await Bun.sleep(500);
	}
	throw new Error(`Timed out waiting for moa-result after ${timeoutMs}ms`);
}

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("moa extension e2e", () => {
	let client: RpcClient;
	let agentDir: string;

	beforeEach(() => {
		agentDir = path.join(os.tmpdir(), `omp-moa-e2e-${Snowflake.next()}`);
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, "..", "..", ".."),
			env: { PI_CODING_AGENT_DIR: agentDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			args: ["--extension", path.join(import.meta.dir, "..", "src", "extension.ts"), "--no-color"],
		});
	});

	afterEach(() => {
		client.stop();
		if (agentDir && fs.existsSync(agentDir)) {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test(
		"runs /moa through real rpc session and persists moa-result",
		async () => {
			await client.start();
			await client.setModel("anthropic", "claude-sonnet-4-5");

			const task = [
				"Need a concise planning recommendation.",
				"Choose between launching Feature A this month or Feature B next month.",
				"No tools are required; reason from generic product tradeoffs only.",
			].join(" ");

			await client.prompt(`/moa run ${task}`);
			const moaResult = await waitForMoaResult(client, 180_000);
			const resultText = extractMessageText(moaResult);
			const details = parseMoaDetails(moaResult.details);

			expect(resultText).toContain("## MOA Run");
			expect(resultText).toContain("### synthesis");
			expect(details.task).toBe(task);
			expect(details.workerCount).toBe(3);
			expect(details.workers).toHaveLength(3);
			expect(details.workers.every(worker => worker.output.trim().length > 0)).toBe(true);
			expect(details.synthesis.output.trim().length).toBeGreaterThan(0);
			expect(details.summary).toContain("## MOA Run");

			await Bun.sleep(200);
			const stats = await client.getSessionStats();
			expect(stats.sessionFile).toBeDefined();
			if (!stats.sessionFile) {
				throw new Error("Expected RPC session file");
			}

			const sessionContent = await Bun.file(stats.sessionFile).text();
			const entries = parseSessionEntries(sessionContent);
			const persistedResult = entries.find(
				(entry): entry is Extract<(typeof entries)[number], { type: "custom_message"; customType: "moa-result" }> =>
					entry.type === "custom_message" && entry.customType === "moa-result",
			);
			expect(persistedResult).toBeDefined();
			if (!persistedResult) {
				throw new Error("Expected persisted moa-result entry");
			}
			const persistedText =
				typeof persistedResult.content === "string"
					? persistedResult.content
					: persistedResult.content
							.filter(
								(block): block is { type: "text"; text: string } =>
									block.type === "text" && typeof block.text === "string",
							)
							.map(block => block.text)
							.join("")
							.trim();
			expect(persistedText).toContain("## MOA Run");
		},
		210_000,
	);
});
