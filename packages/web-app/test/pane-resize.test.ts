import { describe, expect, it } from "bun:test";
import {
	applyDividerDelta,
	CONTENT_MIN_PX,
	clamp,
	clampRatio,
	createDragSession,
	DEFAULT_PANE_GEOMETRY,
	type DividerTarget,
	dragCapPx,
	FILE_SPLIT,
	PANE_SPECS,
	paneVarName,
	pxToRatio,
	ratioToPx,
	readPaneGeometry,
	stepDivider,
	valueFromDrag,
	valueFromKey,
	writePaneGeometry,
} from "../src/lib/pane-resize";

/**
 * 分栏几何：拖拽怎么算、偏好怎么读。
 *
 * 这层是整件事唯一有分支的地方，也是唯一能在没有 DOM 的环境里被验证的地方 —— 组件的指针接线
 * 交给 Playwright（真实指针事件）。所以这里的用例按**边界**写，不按"看起来对"写：
 * 上下限、方向（左栏右拖变宽 / 右栏右拖变窄）、动态上限、点一下没动、坏数据。
 *
 * 一个口径要写清楚：`clamp` 家族**不做非有限数兜底**（NaN / Infinity 原样传出去）。
 * 拦截发生在入口 —— store 的 setter（`setPaneWidth` / `setFileSplitRatio`）与 `readPaneGeometry`
 * 都拒收非有限数；中间层再各兜一次，只会把「上游算错了」这件事藏起来。
 */

/** 记录被调用情况的假量：断言的是「效果」（preview/commit 收到了什么），不是内部状态。 */
function fakeTarget(init: { current?: number; min?: number; max?: number } = {}) {
	const previewed: number[] = [];
	const committed: number[] = [];
	let resets = 0;
	const target: DividerTarget = {
		label: "调整会话栏宽度",
		currentPx: () => init.current ?? 300,
		boundsPx: () => ({ minPx: init.min ?? 200, maxPx: init.max ?? 600 }),
		preview: px => previewed.push(px),
		commit: px => committed.push(px),
		reset: () => {
			resets += 1;
		},
		a11y: () => ({ now: 300, min: 200, max: 600, text: "300 像素" }),
	};
	return { target, previewed, committed, resets: () => resets };
}

describe("边界收口", () => {
	it("clamp 落在区间内、贴着边界、越界", () => {
		expect(clamp(250, 200, 600)).toBe(250);
		expect(clamp(200, 200, 600)).toBe(200);
		expect(clamp(600, 200, 600)).toBe(600);
		expect(clamp(199, 200, 600)).toBe(200);
		expect(clamp(601, 200, 600)).toBe(600);
		expect(clamp(-5, 200, 600)).toBe(200);
	});

	it("上限低于下限时以上限为准：容器是硬约束", () => {
		expect(clamp(500, 300, 120)).toBe(120);
	});
});

describe("分隔条方向", () => {
	it("before 侧（左/上）向右拖变宽，after 侧（右/下）向右拖变窄", () => {
		expect(applyDividerDelta(300, 40, "before")).toBe(340);
		expect(applyDividerDelta(300, -40, "before")).toBe(260);
		expect(applyDividerDelta(300, 40, "after")).toBe(260);
		expect(applyDividerDelta(300, -40, "after")).toBe(340);
		expect(applyDividerDelta(300, 0, "before")).toBe(300);
	});
});

describe("拖拽一步（valueFromDrag）", () => {
	const base = { startValue: 300, startCoordinate: 500, minPx: 200, maxPx: 600 };

	it("位移为 0 就是起点值（按下不动不该改宽度）", () => {
		expect(valueFromDrag({ ...base, coordinate: 500, edge: "before" })).toBe(300);
	});

	it("左栏右拖按位移线性变宽，左拖变窄", () => {
		expect(valueFromDrag({ ...base, coordinate: 560, edge: "before" })).toBe(360);
		expect(valueFromDrag({ ...base, coordinate: 440, edge: "before" })).toBe(240);
	});

	it("右栏（after 侧）方向相反", () => {
		expect(valueFromDrag({ ...base, coordinate: 560, edge: "after" })).toBe(240);
		expect(valueFromDrag({ ...base, coordinate: 440, edge: "after" })).toBe(360);
	});

	it("拖过头收在下限 / 上限，不越过", () => {
		expect(valueFromDrag({ ...base, coordinate: 100, edge: "before" })).toBe(200);
		expect(valueFromDrag({ ...base, coordinate: 5000, edge: "before" })).toBe(600);
		expect(valueFromDrag({ ...base, coordinate: 5000, edge: "after" })).toBe(200);
		expect(valueFromDrag({ ...base, coordinate: 100, edge: "after" })).toBe(600);
	});

	it("动态上限低于偏好下限时收到上限（窗口窄到给不出下限，先不让布局撑出去）", () => {
		expect(valueFromDrag({ ...base, minPx: 300, maxPx: 120, coordinate: 900, edge: "before" })).toBe(120);
	});
});

