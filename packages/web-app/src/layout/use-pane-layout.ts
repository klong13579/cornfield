import { useMemo, useRef } from "react";
import {
	type DividerTarget,
	dragCapPx,
	FILE_SPLIT,
	FILE_SPLIT_VAR,
	PANE_SPECS,
	type PaneId,
	paneVarName,
	pxToRatio,
	ratioToPx,
} from "../lib/pane-resize";
import { getUiStore, useUiState } from "../state/ui-store";

/**
 * 分栏布局：偏好进、渲染值与分隔条目标出。
 *
 * 偏好（store）怎么变成屏幕上的宽度：
 *   1. 容器 style 把每一栏的偏好写成 CSS 变量（`--pane-<id>-basis` / `-min`）；
 *   2. 栏自己用 `lg:basis-[var(--pane-<id>-basis)]` 取用，容器放不下时由浏览器按各栏下限收紧；
 *   3. 拖拽中分隔条直接改容器上的同一个变量（不经过 React），松手才 commit 回 store。
 *
 * **没有 ResizeObserver**：渲染这步不需要 JS 知道容器多宽 —— flex 的 basis + min-width 本来
 * 就是「偏好 + 上限」的表达，交给布局引擎算比我在这里重算一遍准确。测量只发生在拖拽按下那一刻，
 * 量的是"这一栏 + 内容列"的可见宽度（见 `DividerTarget`）。
 */

/** 内容列在元素表里的键（与 PaneId 分开：它不是可拖的栏，只是拖拽上限的参照）。 */
const CONTENT_KEY = "content";

/** 右栏内部上下分栏的预览元素键。 */
const FILE_PREVIEW_KEY = "filePreview";

export interface PaneLayout {
	/** 分栏容器：CSS 变量写在它身上，拖拽中直接改它。 */
	readonly containerRef: React.RefObject<HTMLDivElement | null>;
	/** 容器 style：各栏的偏好宽度与下限。 */
	readonly containerStyle: React.CSSProperties;
	/** 挂到某一栏的根元素上（拖拽时量它的可见宽度）。 */
	paneRef(id: PaneId): (el: HTMLElement | null) => void;
	/** 挂到内容列（转录列 / 主内容）的根元素上：拖拽上限要扣掉它的下限。 */
	contentRef(el: HTMLElement | null): void;
	/**
	 * 某一栏的分隔条目标。
	 *
	 * 每次调用新建一个轻量闭包（不持有状态，全部从 ref 与 store 现读），所以不必缓存；
	 * 分隔条只在事件处理器里用它，而拖拽期间没有重渲染 —— 中途不会换掉手里的那个对象。
	 */
	target(id: PaneId): DividerTarget;
}

/** CSS 自定义属性不在 `React.CSSProperties` 的字面类型里，集中在这里转一次。 */
function cssVars(vars: Record<string, string>): React.CSSProperties {
	return vars as React.CSSProperties;
}

export function usePaneLayout(panes: readonly PaneId[]): PaneLayout {
	const ui = useUiState();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const elements = useRef(new Map<string, HTMLElement>());

	// 回调 ref 按 key 缓存：每次渲染新建闭包会让 React 每轮 detach/attach 一遍元素。
	const registry = useMemo(() => {
		const cached = new Map<string, (el: HTMLElement | null) => void>();
		return (key: string) => {
			const existing = cached.get(key);
			if (existing) return existing;
			const ref = (el: HTMLElement | null) => {
				if (el) elements.current.set(key, el);
				else elements.current.delete(key);
			};
			cached.set(key, ref);
			return ref;
		};
	}, []);

	const vars: Record<string, string> = {};
	for (const id of panes) {
		vars[paneVarName(id, "width")] = `${ui.paneWidths[id]}px`;
		vars[paneVarName(id, "min")] = `${PANE_SPECS[id].minPx}px`;
	}

	return {
		containerRef,
		containerStyle: cssVars(vars),
		paneRef: id => registry(id),
		contentRef: registry(CONTENT_KEY),
		target: id => paneTarget(id, containerRef, elements),
	};
}

