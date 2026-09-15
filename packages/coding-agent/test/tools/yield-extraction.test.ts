import { describe, expect, it } from "bun:test";
import "../../src/tools/yield";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";

describe("yield subprocess extraction", () => {
	const handler = subprocessToolRegistry.getHandler("yield");

	it("extracts valid yield payloads", () => {
		expect(handler?.extractData).toBeDefined();
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-1",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
		expect(data).toEqual({ status: "success", data: { ok: true }, error: undefined });
	});

	it("ignores malformed yield details without status", () => {
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-2",
			result: {
				content: [{ type: "text", text: "Tool execution was aborted." }],
				details: {},
			},
			isError: true,
		});
		expect(data).toBeUndefined();
	});

	it("terminates on a terminal submission and keeps running on an incremental section", () => {
		const event = (details: unknown, isError = false) => ({
			toolName: "yield",
			toolCallId: "call-3",
			result: { content: [{ type: "text", text: "" }], details },
			isError,
		});
		expect(handler?.shouldTerminate?.(event({ status: "success", data: { ok: true } }))).toBe(true);
		expect(handler?.shouldTerminate?.(event({ status: "success", data: 1, type: "result" }))).toBe(true);
		expect(handler?.shouldTerminate?.(event({ status: "success", data: 1, type: ["findings"] }))).toBe(false);
		expect(handler?.shouldTerminate?.(event({ status: "success", data: 1 }, true))).toBe(false);
	});

	it("carries the section labels through extraction", () => {
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-4",
			result: {
				content: [{ type: "text", text: "Section submitted: findings." }],
				details: { status: "success", data: { id: 1 }, type: ["findings"] },
			},
			isError: false,
		});
		expect(data).toEqual({ status: "success", data: { id: 1 }, error: undefined, type: ["findings"] });
	});
});
