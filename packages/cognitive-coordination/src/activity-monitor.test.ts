import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analyzeActivityTrends } from "./activity-monitor";

describe("analyzeActivityTrends", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp("/tmp/activity-test-");
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function makeJsonlFile(name: string, lines: object[]): Promise<string> {
		const filePath = path.join(tempDir, name);
		const content = lines.map(l => JSON.stringify(l)).join("\n");
		await Bun.write(filePath, content);
		return filePath;
	}

	test("returns empty report for non-existent file", async () => {
		const report = await analyzeActivityTrends("/nonexistent/file.jsonl");
		expect(report.fitScoreTrend.scores).toHaveLength(0);
		expect(report.skillDecay).toHaveLength(0);
		expect(report.errorRate.rate).toBe(0);
	});

	test("computes fitScoreTrend.average correctly", async () => {
		const recentDate = new Date().toISOString();
		const entries = [
			{ type: "evolution-fit", timestamp: recentDate, score: 60 },
			{ type: "evolution-fit", timestamp: recentDate, score: 80 },
			{ type: "evolution-fit", timestamp: recentDate, score: 70 },
		];
		const filePath = await makeJsonlFile("fit-trend.jsonl", entries);
		const report = await analyzeActivityTrends(filePath);
		expect(report.fitScoreTrend.average).toBeCloseTo(70, 1);
		expect(report.fitScoreTrend.scores).toHaveLength(3);
	});

	test("computes errorRate correctly", async () => {
		const recentDate = new Date().toISOString();
		const entries = [
			{ type: "evolution-fit", timestamp: recentDate, score: 70 },
			{ type: "tool_error", timestamp: recentDate, tool: "bash", error: "timeout" },
			{ type: "tool_error", timestamp: recentDate, tool: "edit", error: "failed" },
			{ type: "skill_usage", timestamp: recentDate, skill_name: "test", skill_usage_count: 1 },
		];
		const filePath = await makeJsonlFile("error-rate.jsonl", entries);
		const report = await analyzeActivityTrends(filePath);
		expect(report.errorRate.errorCount).toBe(2);
		expect(report.errorRate.totalEvents).toBe(4);
		expect(report.errorRate.rate).toBeCloseTo(0.5, 2);
	});

	test("detects skill decay for skills not used recently", async () => {
		const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		const entries = [
			{ type: "skill_usage", timestamp: oldTimestamp, skill_name: "old-skill", skill_usage_count: 0 },
			{ type: "skill_usage", timestamp: new Date().toISOString(), skill_name: "new-skill", skill_usage_count: 5 },
		];
		const filePath = await makeJsonlFile("decay.jsonl", entries);
		const report = await analyzeActivityTrends(filePath);
		const decayedNames = report.skillDecay.map(d => d.skillName);
		expect(decayedNames).toContain("old-skill");
		expect(decayedNames).not.toContain("new-skill");
	});

	test("does not flag recently used skills as decayed", async () => {
		const recentTimestamp = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
		const entries = [
			{ type: "skill_usage", timestamp: recentTimestamp, skill_name: "recent-skill", skill_usage_count: 3 },
		];
		const filePath = await makeJsonlFile("recent.jsonl", entries);
		const report = await analyzeActivityTrends(filePath);
		const decayedNames = report.skillDecay.map(d => d.skillName);
		expect(decayedNames).not.toContain("recent-skill");
	});

	test("handles empty log file gracefully", async () => {
		const filePath = await makeJsonlFile("empty.jsonl", []);
		const report = await analyzeActivityTrends(filePath);
		expect(report.fitScoreTrend.scores).toHaveLength(0);
		expect(report.skillDecay).toHaveLength(0);
		expect(report.errorRate.rate).toBe(0);
	});

	test("skips invalid JSON lines", async () => {
		const recentDate = new Date().toISOString();
		const filePath = path.join(tempDir, "invalid.jsonl");
		await Bun.write(filePath, `not json\n{"type": "evolution-fit", "timestamp": "${recentDate}", "score": 50}\n{broken`);
		const report = await analyzeActivityTrends(filePath);
		expect(report.fitScoreTrend.scores).toHaveLength(1);
		expect(report.fitScoreTrend.average).toBe(50);
	});

	test("ignores entries without type field", async () => {
		const recentDate = new Date().toISOString();
		const entries = [
			{ timestamp: recentDate, score: 50 },
			{ type: "evolution-fit", timestamp: recentDate, score: 70 },
		];
		const filePath = await makeJsonlFile("no-type.jsonl", entries);
		const report = await analyzeActivityTrends(filePath);
		expect(report.fitScoreTrend.scores).toHaveLength(1);
	});
});