function paneTarget(
	id: PaneId,
	container: React.RefObject<HTMLDivElement | null>,
	elements: React.RefObject<Map<string, HTMLElement>>,
): DividerTarget {
	const spec = PANE_SPECS[id];
	const paneEl = (): HTMLElement | null => elements.current.get(id) ?? null;
	const contentEl = (): HTMLElement | null => elements.current.get(CONTENT_KEY) ?? null;

	/** 可见宽度（px）。元素还没挂（SSR / 首帧）时回落到偏好值 —— 那是这一刻屏幕上的意图。 */
	const renderedPx = (): number => {
		const el = paneEl();
		if (!el) return getUiStore().getSnapshot().paneWidths[id];
		return Math.round(el.getBoundingClientRect().width);
	};

	return {
		label: spec.label,
		currentPx: renderedPx,
		boundsPx: () => {
			// 上限是动态的：能用多少，取决于内容列此刻还剩多少自由空间 —— 静态常量算不出来
			// （三栏同时拉满会把转录列压成负宽）。内容列没挂时不收紧，用静态上限。
			const content = contentEl();
			if (!content) return { minPx: spec.minPx, maxPx: spec.maxPx };
			const cap = dragCapPx({ panePx: renderedPx(), contentPx: Math.round(content.getBoundingClientRect().width) });
			// cap 可能低于 spec.minPx（窗口太窄）：如实交出去，收口规则在 clamp 那儿（以上限为准）。
			return { minPx: spec.minPx, maxPx: Math.min(spec.maxPx, cap) };
		},
		preview: px => container.current?.style.setProperty(paneVarName(id, "width"), `${px}px`),
		commit: px => getUiStore().setPaneWidth(id, px),
		reset: () => getUiStore().setPaneWidth(id, spec.defaultPx),
		a11y: () => {
			const now = getUiStore().getSnapshot().paneWidths[id];
			return { now, min: spec.minPx, max: spec.maxPx, text: `${Math.round(now)} 像素` };
		},
	};
}

export interface FileSplit {
	/** 上下分栏的容器：高度变量写在它身上。 */
	readonly containerRef: React.RefObject<HTMLDivElement | null>;
	readonly containerStyle: React.CSSProperties;
	/** 挂到预览那一格上（拖拽时量它当前多高）。 */
	previewRef(el: HTMLElement | null): void;
	readonly target: DividerTarget;
}

/**
 * 右栏内部的上下分栏（文件树 / 文件预览）。
 *
 * 与左右分栏的区别只有一处：它锚的是**容器高度**，所以偏好存比例而不是像素 —— 右栏宽度可拖，
 * 存像素的话换个宽度就失真。渲染直接写百分比（换高度自动跟着走），拖拽时才换算成像素。
 */
export function useFileSplit(): FileSplit {
	const ui = useUiState();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const elements = useRef(new Map<string, HTMLElement>());
	const previewRef = useMemo(() => {
		return (el: HTMLElement | null) => {
			if (el) elements.current.set(FILE_PREVIEW_KEY, el);
			else elements.current.delete(FILE_PREVIEW_KEY);
		};
	}, []);

	const extentPx = (): number => containerRef.current?.clientHeight ?? 0;
	const renderedPx = (): number => {
		const el = elements.current.get(FILE_PREVIEW_KEY);
		if (!el) return ratioToPx(ui.fileSplitRatio, extentPx());
		return Math.round(el.getBoundingClientRect().height);
	};

	const target: DividerTarget = {
		label: "调整文件预览高度",
		currentPx: renderedPx,
		boundsPx: () => {
			const extent = extentPx();
			// 量不到高度（还没上屏）时区间是 0–0：拖不动，但也不会把预览写成负数。
			return {
				minPx: ratioToPx(FILE_SPLIT.minRatio, extent),
				maxPx: ratioToPx(FILE_SPLIT.maxRatio, extent),
			};
		},
		preview: px => containerRef.current?.style.setProperty(FILE_SPLIT_VAR, `${px}px`),
		commit: px => {
			const extent = extentPx();
			if (extent <= 0) return;
			getUiStore().setFileSplitRatio(pxToRatio(px, extent));
		},
		reset: () => getUiStore().setFileSplitRatio(FILE_SPLIT.defaultRatio),
		a11y: () => {
			const ratio = getUiStore().getSnapshot().fileSplitRatio;
			return {
				now: ratio * 100,
				min: FILE_SPLIT.minRatio * 100,
				max: FILE_SPLIT.maxRatio * 100,
				text: `${Math.round(ratio * 100)}%`,
			};
		},
	};

	return {
		containerRef,
		containerStyle: cssVars({ [FILE_SPLIT_VAR]: `${ui.fileSplitRatio * 100}%` }),
		previewRef,
		target,
	};
}
