import { describe, expect, it } from "bun:test";
import {
	type ContextItem,
	composePrompt,
	contextItemFacts,
	dedupeContextItems,
	formatContextItems,
	hasFileVersion,
	makeFileContextItem,
	makeSelectionContextItem,
	pathContains,
	selectionLineRange,
	workspaceAbsolutePath,
} from "../src/lib/context-items";

/**
 * T9：composer 上下文条目的纯逻辑；T22 补 scope / version 两件随附事实。
 *
 * 这一层唯一的出口是「发给 agent 运行时的 prompt 文本」：`@<path>` 提及由运行时
 * file-mentions 通道读取并注入文件内容（本层不读文件、不注入）。所以测试盯四件事：
 *   1. 文本格式逐字正确（多一个空格、少一个空行都是协议变化）；
 *   2. 选区文本逐字保留（转义/裁剪会篡改用户选中的内容）；
 *   3. 身份（id / 去重）稳定，否则 React key 会错位、同一条目会加两次；
 *   4. 事实不许编：范围/版本拿不到就写「未知」，绝不写空值。
 */

const FENCE = "```";

/** 没带事实的条目在文本里长什么样（两种事实都是「不知道」）。 */
const UNKNOWN_FACTS = "[范围 未知 · 版本 未知]";

function artifactItem(path: string): ContextItem {
	return { id: `artifact:${path}`, kind: "artifact", path };
}

function urlItem(url: string): ContextItem {
	return { id: `url:${url}`, kind: "url", path: url };
}

describe("formatContextItems", () => {
	it("没有条目就是空串（不是空行）", () => {
		expect(formatContextItems([])).toBe("");
	});

	it("file 条目：@ 提及 + 一行事实（不知道就说不知道）", () => {
		expect(formatContextItems([makeFileContextItem("src/a.ts")])).toBe(`@src/a.ts\n${UNKNOWN_FACTS}`);
	});

	it("artifact 按路径走同一条提及通道", () => {
		expect(formatContextItems([artifactItem("artifacts/run-1.md")])).toBe(`@artifacts/run-1.md\n${UNKNOWN_FACTS}`);
	});

	it("url 独占一行，不发提及；版本对它不适用，不写「未知」", () => {
		expect(formatContextItems([urlItem("https://example.com/doc")])).toBe("https://example.com/doc\n[范围 未知]");
		expect(formatContextItems([{ ...urlItem("https://example.com/doc"), scope: "global" }])).toBe(
			"https://example.com/doc\n[范围 global]",
		);
	});

	it("selection = 提及 + 选区行 + 事实行 + 原样围栏", () => {
		const item = makeSelectionContextItem({
			path: "src/a.ts",
			text: "const x = 1;",
			lineStart: 3,
			lineEnd: 3,
		});
		expect(formatContextItems([item])).toBe(
			`@src/a.ts\n[选区 src/a.ts:3-3]\n${UNKNOWN_FACTS}\n${FENCE}\nconst x = 1;\n${FENCE}`,
		);
	});

	it("多条之间空一行，顺序不变", () => {
		const items = [makeFileContextItem("a.ts"), urlItem("https://example.com")];
		expect(formatContextItems(items)).toBe(`@a.ts\n${UNKNOWN_FACTS}\n\nhttps://example.com\n[范围 未知]`);
	});

	it("selection 缺 lineStart/lineEnd 时当场报错，而不是写出 undefined 行", () => {
		const broken: ContextItem = { id: "selection:x", kind: "selection", path: "x.ts", text: "a" };
		expect(() => formatContextItems([broken])).toThrow();
	});

	it("路径带空格照常发出（运行时的提及正则按空白切分，读不到是通道限制，但不能丢条目）", () => {
		expect(formatContextItems([makeFileContextItem("src/my file.ts")])).toBe(`@src/my file.ts\n${UNKNOWN_FACTS}`);
		const selection = makeSelectionContextItem({
			path: "src/my file.ts",
			text: "a = 1",
			lineStart: 1,
			lineEnd: 1,
		});
		// 选区行里带完整路径，模型仍能看出指的是哪个文件。
		expect(formatContextItems([selection])).toBe(
			`@src/my file.ts\n[选区 src/my file.ts:1-1]\n${UNKNOWN_FACTS}\n${FENCE}\na = 1\n${FENCE}`,
		);
	});
});

