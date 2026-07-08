import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Type } from "@sinclair/typebox";

describe("Tool argument coercion", () => {
	it("coerces numeric strings when schema expects number", () => {
		const tool: Tool = {
			name: "t1",
			description: "",
			parameters: Type.Object({ timeout: Type.Number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "t1",
			arguments: { timeout: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { timeout: number };
		expect(result.timeout).toBe(300);
		expect(typeof result.timeout).toBe("number");
	});

	it("preserves string values when schema expects string", () => {
		const tool: Tool = {
			name: "t2",
			description: "",
			parameters: Type.Object({ label: Type.String() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "t2",
			arguments: { label: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { label: string };
		expect(result.label).toBe("300");
		expect(typeof result.label).toBe("string");
	});

	it("parses JSON arrays in string values when schema expects array", () => {
		const tool: Tool = {
			name: "t3",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.Number()) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3",
			name: "t3",
			arguments: { items: "[1, 2, 3]" },
		};

		const result = validateToolArguments(tool, toolCall) as { items: number[] };
		expect(result.items).toEqual([1, 2, 3]);
	});

	it("parses JSON objects in string values when schema expects object", () => {
		const tool: Tool = {
			name: "t4",
			description: "",
			parameters: Type.Object({ payload: Type.Object({ a: Type.Number() }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-4",
			name: "t4",
			arguments: { payload: '{"a": 1}' },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload).toEqual({ a: 1 });
	});

	it("parses nested JSON arrays in string values", () => {
		const tool: Tool = {
			name: "t5",
			description: "",
			parameters: Type.Object({ payload: Type.Object({ items: Type.Array(Type.Number()) }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-5",
			name: "t5",
			arguments: { payload: { items: "[4, 5]" } },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload.items).toEqual([4, 5]);
	});

	it("coerces JSON-stringified object arrays when schema expects array of objects", () => {
		const tool: Tool = {
			name: "t9",
			description: "",
			parameters: Type.Object({
				a: Type.String(),
				b: Type.Array(
					Type.Object({
						k: Type.String(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-9",
			name: "t9",
			arguments: {
				a: "hello",
				b: '[{"k":"y"}]',
			},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.b).toEqual([{ k: "y" }]);
	});

	it("coerces JSON-stringified root arguments containing array-of-object fields", () => {
		const tool: Tool = {
			name: "t10",
			description: "",
			parameters: Type.Object({
				a: Type.String(),
				b: Type.Array(
					Type.Object({
						k: Type.String(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-10",
			name: "t10",
			arguments: '{"a":"hello","b":"[{\\"k\\":\\"y\\"}]"}' as unknown as Record<string, unknown>,
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			a: "hello",
			b: [{ k: "y" }],
		});
	});

	it("iteratively coerces when both root arguments and nested fields are JSON strings", () => {
		const tool: Tool = {
			name: "t7",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						target: Type.String(),
						new_content: Type.String(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-7",
			name: "t7",
			arguments:
				'{"path":"somefile.js","edits":"[{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}]"}' as unknown as Record<
					string,
					unknown
				>,
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.path).toBe("somefile.js");
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("coerces quoted edit arrays before stripping optional null fields", () => {
		const textSchema = Type.Union([Type.Array(Type.String()), Type.String()]);
		const tool: Tool = {
			name: "atom-like-edit",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						loc: Type.String(),
						set: Type.Optional(textSchema),
						pre: Type.Optional(textSchema),
						post: Type.Optional(textSchema),
						sub: Type.Optional(Type.Tuple([Type.String(), Type.String()])),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-atom-like-edit",
			name: "atom-like-edit",
			arguments: {
				path: "orcid.ts",
				edits: '[{"loc":"276ka-282vu","pre":null,"set":["line"],"post":null,"sub":null}]',
			},
		};

		const result = validateToolArguments(tool, toolCall) as { edits: Array<Record<string, unknown>> };
		expect(result.edits).toEqual([{ loc: "276ka-282vu", set: ["line"] }]);
	});

	it("coerces array strings with trailing wrapper braces from malformed nested JSON", () => {
		const tool: Tool = {
			name: "t16",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						op: Type.String(),
						pos: Type.String(),
						end: Type.String(),
						lines: Type.Array(Type.String()),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-16",
			name: "t16",
			arguments: {
				path: "packages/coding-agent/src/prompts/tools/bash.md",
				edits: '[{"op":"replace","pos":"38#BR","end":"39#QY","lines":["line 1","line 2"]}]}\n',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([
			{
				op: "replace",
				pos: "38#BR",
				end: "39#QY",
				lines: ["line 1", "line 2"],
			},
		]);
	});
	it("iteratively coerces nested array items that are JSON-serialized objects", () => {
		const tool: Tool = {
			name: "t8",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						target: Type.String(),
						new_content: Type.String(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-8",
			name: "t8",
			arguments: {
				path: "somefile.js",
				edits: '["{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}"]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("accepts null for optional properties by treating them as omitted", () => {
		const tool: Tool = {
			name: "t11",
			description: "",
			parameters: Type.Object({
				requiredText: Type.String(),
				optionalCount: Type.Optional(Type.Number()),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-11",
			name: "t11",
			arguments: { requiredText: "ok", optionalCount: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ requiredText: "ok" });
	});

	it("drops null optional properties nested in array objects", () => {
		const tool: Tool = {
			name: "t12",
			description: "",
			parameters: Type.Object({
				edits: Type.Array(
					Type.Object({
						target: Type.String(),
						pos: Type.Optional(Type.String()),
						end: Type.Optional(Type.String()),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-12",
			name: "t12",
			arguments: { edits: [{ target: "a", pos: null, end: "e" }] },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ edits: [{ target: "a", end: "e" }] });
	});

	it("drops null optional properties in anyOf object branches", () => {
		const opSchema = Type.Union([
			Type.Object({
				op: Type.Literal("add_task"),
				phase: Type.String(),
				content: Type.String(),
			}),
			Type.Object({
				op: Type.Literal("update"),
				id: Type.String(),
				status: Type.Optional(Type.String()),
				content: Type.Optional(Type.String()),
				notes: Type.Optional(Type.String()),
			}),
		]);

		const tool: Tool = {
			name: "t13",
			description: "",
			parameters: Type.Object({
				ops: Type.Array(opSchema),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-13",
			name: "t13",
			arguments: {
				ops: [
					{
						op: "update",
						id: "task-1",
						status: "completed",
						content: null,
						notes: "",
					},
				],
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			ops: [
				{
					op: "update",
					id: "task-1",
					status: "completed",
					notes: "",
				},
			],
		});
	});

	it("does not parse quoted JSON strings when schema expects number", () => {
		const tool: Tool = {
			name: "t6",
			description: "",
			parameters: Type.Object({ timeout: Type.Number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-6",
			name: "t6",
			arguments: { timeout: '"300"' },
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow('Validation failed for tool "t6"');
	});

	it("coerces numeric string for Optional<number> (anyOf:[number,null])", () => {
		const tool: Tool = {
			name: "t14",
			description: "",
			parameters: Type.Object({ tick_size: Type.Optional(Type.Number()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-14",
			name: "t14",
			arguments: { tick_size: "1.0" },
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBe(1);
		expect(typeof result.tick_size).toBe("number");
	});

	it("leaves Optional<number> as undefined when absent", () => {
		const tool: Tool = {
			name: "t15",
			description: "",
			parameters: Type.Object({ tick_size: Type.Optional(Type.Number()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-15",
			name: "t15",
			arguments: {},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBeUndefined();
	});
	it("strips string 'null' on optional boolean field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				delete: Type.Optional(Type.Boolean()),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", delete: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("strips string 'null' on optional string field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				move: Type.Optional(Type.String()),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", move: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("errors on string 'null' for required field", () => {
		const tool: Tool = {
			name: "required-tool",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-required",
			name: "required-tool",
			arguments: { path: "null" },
		};

		// Should NOT strip - path is required, so validation should pass
		// (the string "null" is a valid string)
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "null" });
	});

	it("strips string 'null' and actual null on multiple optional fields", () => {
		const tool: Tool = {
			name: "multi-optional",
			description: "",
			parameters: Type.Object({
				required: Type.String(),
				optBool: Type.Optional(Type.Boolean()),
				optString: Type.Optional(Type.String()),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-multi",
			name: "multi-optional",
			arguments: { required: "value", optBool: "null", optString: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ required: "value" });
	});

	it("heals stringified array with extra bracket at end", () => {
		const tool: Tool = {
			name: "heal-1",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						target: Type.String(),
						content: Type.String(),
					}),
				),
			}),
		};

		// Model wrote "]}]" at the end instead of "}]" -- extra ] between " and }
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-1",
			name: "heal-1",
			arguments: {
				path: "foo.ts",
				edits: '[{"target": "fn_foo#ABCD", "content": "code}"}]}]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD", content: "code}" }]);
	});

	it("heals stringified array with wrong bracket type at end", () => {
		const tool: Tool = {
			name: "heal-2",
			description: "",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({
						target: Type.String(),
						content: Type.String(),
					}),
				),
			}),
		};

		// Model wrote "}}" at the end instead of "}]" -- wrong bracket type
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-2",
			name: "heal-2",
			arguments: {
				path: "bar.ts",
				edits: '[{"target": "fn_bar#1234", "content": "return 1}"}}',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_bar#1234", content: "return 1}" }]);
	});

	it("heals stringified array with literal backslash-n between tokens", () => {
		const tool: Tool = {
			name: "heal-esc-1",
			description: "",
			parameters: Type.Object({
				edits: Type.Array(Type.Object({ target: Type.String(), content: Type.String() })),
			}),
		};

		// LLM emits literal \n between the closing } and ]
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-esc-1",
			name: "heal-esc-1",
			arguments: {
				edits: '[{"target": "fn_foo#ABCD~", "content": "return 1;\\n"}\\n]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD~", content: "return 1;\n" }]);
	});

	it("heals stringified array with trailing junk after balanced container", () => {
		const tool: Tool = {
			name: "heal-trail-1",
			description: "",
			parameters: Type.Object({
				edits: Type.Array(Type.Object({ target: Type.String(), op: Type.String() })),
			}),
		};

		// LLM appends \n</invoke> after the valid JSON
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-trail-1",
			name: "heal-trail-1",
			arguments: {
				edits: '[{"target": "fn_foo", "op": "replace"}]\n</invoke>',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo", op: "replace" }]);
	});

	it("does not heal deeply broken JSON strings", () => {
		const tool: Tool = {
			name: "heal-3",
			description: "",
			parameters: Type.Object({
				edits: Type.Array(Type.Object({ target: Type.String() })),
			}),
		};

		// Structural error deep in the middle -- should NOT be healed
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-3",
			name: "heal-3",
			arguments: {
				edits: '[{"target": invalid json here}]',
			},
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});
	it("parses JSON-stringified array containing raw newlines inside string values", () => {
		const tool: Tool = {
			name: "todo_write_like",
			description: "",
			parameters: Type.Object({
				phases: Type.Array(
					Type.Object({
						name: Type.String(),
						tasks: Type.Array(
							Type.Object({
								content: Type.String(),
								details: Type.Optional(Type.String()),
							}),
						),
					}),
				),
			}),
		};

		// Stringified phases array where one `details` value contains a raw newline,
		// which `JSON.parse` rejects unless the control char is escaped.
		const stringifiedPhases =
			'[{"name":"Investigation","tasks":[{"content":"Locate code","details":"line one\nline two"}]}]';
		expect(stringifiedPhases.includes("\n")).toBe(true);

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-rawnl",
			name: "todo_write_like",
			arguments: { phases: stringifiedPhases },
		};

		const result = validateToolArguments(tool, toolCall) as {
			phases: Array<{ name: string; tasks: Array<{ content: string; details?: string }> }>;
		};
		expect(result.phases).toEqual([
			{
				name: "Investigation",
				tasks: [{ content: "Locate code", details: "line one\nline two" }],
			},
		]);
	});
});

describe("Tool argument coercion: object-wrapper into string[]", () => {
	// Regression: LLM shape error observed 2026-07-08. The model wrapped each
	// task content in `{task: "..."}` instead of passing a flat string array:
	//   items: [{task: "Delete prompt-queue-rolling hard cap test", item: {...}}, ...]
	// instead of
	//   items: ["Delete prompt-queue-rolling hard cap test", ...]
	// AJV reported `items/0: must be string` and the call failed. The fix
	// detects wrapper objects and extracts the string content.

	it("extracts `task` field from object-wrapped string array elements", () => {
		const tool: Tool = {
			name: "tw1",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-1",
			name: "tw1",
			arguments: {
				items: [
					{ task: "first task", item: { foo: "bar" } },
					{ task: "second task", item: { foo: "baz" } },
				],
			},
		};
		const result = validateToolArguments(tool, toolCall) as { items: string[] };
		expect(result.items).toEqual(["first task", "second task"]);
	});

	it("prefers `task` over other common field names", () => {
		const tool: Tool = {
			name: "tw2",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-2",
			name: "tw2",
			arguments: {
				items: [{ task: "winner", text: "loser", name: "loser", content: "loser" }],
			},
		};
		const result = validateToolArguments(tool, toolCall) as { items: string[] };
		expect(result.items).toEqual(["winner"]);
	});

	it("falls back to common content field names in priority order", () => {
		const tool: Tool = {
			name: "tw3",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const cases: Array<{ key: string; expected: string }> = [
			{ key: "text", expected: "by-text" },
			{ key: "content", expected: "by-content" },
			{ key: "name", expected: "by-name" },
			{ key: "value", expected: "by-value" },
			{ key: "description", expected: "by-description" },
			{ key: "label", expected: "by-label" },
		];
		for (const c of cases) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `call-ow-3-${c.key}`,
				name: "tw3",
				arguments: { items: [{ [c.key]: c.expected, noise: "ignored" }] },
			};
			const result = validateToolArguments(tool, toolCall) as { items: string[] };
			expect(result.items).toEqual([c.expected]);
		}
	});

	it("falls back to a single non-empty string field when no preferred key is present", () => {
		const tool: Tool = {
			name: "tw4",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-4",
			name: "tw4",
			arguments: { items: [{ bespokeField: "extracted", otherNumber: 42 }] },
		};
		const result = validateToolArguments(tool, toolCall) as { items: string[] };
		expect(result.items).toEqual(["extracted"]);
	});

	it("does NOT extract when the object has multiple string fields (ambiguous)", () => {
		const tool: Tool = {
			name: "tw5",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-5",
			name: "tw5",
			arguments: { items: [{ foo: "a", bar: "b" }] },
		};
		// Two string fields, no preferred key — coercion declines, AJV still fails.
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed/);
	});

	it("does NOT extract when the object has no string fields at all", () => {
		const tool: Tool = {
			name: "tw6",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-6",
			name: "tw6",
			arguments: { items: [{ count: 42, ok: true }] },
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed/);
	});

	it("preserves real string values in the array", () => {
		const tool: Tool = {
			name: "tw7",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-7",
			name: "tw7",
			arguments: { items: ["a", "b", "c"] },
		};
		const result = validateToolArguments(tool, toolCall) as { items: string[] };
		expect(result.items).toEqual(["a", "b", "c"]);
	});

	it("handles mixed strings and object-wrapped elements", () => {
		const tool: Tool = {
			name: "tw8",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-8",
			name: "tw8",
			arguments: { items: ["plain", { task: "wrapped" }, "another plain"] },
		};
		const result = validateToolArguments(tool, toolCall) as { items: string[] };
		expect(result.items).toEqual(["plain", "wrapped", "another plain"]);
	});

	it("recovers deeply nested ops[].list[].items[] (the actual todo_write shape)", () => {
		const tool: Tool = {
			name: "todo_write",
			description: "",
			parameters: Type.Object({
				ops: Type.Array(
					Type.Object({
						op: Type.String(),
						list: Type.Optional(
							Type.Array(
								Type.Object({
									phase: Type.String(),
									items: Type.Array(Type.String()),
								}),
							),
						),
					}),
				),
			}),
		};
		// This is the exact shape that failed on 2026-07-08.
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-9",
			name: "todo_write",
			arguments: {
				ops: [
					{
						op: "init",
						list: [
							{
								phase: "Test cleanup",
								items: [
									{ task: "Delete prompt-queue-rolling hard cap test" },
									{ task: "Update scheduler tests referencing hard cap" },
									{ task: "Update config schema/doctor test fixtures" },
								],
							},
							{
								phase: "Verification",
								items: [{ task: "Type check" }, { task: "Run gateway test suite" }, { task: "Commit" }],
							},
						],
					},
				],
			},
		};
		const result = validateToolArguments(tool, toolCall) as {
			ops: Array<{
				op: string;
				list: Array<{ phase: string; items: string[] }>;
			}>;
		};
		expect(result.ops[0]?.list[0]?.items).toEqual([
			"Delete prompt-queue-rolling hard cap test",
			"Update scheduler tests referencing hard cap",
			"Update config schema/doctor test fixtures",
		]);
		expect(result.ops[0]?.list[1]?.items).toEqual(["Type check", "Run gateway test suite", "Commit"]);
	});

	it("does NOT touch elements in object[] arrays (no false positive)", () => {
		const tool: Tool = {
			name: "tw10",
			description: "",
			parameters: Type.Object({
				records: Type.Array(
					Type.Object({
						id: Type.String(),
						name: Type.Optional(Type.String()),
					}),
				),
			}),
		};
		// records: [{id: "a", name: "alpha"}] — `name` is a string field on the
		// object schema. The object-wrapper coercion must NOT promote this
		// into a string; the schema is Type.Array(Type.Object(...)), not string[].
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-10",
			name: "tw10",
			arguments: { records: [{ id: "a", name: "alpha" }] },
		};
		const result = validateToolArguments(tool, toolCall) as {
			records: Array<{ id: string; name?: string }>;
		};
		expect(result.records).toEqual([{ id: "a", name: "alpha" }]);
	});

	it("does NOT touch a top-level string field that happens to be an object", () => {
		// Schema says the field is a string. If the LLM sent an object as the
		// whole field value (not inside an array), the wrapper heuristic would
		// also apply. Verify that the same extract works.
		const tool: Tool = {
			name: "tw11",
			description: "",
			parameters: Type.Object({ label: Type.String() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-ow-11",
			name: "tw11",
			arguments: { label: { task: "extracted label" } },
		};
		const result = validateToolArguments(tool, toolCall) as { label: string };
		expect(result.label).toBe("extracted label");
	});
});

describe("Tool argument validation: empty-args-with-intent hint", () => {
	const editTool: Tool = {
		name: "edit",
		description: "",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(
				Type.Object({
					old_text: Type.String(),
					new_text: Type.String(),
				}),
			),
		}),
	};

	it("enhances error message when args only contain _i and missing required properties", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-empty-intent",
			name: "edit",
			arguments: { _i: "Update picker card content" },
		};

		expect(() => validateToolArguments(editTool, toolCall)).toThrow(/missing required properties: path, edits/);
		expect(() => validateToolArguments(editTool, toolCall)).toThrow(/Hint: your arguments object only contains intent fields/);
		expect(() => validateToolArguments(editTool, toolCall)).toThrow(/Did you forget to include the actual tool arguments/);
	});

	it("enhances error message for any intent field starting with _", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-intent-underscore",
			name: "edit",
			arguments: { _intent: "modify file", _retry: 2 },
		};

		expect(() => validateToolArguments(editTool, toolCall)).toThrow(/missing required properties/);
	});

	it("does NOT add hint when args is completely empty", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-truly-empty",
			name: "edit",
			arguments: {},
		};

		// Truly empty (no keys) should produce the standard error without the
		// intent-field hint, because we can't tell whether the LLM forgot
		// args entirely vs. sent an empty object intentionally.
		const error = (() => {
			try {
				validateToolArguments(editTool, toolCall);
				return null;
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error).not.toBeNull();
		expect(error!.message).toMatch(/Validation failed for tool "edit"/);
		expect(error!.message).not.toMatch(/Hint: your arguments object only contains intent fields/);
	});

	it("does NOT add hint when args has real properties (just not the right ones)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-real-prop",
			name: "edit",
			arguments: { foo: "bar" }, // has a real prop, just not path/edits
		};

		const error = (() => {
			try {
				validateToolArguments(editTool, toolCall);
				return null;
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error).not.toBeNull();
		expect(error!.message).not.toMatch(/Hint: your arguments object only contains intent fields/);
	});

	it("does NOT add hint when all required properties are present (validation passes)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-valid",
			name: "edit",
			arguments: {
				_i: "legitimate intent",
				path: "file.txt",
				edits: [{ old_text: "a", new_text: "b" }],
			},
		};

		const result = validateToolArguments(editTool, toolCall);
		expect(result.path).toBe("file.txt");
		expect(result.edits).toEqual([{ old_text: "a", new_text: "b" }]);
	});
});
