import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureMemorySummaryFromMemory } from "../src/memory/summary";

describe("ensureMemorySummaryFromMemory", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("writes llm summary when long enough", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-sum-"));
		const long = "x".repeat(220);
		const result = await ensureMemorySummaryFromMemory(tmpDir, { llmSummary: long });
		expect(result.written).toBe(true);
		expect(result.source).toBe("llm");
		const text = await Bun.file(path.join(tmpDir, "memory_summary.md")).text();
		expect(text.trim().length).toBeGreaterThanOrEqual(200);
	});

	it("derives summary from MEMORY.md when llm summary is short", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mem-sum-md-"));
		const body = `User prefers concise answers.\n${"detail line.\n".repeat(40)}`;
		await Bun.write(path.join(tmpDir, "MEMORY.md"), body);
		const result = await ensureMemorySummaryFromMemory(tmpDir, { llmSummary: "too short" });
		expect(result.written).toBe(true);
		expect(result.source).toBe("memory_md");
		expect(result.length).toBeGreaterThanOrEqual(200);
	});
});