describe("事实行：来源 + 范围 + 版本", () => {
	it("有事实的条目：范围与版本都进 prompt（模型看得到引的是哪一份）", () => {
		const item = makeFileContextItem("src/a.ts", { scope: "agent", version: "3f9ac1b2" });
		expect(formatContextItems([item])).toBe("@src/a.ts\n[范围 agent · 版本 3f9ac1b2]");
	});

	it("版本不知道时写「未知」：不写空值、不写假版本号", () => {
		const text = formatContextItems([makeFileContextItem("src/a.ts", { scope: "agent" })]);
		expect(text).toBe("@src/a.ts\n[范围 agent · 版本 未知]");
		// 「版本」后面必须紧跟着一个词（未知或真版本），不能是空、不能是分隔符
		expect(text).toMatch(/版本 (?!·|\])[^·\]]+/);
	});

	it("范围判不出来时写「未知」：缺省不是 global", () => {
		const item = makeFileContextItem("src/a.ts", { version: "3f9ac1b2" });
		expect(formatContextItems([item])).toBe("@src/a.ts\n[范围 未知 · 版本 3f9ac1b2]");
	});

	it("事实不进身份：同一条引用带不同事实仍是同一个 id（否则重复添加会多出一条）", () => {
		const first = makeFileContextItem("src/a.ts", { scope: "agent", version: "v1" });
		const second = makeFileContextItem("src/a.ts", { scope: "agent", version: "v2" });
		expect(first.id).toBe(second.id);
		expect(dedupeContextItems([first, second])).toHaveLength(1);
	});

	it("hasFileVersion：链接没有「文件版本」这个事实", () => {
		expect(hasFileVersion("file")).toBe(true);
		expect(hasFileVersion("selection")).toBe(true);
		expect(hasFileVersion("artifact")).toBe(true);
		expect(hasFileVersion("url")).toBe(false);
	});
});

describe("contextItemFacts / workspaceAbsolutePath / pathContains", () => {
	const AGENT_DIR = "/work/agents/hr";

	it("路径落在 Agent 的工作区里 ⇒ agent（serve 的 fs 路径也是按 agentDir 解析的）", () => {
		expect(contextItemFacts({ kind: "file", path: "src/a.ts", agentDir: AGENT_DIR, version: "v1" })).toEqual({
			scope: "agent",
			version: "v1",
		});
	});

	it("Agent 的工作区落在 Project 里 ⇒ 仍然是 agent（更具体的那条先判，与技能页同一份规则）", () => {
		expect(
			contextItemFacts({
				kind: "selection",
				path: "src/a.ts",
				agentDir: "/work/project/agents/hr",
				projectRoot: "/work/project",
			}).scope,
		).toBe("agent");
	});

	it("拿不到 Agent 的工作区 ⇒ 判不了（缺省，不是 global、也不是别的猜的）", () => {
		expect(contextItemFacts({ kind: "file", path: "src/a.ts" })).toEqual({});
		expect(contextItemFacts({ kind: "file", path: "src/a.ts", agentDir: "" })).toEqual({});
	});

	it("URL 不跟工作区拼接（拼了就会把链接说成 Agent 家里的东西）", () => {
		expect(contextItemFacts({ kind: "url", path: "https://example.com/doc", agentDir: AGENT_DIR }).scope).toBe(
			"global",
		);
		// 没有锚点就说不出「没有锚点包含它」：仍然判不了
		expect(contextItemFacts({ kind: "url", path: "https://example.com/doc" }).scope).toBeUndefined();
		// 链接没有「文件版本」这个事实：即使调用方递了也不带
		expect(
			contextItemFacts({ kind: "url", path: "https://example.com/doc", agentDir: AGENT_DIR, version: "v1" }),
		).toEqual({ scope: "global" });
	});

	it("版本空串 = 还不知道（读取途中 baseVersion 就是空串，它不是版本）", () => {
		expect(contextItemFacts({ kind: "file", path: "src/a.ts", agentDir: AGENT_DIR, version: "" })).toEqual({
			scope: "agent",
		});
	});

	it("越界路径（绝对 / `..`）不判范围：那是 serve 会拒读的路径", () => {
		expect(workspaceAbsolutePath("/work/a", "/etc/passwd")).toBeNull();
		expect(workspaceAbsolutePath("/work/a", "../b.ts")).toBeNull();
		expect(workspaceAbsolutePath("/work/a", "")).toBeNull();
		expect(workspaceAbsolutePath("/work/a/", "src/a.ts")).toBe("/work/a/src/a.ts");
		expect(contextItemFacts({ kind: "file", path: "../b.ts", agentDir: "/work/a", version: "v1" })).toEqual({
			version: "v1",
		});
	});

	it("pathContains：根自身在内，兄弟目录不算（serve 侧 pathIsWithin 的同一口径，少了 symlink 归一）", () => {
		expect(pathContains("/work/a", "/work/a")).toBe(true);
		expect(pathContains("/work/a/", "/work/a/src/x.ts")).toBe(true);
		expect(pathContains("/work/a", "/work/a-next/x.ts")).toBe(false);
		expect(pathContains("/work/a", "/work/b/x.ts")).toBe(false);
	});
});

