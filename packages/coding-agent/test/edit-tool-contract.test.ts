import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Type } from "@sinclair/typebox";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";

// ============================================================================
// Regression test for fp_20260708_empty_args_with_intent (55bdd20d T10):
// LLM emitted edit tool calls with only an `_i` intent field and no path/edits,
// failing validation with "path: must have required property / edits: must have
// required property". This test pins the two-layer defense so neither layer can
// regress silently.
//
//   Layer 1 (prompt, 164e79ddf): EditTool.description prepends the
//       REQUIRED FIELDS contract so the LLM sees the contract before
//       inferring from schema.
//   Layer 2 (validation, 6585f026c): validateToolArguments + isIntentOnlyArgs
//       detect the `_i`-only shape and return a hint pointing at the missing
//       required properties.
//
// If either layer breaks, this file fails — by design.
// ============================================================================

// Modes whose .md prompt is pure text (no Handlebars helper references) and
// can be rendered in a unit test without registering runtime helpers. The
// hashline and atom prompts reference session-specific helpers (e.g. `{{hline}}`)
// and are exercised end-to-end via the agent loop, not here.
const TESTABLE_MODES = ["replace", "patch", "apply_patch"] as const;

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
});

// ----------------------------------------------------------------------------
// Layer 1: contract is prepended to EditTool.description in every mode
// ----------------------------------------------------------------------------

describe("EditTool contract — REQUIRED FIELDS preamble (Layer 1, 164e79ddf)", () => {
	test.each(TESTABLE_MODES)("contract is prepended in %s mode", mode => {
		Bun.env.PI_EDIT_VARIANT = mode;
		const tool = new EditTool(createTestSession(os.tmpdir()));
		// Contract must be the first thing the LLM sees
		expect(tool.description.startsWith("**REQUIRED FIELDS**: Every `edit` tool call MUST include")).toBe(true);
	});

	test("contract is prepended AND mode-specific description is preserved (replace mode)", () => {
		Bun.env.PI_EDIT_VARIANT = "replace";
		const tool = new EditTool(createTestSession(os.tmpdir()));
		expect(tool.description).toContain("**REQUIRED FIELDS**");
		expect(tool.description).toContain("Performs string replacements");
	});

	test("contract is prepended AND mode-specific description is preserved (patch mode)", () => {
		Bun.env.PI_EDIT_VARIANT = "patch";
		const tool = new EditTool(createTestSession(os.tmpdir()));
		expect(tool.description).toContain("**REQUIRED FIELDS**");
		// Patch description references create/update/delete operations
		expect(tool.description.toLowerCase()).toMatch(/create|update|delete/);
	});

	test("contract text mentions required fields, intent, and re-emit guidance", () => {
		Bun.env.PI_EDIT_VARIANT = "replace";
		const tool = new EditTool(createTestSession(os.tmpdir()));
		// Pull just the contract preamble (first paragraph) and assert it carries
		// the three pieces of guidance the LLM needs to self-correct.
		const preamble = tool.description.split("\n\n")[0]!;
		expect(preamble).toMatch(/MUST include all required arguments/);
		expect(preamble).toMatch(/`_i` field is OPTIONAL/);
		expect(preamble).toMatch(/Re-emit the call/);
	});

	test("contract includes a concrete correct-shape Example", () => {
		Bun.env.PI_EDIT_VARIANT = "replace";
		const tool = new EditTool(createTestSession(os.tmpdir()));
		// The example was added during the tmux test session; pin it so a future
		// "let me shorten the contract" cleanup can't silently drop it.
		expect(tool.description).toContain('Example: {"path":');
		expect(tool.description).toContain('"edits": [');
	});
});

// ----------------------------------------------------------------------------
// Layer 2: validation layer catches the exact 55bdd20d T10 failure shape
// ----------------------------------------------------------------------------

describe("validateToolArguments — intent-only args safety net (Layer 2, 6585f026c)", () => {
	// Mirror the edit tool's `replace`-mode schema: path + edits[]. This is the
	// schema shape the LLM was trying to call in 55bdd20d T10.
	const editSchema = Type.Object({
		path: Type.String(),
		edits: Type.Array(
			Type.Object({
				old_text: Type.String(),
				new_text: Type.String(),
			}),
		),
	});

	const fakeEditTool: Tool = {
		name: "edit",
		description: "edit tool",
		parameters: editSchema,
	};

	test("rejects intent-only args and surfaces a clear hint (the 55bdd20d T10 case)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-55bdd20d-t10",
			name: "edit",
			// Exact failure shape: LLM sent only `_i`, no path, no edits.
			arguments: { _i: "Update picker card content/statusLine/hasAction" } as never,
		};
		try {
			validateToolArguments(fakeEditTool, toolCall);
			throw new Error("expected validation to throw");
		} catch (e) {
			const msg = (e as Error).message;
			// AJV lists each missing required property on its own line; match
			// across newlines with the /s flag.
			expect(msg).toMatch(/path[\s\S]*edits|edits[\s\S]*path/);
			// Enhanced hint must point at the intent-only failure mode
			expect(msg).toContain("Hint: your arguments object only contains intent fields");
			expect(msg).toContain("missing required properties: path, edits");
			expect(msg).toMatch(/Re-emit the tool call/);
		}
	});

	test("truly empty args still fail but without the intent hint (no `_i` present)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-empty",
			name: "edit",
			arguments: {} as never,
		};
		try {
			validateToolArguments(fakeEditTool, toolCall);
			throw new Error("expected validation to throw");
		} catch (e) {
			const msg = (e as Error).message;
			// AJV lists each missing required property on its own line; match
			// across newlines with the /s flag.
			expect(msg).toMatch(/path[\s\S]*edits|edits[\s\S]*path/);
			// isIntentOnlyArgs returns false for empty object — no intent hint
			expect(msg).not.toContain("Hint: your arguments object only contains intent fields");
		}
	});

	test("partial args (some real fields present) fail without intent hint", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-partial",
			name: "edit",
			arguments: { _i: "intent", path: "foo.ts" } as never, // missing edits
		};
		try {
			validateToolArguments(fakeEditTool, toolCall);
			throw new Error("expected validation to throw");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toMatch(/edits.*required|edits: must/);
			// has `path` (non-intent) so isIntentOnlyArgs is false — no intent hint
			expect(msg).not.toContain("Hint: your arguments object only contains intent fields");
		}
	});

	test("intent-only with custom-prefix field is still flagged", () => {
		// `_purpose` and `_why` should also trip isIntentOnlyArgs — any `_`-prefix
		// is treated as an intent field per the helper's contract.
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-intent-mix",
			name: "edit",
			arguments: { _purpose: "refactor", _why: "readability" } as never,
		};
		try {
			validateToolArguments(fakeEditTool, toolCall);
			throw new Error("expected validation to throw");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("Hint: your arguments object only contains intent fields");
		}
	});

	test("valid args pass through cleanly (no false positive)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-valid",
			name: "edit",
			arguments: {
				path: "foo.ts",
				edits: [{ old_text: "a", new_text: "b" }],
			},
		};
		const result = validateToolArguments(fakeEditTool, toolCall);
		expect(result).toEqual({
			path: "foo.ts",
			edits: [{ old_text: "a", new_text: "b" }],
		});
	});
});
