import { describe, expect, it } from "bun:test";
import { type DiffRow, parseNumberedDiff, summarizeDiff } from "../src/pages/workspace/diff-format";

/**
 * T9：文件编辑面板的 diff 拆分。
 *
 * 面板是用户看 agent 改了什么的唯一窗口。拆错的两种代价都很实在：
 * 多出的幽灵行会让人以为文件末尾被动了；静默吞掉的行会让人以为没被改。
 * 所以这里的每条断言都在守「屏幕上看到的就是线上那份 diff」。
 */

describe("parseNumberedDiff", () => {
	it("空串 → 空数组", () => {
		expect(parseNumberedDiff("")).toEqual([]);
	});

	it("末尾换行不产生幽灵空行", () => {
		expect(parseNumberedDiff("+1|a\n")).toEqual([{ kind: "add", lineNo: 1, text: "a" }]);
		expect(parseNumberedDiff("+1|a\n-1|b\n")).toHaveLength(2);
	});

	it("行内容含 `|` 时按第一个 `|` 切分，内容完整保留", () => {
		expect(parseNumberedDiff("+3|const a = b | c;")).toEqual([{ kind: "add", lineNo: 3, text: "const a = b | c;" }]);
	});

	it("空行内容 → text 为空的正常行", () => {
		expect(parseNumberedDiff("+7|")).toEqual([{ kind: "add", lineNo: 7, text: "" }]);
		expect(parseNumberedDiff(" 2|")).toEqual([{ kind: "context", lineNo: 2, text: "" }]);
	});

	it("四种形状都能识别：hunk 头 / 新增 / 删除 / 上下文", () => {
		const diff = ["@@ -1,2 +1,3 @@", "-1|old", " 2|same", "+2|new"].join("\n");
		expect(parseNumberedDiff(diff)).toEqual([
			{ kind: "hunk", text: "@@ -1,2 +1,3 @@" },
			{ kind: "del", lineNo: 1, text: "old" },
			{ kind: "context", lineNo: 2, text: "same" },
			{ kind: "add", lineNo: 2, text: "new" },
		] satisfies DiffRow[]);
	});

	it("非四种形状的行原文透传为 hunk，一行都不丢", () => {
		const diff = [
			"diff --git a/x.ts b/x.ts",
			"--- a/x.ts",
			"+++ b/x.ts",
			"\\ No newline at end of file",
			"hello world",
			" ab|not-a-number",
		].join("\n");
		expect(parseNumberedDiff(diff)).toEqual([
			{ kind: "hunk", text: "diff --git a/x.ts b/x.ts" },
			{ kind: "hunk", text: "--- a/x.ts" },
			{ kind: "hunk", text: "+++ b/x.ts" },
			{ kind: "hunk", text: "\\ No newline at end of file" },
			{ kind: "hunk", text: "hello world" },
			{ kind: "hunk", text: " ab|not-a-number" },
		]);
	});

	it("行号不是正整数 → hunk，而不是 NaN 行号", () => {
		for (const line of ["+abc|text", "-x1|text", "+|text", "+1.5|text", "+ 1|text", " 0|text", "+0x1|text"]) {
			const rows = parseNumberedDiff(line);
			expect(rows).toEqual([{ kind: "hunk", text: line }]);
		}
	});

	it("没有 `|` 的 +/-/空格 行 → hunk", () => {
		expect(parseNumberedDiff("+no separator here")).toEqual([{ kind: "hunk", text: "+no separator here" }]);
		expect(parseNumberedDiff("-")).toEqual([{ kind: "hunk", text: "-" }]);
	});

	it("tab 与中文内容原样透传", () => {
		expect(parseNumberedDiff('+12|\tconst 变量 = "值";')).toEqual([
			{ kind: "add", lineNo: 12, text: '\tconst 变量 = "值";' },
		]);
	});

	it("CRLF 输入：行尾 \\r 先剥掉再匹配", () => {
		const diff = "@@ -1,1 +1,2 @@\r\n-1|旧\r\n+1|新\r";
		expect(parseNumberedDiff(diff)).toEqual([
			{ kind: "hunk", text: "@@ -1,1 +1,2 @@" },
			{ kind: "del", lineNo: 1, text: "旧" },
			{ kind: "add", lineNo: 1, text: "新" },
		]);
	});

	it("空格前缀的上下文行不因首个字符是空白而被丢掉", () => {
		expect(parseNumberedDiff(" 1|  缩进的内容")).toEqual([{ kind: "context", lineNo: 1, text: "  缩进的内容" }]);
	});
});

describe("summarizeDiff", () => {
	it("空数组 → 全 0", () => {
		expect(summarizeDiff([])).toEqual({ added: 0, removed: 0 });
	});

	it("只数 add/del，忽略 hunk 与 context", () => {
		const rows = parseNumberedDiff(["@@ -1,3 +1,3 @@", "-1|a", "-2|b", "+1|c", " 3|d", "junk"].join("\n"));
		expect(summarizeDiff(rows)).toEqual({ added: 1, removed: 2 });
	});

	it("内容为空的新增/删除行同样计数", () => {
		expect(summarizeDiff(parseNumberedDiff("+1|\n-1|"))).toEqual({ added: 1, removed: 1 });
	});
});
