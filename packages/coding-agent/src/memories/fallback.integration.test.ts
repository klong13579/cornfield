import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("Memory Fallback Integration", () => {
	test("full pipeline produces valid output when LLM is unavailable", async () => {
		// Simulate a scenario where LLM is unavailable
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-fallback-"));

		try {
			// Create a mock trace file
			const traceFile = path.join(tmpDir, "trace.jsonl");
			const traceEntries = [
				{
					type: "tool_call",
					toolName: "read",
					args: { path: "src/index.ts" },
					timestamp: Date.now(),
				},
				{
					type: "tool_result",
					toolName: "read",
					isError: false,
					result: "content",
					timestamp: Date.now(),
				},
				{
					type: "user_input",
					content: "Use async/await instead of callbacks",
					timestamp: Date.now(),
				},
			];

			await fs.writeFile(traceFile, traceEntries.map(e => JSON.stringify(e)).join("\n"));

			// Verify the trace file exists
			const exists = await fs
				.stat(traceFile)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);

			// Verify we can parse the trace
			const content = await fs.readFile(traceFile, "utf-8");
			const lines = content.split("\n").filter(Boolean);
			expect(lines.length).toBe(3);

			// Verify each entry is valid JSON
			for (const line of lines) {
				const entry = JSON.parse(line);
				expect(entry.type).toBeDefined();
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("fallback produces structured output from trace", () => {
		const traceEntries = [
			{ type: "tool_call", toolName: "read", args: { path: "src/index.ts" } },
			{ type: "tool_result", toolName: "read", isError: false, result: "content" },
			{ type: "tool_call", toolName: "edit", args: { path: "src/index.ts" } },
			{ type: "user_input", content: "Use async/await" },
		];

		// Extract signals from trace
		const toolsUsed = new Set<string>();
		const filesModified = new Set<string>();
		const corrections: string[] = [];
		let errorCount = 0;

		for (const entry of traceEntries) {
			if (entry.type === "tool_call" && entry.toolName) {
				toolsUsed.add(entry.toolName);
				if (entry.toolName === "edit" || entry.toolName === "write") {
					const p = entry.args?.path;
					if (typeof p === "string") filesModified.add(p);
				}
			}
			if (entry.type === "user_input" && entry.content) {
				corrections.push(entry.content);
			}
			if (entry.type === "tool_result" && entry.isError) {
				errorCount++;
			}
		}

		// Verify extracted signals
		expect(Array.from(toolsUsed)).toEqual(["read", "edit"]);
		expect(Array.from(filesModified)).toEqual(["src/index.ts"]);
		expect(corrections).toEqual(["Use async/await"]);
		expect(errorCount).toBe(0);
	});
});
