import { describe, expect, test } from "bun:test";
import type { AgentPromptSourceDto } from "@cornfield/wire";
import { renderToStaticMarkup } from "react-dom/server";
import { currentPromptsLoad, PromptSourcesView, type PromptsLoad } from "./AgentDetailView";

/**
 * Prompts tab 的展示层（F5）。
 *
 * 五种画面长得很像，混掉一个就是一个假结论，所以逐个钉：
 *   未连接 / 加载中 / 清单读失败 —— 都是「没问到」，一个都不许渲染成「一份空清单」
 *   不存在                       —— 清单里 `exists:false` 的事实（缺的项留在清单里）
 *   读失败                       —— 清单说存在、fs_read 报错：原文照显，**不写成「不存在」**
 *
 * 静态渲染不跑 effect，这些状态本来就在渲染时判定 —— 这正是把它做成纯 props 组件的原因。
 */

const SOURCES: AgentPromptSourceDto[] = [
	{ path: "AGENTS.md", title: "硬约束与文件地图", description: "启动时无条件读取。", exists: true },
	{ path: "user.md", title: "项目级人设", description: "本项目覆盖层。", exists: false },
];

function render(sources: Parameters<typeof PromptSourcesView>[0]["sources"], read: PromptsLoad["read"] = null): string {
	return renderToStaticMarkup(PromptSourcesView({ sources, read, onOpen: () => undefined }));
}

describe("PromptSourcesView", () => {
	test("未连接：说「未连接」，不是一份空清单", () => {
		const html = render({ status: "disconnected" });
		expect(html).toContain("未连接——读不到 prompt 源清单");
		expect(html).not.toContain("data-prompt-path");
	});

	test("加载中：说「加载中」，也不当空清单", () => {
		const html = render({ status: "loading" });
		expect(html).toContain("加载中");
		expect(html).not.toContain("data-prompt-path");
	});

	test("清单读失败：带服务端原文，不当空清单", () => {
		const html = render({ status: "error", error: "unknown agent: no-such" });
		expect(html).toContain("unknown agent: no-such");
		expect(html).not.toContain("data-prompt-path");
	});

	test("ready：逐项渲染 path + title + description，不存在的项单独标出来", () => {
		const html = render({ status: "ready", sources: SOURCES });
		// 三项事实都在屏幕上（path 是身份，title 是展示名，description 说它运行时真起什么作用）
		expect(html).toContain("AGENTS.md");
		expect(html).toContain("硬约束与文件地图");
		expect(html).toContain("启动时无条件读取。");
		expect(html).toContain("user.md");
		expect(html).toContain("项目级人设");
		// 缺的那项也在清单里，并且看得出来
		expect(html).toContain("不存在");
		expect(html.match(/data-prompt-path=/g)?.length).toBe(SOURCES.length);
	});

	test("还没点任何一项：「未读」不是「没有正文」", () => {
		const html = render({ status: "ready", sources: SOURCES }, null);
		expect(html).toContain("点击左侧浏览 agent 的各份 prompt 配置");
		expect(html).not.toContain("该文件不存在");
		expect(html).not.toContain("读取失败");
	});

	test("点开的项不存在：说「该文件不存在」，不说「读取失败」", () => {
		const html = render({ status: "ready", sources: SOURCES }, { path: "user.md", kind: "missing" });
		expect(html).toContain("该文件不存在");
		expect(html).not.toContain("读取失败");
	});

	test("点开的项读失败：带错误原文，不写成「不存在」", () => {
		const html = render(
			{ status: "ready", sources: SOURCES },
			{ path: "AGENTS.md", kind: "error", error: "EACCES: permission denied" },
		);
		expect(html).toContain("读取失败");
		expect(html).toContain("EACCES: permission denied");
		expect(html).not.toContain("该文件不存在");
	});

	test("读到正文：渲染文本，截断的标记也说出来", () => {
		const html = render(
			{ status: "ready", sources: SOURCES },
			{ path: "AGENTS.md", kind: "text", text: "# 硬约束\nMUST NOT 改仓库外文件", truncated: true },
		);
		expect(html).toContain("MUST NOT 改仓库外文件");
		expect(html).toContain("128KB");
	});
});

describe("currentPromptsLoad", () => {
	const loaded: PromptsLoad = {
		agentId: "hr",
		sources: { status: "ready", sources: SOURCES },
		read: { path: "user.md", kind: "missing" },
	};

	test("同 agent：原样返回（不把已读到的清单打回加载中）", () => {
		expect(currentPromptsLoad(loaded, "hr")).toBe(loaded);
	});

	test("换了 agent：上一个 agent 的清单与正文都不算数（回到加载中）", () => {
		const next = currentPromptsLoad(loaded, "coding");
		expect(next.agentId).toBe("coding");
		expect(next.sources).toEqual({ status: "loading" });
		expect(next.read).toBeNull();
	});
});
