import { describe, expect, test } from "bun:test";
import type { ModelInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type AvailableModelsState, ModelPickerView } from "./ModelPicker";

/**
 * 模型配置 tab 的两个下拉：Provider 的选中值必须能在它自己的选项里找到，Model 下拉**任何一帧**
 * 都不能是 0 个 option。
 *
 * 这两个断言不是形式主义：受控 select 的 value 对不上任何 option 时，浏览器把 selectedIndex 置 -1 ——
 * 屏幕上就是「一个都没选中」（Provider 写死 "anthropic" 的那版），而 Model 那版干脆一个 option 都没有
 * （被那个写死的 provider 筛空），既选不了也看不到当前模型。静态渲染里 `selected` 落在哪一项上就是
 * 浏览器看到的 selectedIndex，所以这两件事在这一层能整份钉死。
 *
 * 静态渲染不跑 effect，四种读取态（未连接 / 加载中 / 读取失败 / 没有模型）也都在渲染时判定 ——
 * 这正是把展示层做成纯 props 组件的原因。
 */

function model(provider: string, id: string): ModelInfoDto {
	return { id, provider, supportsThinking: false };
}

const CATALOG = [
	model("alibaba-coding-plan", "qwen3-max"),
	model("alibaba-coding-plan", "qwen3-plus"),
	model("kimi-code", "kimi-latest"),
];

interface SelectOption {
	value: string;
	label: string;
	disabled: boolean;
	selected: boolean;
}

interface SelectRead {
	/** 选中项的值（没有选中项 = ""，与浏览器 select.value 同义）。 */
	value: string;
	/** 选中项下标；-1 = value 不在选项里（受控 select 被破坏的样子）。 */
	selectedIndex: number;
	options: SelectOption[];
}

