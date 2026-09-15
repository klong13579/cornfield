import { describe, expect, it } from "bun:test";
import { arrayValuedLabels, assembleYieldResult, isIncrementalYieldType } from "../../src/task/yield-assembly";

describe("assembleYieldResult", () => {
	it("keeps last-yield-wins for untyped submissions", () => {
		const out = assembleYieldResult([
			{ status: "success", data: { a: 1 } },
			{ status: "success", data: { a: 2 } },
		]);
		expect(out?.data).toEqual({ a: 2 });
		expect(out?.missingData).toBe(false);
		expect(out?.terminalStatus).toBe("success");
	});

	it("returns undefined when the run submitted nothing", () => {
		expect(assembleYieldResult([])).toBeUndefined();
	});

	it("accumulates repeated section labels into a list", () => {
		const out = assembleYieldResult([
			{ status: "success", type: ["notes"], data: "first" },
			{ status: "success", type: ["notes"], data: "second" },
			{ status: "success", type: ["other"], data: 7 },
		]);
		expect(out?.data).toEqual({ notes: ["first", "second"], other: 7 });
	});

	it("wraps a single section in a list when the schema declares that label as an array", () => {
		const out = assembleYieldResult([{ status: "success", type: ["findings"], data: { id: 1 } }], new Set(["findings"]));
		expect(out?.data).toEqual({ findings: [{ id: 1 }] });
	});

	it("lets a terminal submission with data win over accumulated sections", () => {
		const out = assembleYieldResult([
			{ status: "success", type: ["notes"], data: "n" },
			{ status: "success", data: { final: true } },
		]);
		expect(out?.data).toEqual({ final: true });
	});

	it("keeps sections when the terminal submission carries no data", () => {
		const out = assembleYieldResult([{ status: "success", type: ["notes"], data: "n" }, { status: "success", type: "result" }]);
		expect(out?.data).toEqual({ notes: "n" });
		expect(out?.terminalStatus).toBe("success");
	});

	it("reports an aborted terminal submission and folds nothing from aborted yields", () => {
		const out = assembleYieldResult([
			{ status: "aborted", error: "section died", type: ["notes"], data: "n" },
			{ status: "aborted", error: "boom" },
		]);
		expect(out?.terminalStatus).toBe("aborted");
		expect(out?.terminalError).toBe("boom");
		expect(out?.data).toBeUndefined();
	});

	it("flags a section that carried no data", () => {
		const out = assembleYieldResult([{ status: "success", type: ["notes"] }]);
		expect(out?.missingData).toBe(true);
		expect(out?.data).toEqual({ notes: undefined });
	});
});

describe("isIncrementalYieldType", () => {
	it("treats only a non-empty string array as incremental", () => {
		expect(isIncrementalYieldType(["a"])).toBe(true);
		expect(isIncrementalYieldType("a")).toBe(false);
		expect(isIncrementalYieldType([])).toBe(false);
		expect(isIncrementalYieldType(undefined)).toBe(false);
		expect(isIncrementalYieldType(3)).toBe(false);
	});
});

describe("arrayValuedLabels", () => {
	it("finds array-typed top-level properties of a JSON schema", () => {
		const labels = arrayValuedLabels({
			type: "object",
			properties: { findings: { type: "array", items: { type: "object" } }, summary: { type: "string" } },
		});
		expect([...labels]).toEqual(["findings"]);
	});

	it("finds the array form a JTD declaration converts into", () => {
		const labels = arrayValuedLabels({
			properties: { summary: { type: "string" } },
			optionalProperties: { findings: { elements: { type: "string" } } },
		});
		expect([...labels]).toEqual(["findings"]);
	});

	it("reports nothing for a schema with no properties", () => {
		expect([...arrayValuedLabels(undefined)]).toEqual([]);
		expect([...arrayValuedLabels(true)]).toEqual([]);
	});
});
