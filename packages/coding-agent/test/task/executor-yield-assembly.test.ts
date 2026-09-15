import { describe, expect, it } from "bun:test";
import { finalizeSubprocessOutput } from "../../src/task/executor";

const SECTIONED_SCHEMA = {
	type: "object",
	properties: {
		findings: { type: "array", items: { type: "object", properties: { id: { type: "number" } } } },
		summary: { type: "string" },
	},
};

function finalize(
	yieldItems: Array<{ data?: unknown; status?: "success" | "aborted"; error?: string; type?: string | string[] }>,
	outputSchema: unknown = SECTIONED_SCHEMA,
) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems,
		outputSchema,
	});
}

describe("finalizeSubprocessOutput over incremental yields", () => {
	it("reports accumulated sections when the run never submitted a terminal result", () => {
		const result = finalize([
			{ status: "success", type: ["findings"], data: { id: 1 } },
			{ status: "success", type: ["findings"], data: { id: 2 } },
		]);
		expect(result.hasYield).toBe(true);
		expect(JSON.parse(result.rawOutput)).toEqual({ findings: [{ id: 1 }, { id: 2 }] });
	});

	it("uses a terminal submission verbatim instead of the accumulated sections", () => {
		const result = finalize([
			{ status: "success", type: ["findings"], data: { id: 1 } },
			{ status: "success", data: { summary: "done" } },
		]);
		expect(JSON.parse(result.rawOutput)).toEqual({ summary: "done" });
	});

	it("keeps last-yield-wins for untyped submissions", () => {
		const result = finalize(
			[
				{ status: "success", data: { a: 1 } },
				{ status: "success", data: { a: 2 } },
			],
			undefined,
		);
		expect(JSON.parse(result.rawOutput)).toEqual({ a: 2 });
	});

	it("reports an abort from the terminal submission, not from a trailing section", () => {
		const aborted = finalize([
			{ status: "success", type: ["findings"], data: { id: 1 } },
			{ status: "aborted", error: "blocked" },
		]);
		expect(aborted.abortedViaYield).toBe(true);
		expect(aborted.stderr).toBe("blocked");

		const sectionAfterTerminal = finalize([
			{ status: "aborted", error: "blocked" },
			{ status: "success", type: ["findings"], data: { id: 1 } },
		]);
		expect(sectionAfterTerminal.abortedViaYield).toBe(true);
		expect(sectionAfterTerminal.stderr).toBe("blocked");
	});
});
