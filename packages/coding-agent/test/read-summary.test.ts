import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/sdk";
import { ReadTool } from "../src/tools/read";
import { type ReadSummarySettings, summarizeFileContent } from "../src/tools/read-summary";

function summarySettings(overrides: Partial<ReadSummarySettings> = {}): ReadSummarySettings {
	return {
		enabled: true,
		minTotalLines: 500,
		minBodyLines: 200,
		minCommentLines: 100,
		prose: true,
		unfoldLimit: 50,
		unfoldUntil: 100,
		...overrides,
	};
}

describe("summarizeFileContent", () => {
	it("returns null when summarization is disabled", () => {
		const content = "line\n".repeat(600);
		expect(summarizeFileContent(content, summarySettings({ enabled: false }))).toBeNull();
	});

	it("returns null when the file is shorter than minTotalLines", () => {
		const content = "body\n".repeat(10);
		expect(summarizeFileContent(content, summarySettings({ minTotalLines: 500 }))).toBeNull();
	});

	it("returns null when body lines are below minBodyLines in prose mode", () => {
		const content = "body\n".repeat(600);
		expect(summarizeFileContent(content, summarySettings({ minBodyLines: 1000 }))).toBeNull();
	});

	it("returns null when comment lines are below minCommentLines in code mode", () => {
		const content = Array.from({ length: 600 }, () => "x = 1").join("\n");
		expect(
			summarizeFileContent(
				content,
				summarySettings({ prose: false, minTotalLines: 500, minBodyLines: 200, minCommentLines: 100 }),
			),
		).toBeNull();
	});

	it("returns null when the head/tail window already covers the whole file", () => {
		const content = "body\n".repeat(20);
		expect(summarizeFileContent(content, summarySettings({ minTotalLines: 10, unfoldLimit: 15 }))).toBeNull();
	});

	it("summarizes prose by keeping head and tail with an expandable hint", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`);
		const summary = summarizeFileContent(
			lines.join("\n"),
			summarySettings({ minTotalLines: 10, minBodyLines: 5, unfoldLimit: 3, unfoldUntil: 4 }),
		);

		expect(summary).not.toBeNull();
		expect(summary!.totalLines).toBe(11);
		expect(summary!.omittedLines).toBe(5);
		expect(summary!.text).toContain("[read.summarize]");
		expect(summary!.text).toContain("line 1");
		expect(summary!.text).toContain("line 3");
		expect(summary!.text).toContain("line 9");
		expect(summary!.text).toContain("line 11");
		expect(summary!.text).not.toContain("line 5");
		expect(summary!.text).not.toContain("line 6");
		expect(summary!.text).toContain('sel="4-7"');
	});

	it("classifies comments and reports the counts in code mode", () => {
		const lines = [
			"// header",
			"import a",
			"import b",
			"fn a(){}",
			"fn b(){}",
			"fn c(){}",
			"fn d(){}",
			"fn e(){}",
			"// footer",
			"export a",
		];
		const summary = summarizeFileContent(
			lines.join("\n"),
			summarySettings({ prose: false, minTotalLines: 10, minBodyLines: 5, minCommentLines: 2, unfoldLimit: 3 }),
		);

		expect(summary).not.toBeNull();
		expect(summary!.totalLines).toBe(10);
		expect(summary!.bodyLines).toBe(8);
		expect(summary!.commentLines).toBe(2);
		expect(summary!.text).toContain("2 comments");
	});

	it("ignores a trailing newline when counting lines", () => {
		const summary = summarizeFileContent(
			"a\nb\nc\n",
			summarySettings({ minTotalLines: 3, minBodyLines: 1, unfoldLimit: 1, unfoldUntil: 1 }),
		);
		expect(summary).not.toBeNull();
		expect(summary!.totalLines).toBe(3);
	});
});

function makeSession(dir: string, settings: Settings): ToolSession {
	let next = 0;
	return {
		cwd: dir,
		settings,
		internalRouter: {
			canHandle: () => false,
			resolve: () => {
				throw new Error("unexpected internal URL");
			},
		},
		hasEditTool: true,
		allocateOutputArtifact: async (toolType: string) => {
			const id = String(next++);
			return { id, path: path.join(dir, `${id}.${toolType}.log`) };
		},
	} as unknown as ToolSession;
}

describe("ReadTool summarization integration", () => {
	it("returns a summary for a long file when read.summarize.enabled is true", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-summary-"));
		try {
			const lines = [
				"// header",
				"import a",
				"import b",
				"fn a(){}",
				"fn b(){}",
				"fn c(){}",
				"fn d(){}",
				"fn e(){}",
				"// footer",
				"export a",
			];
			const file = path.join(dir, "code.ts");
			await fs.writeFile(file, lines.join("\n"));

			const settings = Settings.isolated({
				"read.summarize.enabled": true,
				"read.summarize.minTotalLines": 10,
				"read.summarize.minBodyLines": 5,
				"read.summarize.minCommentLines": 2,
				"read.summarize.prose": false,
				"read.summarize.unfoldLimit": 3,
				"read.summarize.unfoldUntil": 4,
			});
			const tool = new ReadTool(makeSession(dir, settings));
			const result = await tool.execute("call-summary", { path: "code.ts" });
			const text = result.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");

			expect(text).toContain("[read.summarize]");
			expect(text).toContain("// header");
			expect(text).toContain("export a");
			expect(text).toContain('sel="');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("leaves behavior unchanged (no summary) when read.summarize.enabled is false", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-summary-"));
		try {
			const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
			const file = path.join(dir, "plain.txt");
			await fs.writeFile(file, lines.join("\n"));

			const settings = Settings.isolated();
			const tool = new ReadTool(makeSession(dir, settings));
			const result = await tool.execute("call-plain", { path: "plain.txt" });
			const text = result.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");

			expect(text).not.toContain("[read.summarize]");
			expect(text).toContain("line 1");
			expect(text).toContain("line 12");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
