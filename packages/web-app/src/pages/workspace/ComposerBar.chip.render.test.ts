import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextItem } from "../../lib/context-items";
import { ContextItemChip } from "./ComposerBar";

/**
 * 上下文条目 chip（§9：每个引用要看得到 scope 与版本）。
 *
 * 这一屏最容易犯的错是「说错」而不是「画错」：把「不知道版本」渲染成一个空标签，
 * 用户就会以为这条引用带的是一个空版本；把范围画成猜的一个值，用户就会拿它当事实。
 * 所以断言全部盯着「屏幕上到底写了哪一句」。
 */

const VERSION = "3f9ac1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90123456789abcdef0123456";

function render(item: ContextItem): string {
	return renderToStaticMarkup(createElement(ContextItemChip, { item, onRemove: () => undefined }));
}

describe("ContextItemChip", () => {
	it("路径 + 范围 + 版本都看得见；版本截短显示，完整值在 title 上", () => {
		const html = render({ id: "f", kind: "file", path: "src/a.ts", scope: "agent", version: VERSION });
		expect(html).toContain("src/a.ts");
		expect(html).toContain("Agent");
		expect(html).toContain("版本 3f9ac1b2…");
		expect(html).toContain(`title="版本 ${VERSION}"`);
	});

	it("选区条目仍带行范围（chip 的定位没有变）", () => {
		const html = render({
			id: "s",
			kind: "selection",
			path: "src/a.ts",
			text: "x",
			lineStart: 3,
			lineEnd: 5,
			scope: "project",
			version: VERSION,
		});
		expect(html).toContain("src/a.ts:3-5");
		expect(html).toContain("Project");
	});

	it("版本不知道 → 写「版本未知」，绝不写空标签", () => {
		const html = render({ id: "f", kind: "file", path: "src/a.ts", scope: "agent" });
		expect(html).toContain("版本未知");
		// 「版本」后面必须跟着别的字，不能直接结束或紧跟标签
		expect(html).not.toMatch(/版本(<|\s*<\/)/);
	});

	it("范围判不出来 → 写「范围未知」，不拿一个猜的范围顶替", () => {
		const html = render({ id: "f", kind: "file", path: "src/a.ts", version: VERSION });
		expect(html).toContain("范围未知");
		expect(html).not.toContain(">Agent<");
	});

	it("URL 条目不说版本：链接没有「文件版本」这个事实（不适用 ≠ 未知）", () => {
		const html = render({ id: "u", kind: "url", path: "https://example.com/doc", scope: "global" });
		expect(html).toContain("https://example.com/doc");
		expect(html).toContain("全局");
		expect(html).not.toContain("版本");
	});
});
