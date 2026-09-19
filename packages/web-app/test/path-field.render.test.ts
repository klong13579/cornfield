import { afterEach, describe, expect, it } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathField, type PathFieldProps } from "../src/components/PathField";
import type { PickDirectoryResult } from "../src/lib/path-picker";

/**
 * `PathField` —— 「一个路径字符串」的唯一一种控件（Project root 与设置页工作目录共用）。
 *
 * 三种「没有」必须分开，它们的后果完全不同：
 *   - **没有壳**：不画浏览按钮（画一个点了没反应的按钮比没有它更坏）；
 *   - **没有候选**：不挂 datalist（空的候选框只会碍事），但输入框照常可用；
 *   - **选不出来**（取消 / 壳回了空路径 / 调用抛错）：取消是「什么都没发生」，
 *     另外两种必须说出来 —— 静默丢弃会让人以为按钮坏了。
 *
 * 组件无 hook，可以直接调用拿到元素树：结构用 `renderToStaticMarkup` 断言，
 * 行为直接触元素树上的处理器（SSR 拿不到 DOM，但那些 props 就是真的处理器）。
 */

type WindowShim = { window?: unknown };

/** `window` 每次用例自己装、自己拆（仓库纪律：不留文件级的长命全局改动）。 */
function installShell(
	pickDirectory: (defaultPath?: string) => Promise<PickDirectoryResult> | PickDirectoryResult,
): void {
	(globalThis as WindowShim).window = { api: { dialog: { pickDirectory } } };
}

afterEach(() => {
	delete (globalThis as WindowShim).window;
});

// ── 元素树小工具（与 app-shell-nav.test.ts 同一套约定）─────────────────

function collect(root: ReactNode, out: ReactElement[] = []): ReactElement[] {
	if (Array.isArray(root)) {
		for (const child of root) collect(child, out);
		return out;
	}
	if (!isValidElement(root)) return out;
	out.push(root);
	collect((root.props as { children?: ReactNode }).children, out);
	return out;
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
	return "";
}

function allOf(root: ReactNode, type: string): ReactElement[] {
	return collect(root).filter(el => el.type === type);
}

function optionValues(root: ReactNode): string[] {
	const list = allOf(root, "datalist")[0];
	if (!list) return [];
	return allOf(propsOf(list).children as ReactNode, "option").map(el => String(propsOf(el).value));
}

function propsOf(el: ReactElement): Record<string, unknown> {
	return el.props as Record<string, unknown>;
}

const BROWSE_LABEL = "浏览…";

function browseButton(root: ReactNode): ReactElement | undefined {
	return allOf(root, "button").find(el => textOf(propsOf(el).children as ReactNode) === BROWSE_LABEL);
}

/** 一份默认 props —— `PathField` 可以直接调用（拿元素树），`createElement` 需要 props 对象。 */
function fieldOfProps(over: Partial<PathFieldProps> = {}): PathFieldProps {
	return {
		id: "root",
		value: "",
		onChange: () => {},
		ariaLabel: "项目根路径",
		onPickError: () => {},
		...over,
	};
}

function fieldOf(over: Partial<PathFieldProps> = {}): ReactElement {
	return PathField(fieldOfProps(over));
}

// ── 结构 ────────────────────────────────────────────────────────────

describe("PathField 结构", () => {
	it("没有壳：不画浏览按钮，输入框本身照常可用", () => {
		const tree = fieldOf({ placeholder: "/绝对/项目/根路径" });
		expect(browseButton(tree)).toBeUndefined();

		const input = allOf(tree, "input")[0];
		expect(input).toBeDefined();
		expect(propsOf(input as ReactElement).id).toBe("root");
		expect(propsOf(input as ReactElement)["aria-label"]).toBe("项目根路径");
		expect(propsOf(input as ReactElement).placeholder).toBe("/绝对/项目/根路径");
	});

	it("有壳：画浏览按钮（文字是「浏览…」）", () => {
		installShell(() => ({ canceled: true }));
		expect(browseButton(fieldOf())).toBeDefined();
	});

	it("没有候选：不挂 datalist，输入框上也没有 list", () => {
		const html = renderToStaticMarkup(createElement(PathField, fieldOfProps()));
		expect(html).not.toContain("<datalist");
		expect(html).not.toContain("list=");
	});

	it("有候选：datalist 的 id 由输入框 id 派生，输入框指过去，选项顺序即候选顺序", () => {
		const html = renderToStaticMarkup(createElement(PathField, fieldOfProps({ suggestions: ["/a", "/b"] })));
		expect(html).toContain('id="root-suggestions"');
		expect(html).toContain('list="root-suggestions"');
		expect(html.indexOf('value="/a"')).toBeGreaterThan(-1);
		expect(html.indexOf('value="/a"')).toBeLessThan(html.indexOf('value="/b"'));
	});

	it("候选原样按给定顺序画（去重与排序是产出这份清单的那一方的责任，不在渲染层做）", () => {
		const tree = fieldOf({ suggestions: ["/b", "/a"] });
		expect(optionValues(tree)).toEqual(["/b", "/a"]);
	});

	it("trailing 与输入、浏览钮**同排**（排在浏览钮之后）—— 调用方的落盘动作就放在那里", () => {
		installShell(() => ({ canceled: true }));
		const html = renderToStaticMarkup(
			createElement(PathField, fieldOfProps({ trailing: createElement("button", { type: "button" }, "保存") })),
		);
		const browse = html.indexOf(BROWSE_LABEL);
		const save = html.indexOf("保存");
		expect(browse).toBeGreaterThan(-1);
		expect(save).toBeGreaterThan(browse);
		// 同一行：两者之间没有把行容器关掉（隔了行就不叫「选完就能看见」）
		expect(html.slice(browse, save)).not.toContain("</div>");
	});
});

