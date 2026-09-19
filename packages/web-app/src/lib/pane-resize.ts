/**
 * 分栏几何：偏好怎么读、拖拽怎么算。
 *
 * 这一层不认识 DOM、也不认识 React。拖拽的坐标换算和越界规则放在这里，因为它们是唯一
 * 需要被反复验证的部分 —— SSR 渲染测试（仓库现有约定）碰不到指针事件，Playwright 又太慢。
 *
 * 三个概念分清楚，不要揉：
 *   - **偏好**（`paneWidths` / `fileSplitRatio`）：用户上一次拖到的值，落 localStorage，
 *     是唯一真相。
 *   - **渲染**：偏好写成 flex-basis（左右分栏）/ 高度百分比（右栏内部的上下分栏）。
 *     容器放不下时由浏览器收紧 —— 被收紧的值**不写回偏好**，否则窗口缩一次，用户选的宽度
 *     就被永久改掉了。
 *   - **拖拽**：按下到松手之间，分隔条每帧把值直接写进容器上的 CSS 变量（不经过 React），
 *     松手才 commit。
 */

export type PaneId = "appSidebar" | "sessionSidebar" | "rightPanel";

/** 被调的那一栏在分隔条的哪一侧：before = 左/上（分隔条向右/下移动则它变宽）。 */
export type PaneEdge = "before" | "after";

export type DividerAxis = "vertical" | "horizontal";

export interface PaneSpec {
	/** 分隔条的无障碍名字。 */
	readonly label: string;
	readonly defaultPx: number;
	readonly minPx: number;
	readonly maxPx: number;
}

export const PANE_SPECS: Record<PaneId, PaneSpec> = {
	appSidebar: { label: "调整主导航宽度", defaultPx: 240, minPx: 180, maxPx: 420 },
	sessionSidebar: { label: "调整会话栏宽度", defaultPx: 300, minPx: 220, maxPx: 520 },
	rightPanel: { label: "调整右栏宽度", defaultPx: 300, minPx: 240, maxPx: 640 },
};

/**
 * 转录列的最小宽度。
 *
 * 两个地方用它，一个口径：拖拽上限（`dragCapPx`）不会把内容列压到这个值以下；窄窗口下
 * 各栏也按它被浏览器收紧。写死一个数字而不是让每处自己拍，是因为这两处一旦不一致，
 * 拖拽就能把转录列压成一个看不见的宽度。
 */
export const CONTENT_MIN_PX = 320;

/** 右栏内部上下分栏：锚的是容器高度，所以存比例而不是像素（右栏宽度可变，像素会失真）。 */
export const FILE_SPLIT = { defaultRatio: 0.4, minRatio: 0.2, maxRatio: 0.8 } as const;

export const KEY_STEP_PX = 16;
export const KEY_STEP_COARSE_PX = 64;

export type PaneWidths = Record<PaneId, number>;

export interface PaneGeometry {
	readonly widths: PaneWidths;
	readonly fileSplitRatio: number;
}

/** 左栏宽度在 localStorage 里的键（与既有布尔键同一命名空间，但互不影响）。 */
export const PANE_GEOMETRY_KEY = "cornfield.workspace.panes";

export const DEFAULT_PANE_GEOMETRY: PaneGeometry = {
	widths: {
		appSidebar: PANE_SPECS.appSidebar.defaultPx,
		sessionSidebar: PANE_SPECS.sessionSidebar.defaultPx,
		rightPanel: PANE_SPECS.rightPanel.defaultPx,
	},
	fileSplitRatio: FILE_SPLIT.defaultRatio,
};

/**
 * 区间收口。
 *
 * 上限低于下限时（窗口窄到连这一栏的偏好下限都给不出）**以上限为准** —— 容器是硬约束，
 * 让这一栏比它的偏好下限更窄，总比把布局撑出屏幕合理。所以调用方可以放心地把
 * `min(静态上限, 动态上限)` 直接当上限传进来。
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** 分隔条沿轴移动 deltaPx：before 侧变宽，after 侧变窄。 */
export function applyDividerDelta(value: number, deltaPx: number, edge: PaneEdge): number {
	return edge === "before" ? value + deltaPx : value - deltaPx;
}

