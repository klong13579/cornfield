import { describe, expect, test } from "bun:test";

const css = (await Bun.file(new URL("../src/index.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 从 index.css 中取出「选择器列表里包含 sel」的那条规则的声明块。
 * 目标规则都是无嵌套花括号的扁平声明，`[^}]*` 足够安全。
 */
function blockForSelector(sel: string): string {
	for (const [, sels, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		if (
			sels
				.split(",")
				.map(s => s.trim())
				.includes(sel)
		)
			return body ?? "";
	}
	return "";
}

function prop(body: string, name: string): string | undefined {
	const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
	return m?.[1]?.trim();
}

function numericProp(body: string, name: string): number | null {
	const value = prop(body, name);
	return value === undefined ? null : Number(value);
}

describe("全站禁用态可辨（source 级不变量：index.css）", () => {
	test(".cbtn 一族有 :disabled 规则且光标为非指针", () => {
		const body = blockForSelector(".cbtn:disabled");
		expect(body).not.toBe("");
		expect(prop(body, "cursor")).toBe("not-allowed");
	});

	test(".cbtn:disabled 与可用态有可见差异：降透明度 + 淡化文字 + 不缩放", () => {
		const body = blockForSelector(".cbtn:disabled");
		const opacity = numericProp(body, "opacity");
		expect(opacity).not.toBeNull();
		expect(opacity!, "opacity 须位于 (0,1) 之间").toBeGreaterThan(0);
		expect(opacity!, "opacity 须位于 (0,1) 之间").toBeLessThan(1);
		expect(prop(body, "color")).toBe("var(--color-ink-faint)");
		expect(prop(body, "transform")).toBe("none");
	});

	test(".cbtn 悬停/按下对禁用态不生效（:not(:disabled) 守卫）", () => {
		expect(blockForSelector(".cbtn:not(:disabled):hover")).not.toBe("");
		expect(blockForSelector(".cbtn:not(:disabled):active")).not.toBe("");
		// 守卫规则里不得残留裸 .cbtn:hover/.cbtn:active（否则禁用悬停仍会高亮）
		expect(blockForSelector(".cbtn:hover")).toBe("");
		expect(blockForSelector(".cbtn:active")).toBe("");
	});

	test("原生输入控件（input/textarea/select）禁用态可辨", () => {
		for (const el of ["input", "textarea", "select"] as const) {
			const body = blockForSelector(`${el}:disabled`);
			expect(body, `${el}:disabled 规则缺失`).not.toBe("");
			expect(prop(body, "cursor"), `${el}:disabled 光标`).toBe("not-allowed");
			const opacity = numericProp(body, "opacity");
			expect(opacity, `${el}:disabled opacity`).not.toBeNull();
			expect(opacity!, `${el}:disabled opacity 须位于 (0,1)`).toBeGreaterThan(0);
			expect(opacity!, `${el}:disabled opacity 须位于 (0,1)`).toBeLessThan(1);
		}
	});

	test("已正确实现的禁用态不回退：.btn/.icon-btn/chip select 仍具禁用规则", () => {
		expect(blockForSelector(".btn:disabled")).not.toBe("");
		expect(blockForSelector(".icon-btn:disabled")).not.toBe("");
		expect(blockForSelector(".chip > select:disabled")).not.toBe("");
	});
});
