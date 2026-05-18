import { describe, expect, test } from "bun:test";

// Test the fallback logic directly

describe("Memory Fallback Logic", () => {
	test("extractSignalsFromTrace handles empty trace", () => {
		// Simulate empty trace
		const signals = {
			toolSequence: [] as string[],
			filesModified: [] as string[],
			userCorrections: [] as string[],
			errorCount: 0,
			hadRecovery: false,
			sessionDuration: 0,
			userPrompt: "",
		};

		expect(signals.toolSequence).toEqual([]);
		expect(signals.errorCount).toBe(0);
	});

	test("buildRawMemory formats signals correctly", () => {
		const signals = {
			toolSequence: ["read", "search", "edit"],
			filesModified: ["src/foo.ts", "src/bar.ts"],
			userCorrections: ["Use async/await"],
			errorCount: 1,
			hadRecovery: true,
			sessionDuration: 30000,
			userPrompt: "Fix the bug",
		};

		const parts: string[] = [];

		if (signals.toolSequence.length > 0) {
			parts.push(`Used tools: ${signals.toolSequence.join(" → ")}`);
		}

		if (signals.filesModified.length > 0) {
			parts.push(`Modified files: ${signals.filesModified.join(", ")}`);
		}

		if (signals.errorCount > 0) {
			parts.push(
				`Encountered ${signals.errorCount} error(s)${signals.hadRecovery ? ", recovered successfully" : ""}`,
			);
		}

		if (signals.userCorrections.length > 0) {
			parts.push(`User corrections: ${signals.userCorrections.join("; ")}`);
		}

		const result = parts.join("\n");

		expect(result).toContain("Used tools: read → search → edit");
		expect(result).toContain("Modified files: src/foo.ts, src/bar.ts");
		expect(result).toContain("Encountered 1 error(s), recovered successfully");
		expect(result).toContain("User corrections: Use async/await");
	});

	test("buildRolloutSummary produces correct summary", () => {
		const toolCount = 3;
		const durationSec = 30;
		const errorCount = 0;
		const filesModifiedCount = 1;

		let summary = `${toolCount} tool(s) used`;
		if (durationSec > 0) {
			summary += ` in ${durationSec}s`;
		}
		if (errorCount > 0) {
			summary += `, ${errorCount} error(s)`;
		}
		if (filesModifiedCount > 0) {
			summary += `, modified ${filesModifiedCount} file(s)`;
		}

		expect(summary).toBe("3 tool(s) used in 30s, modified 1 file(s)");
	});

	test("buildRolloutSlug generates correct slug", () => {
		const parts: string[] = [];
		const errorCount = 0;
		const filesModified = ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
		const toolSequence = ["read", "test"];

		if (errorCount > 0) parts.push("fix");
		else if (filesModified.length > 2) parts.push("refactor");
		else parts.push("update");

		const domains = new Set(
			filesModified
				.map(f => {
					const ext = f.split(".").pop();
					return ext;
				})
				.filter(Boolean),
		);
		if (domains.has("ts")) parts.push("ts");

		if (toolSequence.includes("test")) parts.push("test");

		expect(parts.join("-")).toBe("refactor-ts-test");
	});
});
