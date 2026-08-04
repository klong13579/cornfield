import { describe, expect, test } from "bun:test";
import { buildVoiceInstructions } from "../src/live/instructions";

const BASE = "你是 Jarvis。";

describe("buildVoiceInstructions", () => {
	test("no history returns the base prompt unchanged", () => {
		expect(buildVoiceInstructions(BASE, [])).toBe(BASE);
	});

	test("recent user/assistant turns are appended, oldest first", () => {
		const history = [
			{ role: "user", content: [{ type: "text", text: "第一条" }] },
			{ role: "assistant", content: [{ type: "text", text: "回答一" }] },
			{ role: "user", content: "第二条" },
		];
		const result = buildVoiceInstructions(BASE, history);
		expect(result).toContain(BASE);
		expect(result.indexOf("第一条")).toBeLessThan(result.indexOf("第二条"));
		expect(result).toContain("用户：第二条");
		expect(result).toContain("助手：回答一");
	});

	test("non-text and system messages are skipped", () => {
		const history = [
			{ role: "system", content: "系统提示" },
			{ role: "user", content: [{ type: "image", data: "x" }] },
			{ role: "user", content: "有效的" },
		];
		const result = buildVoiceInstructions(BASE, history);
		expect(result).not.toContain("系统提示");
		expect(result).toContain("用户：有效的");
	});

	test("long turns and long blocks are clipped", () => {
		const history = Array.from({ length: 20 }, (_, i) => ({
			role: "user",
			content: `第${i}条${"很长的内容".repeat(50)}`,
		}));
		const result = buildVoiceInstructions(BASE, history);
		expect(result.length).toBeLessThan(BASE.length + 1_700);
	});
});
