import { describe, expect, test } from "bun:test";
import {
	extractReplayVerdictFromJsonStream,
	parseOmpJsonEventStreamToTraceEntries,
} from "../src/regression/parse-omp-json-events";

describe("parseOmpJsonEventStreamToTraceEntries", () => {
	test("maps tool_execution events to trace entries", () => {
		const stdout = [
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "1",
				toolName: "read",
				args: { path: "a.ts" },
			}),
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "read",
				result: "ENOENT",
				isError: true,
			}),
		].join("\n");

		const entries = parseOmpJsonEventStreamToTraceEntries(stdout);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.type).toBe("tool_call");
		expect(entries[0]?.toolName).toBe("read");
		expect(entries[1]?.type).toBe("tool_result");
		expect(entries[1]?.isError).toBe(true);
	});
});

describe("extractReplayVerdictFromJsonStream", () => {
	test("reads JSON verdict from final assistant message_end", () => {
		const stdout = [
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: {} }),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: '{"passed": true, "reason": "Used find before read."}' }],
				},
			}),
		].join("\n");

		const verdict = extractReplayVerdictFromJsonStream(stdout);
		expect(verdict?.passed).toBe(true);
		expect(verdict?.reason).toContain("find");
	});
});
