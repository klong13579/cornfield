/**
 * Real e2e: /moa run with locked cost-lite 4-model layout loaded via
 * project `.omp/moa.yml` (not the developer's ~/.omp/agent/moa.yml).
 *
 * Isolation:
 *   - HOME → empty fake home (no global moa.yml bleed)
 *   - cwd → temp project with `.git` + `.omp/moa.yml` matching DEFAULT_* in settings.ts
 *   - PI_CODING_AGENT_DIR → seeded agent dir (config/models)
 *   - no PI_MOA_SETTINGS_JSON
 *
 * Skips unless BOTH NARWAL_PLAN_API_KEY and ALIBABA_API_KEY are set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../coding-agent/test/utilities";
import { DEFAULT_SYNTHESIS_MODEL, DEFAULT_WORKER_MODELS } from "../src/settings";
import { MOA_ARCHIVE_ENTRY_TYPE } from "../src/types";

const narwalApiKey = e2eApiKey("NARWAL_PLAN_API_KEY");
const alibabaApiKey = e2eApiKey("ALIBABA_API_KEY");

/** Locked fixture — must match DEFAULT_WORKER_MODELS / DEFAULT_SYNTHESIS_MODEL. */
const COST_LITE_WORKERS = [
	{ name: "divergent", model: DEFAULT_WORKER_MODELS.divergent },
	{ name: "grounded", model: DEFAULT_WORKER_MODELS.grounded },
	{ name: "critical", model: DEFAULT_WORKER_MODELS.critical },
] as const;
const COST_LITE_SYNTHESIS_MODEL = DEFAULT_SYNTHESIS_MODEL;

const COST_LITE_MOA_YML = `workers:
  - name: divergent
    role: Generate distinct candidate routes and alternate framings
    model: ${COST_LITE_WORKERS[0].model}
  - name: grounded
    role: Evaluate constraints, costs, and implementation realism
    model: ${COST_LITE_WORKERS[1].model}
  - name: critical
    role: Attack weaknesses, edge cases, and failure modes
    model: ${COST_LITE_WORKERS[2].model}
synthesisModel: ${COST_LITE_SYNTHESIS_MODEL}
discoveryEnabled: true
rewriteEnabled: true
plannerToolMode: read-only
timeoutMs: 300000
workerExecutionMode: subprocess
maxRounds: 0
qualityMinScore: 0
resumeContextBytes: 32000
`;

const TEST_TASK =
	"为米克原子（室内家庭服务机器人创业公司，2C，研发阶段，天使轮）设计一份 4 周招聘计划，10 个岗位，从速度、成本、质量三个角度权衡";

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

function isMoaResult(m: AgentMessage): m is MoaResultMessage {
	return m.role === "custom" && m.customType === "moa-result";
}
function isMoaArchive(m: AgentMessage): m is MoaArchiveMessage {
	return m.role === "custom" && m.customType === MOA_ARCHIVE_ENTRY_TYPE;
}
function extractText(m: MoaResultMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("")
		.trim();
}

function archiveChunkText(m: MoaArchiveMessage): string {
	const details = m.details as { kind?: string; content?: string } | undefined;
	if (details?.kind === "chunk" && typeof details.content === "string") return details.content;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
			.map(b => b.text)
			.join("");
	}
	return "";
}