describe("composePrompt", () => {
	it("无条目时草稿逐字返回（空白草稿也不动）", () => {
		expect(composePrompt("", [])).toBe("");
		expect(composePrompt("  \n ", [])).toBe("  \n ");
	});

	it("有条目时草稿 + 空行 + 提示块", () => {
		expect(composePrompt("看下这个", [makeFileContextItem("src/a.ts")])).toBe(
			`看下这个\n\n@src/a.ts\n${UNKNOWN_FACTS}`,
		);
	});

	it("空草稿：只留提示块，开头无空行", () => {
		expect(composePrompt("", [makeFileContextItem("src/a.ts")])).toBe(`@src/a.ts\n${UNKNOWN_FACTS}`);
	});

	it("空白草稿：不留下悬空的前导空白", () => {
		expect(composePrompt("   \n\t\n ", [makeFileContextItem("src/a.ts")])).toBe(`@src/a.ts\n${UNKNOWN_FACTS}`);
	});
});

describe("选区文本逐字保留", () => {
	it("反引号 / @ / CRLF 都不转义不剥离", () => {
		const text = `line1\r\n${FENCE}\r\nsee @foo for details`;
		const item = makeSelectionContextItem({ path: "src/a.ts", text, lineStart: 1, lineEnd: 3 });
		const formatted = formatContextItems([item]);
		expect(formatted).toBe(`@src/a.ts\n[选区 src/a.ts:1-3]\n${UNKNOWN_FACTS}\n${FENCE}\n${text}\n${FENCE}`);
		// 围栏体整段原样出现（CRLF、内部围栏、@ 都没被改写）
		expect(formatted.includes(text)).toBe(true);
		expect(formatted).toContain("line1\r\n");
	});
});

