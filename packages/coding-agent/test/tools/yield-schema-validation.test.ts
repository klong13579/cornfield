/**
 * Boundary coverage for the unified output-schema entry point (`tools/output-schema-validator.ts`),
 * asserted through its two production consumers.
 *
 * The point of the unification is that the subagent-side `yield` tool and the parent-side executor
 * reach the same verdict for the same declaration, so the payload table below runs the same inputs
 * through both and requires agreement.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { buildOutputValidator } from "@cornfield/coding-agent/tools/output-schema-validator";
import { YieldTool } from "@cornfield/coding-agent/tools/yield";
import { finalizeSubprocessOutput, SUBAGENT_WARNING_MISSING_YIELD } from "../../src/task/executor";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

type Verdict = "accept" | "reject";

/** What the subagent-side tool decides for a submitted `data` payload. */
async function yieldVerdict(outputSchema: unknown, data: unknown): Promise<Verdict> {
	const tool = new YieldTool(createSession({ outputSchema }));
	try {
		await tool.execute("verdict", { result: { data } } as never);
		return "accept";
	} catch {
		return "reject";
	}
}

/** What the parent-side finalizer decides when the subagent emitted JSON as raw text. */
function executorVerdict(outputSchema: unknown, data: unknown): Verdict {
	const result = finalizeSubprocessOutput({
		rawOutput: JSON.stringify(data),
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: undefined,
		outputSchema,
	});
	return result.rawOutput.startsWith("SYSTEM WARNING") ? "reject" : "accept";
}

const closedSchema = {
	type: "object",
	properties: { ok: { type: "boolean" } },
	required: ["ok"],
	additionalProperties: false,
};

describe("unified output-schema entry", () => {
	it("reports no declaration and no error when no schema is provided", () => {
		const built = buildOutputValidator(undefined);
		expect(built.normalized).toBeUndefined();
		expect(built.jsonSchema).toBeUndefined();
		expect(built.validate).toBeUndefined();
		expect(built.error).toBeUndefined();
	});

	it("reports the parse failure verbatim when the declaration is not valid JSON", async () => {
		const built = buildOutputValidator("{ not json");
		expect(built.validate).toBeUndefined();
		expect(built.error).toBeString();

		// Unreadable declaration means no verdict is bound: both sides fall back to loose acceptance.
		expect(await yieldVerdict("{ not json", { any: "shape" })).toBe("accept");
		const executed = finalizeSubprocessOutput({
			rawOutput: "plain text notes",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: "{ not json",
		});
		expect(executed.rawOutput).toBe("plain text notes");
		expect(executed.exitCode).toBe(0);
	});

	it("reports a compile failure instead of throwing, and keeps the declaration readable", () => {
		const built = buildOutputValidator({
			type: "object",
			properties: { value: { type: "not-a-real-json-schema-type" } },
		});
		expect(built.validate).toBeUndefined();
		expect(built.error).toBeString();
		// `normalized` still describes what was declared, so callers can distinguish
		// "no schema" from "schema that cannot be honored".
		expect(built.normalized).not.toBeUndefined();
	});

	it("reports a declaration that rejects every output", () => {
		const built = buildOutputValidator(false);
		expect(built.validate).toBeUndefined();
		expect(built.error).toBe("boolean false schema rejects all outputs");
	});

	it("returns the same verdict from both consumers across payload boundaries", async () => {
		const cases: Array<{ name: string; schema: unknown; data: unknown; expected: Verdict }> = [
			{ name: "valid payload", schema: closedSchema, data: { ok: true }, expected: "accept" },
			{ name: "missing required field", schema: closedSchema, data: { other: true }, expected: "reject" },
			{
				name: "extra field on a closed schema",
				schema: closedSchema,
				data: { ok: true, extra: 1 },
				expected: "reject",
			},
			{ name: "wrong field type", schema: closedSchema, data: { ok: "true" }, expected: "reject" },
			{ name: "null candidate", schema: closedSchema, data: null, expected: "reject" },
			{ name: "no schema declared", schema: undefined, data: { anything: [1, 2] }, expected: "accept" },
			{ name: "unconstrained schema", schema: true, data: [1, 2, 3], expected: "accept" },
		];

		for (const testCase of cases) {
			expect(await yieldVerdict(testCase.schema, testCase.data)).toBe(testCase.expected);
			expect(executorVerdict(testCase.schema, testCase.data)).toBe(testCase.expected);
		}
	});

	it("names the failing rule and location when the parent rejects a payload", () => {
		const executed = finalizeSubprocessOutput({
			rawOutput: '{"other":true}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: closedSchema,
		});
		expect(executed.exitCode).toBe(1);
		expect(executed.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
	});
});
