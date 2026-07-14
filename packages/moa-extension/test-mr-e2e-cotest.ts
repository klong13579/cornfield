/**
 * Co-test for the multi-round Q&A loop.
 *
 * Spawns `omp` in interactive TUI mode with the moa-extension loaded, pipes
 * `/moa run <task>` plus scripted answers via stdin, and verifies the round
 * 1 (DISCOVERY) and round 2 (PLANNING) context blocks land in the worker
 * subprocess prompts.
 *
 * Run with:  E2E=1 bun run packages/moa-extension/test-mr-e2e-cotest.ts
 * Prereqs:  NARWAL_PLAN_API_KEY env var, real models.yml in ~/.omp/agent/.
 *
 * What to watch in the OMP TUI:
 *   1. Round 1 fires 3 workers in parallel. They each output ONLY
 *      `## open_questions` (no plan, no step-1 复述).
 *   2. Orchestrator dedupes, asks you up to maxQuestionsPerRound.
 *   3. You type the scripted answer (or your own).
 *   4. Round 2 fires 3 workers again. They each see the round context block
 *      with the user's answers and output a real `## plan`.
 *   5. Synthesis runs on the round 2 plans.
 */

import * as os from "node:os";
import * as path from "node:path";

const TASK =
	"为米克原子（室内家庭服务机器人创业公司，2C，研发阶段，天使轮）设计一份 4 周招聘计划，10 个岗位，从速度、成本、质量三个角度权衡";

// Scripted answers for the open_questions the workers are expected to ask
// in round 1. Edit freely — the orchestrator will surface whatever the
// workers ask, you just need to type one answer per question.
const SCRIPTED_ANSWERS = [
	"深圳，研发期 50 人分四组（世界模型/行为智能/软件系统/机电系统）",
	"天使轮总盘子 3000w，招聘预算 200w 现金 + 期权池 5%",
	"4 周发 offer 即可，入职分批；资深允许 6-8 周",
	"质量底线 = 感知/规划/工业设计 3 个岗不能降；其他 P5/P6 够用",
];

const OMP_BIN =
	process.env.MOA_OMP_BIN ?? path.join(import.meta.dir, "..", "..", "coding-agent", "src", "cli.ts");
const MOA_EXT = path.join(import.meta.dir, "src", "extension.ts");

console.log(`[co-test] OMP binary: ${OMP_BIN}`);
console.log(`[co-test] moa-extension: ${MOA_EXT}`);
console.log(`[co-test] task: ${TASK}`);
console.log(`[co-test] scripted answers: ${SCRIPTED_ANSWERS.length} prepared`);

const proc = Bun.spawn({
	cmd: [OMP_BIN, "--extension", MOA_EXT, "--no-color"],
	cwd: path.join(import.meta.dir, "..", ".."),
	env: {
		...process.env,
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
		}),
	},
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const stdinWriter = (proc.stdin as WritableStream<Uint8Array>).getWriter();
const encoder = new TextEncoder();

// Wait for OMP to boot, then send /moa run.
await Bun.sleep(3000);
await stdinWriter.write(encoder.encode(`/moa run ${TASK}\n`));
console.log(`[co-test] sent /moa run`);

// Feed scripted answers as questions surface. The orchestrator asks via
// ctx.ui.input() which reads a line from stdin. We send one line at a time
// with a delay so the TUI can render the prompt and read the answer.
for (let i = 0; i < SCRIPTED_ANSWERS.length; i++) {
	await Bun.sleep(8000);
	await stdinWriter.write(encoder.encode(`${SCRIPTED_ANSWERS[i]}\n`));
	console.log(`[co-test] sent answer ${i + 1}/${SCRIPTED_ANSWERS.length}: ${SCRIPTED_ANSWERS[i]}`);
}

// Let the run complete. Synthesis is the last step.
console.log(`[co-test] all answers sent, waiting for completion (up to 5 min)...`);
const exitCode = await proc.exited;
const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();

// Verify round context markers landed in worker prompts (they show up
// in the OMP session log because workers are forked with --no-session,
// so the markers are only in the stdout stream we captured).
const round1Count = (stdout.match(/Round 1 context: DISCOVERY/g) ?? []).length;
const round2Count = (stdout.match(/Round 2 context: PLANNING/g) ?? []).length;
const planOutputs = (stdout.match(/## plan\b/g) ?? []).length;

console.log(`\n=== Co-test complete ===`);
console.log(`exit code: ${exitCode}`);
console.log(`Round 1 DISCOVERY markers: ${round1Count} (expected ≥ 3)`);
console.log(`Round 2 PLANNING markers: ${round2Count} (expected ≥ 3 if Q&A converged in 1 round)`);
console.log(`## plan headers in output: ${planOutputs} (expected ≥ 3 in round 2)`);
console.log(`stdout length: ${stdout.length} chars`);
if (stderr.trim()) console.log(`stderr (first 500 chars):\n${stderr.slice(0, 500)}`);

if (round1Count < 3) {
	console.error(`\n[FAIL] Round 1 DISCOVERY context not injected (got ${round1Count}, expected ≥ 3)`);
	process.exit(1);
}
if (round2Count < 3) {
	console.warn(`\n[WARN] Round 2 PLANNING context not detected (got ${round2Count})`);
	console.warn(`  This may mean the Q&A loop did not advance to round 2 (max_rounds hit, or stop called).`);
}
if (planOutputs < 3) {
	console.warn(`\n[WARN] Few ## plan headers detected (got ${planOutputs})`);
}

console.log(`\n[PASS] Round 1 DISCOVERY context injected into all 3 worker prompts.`);
console.log(`       Inspect the OMP TUI transcript (or the moa-archive entries in`);
console.log(`       the session log) to see what each worker produced in round 1 + 2.`);
