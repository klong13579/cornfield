/**
 * Tool-name schema validator.
 *
 * OpenAI / Anthropic tool-calling API requires `name` to match
 * `^[a-zA-Z0-9_-]{1,64}$`. Backends that strictly enforce this (e.g.
 * DeepSeek V4 via OpenAI-compat) return 400 invalid_request_error if a host
 * tool's name contains `.` / `:` / `/` / spaces / non-ASCII characters.
 *
 * These tests pin:
 *   1. The regex itself (`isValidToolName`)
 *   2. The fail-fast error message (`assertValidToolName`)
 *   3. The wiring in `HostToolDispatcher.setTools` — invalid names throw at
 *      registration time, not at first LLM request.
 */
import { describe, expect, it } from "bun:test";
import {
	assertValidToolName,
	HostToolDispatcher,
	type HostToolHandler,
	isValidToolName,
} from "../src/host-tool-dispatcher";

const dummyHandler: HostToolHandler = {
	definition: {
		name: "good_name",
		description: "x",
		parameters: {},
	},
	handle: () => ({ type: "tool_result", tool_use_id: "", content: [{ type: "text", text: "" }] }),
};

describe("isValidToolName — OpenAI tool-calling schema ^[a-zA-Z0-9_-]{1,64}$", () => {
	const valid = [
		"cron",
		"bridge_status",
		"dingtalk_attachment",
		"dingtalk_send_message",
		"a",
		"A",
		"_underscore_start",
		"kebab-case",
		"alphanum123",
		"x".repeat(64),
	];
	for (const name of valid) {
		it(`accepts ${name.length > 20 ? `${name.slice(0, 12)}...` : name}`, () => {
			expect(isValidToolName(name)).toBe(true);
		});
	}

	const invalid: Array<[string, string]> = [
		["", "empty string"],
		["x".repeat(65), "65 chars (exceeds 64)"],
		["bridge.status", "dot"],
		["dingtalk.send_message", "two dots"],
		["git:status", "colon"],
		["pkg/foo", "slash"],
		["has space", "space"],
		["has\ttab", "tab"],
		["中文", "non-ASCII"],
		["emoji🎉", "emoji"],
		["name;semi", "semicolon"],
		["name(paren)", "parens"],
		["name[br]", "brackets"],
	];
	for (const [name, label] of invalid) {
		it(`rejects ${label} (${JSON.stringify(name)})`, () => {
			expect(isValidToolName(name)).toBe(false);
		});
	}
});

describe("assertValidToolName", () => {
	it("does not throw for valid names", () => {
		expect(() => assertValidToolName("cron")).not.toThrow();
		expect(() => assertValidToolName("bridge_status")).not.toThrow();
	});

	it("throws with a clear error message for invalid names", () => {
		expect(() => assertValidToolName("bridge.status")).toThrow(
			/Host tool name "bridge\.status" violates OpenAI tool-calling schema/,
		);
		expect(() => assertValidToolName("dingtalk.attachment")).toThrow(/snake_case before registering/);
	});
});

describe("HostToolDispatcher.setTools — fail-fast on invalid name", () => {
	it("rejects a tool with a dotted name at registration time", () => {
		const dispatcher = new HostToolDispatcher();
		const bad: HostToolHandler = {
			definition: {
				name: "bridge.status",
				description: "x",
				parameters: {},
			},
			handle: dummyHandler.handle,
		};
		expect(() => dispatcher.setTools([bad])).toThrow(/bridge\.status/);
	});

	it("accepts a renamed tool with snake_case name", () => {
		const dispatcher = new HostToolDispatcher();
		const good: HostToolHandler = {
			definition: {
				name: "bridge_status",
				description: "x",
				parameters: {},
			},
			handle: dummyHandler.handle,
		};
		expect(() => dispatcher.setTools([good])).not.toThrow();
		expect(dispatcher.getToolNames()).toEqual(["bridge_status"]);
	});

	it("rejects the entire batch if any single name is invalid", () => {
		const dispatcher = new HostToolDispatcher();
		const good: HostToolHandler = {
			definition: { name: "cron", description: "x", parameters: {} },
			handle: dummyHandler.handle,
		};
		const bad: HostToolHandler = {
			definition: { name: "dingtalk.attachment", description: "x", parameters: {} },
			handle: dummyHandler.handle,
		};
		// setTools is atomic: a single bad name must throw, and the dispatcher
		// should NOT partially register the good tool.
		expect(() => dispatcher.setTools([good, bad])).toThrow(/dingtalk\.attachment/);
		expect(dispatcher.getToolNames()).toEqual([]);
	});
});
