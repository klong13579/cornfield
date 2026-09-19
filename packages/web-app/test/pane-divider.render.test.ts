import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaneDivider } from "../src/layout/PaneDivider";
import type { DividerTarget } from "../src/lib/pane-resize";

/**
 * 分隔条的对外契约：它能被键盘碰到、能被读屏念出来。
 *
 * 只钉结构（role / aria / tabindex / 轴向类名）—— 拖拽的计算在 `pane-resize.test.ts`、
 * 指针接线在 Playwright（SSR 里没有指针事件，`renderToStaticMarkup` 也拿不到处理器）。
 * 这几项一旦丢了不会报错，只会让键盘用户完全用不了，所以值得单独钉住。
 */

function target(overrides: Partial<DividerTarget> = {}): DividerTarget {
	return {
		label: "调整会话栏宽度",
		currentPx: () => 300,
		boundsPx: () => ({ minPx: 220, maxPx: 520 }),
		preview: () => undefined,
		commit: () => undefined,
		reset: () => undefined,
		a11y: () => ({ now: 300, min: 220, max: 520, text: "300 像素" }),
		...overrides,
	};
}

function render(props: Parameters<typeof PaneDivider>[0]): string {
	return renderToStaticMarkup(createElement(PaneDivider, props));
}

describe("左右分栏的分隔条（竖向）", () => {
	const html = render({ axis: "vertical", edge: "before", target: target() });

	it("是一个可聚焦的 window splitter（可调整大小的 separator）", () => {
		expect(html).toContain('role="separator"');
		expect(html).toContain('aria-orientation="vertical"');
		expect(html).toContain('tabindex="0"');
	});

	it("数值按目标量自己的单位说（这里是像素）", () => {
		expect(html).toContain('aria-valuenow="300"');
		expect(html).toContain('aria-valuemin="220"');
		expect(html).toContain('aria-valuemax="520"');
		expect(html).toContain('aria-valuetext="300 像素"');
		expect(html).toContain('aria-label="调整会话栏宽度"');
	});

	it("数值取整（读屏不该念出小数）", () => {
		const rounded = render({
			axis: "vertical",
			edge: "before",
			target: target({ a11y: () => ({ now: 300.4, min: 220.6, max: 519.5, text: "300 像素" }) }),
		});
		expect(rounded).toContain('aria-valuenow="300"');
		expect(rounded).toContain('aria-valuemin="221"');
		expect(rounded).toContain('aria-valuemax="520"');
	});

	it("拖拽态只由 data-dragging 表达，静止时不出现", () => {
		expect(html).not.toContain("data-dragging");
	});
});

describe("右栏内部上下分栏的分隔条（横向）", () => {
	const html = render({
		axis: "horizontal",
		edge: "after",
		target: target({
			label: "调整文件预览高度",
			a11y: () => ({ now: 40, min: 20, max: 80, text: "40%" }),
		}),
	});

	it("轴向、光标与数值口径都换成横向/比例", () => {
		expect(html).toContain('aria-orientation="horizontal"');
		expect(html).toContain("pane-divider--row");
		expect(html).toContain('aria-valuetext="40%"');
		expect(html).not.toContain('aria-orientation="vertical"');
	});
});

describe("断点可见性", () => {
	it("附加类名接在原类名之后（移动端的分栏是抽屉，分隔条跟着藏）", () => {
		const html = render({ axis: "vertical", edge: "before", target: target(), className: "hidden lg:block" });
		expect(html).toContain('class="pane-divider hidden lg:block"');
	});

	it("不给附加类名时不留多余空格", () => {
		const html = render({ axis: "vertical", edge: "before", target: target() });
		expect(html).toContain('class="pane-divider"');
	});
});
