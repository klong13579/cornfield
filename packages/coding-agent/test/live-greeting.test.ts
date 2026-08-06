/**
 * Voice-start greeting helpers (name extraction from the declarative persona
 * + greeting note composition).
 */
import { describe, expect, test } from "bun:test";
import { buildGreetingNote, extractUserName } from "../src/live/greeting";

describe("extractUserName", () => {
	test("parses the declarative persona name line", () => {
		expect(extractUserName("## basics\n- name: 彭梦龙\n- role: CEO")).toBe("彭梦龙");
	});

	test("trims whitespace around the name", () => {
		expect(extractUserName("- name:   梦龙  ")).toBe("梦龙");
	});

	test("returns undefined without a profile or name line", () => {
		expect(extractUserName(null)).toBeUndefined();
		expect(extractUserName(undefined)).toBeUndefined();
		expect(extractUserName("")).toBeUndefined();
		expect(extractUserName("## basics\n- role: CEO")).toBeUndefined();
		expect(extractUserName("- name:")).toBeUndefined();
	});
});

describe("buildGreetingNote", () => {
	test("addresses the user by name when known", () => {
		const note = buildGreetingNote("彭梦龙");
		expect(note).toContain("用户叫彭梦龙");
		expect(note).toContain("问好");
	});

	test("falls back to a generic greeting without a name", () => {
		const note = buildGreetingNote(undefined);
		expect(note).toContain("问好");
		expect(note).not.toContain("用户叫");
	});
});
