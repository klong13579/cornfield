/**
 * Co-test for the multi-round Q&A loop.
 *
 * Spawns `omp` in interactive TUI mode (MOA is inline — no `--extension`),
 * pipes `/moa run <task>` plus scripted answers via stdin, then verifies the
 * session archive / dispatchLog after the run.
 *
 * Run with:  E2E=1 bun run packages/moa-extension/test-mr-e2e-cotest.ts
 * Prereqs:  NARWAL_PLAN_API_KEY (+ ALIBABA_API_KEY if using cross-provider models),
 *           real models.yml in ~/.omp/agent/.
 *
 * What to expect:
 *   1. Pre-ask / Round 1 workers may surface open_questions.
 *   2. Orchestrator asks via stdin (answer / skip / stop).
 *   3. Round 2+ prompts get `## Round N context` + previous answers
 *      (Round 1 has no Round context block — see stages.buildRoundHistoryBlock).
 *   4. Synthesis runs on surviving worker plans.
 *   5. Session holds moa-result + moa-archive with dispatchLog rounds.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MOA_ARCHIVE_ENTRY_TYPE } from "./src/types";

const TASK =
	"为米克原子（室内家庭服务机器人创业公司，2C，研发阶段，天使轮）设计一份 4 周招聘计划，10 个岗位，从速度、成本、质量三个角度权衡";

const SCRIPTED_ANSWERS = [
	"深圳，研发期 50 人分四组（世界模型/行为智能/软件系统/机电系统）",
	"天使轮总盘子 3000w，招聘预算 200w 现金 + 期权池 5%",
	"4 周发 offer 即可，入职分批；资深允许 6-8 周",
	"质量底线 = 感知/规划/工业设计 3 个岗不能降；其他 P5/P6 够用",
];

const OMP_BIN =
	process.env.MOA_OMP_BIN ?? path.join(import.meta.dir, "..", "coding-agent", "src", "cli.ts");

const stamp = Date.now();
const agentDir = path.join(os.tmpdir(), `omp-moa-cotest-agent-${stamp}`);
const projectDir = path.join(os.tmpdir(), `omp-moa-cotest-proj-${stamp}`);
const userAgent = path.join(os.homedir(), ".omp", "agent");

await fs.mkdir(agentDir, { recursive: true });
await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
await Bun.write(path.join(agentDir, "config.yml"), await Bun.file(path.join(userAgent, "config.yml")).text());
await Bun.write(path.join(agentDir, "models.yml"), await Bun.file(path.join(userAgent, "models.yml")).text());

console.log(`[co-test] OMP binary: ${OMP_BIN}`);
console.log(`[co-test] agentDir: ${agentDir}`);
console.log(`[co-test] projectDir: ${projectDir}`);
console.log(`[co-test] task: ${TASK}`);
console.log(`[co-test] scripted answers: ${SCRIPTED_ANSWERS.length} prepared`);

const proc = Bun.spawn({
	cmd: [OMP_BIN, "--no-color"],
	cwd: projectDir,
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_LOG_CONSOLE: "false",
		PI_MOA_SETTINGS_JSON: JSON.stringify({
			workers: [
				{ name: "divergent", role: "Generate distinct candidate routes", model: "narwal-plan/minimax-m3" },
				{ name: "grounded", role: "Evaluate constraints", model: "narwal-plan/kimi-k2.5" },
				{ name: "critical", role: "Attack weaknesses", model: "alibaba-coding-plan/glm-5.1" },
			],
			synthesisModel: "narwal-plan/deepseek-v4-pro-202606",
			maxRounds: 3,
			maxQuestionsPerRound: 5,
			qualityMinScore: 40,
			workerExecutionMode: "subprocess",
		}),
	},
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const stdinWriter = (proc.stdin as WritableStream<Uint8Array>).getWriter();
const encoder = new TextEncoder();

await Bun.sleep(3000);
await stdinWriter.write(encoder.encode(`/moa run ${TASK}\n`));
console.log(`[co-test] sent /moa run`);

for (let i = 0; i < SCRIPTED_ANSWERS.length; i++) {
	await Bun.sleep(8000);
	await stdinWriter.write(encoder.encode(`${SCRIPTED_ANSWERS[i]}\n`));
	console.log(`[co-test] sent answer ${i + 1}/${SCRIPTED_ANSWERS.length}: ${SCRIPTED_ANSWERS[i]}`);
}

interface SessionCustom {
	type?: string;
	role?: string;
	customType?: string;
	details?: {
		kind?: string;
		runId?: string;
		dispatchLog?: Array<{ workerName: string; round: number }>;
		workerCount?: number;
		workers?: Array<{ name: string; ok: boolean; model?: string }>;
		content?: string;
		task?: string;
	};
	content?: string | Array<{ type: string; text?: string }>;
}

async function findSessionJsonlFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = path.join(dir, name);
			const st = await fs.stat(full);
			if (st.isDirectory()) await walk(full);
			else if (name.endsWith(".jsonl")) out.push(full);
		}
	}
	await walk(root);
	return out;
}

async function loadCustomEntries(): Promise<SessionCustom[]> {
	const files = await findSessionJsonlFiles(path.join(agentDir, "sessions"));
	const entries: SessionCustom[] = [];
	for (const file of files) {
		const text = await Bun.file(file).text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as SessionCustom;
				if (parsed.type === "custom_message" || parsed.role === "custom") {
					entries.push(parsed);
				}
			} catch {
				// ignore malformed lines
			}
		}
	}
	return entries;
}

function extractText(entry: SessionCustom): string {
	if (typeof entry.content === "string") return entry.content;
	if (Array.isArray(entry.content)) {
		return entry.content
			.filter(b => b.type === "text" && typeof b.text === "string")
			.map(b => b.text!)
			.join("");
	}
	return entry.details?.content ?? "";
}

console.log(`[co-test] waiting for moa-result in session (up to 6 min)...`);
const deadline = Date.now() + 360_000;
let moaResult: SessionCustom | undefined;
let archives: SessionCustom[] = [];
while (Date.now() < deadline) {
	const customs = await loadCustomEntries();
	moaResult = [...customs].reverse().find(e => e.customType === "moa-result");
	archives = customs.filter(e => e.customType === MOA_ARCHIVE_ENTRY_TYPE);
	if (moaResult) break;
	await Bun.sleep(2000);
}

// Ask TUI to exit cleanly; fall back to SIGTERM.
try {
	await stdinWriter.write(encoder.encode("/exit\n"));
} catch {
	// stdin may already be closed
}
await Bun.sleep(2000);
if (!proc.killed) {
	proc.kill("SIGTERM");
}
await Promise.race([proc.exited, Bun.sleep(5000)]);

const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();

console.log(`\n=== Co-test complete ===`);
console.log(`stdout length: ${stdout.length} chars`);
if (stderr.trim()) console.log(`stderr (first 500 chars):\n${stderr.slice(0, 500)}`);

if (!moaResult) {
	console.error(`\n[FAIL] No moa-result custom message found under ${agentDir}/sessions`);
	process.exit(1);
}

const details = moaResult.details;
const handoff = extractText(moaResult);
console.log(`runId: ${details?.runId ?? "(missing)"}`);
console.log(`workers: ${details?.workers?.map(w => `${w.name}/${w.model} ok=${w.ok}`).join(", ") ?? "(none)"}`);
console.log(`handoff preview:\n${handoff.slice(0, 400)}`);

if (!details?.workers || details.workers.length !== 3) {
	console.error(`[FAIL] Expected 3 workers in moa-result details, got ${details?.workers?.length ?? 0}`);
	process.exit(1);
}
if (!handoff.includes("∪ moa transcript:") || !handoff.includes("## Worker conclusions")) {
	console.error(`[FAIL] handoff missing expected markers`);
	process.exit(1);
}
if (archives.length === 0) {
	console.error(`[FAIL] No moa-archive entries in session`);
	process.exit(1);
}

const manifest = archives.find(a => a.details?.kind === "manifest");
const dispatchLog = manifest?.details?.dispatchLog ?? [];
const rounds = new Set(dispatchLog.map(e => e.round));
const archiveText = archives.map(extractText).join("");
const planHeaders = (archiveText.match(/## plan\b/gi) ?? []).length;
// Current format: "## Round 2 context" (no DISCOVERY/PLANNING phase labels).
// Round 1 intentionally has no Round context block.
const round2InHandoffOrArchive = archiveText.includes("## Round 2 context") || handoff.includes("## Round 2 context");

console.log(`archive entries: ${archives.length}`);
console.log(`dispatchLog rounds: ${[...rounds].sort((a, b) => a - b).join(",") || "(empty)"}`);
console.log(`## plan headers in archive: ${planHeaders}`);
console.log(`## Round 2 context in archive/handoff: ${round2InHandoffOrArchive}`);

if (!rounds.has(1) && dispatchLog.length > 0) {
	console.error(`[FAIL] dispatchLog present but missing round 1`);
	process.exit(1);
}

if (rounds.has(2) || round2InHandoffOrArchive) {
	console.log(`[PASS] Multi-round advanced (round 2 observed).`);
} else {
	console.warn(
		`[WARN] No round-2 signal (dispatchLog rounds=${[...rounds].join(",") || "∅"}; ` +
			`archive may omit prompt text). ` +
			`This can happen if round 1 already converged / user stop / maxRounds short-circuit.`,
	);
}

if (planHeaders < 1) {
	console.warn(`[WARN] Few ## plan headers in archive (got ${planHeaders}) — workers may have mostly asked questions.`);
}

console.log(`\n[PASS] moa-result + moa-archive persisted; 3 workers recorded.`);
console.log(`       Session dir: ${agentDir}`);
console.log(`       Inspect archive for TCO / worker plans / synthesis.`);

try {
	await fs.rm(agentDir, { recursive: true, force: true });
	await fs.rm(projectDir, { recursive: true, force: true });
} catch {
	// leave artifacts if cleanup fails
}