describe("键盘一步（valueFromKey）", () => {
	const base = { current: 300, stepPx: 16, minPx: 200, maxPx: 600 } as const;

	it("方向 ±1 与分隔条方向一致（Shift 只是更大的 step）", () => {
		expect(valueFromKey({ ...base, direction: 1, edge: "before" })).toBe(316);
		expect(valueFromKey({ ...base, direction: -1, edge: "before" })).toBe(284);
		expect(valueFromKey({ ...base, direction: 1, edge: "after" })).toBe(284);
		expect(valueFromKey({ ...base, direction: -1, edge: "after" })).toBe(316);
		expect(valueFromKey({ ...base, direction: 1, stepPx: 64, edge: "before" })).toBe(364);
	});

	it("键盘也收在上下限内", () => {
		expect(valueFromKey({ ...base, current: 205, direction: -1, edge: "before" })).toBe(200);
		expect(valueFromKey({ ...base, current: 595, direction: 1, edge: "before" })).toBe(600);
	});
});

describe("拖拽上限（动态，不是静态常量）", () => {
	it("能长的是内容列的自由空间：内容列还有余量就吃它", () => {
		// 这一栏 300、内容列 520、内容列下限 320 → 还能长 200
		expect(dragCapPx({ panePx: 300, contentPx: 520 })).toBe(500);
	});

	it("内容列正好到下限：一点也长不了（上限＝当前宽度）", () => {
		expect(dragCapPx({ panePx: 300, contentPx: CONTENT_MIN_PX })).toBe(300);
	});

	it("内容列已被压在更窄处也不会返回比当前更小的上限（收紧是渲染的事，不是拖拽的）", () => {
		expect(dragCapPx({ panePx: 300, contentPx: 120 })).toBe(300);
	});
});

describe("比例 ↔ 像素（右栏内部的上下分栏）", () => {
	it("按容器高度换算", () => {
		expect(ratioToPx(0.4, 800)).toBe(320);
		expect(pxToRatio(320, 800)).toBeCloseTo(0.4, 10);
	});

	it("量不到容器高度时不猜：回到默认比例", () => {
		expect(pxToRatio(320, 0)).toBe(FILE_SPLIT.defaultRatio);
	});

	it("比例被收在 0.2–0.8，且换算出来的像素也收在区间内", () => {
		expect(clampRatio(0.05)).toBe(FILE_SPLIT.minRatio);
		expect(clampRatio(0.95)).toBe(FILE_SPLIT.maxRatio);
		expect(clampRatio(0.5)).toBe(0.5);
	});
});

describe("偏好读盘（readPaneGeometry）", () => {
	it("没有键 → 默认几何", () => {
		expect(readPaneGeometry(null)).toEqual(DEFAULT_PANE_GEOMETRY);
	});

	it("空串 → 默认几何（store 用空串表示「没有」）", () => {
		expect(readPaneGeometry("")).toEqual(DEFAULT_PANE_GEOMETRY);
	});

	it("坏 JSON → 默认几何，不抛", () => {
		expect(readPaneGeometry("{not json")).toEqual(DEFAULT_PANE_GEOMETRY);
	});

	it("JSON 是数组 / 字符串 / null → 默认几何（顶层形状不对也算坏数据）", () => {
		expect(readPaneGeometry("[]")).toEqual(DEFAULT_PANE_GEOMETRY);
		expect(readPaneGeometry("42")).toEqual(DEFAULT_PANE_GEOMETRY);
		expect(readPaneGeometry("null")).toEqual(DEFAULT_PANE_GEOMETRY);
	});

	it("缺字段：缺的那一栏回默认，有的照读", () => {
		const geometry = readPaneGeometry(JSON.stringify({ widths: { sessionSidebar: 377 } }));
		expect(geometry.widths.sessionSidebar).toBe(377);
		expect(geometry.widths.appSidebar).toBe(PANE_SPECS.appSidebar.defaultPx);
		expect(geometry.fileSplitRatio).toBe(FILE_SPLIT.defaultRatio);
	});

	it("越界值收口到 spec 区间（改过 spec 的老数据不该把栏拖出屏幕）", () => {
		const geometry = readPaneGeometry(
			JSON.stringify({ widths: { sessionSidebar: 99999, rightPanel: 1, appSidebar: -40 }, fileSplitRatio: 0.99 }),
		);
		expect(geometry.widths.sessionSidebar).toBe(PANE_SPECS.sessionSidebar.maxPx);
		expect(geometry.widths.rightPanel).toBe(PANE_SPECS.rightPanel.minPx);
		expect(geometry.widths.appSidebar).toBe(PANE_SPECS.appSidebar.minPx);
		expect(geometry.fileSplitRatio).toBe(FILE_SPLIT.maxRatio);
	});

	it("非数字 / 非有限数 → 该栏回默认", () => {
		const geometry = readPaneGeometry(
			JSON.stringify({ widths: { sessionSidebar: "300", rightPanel: null }, fileSplitRatio: "0.4" }),
		);
		expect(geometry.widths.sessionSidebar).toBe(PANE_SPECS.sessionSidebar.defaultPx);
		expect(geometry.widths.rightPanel).toBe(PANE_SPECS.rightPanel.defaultPx);
		expect(geometry.fileSplitRatio).toBe(FILE_SPLIT.defaultRatio);
	});

	it("读→写→读 不漂移（落盘格式与读盘对称）", () => {
		const once = readPaneGeometry(
			JSON.stringify({ widths: { sessionSidebar: 411, rightPanel: 288 }, fileSplitRatio: 0.55 }),
		);
		expect(readPaneGeometry(writePaneGeometry(once))).toEqual(once);
	});

	it("变量名带 pane id 与用途，两侧拼法一致", () => {
		expect(paneVarName("rightPanel", "width")).toBe("--pane-rightPanel-width");
		expect(paneVarName("rightPanel", "min")).toBe("--pane-rightPanel-min");
	});
});

