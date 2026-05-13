import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assembleContext } from "@oh-my-pi/cognitive-coordination";
import { mineImplicitConventions } from "@oh-my-pi/cognitive-coordination";
import type { ImplicitConvention, UnifiedSkill } from "@oh-my-pi/cognitive-coordination";

/**
 * AB-01: AB Test — Before/After Convention Injection Effectiveness
 *
 * Compares two environments:
 * - Control: No convention injection (baseline)
 * - Experiment: With convention injection from mined rules
 *
 * Verifies that convention injection changes the context assembly output
 * and that the mined conventions are correctly included.
 */
describe("AB-01: Convention Injection AB Test", () => {
	let tempDir: string;

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function makeSkill(name: string, content: string): UnifiedSkill {
		return {
			id: `evolution_extraction:${name}`,
			source: "evolution_extraction",
			name,
			content,
			confidenceScore: 0.8,
			lastUsedAt: Date.now(),
			version: "1.0",
			status: "active",
		};
	}

	test("experiment context contains mined conventions, control does not", async () => {
		tempDir = await fs.mkdtemp("/tmp/ab-test-");

		// Create session log where user says "don't use async/await"
		const logPath = path.join(tempDir, "session.jsonl");
		await Bun.write(
			logPath,
			JSON.stringify({
				type: "user_message",
				content: "Please don't use async/await in this project. We use callbacks only.",
			}) +
				"\n" +
				JSON.stringify({
					type: "agent_message",
					content: "Understood, I'll use callbacks.",
				}) +
				"\n",
		);

		// Mine conventions from the log
		const conventions = await mineImplicitConventions(logPath);

		// Should have extracted the "don't use async/await" rule
		expect(conventions.length).toBeGreaterThan(0);
		const hasAsyncRule = conventions.some(c => c.rule.toLowerCase().includes("async/await"));
		expect(hasAsyncRule).toBe(true);

		// Setup identical skills for both environments
		const skills: UnifiedSkill[] = [makeSkill("nodejs-tool", "Use Node.js patterns.")];

		// Control: no conventions
		const controlContext = assembleContext(skills, [], { maxTokens: 2000 });

		// Experiment: with mined conventions
		const experimentContext = assembleContext(skills, conventions, { maxTokens: 2000 });

		// Control should NOT mention async/await rule
		expect(controlContext.toLowerCase()).not.toContain("async/await");

		// Experiment SHOULD mention async/await rule
		expect(experimentContext.toLowerCase()).toContain("async/await");

		// Experiment should have a Conventions section
		expect(experimentContext).toContain("## Active Conventions");
		expect(controlContext).not.toContain("## Active Conventions");
	});

	test("convention injection changes context structure", async () => {
		tempDir = await fs.mkdtemp("/tmp/ab-structure-");

		const logPath = path.join(tempDir, "session.jsonl");
		await Bun.write(
			logPath,
			JSON.stringify({
				type: "user_message",
				content: "Never commit directly to main branch. Always use feature branches.",
			}) + "\n",
		);

		const conventions = await mineImplicitConventions(logPath);

		const skills: UnifiedSkill[] = [
			makeSkill("git-flow", "Use git flow for branching."),
			makeSkill("code-review", "Always review PRs before merging."),
		];

		const controlContext = assembleContext(skills, [], { maxTokens: 2000 });
		const experimentContext = assembleContext(skills, conventions, { maxTokens: 2000 });

		// Experiment context should be longer (conventions add content)
		expect(experimentContext.length).toBeGreaterThan(controlContext.length);

		// Conventions should appear before skills
		const convIdx = experimentContext.indexOf("## Active Conventions");
		const skillIdx = experimentContext.indexOf("## Relevant Skills");
		expect(convIdx).toBeLessThan(skillIdx);
	});

	test("multiple conventions are all injected", async () => {
		tempDir = await fs.mkdtemp("/tmp/ab-multi-");

		const logPath = path.join(tempDir, "session.jsonl");
		await Bun.write(
			logPath,
			[
				{ type: "user_message", content: "Don't use console.log for logging." },
				{ type: "user_message", content: "Never use var declarations." },
				{ type: "user_message", content: "Avoid using any type in TypeScript." },
			]
				.map(e => JSON.stringify(e))
				.join("\n") + "\n",
		);

		const conventions = await mineImplicitConventions(logPath);

		// Should extract at least 2 conventions (one might be filtered as false positive)
		expect(conventions.length).toBeGreaterThanOrEqual(2);

		const skills: UnifiedSkill[] = [makeSkill("typescript", "TS best practices")];

		const experimentContext = assembleContext(skills, conventions, { maxTokens: 4000 });

		// All mined conventions should appear in context
		for (const conv of conventions) {
			expect(experimentContext).toContain(conv.rule);
		}
	});

	test("convention confidence is displayed in context", async () => {
		tempDir = await fs.mkdtemp("/tmp/ab-conf-");

		const logPath = path.join(tempDir, "session.jsonl");
		await Bun.write(
			logPath,
			JSON.stringify({
				type: "user_message",
				content: "You must never expose API keys in logs.", // weight 1.0
			}) + "\n",
		);

		const conventions = await mineImplicitConventions(logPath);

		const skills: UnifiedSkill[] = [makeSkill("security", "Security best practices")];
		const experimentContext = assembleContext(skills, conventions, { maxTokens: 2000 });

		// Confidence should be displayed
		expect(experimentContext).toContain("Confidence: 1.00");
	});

	test("AB test proves pipeline effectiveness", async () => {
		/**
		 * Full AB test: simulate a real workflow where conventions improve context.
		 *
		 * Scenario: User says "don't use raw SQL" → Convention mined →
		 * Next session context includes this rule → Agent avoids raw SQL.
		 */
		tempDir = await fs.mkdtemp("/tmp/ab-full-");

		// Step 1: Simulate session where user expresses a preference
		const logPath = path.join(tempDir, "session.jsonl");
		await Bun.write(
			logPath,
			JSON.stringify({
				type: "user_message",
				content: "Don't use raw SQL queries in this project. Always use the ORM layer.",
			}) +
				"\n" +
				JSON.stringify({
					type: "agent_message",
					content: "Got it, I'll use Prisma ORM.",
				}) +
				"\n",
		);

		// Step 2: Mine conventions
		const conventions = await mineImplicitConventions(logPath);
		expect(conventions.length).toBeGreaterThan(0);

		const sqlRule = conventions.find(c => c.rule.toLowerCase().includes("raw sql"));
		expect(sqlRule).toBeDefined();
		expect(sqlRule!.confidence).toBeGreaterThan(0);

		// Step 3: Compare contexts
		const skills: UnifiedSkill[] = [
			makeSkill("database", "Use database connections properly."),
			makeSkill("orm", "Use Prisma ORM for all queries."),
		];

		const controlContext = assembleContext(skills, [], { maxTokens: 2000 });
		const experimentContext = assembleContext(skills, conventions, { maxTokens: 2000 });

		// Control: no SQL rule mentioned
		expect(controlContext.toLowerCase()).not.toContain("raw sql");

		// Experiment: SQL rule IS mentioned
		expect(experimentContext.toLowerCase()).toContain("raw sql");

		// Conclusion: Convention injection pipeline works end-to-end
		// The mined convention successfully changed the assembled context
	});
});
