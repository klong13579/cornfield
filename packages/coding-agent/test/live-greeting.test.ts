/**
 * Voice-start greeting helpers (name extraction, address-form derivation,
 * greeting note composition).
 */
import { describe, expect, test } from "bun:test";
import { buildGreetingNote, deriveAddressName, extractUserName } from "../src/live/greeting";

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

describe("deriveAddressName", () => {
	test("3-char Chinese names address by given name (surname dropped)", () => {
		expect(deriveAddressName("彭梦龙")).toBe("梦龙");
	});

	test("2-char names and non-Chinese names stay as-is", () => {
		expect(deriveAddressName("张伟")).toBe("张伟");
		expect(deriveAddressName("Alice")).toBe("Alice");
		expect(deriveAddressName("欧阳娜娜")).toBe("欧阳娜娜"); // 4 chars: not the 3-char rule
	});
});

describe("buildGreetingNote", () => {
	test("addresses the user by given name, hello-first, old-friend tone", () => {
		const note = buildGreetingNote("梦龙");
		expect(note).toContain("梦龙");
		expect(note).toContain("你好");
		expect(note).toContain("老朋友");
		expect(note).toContain("不要连姓带名");
	});

	test("falls back to a generic greeting without a name", () => {
		const note = buildGreetingNote(undefined);
		expect(note).toContain("问好");
		expect(note).not.toContain("称呼");
	});
});
