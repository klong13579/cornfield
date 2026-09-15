import { describe, expect, it } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { YieldTool } from "@cornfield/coding-agent/tools/yield";

/** An open schema declaring an array-typed section plus a terminal field. */
const OPEN_SCHEMA = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
		},
		summary: { type: "string" },
	},
	required: ["summary"],
};

/** The same schema with the top level closed: an undeclared section cannot fit a valid result. */
const CLOSED_SCHEMA = { ...OPEN_SCHEMA, additionalProperties: false };

function createSession(outputSchema: unknown): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		outputSchema,
	} as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

describe("yield incremental sections", () => {
	it("accepts a section whose label the schema declares", async () => {
		const tool = new YieldTool(createSession(OPEN_SCHEMA));
		const result = await tool.execute("call-1", { result: { type: ["findings"], data: { id: 1 } } } as never);
		expect(result.details?.type).toEqual(["findings"]);
		expect(result.details?.status).toBe("success");
		expect(textOf(result)).toBe("Section submitted: findings.");
	});

	it("judges an array-typed section by its element schema, one element per submission", async () => {
		// The payload is one element of `findings`, so the list shape is wrong here.
		// Each rejection needs its own tool instance: the tool deliberately accepts a
		// second failing submission with a notice (the retry ladder), so two
		// rejections on one instance would not both surface.
		await expect(
			new YieldTool(createSession(OPEN_SCHEMA)).execute("call-2", {
				result: { type: ["findings"], data: [{ id: 1 }] },
			} as never),
		).rejects.toThrow(/Output section "findings" does not match its schema/);
		await expect(
			new YieldTool(createSession(OPEN_SCHEMA)).execute("call-3", {
				result: { type: ["findings"], data: { id: "x" } },
			} as never),
		).rejects.toThrow(/Output section "findings" does not match its schema/);
	});

	it("refuses an undeclared label when the schema is closed, naming the known ones", async () => {
		const tool = new YieldTool(createSession(CLOSED_SCHEMA));
		await expect(tool.execute("call-4", { result: { type: ["nope"], data: 1 } } as never)).rejects.toThrow(
			/Unknown output section "nope"\. Known sections: findings, summary\./,
		);
	});

	it("accepts an undeclared label on an open schema, which can still carry it", async () => {
		const tool = new YieldTool(createSession(OPEN_SCHEMA));
		const result = await tool.execute("call-5", { result: { type: ["notes"], data: "free-form" } } as never);
		expect(textOf(result)).toBe("Section submitted: notes.");
	});

	it("checks no labels when the schema declares no properties", async () => {
		const tool = new YieldTool(createSession(undefined));
		const result = await tool.execute("call-6", { result: { type: ["anything"], data: { a: 1 } } } as never);
		expect(result.details?.type).toEqual(["anything"]);
	});

	it("keeps validating terminal submissions against the whole schema", async () => {
		await expect(
			new YieldTool(createSession(OPEN_SCHEMA)).execute("call-7", { result: { data: { findings: [] } } } as never),
		).rejects.toThrow(/Output does not match schema/);
		// A section payload is a part of the result, so the whole-schema check must
		// not run against it.
		const result = await new YieldTool(createSession(OPEN_SCHEMA)).execute("call-8", {
			result: { type: ["summary"], data: "done" },
		} as never);
		expect(textOf(result)).toBe("Section submitted: summary.");
	});

	it("treats a plain string type as terminal, not as a section label", async () => {
		const tool = new YieldTool(createSession(undefined));
		const result = await tool.execute("call-9", { result: { type: "result", data: { ok: true } } } as never);
		expect(textOf(result)).toBe("Result submitted.");
	});

	it("survives a schema that defeats conversion instead of failing construction", () => {
		const circular: Record<string, unknown> = { type: "object", properties: {} };
		(circular.properties as Record<string, unknown>).self = circular;
		const tool = new YieldTool(createSession(circular));
		expect(tool.parameters).toBeDefined();
	});

	it("advertises the type argument in the parameter schema", () => {
		const tool = new YieldTool(createSession(OPEN_SCHEMA));
		const parameters = tool.parameters as { properties?: Record<string, unknown> };
		const resultSchema = parameters.properties?.result as { anyOf?: Array<{ properties?: Record<string, unknown> }> };
		const successVariant = resultSchema.anyOf?.find(variant => variant.properties && "data" in variant.properties);
		expect(successVariant?.properties && "type" in successVariant.properties).toBe(true);
	});
});