/** 按下时的值与坐标 + 当前坐标 → 新值（已按方向与上下限收口）。 */
export function valueFromDrag(args: {
	startValue: number;
	startCoordinate: number;
	coordinate: number;
	edge: PaneEdge;
	minPx: number;
	maxPx: number;
}): number {
	const moved = args.coordinate - args.startCoordinate;
	return clamp(applyDividerDelta(args.startValue, moved, args.edge), args.minPx, args.maxPx);
}

/** 键盘一步：direction = +1 表示分隔条向右/下。 */
export function valueFromKey(args: {
	current: number;
	direction: -1 | 1;
	stepPx: number;
	edge: PaneEdge;
	minPx: number;
	maxPx: number;
}): number {
	return clamp(applyDividerDelta(args.current, args.direction * args.stepPx, args.edge), args.minPx, args.maxPx);
}

/**
 * 拖拽上限：只吃内容列的自由空间，不挤压别的栏。
 *
 * 「这一栏 + 内容列」是分隔条两侧可见的全部空间，扣掉内容列的下限就是它还能长的量。
 * 别的栏不在这个式子里 —— 拖一栏不该悄悄改掉另一栏（那会让用户找不到自己拉哪去了）。
 */
export function dragCapPx(args: { panePx: number; contentPx: number; contentMinPx?: number }): number {
	const contentMin = args.contentMinPx ?? CONTENT_MIN_PX;
	return args.panePx + Math.max(0, args.contentPx - contentMin);
}

export function clampRatio(ratio: number): number {
	return clamp(ratio, FILE_SPLIT.minRatio, FILE_SPLIT.maxRatio);
}

export function ratioToPx(ratio: number, extentPx: number): number {
	return ratio * extentPx;
}

/** 容器还没量到尺寸时（SSR / 首帧）不猜：回到默认比例。 */
export function pxToRatio(px: number, extentPx: number): number {
	return extentPx > 0 ? clampRatio(px / extentPx) : FILE_SPLIT.defaultRatio;
}

/**
 * 容器上承载一栏几何的 CSS 变量名。
 *
 * 用 `width` 而不是 `flex-basis`：折叠/展开这些状态动画的是 `width`（两个状态都给出确定宽度
 * 才能过渡），拖拽写的也是同一个量 —— 一个数量一种表示，不要一半走 basis 一半走 width。
 */
export function paneVarName(id: PaneId, kind: "width" | "min"): string {
	return `--pane-${id}-${kind}`;
}

/** 右栏内部上下分栏的高度变量（拖拽中写像素，静止时写百分比）。 */
export const FILE_SPLIT_VAR = "--file-preview-h";

function readWidth(raw: unknown, id: PaneId): number {
	const spec = PANE_SPECS[id];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return spec.defaultPx;
	// 越界的旧值（改过 spec、或手改过 localStorage）按现状收口，不回写 —— 读的时候改人家存的东西
	// 会让「用户选的宽度」在刷新后悄悄变掉。
	return clamp(raw, spec.minPx, spec.maxPx);
}

/**
 * 读分栏偏好。坏 JSON / 缺字段 / 非有限数一律回退默认；越界值收口到 spec 区间。
 *
 * 不 throw：这是 UI 偏好，读不出来就用默认值，比让整个工作台崩掉合理。
 */
export function readPaneGeometry(raw: string | null): PaneGeometry {
	if (raw === null || raw === "") return DEFAULT_PANE_GEOMETRY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_PANE_GEOMETRY;
	}
	if (typeof parsed !== "object" || parsed === null) return DEFAULT_PANE_GEOMETRY;
	const record = parsed as { widths?: unknown; fileSplitRatio?: unknown };
	const widths = record.widths;
	const widthsRecord = typeof widths === "object" && widths !== null ? (widths as Record<string, unknown>) : {};
	const ratio = record.fileSplitRatio;
	return {
		widths: {
			appSidebar: readWidth(widthsRecord.appSidebar, "appSidebar"),
			sessionSidebar: readWidth(widthsRecord.sessionSidebar, "sessionSidebar"),
			rightPanel: readWidth(widthsRecord.rightPanel, "rightPanel"),
		},
		fileSplitRatio: typeof ratio === "number" && Number.isFinite(ratio) ? clampRatio(ratio) : FILE_SPLIT.defaultRatio,
	};
}

