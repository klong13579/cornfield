/**
 * Regression test for `buildCronContextPrefix`.
 *
 * The earlier wording — "Do not create new cron jobs or send messages" —
 * was ambiguous: agents spent think-cycles deciding whether "send
 * messages" forbade the reply text itself (which would have broken
 * DingTalk delivery) or only proactive messaging tools. The new wording
 * spells out three rules, each in concrete tool/behavioral terms.
 *
 * These assertions lock in the new wording. If anyone tries to revert
 * to the old "Do not create new cron jobs or send messages" string, or
 * drops the rule that "reply text IS the delivery", these fail.
 */
import { describe, expect, it } from "bun:test";
import { buildCronContextPrefix } from "../src/scheduler/cron-service";
import type { ScheduledTask } from "../src/scheduler/types";

const baseTask: ScheduledTask = {
	id: "task_test",
	name: "test",
	cron: "0 12 * * *",
	command: "do the thing",
	status: "active",
	runCount: 0,
	failCount: 0,
};

describe("buildCronContextPrefix", () => {
	it("marks the run as cron and names the agent", () => {
		const task: ScheduledTask = { ...baseTask, agentDir: "/tmp/agents/hr3" };
		const out = buildCronContextPrefix(task);
		expect(out).toStartWith("[CRON-CONTEXT]");
		expect(out).toContain("hr3");
	});

	it("explicitly forbids the `cron` host tool and names the disabled toolset", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("`cron` host tool");
		expect(out).toContain("cronjob");
	});

	it("forbids proactive messaging tools and names concrete examples", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("messaging");
		expect(out).toContain("dws chat message send");
		expect(out).toContain("chat_post");
	});

	it("states that the reply text IS the delivery (the anti-ambiguity rule)", () => {
		const out = buildCronContextPrefix(baseTask);
		// Must say the reply body is the deliverable, not "do not reply".
		expect(out).toContain("reply text IS the delivery");
		// Must give a clear positive instruction (not just a list of
		// forbidden actions) — the old wording left the agent guessing.
		expect(out).toMatch(/just write your answer in the reply body/i);
		// Acknowledge the contradiction that tripped up the previous
		// wording (task says "send to user" while cron says "no send").
		expect(out).toMatch(/发给用户|send to user|notify/i);
	});

	it("Rule 3 mentions markdown formatting so the agent writes card-friendly output", () => {
		const out = buildCronContextPrefix(baseTask);
		// The cron card is rendered as markdown; without a hint the
		// agent produces flat text that looks bad in the card. The hint
		// asks for ## headings, - bullets, fenced code blocks, and
		// `inline code`. We assert the markers are present (not the
		// exact phrasing) so a future reword doesn't break the test.
		// Note: the prompt says "fenced code blocks" in prose rather
		// than embedding the literal ``` to avoid the LLM misreading
		// the prompt as a code-fence start.
		expect(out).toContain("##");
		expect(out).toContain("headings");
		expect(out).toContain("bullets");
		expect(out).toContain("fenced code blocks");
		expect(out).toContain("`inline code`");
	});

	it("does NOT contain the old ambiguous wording", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).not.toContain("Do not create new cron jobs or send messages");
	});

	it("teaches the agent about [SILENT] to suppress delivery when there's nothing to report", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("[SILENT]");
		expect(out).toContain("nothing new to report");
		expect(out).toContain("suppresses delivery");
		expect(out).toContain("Never combine [SILENT] with other content");
	});

	it("uses agentDir basename when present, falls back to accountId", () => {
		const withAgentDir: ScheduledTask = { ...baseTask, agentDir: "/var/data/agents/alpha" };
		expect(buildCronContextPrefix(withAgentDir)).toContain("alpha");
		const withAccount: ScheduledTask = { ...baseTask, accountId: "ops" };
		expect(buildCronContextPrefix(withAccount)).toContain("ops");
	});

	// --- context-aware cases for the a+ tiered prefix ---

	it("includes the task name and schedule in the header", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("Task: test");
		expect(out).toContain("Schedule: 0 12 * * *");
		expect(out).toContain("Type: agent");
	});

	it("emits the metaLine when provided", () => {
		const out = buildCronContextPrefix(baseTask, { metaLine: "Last run: 2026-07-05 09:00 (24h ago)  Status: ok" });
		expect(out).toContain("Last run: 2026-07-05 09:00 (24h ago)  Status: ok");
	});

	it("emits the Tier 2 last-output block when provided", () => {
		const out = buildCronContextPrefix(baseTask, { lastOutput: "Yesterday's brief: 12 PRs, 3 merged." });
		expect(out).toContain("Last run summary:");
		expect(out).toContain("Yesterday's brief: 12 PRs, 3 merged.");
	});

	it("emits the Tier 3 tool-calls block when provided", () => {
		const calls = '[tool: bash] {"command":"ls"} → "file1"';
		const out = buildCronContextPrefix(baseTask, { lastToolCalls: calls });
		expect(out).toContain("Last run tool calls:");
		expect(out).toContain(calls);
	});

	it("emits all three tiers in the order meta → output → toolCalls", () => {
		const out = buildCronContextPrefix(baseTask, {
			metaLine: "META",
			lastOutput: "OUTPUT",
			lastToolCalls: "TOOLCALLS",
		});
		const metaIdx = out.indexOf("META");
		const outputIdx = out.indexOf("OUTPUT");
		const toolsIdx = out.indexOf("TOOLCALLS");
		const rulesIdx = out.indexOf("Four rules for this run:");
		expect(metaIdx).toBeGreaterThan(-1);
		expect(outputIdx).toBeGreaterThan(metaIdx);
		expect(toolsIdx).toBeGreaterThan(outputIdx);
		expect(rulesIdx).toBeGreaterThan(toolsIdx);
	});

	it("places a '---' separator between context and the four rules", () => {
		const out = buildCronContextPrefix(baseTask, { metaLine: "META" });
		const sepIdx = out.indexOf("---");
		const rulesIdx = out.indexOf("Four rules for this run:");
		expect(sepIdx).toBeGreaterThan(-1);
		expect(rulesIdx).toBeGreaterThan(sepIdx);
	});

	it("with no context, output still contains the four rules and the header", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("[CRON-CONTEXT]");
		expect(out).toContain("Task: test");
		expect(out).toContain("Four rules for this run:");
		expect(out).toContain("`cron` host tool");
		expect(out).toContain("[SILENT]");
	});
});