// ── 行为 ────────────────────────────────────────────────────────────

function fireInput(tree: ReactNode, handler: string, payload: unknown): void {
	const input = allOf(tree, "input")[0];
	if (!input) throw new Error("元素树里没有 <input>");
	const fn = propsOf(input)[handler];
	if (typeof fn !== "function") throw new Error(`<input> 上没有 ${handler}`);
	(fn as (arg: unknown) => void)(payload);
}

/** 点浏览钮并等它跑完（组件里是 `void browse()`，所以只能靠事件循环推进）。 */
async function clickBrowse(tree: ReactNode): Promise<void> {
	const button = browseButton(tree);
	if (!button) throw new Error("元素树里没有浏览按钮");
	(propsOf(button).onClick as () => void)();
	await Bun.sleep(0);
}

describe("PathField 行为", () => {
	it("改输入把原文交出去（这个组件不做任何路径校验）", () => {
		const seen: string[] = [];
		fireInput(fieldOf({ onChange: v => seen.push(v) }), "onChange", { target: { value: "  /Users/me  " } });
		expect(seen).toEqual(["  /Users/me  "]);
	});

	it("回车交出去一次；没给 onEnter 时回车不抛", () => {
		let hits = 0;
		fireInput(fieldOf({ onEnter: () => (hits += 1) }), "onKeyDown", { key: "Enter" });
		expect(hits).toBe(1);

		// 别的键不触发
		fireInput(fieldOf({ onEnter: () => (hits += 1) }), "onKeyDown", { key: "a" });
		expect(hits).toBe(1);

		const bare = fieldOf();
		expect(() => fireInput(bare, "onKeyDown", { key: "Enter" })).not.toThrow();
	});

	it("选成功：把当前输入（trim 过）当起点，选中的路径写回", async () => {
		const starts: Array<string | undefined> = [];
		installShell(defaultPath => {
			starts.push(defaultPath);
			return { canceled: false, path: "/Users/me/dtc" };
		});
		const picked: string[] = [];
		await clickBrowse(fieldOf({ value: "  /Users/me  ", onChange: v => picked.push(v) }));

		expect(starts).toEqual(["/Users/me"]);
		expect(picked).toEqual(["/Users/me/dtc"]);
	});

	it("用户取消：什么都不发生（不写值、不报错）", async () => {
		installShell(() => ({ canceled: true }));
		const picked: string[] = [];
		const errors: string[] = [];
		await clickBrowse(fieldOf({ value: "/old", onChange: v => picked.push(v), onPickError: m => errors.push(m) }));

		expect(picked).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("壳回了「没取消但也没路径」：不当成一次成功的选择，说清是什么", async () => {
		installShell(() => ({ canceled: false, path: "" }));
		const picked: string[] = [];
		const errors: string[] = [];
		await clickBrowse(fieldOf({ value: "/old", onChange: v => picked.push(v), onPickError: m => errors.push(m) }));

		expect(picked).toEqual([]);
		expect(errors).toEqual(["桌面壳没有返回路径"]);
	});

	it("选择器抛错：原文交回调用方显示（不吞、不改写）", async () => {
		installShell(() => {
			throw new Error("Error invoking remote method 'dialog:pick-directory': no handler registered");
		});
		const errors: string[] = [];
		await clickBrowse(fieldOf({ onPickError: m => errors.push(m) }));

		expect(errors).toEqual(["Error invoking remote method 'dialog:pick-directory': no handler registered"]);
	});
});
