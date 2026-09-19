import { describe, expect, it } from "bun:test";
import type { ImageContentDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentThumb, attachmentBytes, attachmentDataUrl } from "./ComposerBar";

/**
 * 输入区附件缩略图（粘贴/选图后、发出前的那一眼）。
 *
 * 这一屏要证的只有一件事：**贴进来的是哪张图、能不能撤掉**。此前的界面只有一个数字角标，
 * 用户既认不出内容、也没法只删掉贴错的那一张——所以要盯的断言是「屏幕上出现了一张真图 +
 * 一个指得名的移除入口」，而不是「计数对不对」。
 *
 * 环境约束与其他 web-app 渲染用例一致：全仓走 `react-dom/server` 静态渲染、无 DOM，
 * 因此组件必须是纯展示的（props 进、标记出），交互逻辑提到纯函数里单独可断言。
 */

function image(data: string, mimeType = "image/png"): ImageContentDto {
	return { type: "image", data, mimeType };
}

describe("attachmentDataUrl", () => {
	it("按 mimeType 拼 data URL（attachments 里存的是裸 base64，不再读一次来源）", () => {
		expect(attachmentDataUrl(image("AAAA", "image/jpeg"))).toBe("data:image/jpeg;base64,AAAA");
	});
});

describe("attachmentBytes —— base64 的精确字节数", () => {
	// 边界逐个覆盖：0 / 1 / 2 / 3（一个 base64 组的三种 padding 形态）/ 4 / 5 / 6。
	// 期望值不写死，交给平台的解码器算——写死就只是在重复我自己的公式。
	const CASES = ["", "AA==", "AAA=", "AAAA", "AAAAAA==", "AAAAAAA=", "AAAAAAAA"];

	it.each(CASES)("与 Buffer 解码结果一致：%p", data => {
		expect(attachmentBytes(image(data))).toBe(Buffer.from(data, "base64").byteLength);
	});

	it("空 data → 0（不是 NaN / 不是 -1）", () => {
		expect(attachmentBytes(image(""))).toBe(0);
	});
});

describe("AttachmentThumb", () => {
	const render = (data: string, index: number, mimeType = "image/png"): string =>
		renderToStaticMarkup(
			createElement(AttachmentThumb, { image: image(data, mimeType), index, onRemove: () => undefined }),
		);

	it("渲染真图（src 是内联 data URL，alt 说清是第几张）", () => {
		const html = render("iVBORw0KGgo=", 0);
		expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
		expect(html).toContain('alt="附件 1（image/png）"');
	});

	it("序号从 1 起展示（index 是 0 起的位置，屏幕上不能从 0 报）", () => {
		expect(render("AAAA", 1)).toContain("附件 2");
	});

	it("移除入口指得名是哪一张", () => {
		const html = render("AAAA", 0);
		expect(html).toContain('title="移除附件 1"');
		expect(html).toContain("×");
	});

	it("title 上给全格式与字节数", () => {
		const eightBytes = Buffer.from("12345678").toString("base64");
		const html = render(eightBytes, 0, "image/gif");
		expect(html).toContain("附件 1 · image/gif · 8");
	});
});