/** 从静态渲染的 HTML 里读一个 <select>：SSR 把 value 标成选项上的 selected，与浏览器一致。 */
function readSelect(html: string, testId: string): SelectRead {
	const holder = new RegExp(`<select[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
	if (!holder) throw new Error(`静态渲染里没有 data-testid="${testId}" 的 <select>`);
	const options = [...holder[1]!.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)].map(m => {
		const attrs = m[1]!;
		return {
			value: /value="([^"]*)"/.exec(attrs)?.[1] ?? "",
			label: m[2]!,
			disabled: /\sdisabled(=|\s|$)/.test(attrs),
			selected: /\sselected(=|\s|$)/.test(attrs),
		};
	});
	const selectedIndex = options.findIndex(o => o.selected);
	return { value: selectedIndex < 0 ? "" : options[selectedIndex]!.value, selectedIndex, options };
}

function render(over: Partial<Parameters<typeof ModelPickerView>[0]> = {}): string {
	return renderToStaticMarkup(
		createElement(ModelPickerView, {
			state: { status: "ready", models: CATALOG },
			currentModel: "qwen3-max",
			providerPick: null,
			onPickProvider: () => {},
			onPickModel: () => {},
			onRetry: () => {},
			...over,
		}),
	);
}

function values(read: SelectRead): string[] {
	return read.options.map(o => o.value);
}

describe("ModelPicker：当前模型在目录里", () => {
	test("Provider 选中当前模型所属 provider，Model 选中当前模型本身", () => {
		const html = render();
		const provider = readSelect(html, "model-provider-select");
		const picker = readSelect(html, "model-select");

		expect(provider.value).toBe("alibaba-coding-plan");
		expect(provider.selectedIndex).toBeGreaterThanOrEqual(0);
		expect(values(provider)).toEqual(["alibaba-coding-plan", "kimi-code"]);
		// Model 只列当前 provider 名下的模型（不跨 provider 混排）
		expect(values(picker)).toEqual(["qwen3-max", "qwen3-plus"]);
		expect(picker.value).toBe("qwen3-max");
		expect(picker.selectedIndex).toBeGreaterThanOrEqual(0);
	});
});

describe("ModelPicker：首屏（当前模型不在目录里）", () => {
	// 真实现场：web-app 拿到的当前模型是裸 id（适配层只搬了 .id），provider 未知；
	// 若该模型又不在可用列表里（例如它所属的 provider 被停用），旧的筛选式 Model 下拉就是 0 个 option。
	const FIRST_PAINT = {
		state: { status: "ready", models: CATALOG } as AvailableModelsState,
		currentModel: "deepseek-v4-flash",
	};

	test("Model 下拉仍 ≥1 个 option，且当前模型自己就是选中项", () => {
		const picker = readSelect(render(FIRST_PAINT), "model-select");
		expect(picker.options.length).toBeGreaterThan(0);
		expect(picker.value).toBe("deepseek-v4-flash");
		expect(picker.selectedIndex).toBeGreaterThanOrEqual(0);
		expect(picker.options[0]).toEqual({
			value: "deepseek-v4-flash",
			label: "当前：deepseek-v4-flash",
			disabled: true,
			selected: true,
		});
	});

	test("Provider 下拉说「未知」，且这个值确实在它自己的选项里", () => {
		const provider = readSelect(render(FIRST_PAINT), "model-provider-select");
		expect(provider.value).toBe("");
		expect(provider.selectedIndex).toBeGreaterThanOrEqual(0);
		expect(provider.options[0]).toEqual({ value: "", label: "未知", disabled: true, selected: true });
		// 未知不等于没有 provider 可选：目录里的 provider 照列，用户从这里进
		expect(values(provider)).toEqual(["", "alibaba-coding-plan", "kimi-code"]);
	});

	test("同名模型分属两个 provider 时不当成知道（不猜一个 provider 名）", () => {
		const html = render({
			state: { status: "ready", models: [model("a", "gpt-5"), model("b", "gpt-5")] },
			currentModel: "gpt-5",
		});
		expect(readSelect(html, "model-provider-select").value).toBe("");
	});
});

describe("ModelPicker：用户选过的 provider 指向不在可用列表里的 provider", () => {
	test("它仍在选项里（否则选中值悬空），并标为不可选", () => {
		const html = render({ providerPick: "narwal-plan" });
		const provider = readSelect(html, "model-provider-select");
		expect(provider.value).toBe("narwal-plan");
		expect(provider.options[0]).toEqual({
			value: "narwal-plan",
			label: "narwal-plan（不在可用列表）",
			disabled: true,
			selected: true,
		});
		// 该 provider 名下没有模型 → Model 下拉保留当前模型那一项（不是空列表）
		const picker = readSelect(html, "model-select");
		expect(values(picker)).toEqual(["qwen3-max"]);
		expect(picker.value).toBe("qwen3-max");
		expect(picker.selectedIndex).toBeGreaterThanOrEqual(0);
	});
});

describe("ModelPicker：四种读取态各说各的", () => {
	const STATES: Array<[string, AvailableModelsState, string]> = [
		["未连接", { status: "disconnected" }, "未连接——读不到可用模型列表"],
		["加载中", { status: "loading" }, "加载中…"],
		["读取失败", { status: "error", error: "boom" }, "读取可用模型失败：boom"],
		["没有模型", { status: "ready", models: [] }, "serve 返回的可用模型列表为空——该 agent 没有可选模型"],
	];

	for (const [name, state, sentence] of STATES) {
		test(`${name} → 只说这一句，且两个下拉仍可渲染`, () => {
			const html = render({ state, currentModel: "deepseek-v4-flash" });
			expect(html).toContain(sentence);
			for (const [, , other] of STATES) {
				if (other === sentence) continue;
				expect(html).not.toContain(other);
			}
			const picker = readSelect(html, "model-select");
			expect(picker.options.length).toBeGreaterThan(0);
			expect(picker.value).toBe("deepseek-v4-flash");
			expect(readSelect(html, "model-provider-select").selectedIndex).toBeGreaterThanOrEqual(0);
		});
	}

	test("四句话互不相同（把它们说成同一句就是这一版修掉的缺陷）", () => {
		const rendered = STATES.map(([, state]) => render({ state, currentModel: "deepseek-v4-flash" }));
		expect(new Set(rendered).size).toBe(STATES.length);
	});
});