/** 落盘格式：与 `readPaneGeometry` 对称（唯一的序列化点，别在 store 里手拼字符串）。 */
export function writePaneGeometry(geometry: PaneGeometry): string {
	return JSON.stringify({ widths: geometry.widths, fileSplitRatio: geometry.fileSplitRatio });
}

/**
 * 分隔条要调的那一个量。
 *
 * 单位换算、上下限、写到哪儿 —— 都是这个量自己的事；分隔条与拖拽会话只负责指针与键盘。
 * 正因为这层接口是「一个值 + 几个动作」而不是「一个 pane id」，同一套拖拽逻辑既能调左右分栏
 * （像素），也能调右栏内部的上下分栏（比例）。
 */
export interface DividerTarget {
	/** 分隔条的无障碍名字（"调整会话栏宽度" 这种），由量自己的 spec 给。 */
	readonly label: string;
	/**
	 * 当前可见值（px，沿分隔条轴向）。拖拽与键盘都以它为准，而不是偏好值：
	 * 容器放不下时被浏览器收紧过的那个视觉尺寸，才是用户看到的、要接着拖的那个。
	 */
	currentPx(): number;
	/** 拖拽可用的 px 上下限（动态上限由实现算：只吃内容列的自由空间）。 */
	boundsPx(): { minPx: number; maxPx: number };
	/** 拖拽中每帧：把值落到 CSS 变量上（不走 React）。 */
	preview(px: number): void;
	/** 松手 / 键盘 / 复位：落盘。 */
	commit(px: number): void;
	/** 回到默认（双击）。 */
	reset(): void;
	/** aria 数值：按这个量自己的口径说（像素或百分比）。 */
	a11y(): { now: number; min: number; max: number; text: string };
}

/**
 * 一次拖拽的现场。
 *
 * 从组件里拿出来是因为它是这个功能唯一有分支的地方（起点快照、越界、"点一下没动就不落盘"），
 * 而这仓库的渲染测试只能直渲 SSR —— 指针事件在那里碰不到。留在闭包里就可以当普通逻辑验证。
 *
 * 轴向由调用方消化：事件坐标换成 clientX/clientY 之后再进来；键盘不走这里（见 `stepDivider`）。
 */
export interface DragSession {
	/** 按下。返回 false = 这次按下不开始拖（已经在拖了）。 */
	begin(coordinate: number): boolean;
	/** 指针移动：算出本帧的值并 preview；没在拖时返回 null。 */
	move(coordinate: number): number | null;
	/**
	 * 松手（含 pointercancel / 丢失指针捕获）：落盘并返回落盘值。
	 * **只是点了一下、指针没动过 → 返回 null**，不落盘：分隔条不该因为被点一下就改宽度。
	 */
	end(): number | null;
}

export function createDragSession(args: { target: DividerTarget; edge: PaneEdge }): DragSession {
	let grab: { coordinate: number; startValue: number } | null = null;
	let latest: number | null = null;

	return {
		begin(coordinate) {
			if (grab !== null) return false;
			grab = { coordinate, startValue: args.target.currentPx() };
			latest = null;
			return true;
		},
		move(coordinate) {
			if (grab === null) return null;
			const bounds = args.target.boundsPx();
			const next = valueFromDrag({
				startValue: grab.startValue,
				startCoordinate: grab.coordinate,
				coordinate,
				edge: args.edge,
				minPx: bounds.minPx,
				maxPx: bounds.maxPx,
			});
			latest = next;
			args.target.preview(next);
			return next;
		},
		end() {
			if (grab === null) return null;
			grab = null;
			const value = latest;
			latest = null;
			if (value !== null) args.target.commit(value);
			return value;
		},
	};
}

/**
 * 键盘一步：一步一个决定，所以 preview 与 commit 是同一个值（没有拖拽中态，也就没有
 * 「点一下没动就不落盘」那回事）。
 */
export function stepDivider(target: DividerTarget, edge: PaneEdge, direction: -1 | 1, stepPx: number): number {
	const bounds = target.boundsPx();
	const next = valueFromKey({
		current: target.currentPx(),
		direction,
		stepPx,
		edge,
		minPx: bounds.minPx,
		maxPx: bounds.maxPx,
	});
	target.preview(next);
	target.commit(next);
	return next;
}
