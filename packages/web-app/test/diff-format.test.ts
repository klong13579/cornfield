import { describe, expect, it } from "bun:test";
import {
	type DiffRow,
	pairForSplit,
	parseNumberedDiff,
	type SplitRow,
	summarizeDiff,
} from "../src/pages/workspace/diff-format";

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

describe("pairForSplit", () => {
	/** 便捷入口：直接把带行号的 diff 文本配成并列视图。 */
	const split = (diff: string): SplitRow[] => pairForSplit(parseNumberedDiff(diff));

	it("空 diff → 空数组", () => {
		expect(split("")).toEqual([]);
	});

	it("没有对应行的一侧留空，不补假内容", () => {
		// 纯删除：右侧全空（不是把删除行折成两栏各一份）
		expect(split("-1|a\n-2|b")).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: null },
			{ kind: "pair", left: { lineNo: 2, kind: "del", text: "b" }, right: null },
		] satisfies SplitRow[]);
		// 纯新增：左侧全空
		expect(split("+1|a\n+2|b")).toEqual([
			{ kind: "pair", left: null, right: { lineNo: 1, kind: "add", text: "a" } },
			{ kind: "pair", left: null, right: { lineNo: 2, kind: "add", text: "b" } },
		] satisfies SplitRow[]);
	});

	it("一段改动里按下标配对（删除多于新增 / 新增多于删除）", () => {
		// 删 3 增 1：多出来的两行只在左栏
		const moreDels = split("-1|a\n-2|b\n-3|c\n+1|x");
		expect(moreDels).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: { lineNo: 1, kind: "add", text: "x" } },
			{ kind: "pair", left: { lineNo: 2, kind: "del", text: "b" }, right: null },
			{ kind: "pair", left: { lineNo: 3, kind: "del", text: "c" }, right: null },
		] satisfies SplitRow[]);
		// 增 2 删 1：多出来的一行只在右栏
		const moreAdds = split("-1|a\n+1|x\n+2|y");
		expect(moreAdds).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: { lineNo: 1, kind: "add", text: "x" } },
			{ kind: "pair", left: null, right: { lineNo: 2, kind: "add", text: "y" } },
		] satisfies SplitRow[]);
	});

	it("上下文行：两侧同一份内容，行号各自是真实行号", () => {
		// 删除在前：旧 2/3 行在新文件里是 1/2 行（新 = 旧 + (新增数 − 删除数)）
		expect(split("-1|a\n 2|b\n 3|c")).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: null },
			{
				kind: "pair",
				left: { lineNo: 2, kind: "context", text: "b" },
				right: { lineNo: 1, kind: "context", text: "b" },
			},
			{
				kind: "pair",
				left: { lineNo: 3, kind: "context", text: "c" },
				right: { lineNo: 2, kind: "context", text: "c" },
			},
		] satisfies SplitRow[]);
		// 新增在前：旧 1/2 行在新文件里是 2/3 行
		expect(split("+1|x\n 1|b\n 2|c")).toEqual([
			{ kind: "pair", left: null, right: { lineNo: 1, kind: "add", text: "x" } },
			{
				kind: "pair",
				left: { lineNo: 1, kind: "context", text: "b" },
				right: { lineNo: 2, kind: "context", text: "b" },
			},
			{
				kind: "pair",
				left: { lineNo: 2, kind: "context", text: "c" },
				right: { lineNo: 3, kind: "context", text: "c" },
			},
		] satisfies SplitRow[]);
	});

	it("hunk 头与拆不出来的原文跨两栏，且偏移只在本 hunk 内成立", () => {
		const diff = ["@@ -1,2 +1,2 @@", "-1|a", " 2|b", "@@ -9,2 +9,2 @@", " 9|y", "+9|z"].join("\n");
		expect(split(diff)).toEqual([
			{ kind: "marker", text: "@@ -1,2 +1,2 @@" },
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: null },
			{
				kind: "pair",
				left: { lineNo: 2, kind: "context", text: "b" },
				right: { lineNo: 1, kind: "context", text: "b" },
			},
			{ kind: "marker", text: "@@ -9,2 +9,2 @@" },
			// 第二个 hunk：偏移从 0 起算，头一行上下文两侧同为 9
			{
				kind: "pair",
				left: { lineNo: 9, kind: "context", text: "y" },
				right: { lineNo: 9, kind: "context", text: "y" },
			},
			{ kind: "pair", left: null, right: { lineNo: 9, kind: "add", text: "z" } },
		] satisfies SplitRow[]);
	});

	it("hunk 中间的原文行跨两栏，且不改变已累计的偏移", () => {
		const diff = ["-1|a", "\\ No newline at end of file", " 2|b"].join("\n");
		expect(split(diff)).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: null },
			{ kind: "marker", text: "\\ No newline at end of file" },
			{
				kind: "pair",
				left: { lineNo: 2, kind: "context", text: "b" },
				right: { lineNo: 1, kind: "context", text: "b" },
			},
		] satisfies SplitRow[]);
	});

	it("没有 hunk 头的 diff：偏移从头累计", () => {
		expect(split("-1|a\n-2|b\n 3|c")).toEqual([
			{ kind: "pair", left: { lineNo: 1, kind: "del", text: "a" }, right: null },
			{ kind: "pair", left: { lineNo: 2, kind: "del", text: "b" }, right: null },
			{
				kind: "pair",
				left: { lineNo: 3, kind: "context", text: "c" },
				right: { lineNo: 1, kind: "context", text: "c" },
			},
		] satisfies SplitRow[]);
	});

	it("内容原样透传：`|`、空行、中文、制表符", () => {
		const diff = ["-1|const a = b | c;", "+1|", "+2|\t中文值"].join("\n");
		expect(split(diff)).toEqual([
			{
				kind: "pair",
				left: { lineNo: 1, kind: "del", text: "const a = b | c;" },
				right: { lineNo: 1, kind: "add", text: "" },
			},
			{ kind: "pair", left: null, right: { lineNo: 2, kind: "add", text: "\t中文值" } },
		] satisfies SplitRow[]);
	});

	it("一行都不丢：每个输入行在并列视图里都还看得见", () => {
		const diff = ["@@ -1,4 +1,4 @@", " 1|same", "-2|old1", "-3|old2", "+2|new1", " 4|tail", "junk line"].join("\n");
		const rows = parseNumberedDiff(diff);
		const splitRows = pairForSplit(rows);
		const cells = splitRows.reduce(
			(total, row) => total + (row.kind === "pair" ? Number(row.left !== null) + Number(row.right !== null) : 0),
			0,
		);
		const markers = splitRows.filter(row => row.kind === "marker").length;
		const parseable = rows.filter(row => row.kind !== "hunk").length;
		const contextRows = rows.filter(row => row.kind === "context").length;
		// 拆不出来的原文（hunk 行）跨两栏：一行对一行
		expect(markers).toBe(rows.length - parseable);
		// 改动行占一格，上下文行两侧各一格 —— 没有行被吞掉
		expect(cells).toBe(parseable + contextRows);
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