describe("selectionLineRange", () => {
	it("单行选区", () => {
		expect(selectionLineRange("a\nb\nc", 0, 1)).toEqual({ lineStart: 1, lineEnd: 1 });
		expect(selectionLineRange("a\nb\nc", 2, 3)).toEqual({ lineStart: 2, lineEnd: 2 });
	});

	it("选区末尾正好落在行首 ⇒ 归上一行（选第一行连同换行是 1-1）", () => {
		expect(selectionLineRange("a\nb\n", 0, 2)).toEqual({ lineStart: 1, lineEnd: 1 });
	});

	it("选区末尾落在中段换行符上 ⇒ 仍算该行", () => {
		expect(selectionLineRange("a\nb", 0, 2)).toEqual({ lineStart: 1, lineEnd: 1 });
	});

	it("跨行：行中起、行中终", () => {
		// "l1\nl2\nl3" 里选 "2\nl3"
		expect(selectionLineRange("l1\nl2\nl3", 4, 7)).toEqual({ lineStart: 2, lineEnd: 3 });
	});

	it("跨行：选到第二行行尾（整行 1-2）", () => {
		expect(selectionLineRange("l1\nl2\nl3", 0, 5)).toEqual({ lineStart: 1, lineEnd: 2 });
	});

	it("整篇选中：末字符是最后一行的换行符（不是多出来的空行）", () => {
		expect(selectionLineRange("a\nb\n", 0, 4)).toEqual({ lineStart: 1, lineEnd: 2 });
		expect(selectionLineRange("a\nb\nc", 0, 5)).toEqual({ lineStart: 1, lineEnd: 3 });
	});

	it("空选区退化成光标所在行", () => {
		expect(selectionLineRange("a\nb", 3, 3)).toEqual({ lineStart: 2, lineEnd: 2 });
		expect(selectionLineRange("", 0, 0)).toEqual({ lineStart: 1, lineEnd: 1 });
	});

	it("越界偏移夹回文档", () => {
		expect(selectionLineRange("a\nb\nc", -5, 999)).toEqual({ lineStart: 1, lineEnd: 3 });
		expect(selectionLineRange("a\nb", 100, 200)).toEqual({ lineStart: 2, lineEnd: 2 });
	});

	it("倒置偏移按同一段选区算", () => {
		expect(selectionLineRange("a\nb\nc", 4, 1)).toEqual(selectionLineRange("a\nb\nc", 1, 4));
		expect(selectionLineRange("a\nb\nc", 4, 1)).toEqual({ lineStart: 1, lineEnd: 2 });
	});
});

describe("身份：id 与去重", () => {
	it("同一路径的 file id 稳定且相同", () => {
		expect(makeFileContextItem("src/a.ts").id).toBe(makeFileContextItem("src/a.ts").id);
	});

	it("不同 path / 不同 kind 的 id 不同", () => {
		expect(makeFileContextItem("src/a.ts").id).not.toBe(makeFileContextItem("src/b.ts").id);
		expect(makeFileContextItem("src/a.ts").id).not.toBe(artifactItem("src/a.ts").id);
		const selection = makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 1 });
		expect(selection.id).not.toBe(makeFileContextItem("src/a.ts").id);
	});

	it("同一选区重复构造 → 同 id", () => {
		const first = makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 });
		const second = makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 });
		expect(first.id).toBe(second.id);
	});

	it("同路径同范围但文本不同 → id 必须不同（否则 React key 撞车）", () => {
		const first = makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 });
		const second = makeSelectionContextItem({ path: "src/a.ts", text: "y", lineStart: 1, lineEnd: 2 });
		expect(first.id).not.toBe(second.id);
	});

	it("同一文件加两次 → 一条", () => {
		const items = [makeFileContextItem("src/a.ts"), makeFileContextItem("src/a.ts")];
		expect(dedupeContextItems(items)).toHaveLength(1);
	});

	it("同一路径的两个不同选区 → 两条", () => {
		const items = [
			makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 }),
			makeSelectionContextItem({ path: "src/a.ts", text: "y", lineStart: 5, lineEnd: 9 }),
		];
		expect(dedupeContextItems(items)).toHaveLength(2);
	});

	it("同一选区加两次 → 一条", () => {
		const items = [
			makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 }),
			makeSelectionContextItem({ path: "src/a.ts", text: "x", lineStart: 1, lineEnd: 2 }),
		];
		expect(dedupeContextItems(items)).toHaveLength(1);
	});

	it("保留首次出现的顺序", () => {
		const file = makeFileContextItem("a.ts");
		const url = urlItem("https://example.com");
		expect(dedupeContextItems([file, url, makeFileContextItem("a.ts")])).toEqual([file, url]);
	});

	it("去重按身份重算，不采信手工构造的 id", () => {
		const handWritten: ContextItem = { id: "随便写的", kind: "file", path: "a.ts" };
		const items = [makeFileContextItem("a.ts"), handWritten];
		expect(dedupeContextItems(items)).toEqual([makeFileContextItem("a.ts")]);
	});

	it("空列表去重仍是空列表", () => {
		expect(dedupeContextItems([])).toEqual([]);
	});
});