async function waitForMoaResult(client: RpcClient, prompt: string, timeoutMs: number) {
	await client.prompt(prompt);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const msgs = await client.getMessages();
		const result = [...msgs].reverse().find(isMoaResult);
		if (result) {
			await Bun.sleep(300);
			return { result, allMessages: await client.getMessages() };
		}
		await Bun.sleep(500);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for moa-result`);
}

async function seedIsolatedAgentDir(agentDir: string): Promise<void> {
	const userAgent = path.join(os.homedir(), ".omp", "agent");
	await Bun.write(path.join(agentDir, "config.yml"), await Bun.file(path.join(userAgent, "config.yml")).text());
	await Bun.write(path.join(agentDir, "models.yml"), await Bun.file(path.join(userAgent, "models.yml")).text());
}

describe.skipIf(!narwalApiKey || !alibabaApiKey)("moa e2e: cost-lite layout from project moa.yml", () => {
	let client: RpcClient;
	let agentDir: string;
	let projectDir: string;
	let fakeHome: string;

	beforeEach(async () => {
		const stamp = Snowflake.next();
		agentDir = path.join(os.tmpdir(), `omp-moa-real-agent-${stamp}`);
		projectDir = path.join(os.tmpdir(), `omp-moa-real-proj-${stamp}`);
		fakeHome = path.join(os.tmpdir(), `omp-moa-real-home-${stamp}`);

		await fs.promises.mkdir(agentDir, { recursive: true });
		await fs.promises.mkdir(path.join(projectDir, ".git"), { recursive: true });
		await fs.promises.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.promises.mkdir(path.join(fakeHome, ".omp", "agent"), { recursive: true });
		await seedIsolatedAgentDir(agentDir);
		await Bun.write(path.join(projectDir, ".omp", "moa.yml"), COST_LITE_MOA_YML);

		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts"),
			cwd: projectDir,
			env: {
				HOME: fakeHome,
				PI_CODING_AGENT_DIR: agentDir,
				NARWAL_PLAN_API_KEY: narwalApiKey!,
				ALIBABA_API_KEY: alibabaApiKey!,
				PI_LOG_CONSOLE: "false",
				// No PI_MOA_SETTINGS_JSON — project .omp/moa.yml is the source of truth.
			},
			provider: "narwal-plan",
			model: "minimax-m3",
			args: ["--no-color"],
		});
	});

	afterEach(() => {
		client.stop();
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
		fs.rmSync(fakeHome, { recursive: true, force: true });
	});

	test("runs /moa run with cost-lite 4 models on the locked 4-week hiring plan task", async () => {
		const startedAt = Date.now();
		await client.start();
		console.log(`[moa-e2e] started, agentDir=${agentDir}, projectDir=${projectDir}`);

		const { result, allMessages } = await waitForMoaResult(client, `/moa run ${TEST_TASK}`, 480_000);
		const wallMs = Date.now() - startedAt;
		const resultText = extractText(result);
		const details = result.details as MoaTraceDetails;

		expect(details.task).toBe(TEST_TASK);
		expect(details.workerCount).toBe(3);
		expect(details.workers).toHaveLength(3);
		expect(resultText).toContain("## Worker conclusions");
		expect(resultText).toContain("### worker ");
		// Handoff may still truncate long worker bodies; synthesis is asserted on summary + archive.
		expect(details.summary).toContain("## MOA Run");
		expect(details.summary).toContain("### synthesis");
		expect(details.runId).toMatch(/^moa-/);
		expect(details.archiveChunks).toBeGreaterThan(0);
		expect(details.archiveBytes).toBeGreaterThan(0);

		const workerModels = details.workers.map(w => w.model);
		expect(new Set(workerModels).size).toBe(3);
		expect(workerModels).toEqual(COST_LITE_WORKERS.map(w => w.model));

		for (const w of details.workers) {
			expect(w.ok).toBe(true);
			console.log(`[moa-e2e] worker ${w.name} model=${w.model} ok=${w.ok}`);
		}

		console.log(`[moa-e2e] synthesis model = ${details.synthesisModel}`);
		expect(details.synthesisModel).toBe(COST_LITE_SYNTHESIS_MODEL);
		expect(details.summary.length).toBeGreaterThan(200);
		// Handoff may omit the short **TCO** line under resumeContextBytes pressure;
		// the durable archive always carries the full Task Context when discovery ran.
		const archive = allMessages.filter(isMoaArchive);
		expect(archive.length).toBeGreaterThanOrEqual(1 + details.archiveChunks);
		const allArchiveText = archive.map(archiveChunkText).join("");
		expect(allArchiveText).toContain("## Task Context (TCO)");
		expect(allArchiveText).toContain("## Worker 1:");
		expect(allArchiveText).toContain("## Synthesis");
		expect(resultText.includes("**TCO**:") || allArchiveText.includes("## Task Context (TCO)")).toBe(true);

		const workerSections =
			allArchiveText.match(/## Worker \d+: [^\n]+ — ok[\s\S]*?(?=\n## (?:Worker|Synthesis|Dispatch)|$)/g) ?? [];
		for (let i = 0; i < workerSections.length; i++) {
			const section = workerSections[i]!.trim();
			console.log(
				`\n========== WORKER ${i + 1} (${section.length} chars) ==========\n${section}\n========== END WORKER ${i + 1} ==========`,
			);
		}

		console.log(`\n=== /moa run completed in ${(wallMs / 1000).toFixed(1)}s ===`);
		console.log(`runId: ${details.runId}`);
		console.log(`workers: ${details.workers.map(w => `${w.name}/${w.model}`).join(", ")}`);
		console.log(`synthesis: ${details.synthesisModel}`);
		console.log(`archive: ${details.archiveChunks} chunk(s), ${details.archiveBytes} bytes`);
	}, 540_000);
});
