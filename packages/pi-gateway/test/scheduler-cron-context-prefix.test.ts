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

	it("does NOT contain the old ambiguous wording", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).not.toContain("Do not create new cron jobs or send messages");
	});

	it("uses agentDir basename when present, falls back to accountId", () => {
		const withAgentDir: ScheduledTask = { ...baseTask, agentDir: "/var/data/agents/alpha" };
		expect(buildCronContextPrefix(withAgentDir)).toContain("alpha");
		const withAccount: ScheduledTask = { ...baseTask, accountId: "ops" };
		expect(buildCronContextPrefix(withAccount)).toContain("ops");
	});
});
