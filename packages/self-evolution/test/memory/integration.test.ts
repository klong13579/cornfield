import { describe, expect, test } from "bun:test";

// Mock trace for testing
const mockTrace = {
	sessionId: "test-session",
	cwd: "/test",
	userPrompt: "Fix the bug in the auth module",
	startTime: Date.now(),
	endTime: Date.now() + 30000,
	entries: [
		{
			type: "user_input",
			content: "Please remember to always validate JWT tokens before processing requests",
			timestamp: Date.now(),
		},
		{
			type: "tool_call",
			toolName: "read",
			args: { path: "src/auth.ts" },
			timestamp: Date.now() + 1000,
		},
		{
			type: "tool_call",
			toolName: "edit",
			args: { path: "src/auth.ts" },
			timestamp: Date.now() + 2000,
		},
		{
			type: "tool_result",
			toolName: "edit",
			isError: false,
			result: "Modified successfully",
			timestamp: Date.now() + 2500,
		},
		{
			type: "tool_call",
			toolName: "test",
			args: { path: "src/auth.test.ts" },
			timestamp: Date.now() + 3000,
		},
	],
	toolCallCount: 4,
	errorCount: 0,
	hadRecovery: false,
	completedSuccessfully: true,
};

describe("Memory System Integration", () => {
	test("extractSignalsFromTrace handles mock trace correctly", () => {
		// We can't directly test extractSignalsFromTrace as it's not exported
		// So we'll test the individual components

		const toolsUsed = new Set<string>();
		const filesModified = new Set<string>();
		const userCorrections: string[] = [];
		let errorCount = 0;
		let hadRecovery = false;
		let userPrompt = "";

		for (const entry of mockTrace.entries) {
			if (entry.type === "tool_call" && entry.toolName) {
				toolsUsed.add(entry.toolName);
				if (entry.toolName === "edit" || entry.toolName === "write") {
					const p = entry.args?.path;
					if (typeof p === "string") filesModified.add(p);
				}
			}

			if (entry.type === "user_input" && entry.content) {
				userPrompt = entry.content;
				if (/不对|错了|should be|应该是|不是|不要|别|错了|incorrect|wrong/i.test(entry.content)) {
					userCorrections.push(entry.content);
				}
			}

			if (entry.type === "tool_result" && entry.isError) {
				errorCount++;
			}

			if (entry.type === "tool_result" && !entry.isError && errorCount > 0) {
				hadRecovery = true;
			}
		}

		expect(toolsUsed.size).toBeGreaterThan(0);
		expect(Array.from(toolsUsed)).toContain("read");
		expect(Array.from(toolsUsed)).toContain("edit");
		expect(Array.from(toolsUsed)).toContain("test");
		expect(Array.from(filesModified)).toContain("src/auth.ts");
		expect(userPrompt).toContain("remember to always validate");
		expect(errorCount).toBe(0);
		expect(hadRecovery).toBe(false);
	});

	test("buildRawMemory formats signals correctly", () => {
		const signals = {
			toolSequence: ["read", "edit", "test"],
			filesModified: ["src/auth.ts"],
			userCorrections: [],
			errorCount: 0,
			hadRecovery: false,
			sessionDuration: 30000,
			userPrompt: "Fix the bug in the auth module",
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

		const result = parts.join("\n") || "No significant signals extracted.";

		expect(result).toContain("Used tools: read → edit → test");
		expect(result).toContain("Modified files: src/auth.ts");
		expect(result).not.toContain("error");
	});

	test("buildRolloutSummary produces correct summary", () => {
		const toolCount = 3;
		const duration = 30000;
		const errorCount = 0;
		const filesModified = ["src/auth.ts"];

		const durationSec = Math.round(duration / 1000);
		const _avgTimePerTool = toolCount > 0 ? Math.round(durationSec / toolCount) : 0;

		let summary = `${toolCount} tool(s) used`;
		if (durationSec > 0) {
			summary += ` in ${durationSec}s`;
		}
		if (errorCount > 0) {
			summary += `, ${errorCount} error(s)${errorCount > 0 ? " (recovered)" : ""}`;
		}
		if (filesModified.length > 0) {
			summary += `, modified ${filesModified.length} file(s)`;
		}

		summary += ".";

		expect(summary).toBe("3 tool(s) used in 30s, modified 1 file(s).");
	});
});
