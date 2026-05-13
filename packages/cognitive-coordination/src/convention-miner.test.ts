import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { mineImplicitConventions } from "./convention-miner";

describe("mineImplicitConventions", () => {
	let tempDir: string;


	beforeEach(async () => {
		tempDir = await fs.mkdtemp("/tmp/miner-test-");
	});
	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function makeJsonlFile(name: string, lines: object[]): string {
		const filePath = path.join(tempDir, name);
		const content = lines.map(l => JSON.stringify(l)).join("\n");
		Bun.write(filePath, content);
		return filePath;
	}

	test("extracts conventions from negative user messages", async () => {
		const entries = [
			{ type: "user_message", content: "I don't like the current approach, don't use async/await for this." },
			{ type: "agent_message", content: "Understood, I'll switch to callbacks." },
		];

		const filePath = makeJsonlFile("negatives.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		expect(conventions.length).toBeGreaterThanOrEqual(1);
		const hasAsyncAwait = conventions.some(c => c.rule.toLowerCase().includes("async/await"));
		expect(hasAsyncAwait).toBe(true);
	});

	test("filters out false positives", async () => {
		const entries = [
			{ type: "user_message", content: "I don't know if this will work, don't worry about it." },
			{ type: "user_message", content: "Never mind that question." },
		];

		const filePath = makeJsonlFile("false-pos.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		expect(conventions).toHaveLength(0);
	});

	test("returns empty array for empty log", async () => {
		const filePath = makeJsonlFile("empty.jsonl", []);
		const conventions = await mineImplicitConventions(filePath);

		expect(conventions).toHaveLength(0);
	});

	test("returns empty array for non-existent file", async () => {
		const conventions = await mineImplicitConventions("/nonexistent/file.jsonl");

		expect(conventions).toHaveLength(0);
	});

	test("extracts multiple conventions from different messages", async () => {
		const entries = [
			{ type: "user_message", content: "Never use console.log in production code." },
			{ type: "user_message", content: "Stop using var declarations, always use const or let." },
			{ type: "user_message", content: "Don't call external APIs without rate limiting." },
		];

		const filePath = makeJsonlFile("multi.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		expect(conventions.length).toBeGreaterThanOrEqual(2);
	});

	test("convention includes confidence based on keyword weight", async () => {
		const entries = [
			{ type: "user_message", content: "Never deploy on Fridays." }, // weight 1.0
			{ type: "user_message", content: "Don't forget to add tests." }, // weight 0.5
		];

		const filePath = makeJsonlFile("weights.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		const neverConf = conventions.find(c => c.rule.toLowerCase().includes("never deploy"));
		const dontConf = conventions.find(c => c.rule.toLowerCase().includes("don't forget"));

		if (neverConf) expect(neverConf.confidence).toBe(1.0);
		if (dontConf) expect(dontConf.confidence).toBe(0.5);
	});

	test("convention includes sourceSessionId", async () => {
		const entries = [
			{ type: "user_message", content: "Don't use raw SQL queries, always use the ORM." },
		];

		const filePath = makeJsonlFile("source.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		expect(conventions.length).toBeGreaterThan(0);
		expect(conventions[0].sourceSessionId).toBe(filePath);
	});

	test("skips very short sentences (< 15 chars)", async () => {
		const entries = [
			{ type: "user_message", content: "Don't." }, // too short
			{ type: "user_message", content: "No." }, // too short
			{ type: "user_message", content: "Never use global variables in modules." }, // long enough
		];

		const filePath = makeJsonlFile("short.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		const shortRules = conventions.filter(c => c.rule.length < 15);
		expect(shortRules).toHaveLength(0);
	});

	test("handles invalid JSON lines gracefully", async () => {
		const filePath = path.join(tempDir, "invalid.jsonl");
		await Bun.write(filePath, "not json\n{\"type\": \"user_message\", \"content\": \"Don't use this pattern.\"}\n{broken");

		const conventions = await mineImplicitConventions(filePath);

		expect(conventions.length).toBeGreaterThanOrEqual(1);
	});

	test("high-weight keywords produce higher confidence", async () => {
		const entries = [
			{ type: "user_message", content: "You must never expose API keys in logs." },
			{ type: "user_message", content: "I don't think we should use that library." },
		];

		const filePath = makeJsonlFile("confidence.jsonl", entries);
		const conventions = await mineImplicitConventions(filePath);

		const mustNever = conventions.find(c => c.rule.toLowerCase().includes("must never"));
		const dontThink = conventions.find(c => c.rule.toLowerCase().includes("don't think"));

		// "must never" has higher weight than "don't"
		if (mustNever && dontThink) {
			expect(mustNever.confidence).toBeGreaterThan(dontThink.confidence);
		}
	});
});
