import { describe, expect, it } from "bun:test";
import { validateAgainstSchema } from "@cornfield/ai/utils/validation";
import { Type } from "@sinclair/typebox";

/** The shape an MCP server actually advertises — plain JSON Schema, no TypeBox `Kind`. */
const mcpSchema = {
	type: "object",
	properties: { query: { type: "string" }, limit: { type: "integer" } },
	required: ["query"],
};

describe("validateAgainstSchema", () => {
	it("accepts a value matching a plain JSON Schema", () => {
		expect(validateAgainstSchema(mcpSchema, { query: "hello", limit: 5 })).toEqual([]);
	});

	it("names the missing property", () => {
		const problems = validateAgainstSchema(mcpSchema, { limit: 5 });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("query");
		expect(problems[0]).toContain("required");
	});

	it("reports the offending path for a wrong type", () => {
		const problems = validateAgainstSchema(mcpSchema, { query: 7 });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toStartWith("query:");
	});

	it("validates TypeBox-built schemas too, so one validator serves both origins", () => {
		const typeboxSchema = Type.Object({ a: Type.String() });
		expect(validateAgainstSchema(typeboxSchema, { a: "x" })).toEqual([]);
		expect(validateAgainstSchema(typeboxSchema, { a: 1 })).toHaveLength(1);
	});

	it("rejects a non-object value against an object schema", () => {
		expect(validateAgainstSchema(mcpSchema, "not an object").length).toBeGreaterThan(0);
	});
});