describe("一次拖拽的现场（createDragSession）", () => {
	it("按下 → 移动 → 松手：每帧预览，松手落盘最后那个值", () => {
		const { target, previewed, committed } = fakeTarget({ current: 300, min: 200, max: 600 });
		const session = createDragSession({ target, edge: "before" });

		expect(session.begin(500)).toBe(true);
		expect(session.move(520)).toBe(320);
		expect(session.move(560)).toBe(360);
		expect(previewed).toEqual([320, 360]);
		expect(committed).toEqual([]); // 拖拽中不落盘

		expect(session.end()).toBe(360);
		expect(committed).toEqual([360]);
	});

	it("起点值是按下那一刻的可见宽度（被容器收紧过的那个），不是偏好值", () => {
		// 偏好 520、屏幕上只有 260：接着拖的量应当从 260 起算
		const { target, committed } = fakeTarget({ current: 260, min: 200, max: 600 });
		const session = createDragSession({ target, edge: "before" });
		session.begin(100);
		session.move(140);
		session.end();
		expect(committed).toEqual([300]);
	});

	it("只是点了一下没动：不落盘（分隔条不该因为被点一下就改宽度）", () => {
		const { target, previewed, committed } = fakeTarget();
		const session = createDragSession({ target, edge: "before" });
		expect(session.begin(500)).toBe(true);
		expect(session.end()).toBeNull();
		expect(previewed).toEqual([]);
		expect(committed).toEqual([]);
	});

	it("没按下就移动 / 松手：什么都不发生", () => {
		const { target, previewed, committed } = fakeTarget();
		const session = createDragSession({ target, edge: "before" });
		expect(session.move(600)).toBeNull();
		expect(session.end()).toBeNull();
		expect(previewed).toEqual([]);
		expect(committed).toEqual([]);
	});

	it("重复按下不重开：第二次不接收，起点仍是第一次那个", () => {
		const { target, committed } = fakeTarget({ current: 300, min: 200, max: 600 });
		const session = createDragSession({ target, edge: "before" });
		expect(session.begin(500)).toBe(true);
		expect(session.begin(900)).toBe(false);
		session.move(540);
		session.end();
		expect(committed).toEqual([340]);
	});

	it("松手后再移动不生效（现场已清），不会把上一次的值又提交一遍", () => {
		const { target, committed } = fakeTarget();
		const session = createDragSession({ target, edge: "before" });
		session.begin(500);
		session.move(540);
		session.end();
		expect(session.move(600)).toBeNull();
		expect(session.end()).toBeNull();
		expect(committed).toEqual([340]);
	});

	it("上限每帧现算：拖到一半内容列被别的栏挤没了，这一栏就停在当下宽度", () => {
		let cap = 600;
		const committed: number[] = [];
		const target: DividerTarget = {
			label: "调整右栏宽度",
			currentPx: () => 300,
			boundsPx: () => ({ minPx: 240, maxPx: cap }),
			preview: () => undefined,
			commit: px => committed.push(px),
			reset: () => undefined,
			a11y: () => ({ now: 300, min: 240, max: cap, text: "300 像素" }),
		};
		const session = createDragSession({ target, edge: "after" });
		session.begin(1000);
		expect(session.move(800)).toBe(500);
		cap = 320; // 内容列触底
		expect(session.move(600)).toBe(320);
		session.end();
		expect(committed).toEqual([320]);
	});
});

describe("键盘一步的落盘（stepDivider）", () => {
	it("预览与落盘是同一个值（键盘没有拖拽中态）", () => {
		const { target, previewed, committed } = fakeTarget({ current: 300, min: 200, max: 600 });
		expect(stepDivider(target, "before", 1, 16)).toBe(316);
		expect(previewed).toEqual([316]);
		expect(committed).toEqual([316]);
	});

	it("到边界后停住，不产生越界值", () => {
		const { target, committed } = fakeTarget({ current: 210, min: 200, max: 600 });
		expect(stepDivider(target, "before", -1, 64)).toBe(200);
		expect(committed).toEqual([200]);
	});
});
