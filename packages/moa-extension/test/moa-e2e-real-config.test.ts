/**
 * Real e2e: /moa run with cost-lite 4-model defaults loaded from
 * ~/.omp/agent/moa.yml. No PI_MOA_SETTINGS_JSON env override — the loader
 * picks up the user's actual config file.
 *
 * Skips unless BOTH NARWAL_PLAN_API_KEY and ALIBABA_API_KEY are set
 * (the cost-lite defaults span two providers).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../coding-agent/test/utilities";

const narwalApiKey = e2eApiKey("NARWAL_PLAN_API_KEY");
const alibabaApiKey = e2eApiKey("ALIBABA_API_KEY");

// Cost-lite defaults (must match DEFAULT_WORKER_SLOTS / DEFAULT_SYNTHESIS_MODEL
// in src/settings.ts AND ~/.omp/agent/moa.yml)
const COST_LITE_WORKERS = [
	{ name: "divergent", model: "narwal-plan/qwen3.5-flash" },
	{ name: "grounded", model: "alibaba-coding-plan/deepseek-v4-pro" },
	{ name: "critical", model: "alibaba-coding-plan/kimi-k2.6" },
] as const;
const COST_LITE_SYNTHESIS_MODEL = "narwal-plan/deepseek-v4-pro-202606";

const TEST_TASK =
	"为米克原子（室内家庭服务机器人创业公司，2C，研发阶段，天灵轮）设计一份 4 周招聘计划，10 个岗位，从速度、成本、质量三个角度权衡";

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
	customType: "moa-archive";
	details?: unknown;
};

function isMoaResult(m: AgentMessage): m is MoaResultMessage {
	return m.role === "custom" && m.customType === "moa-result";
}
function isMoaArchive(m: AgentMessage): m is MoaArchiveMessage {
	return m.role === "custom" && m.customType === "moa-archive";
}
function extractText(m: MoaResultMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("")
		.trim();
}

async function waitForMoaResult(client: RpcClient, prompt: string, timeoutMs: number) {
	await client.prompt(prompt);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msgs = await client.getMessages();
		const result = [...msgs].reverse().find(isMoaResult);
		if (result) return { result, allMessages: msgs };
		await Bun.sleep(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for moa-result`);
}

async function seedIsolatedAgentDir(agentDir: string): Promise<void> {
	const userAgent = path.join(os.homedir(), ".omp", "agent");
	await Bun.write(path.join(agentDir, "config.yml"), await Bun.file(path.join(userAgent, "config.yml")).text());
	await Bun.write(path.join(agentDir, "models.yml"), await Bun.file(path.join(userAgent, "models.yml")).text());
}

describe.skipIf(!narwalApiKey || !alibabaApiKey)("moa e2e: real cost-lite config from ~/.omp/agent/moa.yml", () => {
	let client: RpcClient;
	let agentDir: string;

	beforeEach(async () => {
		agentDir = path.join(os.tmpdir(), `omp-moa-real-${Snowflake.next()}`);
		await fs.promises.mkdir(agentDir, { recursive: true });
		await seedIsolatedAgentDir(agentDir);

		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, "..", "..", ".."),
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				NARWAL_PLAN_API_KEY: narwalApiKey!,
				ALIBABA_API_KEY: alibabaApiKey!,
				PI_LOG_CONSOLE: "false",
				// NO PI_MOA_SETTINGS_JSON — let the loader pick up ~/.omp/agent/moa.yml
			},
			provider: "narwal-plan",
			model: "minimax-m3",
			args: ["--extension", path.join(import.meta.dir, "..", "src", "extension.ts"), "--no-color"],
		});
	});

	afterEach(() => {
		client.stop();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	test("runs /moa run with cost-lite 4 models on the locked 4-week hiring plan task", async () => {
		const startedAt = Date.now();
		await client.start();
		console.log(`[moa-e2e] started, agentDir=${agentDir}`);

		const { result, allMessages } = await waitForMoaResult(client, `/moa run ${TEST_TASK}`, 300_000);
		const wallMs = Date.now() - startedAt;
		const resultText = extractText(result);
		const details = result.details as MoaTraceDetails;

		// --- structural assertions ---
		expect(details.task).toBe(TEST_TASK);
		expect(details.workerCount).toBe(3);
		expect(details.workers).toHaveLength(3);
		// handoff text uses per-worker sections; "## MOA Run" is only in details.summary
		expect(resultText).toContain("## Worker conclusions");
		for (const _name of ["divergent", "grounded", "critical"]) {
			expect(resultText).toContain(`### worker `);
		}
		expect(details.summary).toContain("## MOA Run");
		expect(details.summary).toContain("### synthesis");

		// --- heterogeneity: 3 distinct models, all from the cost-lite set ---
		const workerModels = details.workers.map(w => w.model);
		expect(new Set(workerModels).size).toBe(3);
		const expected = COST_LITE_WORKERS.map(w => w.model);
		expect(workerModels).toEqual(expected);

		// --- every worker actually produced output ---
		for (const w of details.workers) {
			expect(w.ok).toBe(true);
			console.log(`[moa-e2e] worker ${w.name} model=${w.model} ok=${w.ok}`);
		}

		// --- synthesis model: surfaced via MoaTraceDetails.synthesisModel.
		//     The executor sets this on the synthesis MoaWorkerResult
		//     (executor.ts mapWorkerOutput) so we don't have to parse
		//     the archive transcript to verify the synthesis model. ---
		console.log(`[moa-e2e] synthesis model = ${details.synthesisModel}`);
		expect(details.synthesisModel).toBe(COST_LITE_SYNTHESIS_MODEL);
		expect(details.summary.length).toBeGreaterThan(200);

		// --- final report ---
		console.log(`\n=== /moa run completed in ${(wallMs / 1000).toFixed(1)}s ===`);
		console.log(`runId: ${details.runId}`);
		console.log(`workers: ${details.workers.map(w => `${w.name}/${w.model}`).join(", ")}`);
		console.log(`synthesis: ${details.synthesisModel}`);
		console.log(`archive: ${details.archiveChunks} chunk(s), ${details.archiveBytes} bytes`);
		console.log(
			`summary (${details.summary.length} chars):\n${details.summary.slice(0, 8000)}${details.summary.length > 8000 ? "\n…(truncated)" : ""}`,
		);

		// dump each worker's full output from the archive
		const archive = allMessages.filter(isMoaArchive);
		const allArchiveText = archive.map(m => (m.details as { content?: string } | undefined)?.content ?? "").join("");
		const workerSections =
			allArchiveText.match(/## Worker \d+: [^\n]+ — ok[\s\S]*?(?=\n## (?:Worker|Synthesis)|$)/g) ?? [];
		for (let i = 0; i < workerSections.length; i++) {
			const section = workerSections[i]!.trim();
			console.log(
				`\n========== WORKER ${i + 1} (${section.length} chars) ==========\n${section}\n========== END WORKER ${i + 1} ==========`,
			);
		}
	}, 360_000);
});
