import { describe, expect, test } from "bun:test";
import { parseOmpSessionJsonlToTrace } from "../src/regression/omp-session-to-trace";
import type { Episode } from "../src/types";

describe("parseOmpSessionJsonlToTrace", () => {
	test("reconstructs tool calls and errors from session messages", () => {
		const episode: Episode = {
			id: "ep-1",
			sessionId: "sess-abc",
			cwd: "/proj",
			userPrompt: "",
			timestamp: 1000,
			durationMs: 5000,
			toolCallCount: 2,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: false,
			summary: "",
			toolsUsed: [],
			filesModified: [],
		};

		const jsonl = [
			JSON.stringify({
				type: "session",
				id: "sess-abc",
				cwd: "/proj",
				timestamp: new Date(1000).toISOString(),
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date(1100).toISOString(),
				message: { role: "user", content: "fix the bug" },
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date(1200).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "x.ts" } }],
				},
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date(1300).toISOString(),
				message: {
					role: "toolResult",
					toolName: "read",
					isError: true,
					content: "ENOENT",
				},
			}),
		].join("\n");

		const trace = parseOmpSessionJsonlToTrace(jsonl, episode);
		expect(trace).toBeDefined();
		expect(trace!.userPrompt).toBe("fix the bug");
		expect(trace!.errorCount).toBeGreaterThanOrEqual(1);
		expect(trace!.entries.some(e => e.type === "tool_call" && e.toolName === "read")).toBe(true);
	});
});
