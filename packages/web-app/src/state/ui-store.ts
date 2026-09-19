import { useSyncExternalStore } from "react";
import {
	clampRatio,
	PANE_GEOMETRY_KEY,
	type PaneId,
	type PaneWidths,
	readPaneGeometry,
	writePaneGeometry,
} from "../lib/pane-resize";

/**
 * UI 偏好 store —— 原生 useSyncExternalStore 实现（等价 zustand，手写栈见 FRAMEWORK-MAPPING 差异章节）。
 * 仅存 UI 态（宽度/草稿/预览开关），不进会话权威数据。
 */

export interface UiState {
	draft: string;
	phonePreviewOpen: boolean;
	/** 草稿保留开关（设置页真控制；关掉后 setDraft 不再写 localStorage）。 */
	keepDraft: boolean;
	/** 移动端左侧会话栏/右栏抽屉开关（<lg 断点）。 */
	mobileNavOpen: boolean;
	/** 右栏折叠开关（R-COLLAPSE，demand-driven；桌面折叠后转录全宽）。 */
	rightPanelOpen: boolean;
	/** 会话侧栏折叠开关（桌面 Linear 风格窄栏；移动端抽屉不受影响）。 */
	sessionSidebarCollapsed: boolean;
	/** 分栏偏好宽度（px）——**用户选的**值，不是当前渲染出来的值（容器放不下时渲染会收紧）。 */
	paneWidths: PaneWidths;
	/** 右栏内部分栏的比例（锚容器高度，所以存比例：右栏宽度可变，像素会失真）。 */
	fileSplitRatio: number;
}

const DRAFT_KEY = "cornfield.workspace.draft";
const KEEPDRAFT_KEY = "cornfield.keepDraft";

const RIGHTPANEL_KEY = "cornfield.workspace.rightPanel";
const SESSIONSIDEBAR_KEY = "cornfield.workspace.sessionSidebar";

function loadString(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

// 分栏几何与其余 UI 偏好同一时机读盘（模块求值）：读不出来就用 spec 默认值。
const initialGeometry = readPaneGeometry(loadString(PANE_GEOMETRY_KEY) || null);

class UiStore {
	#state: UiState = {
		draft: loadString(DRAFT_KEY),
		phonePreviewOpen: false,
		keepDraft: loadString(KEEPDRAFT_KEY) !== "0",
		mobileNavOpen: false,
		rightPanelOpen: loadString(RIGHTPANEL_KEY) === "1",
		sessionSidebarCollapsed: loadString(SESSIONSIDEBAR_KEY) === "1",
		paneWidths: initialGeometry.widths,
		fileSplitRatio: initialGeometry.fileSplitRatio,
	};
	#listeners = new Set<() => void>();

	getSnapshot(): UiState {
		return this.#state;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setDraft(draft: string): void {
		this.#mutate({ draft });
		if (!this.#state.keepDraft) return; // 草稿保留关闭时只更新内存，不落盘
		try {
			localStorage.setItem(DRAFT_KEY, draft);
		} catch {
			// localStorage 不可用时仅内存态
		}
	}

	setKeepDraft(keep: boolean): void {
		this.#mutate({ keepDraft: keep });
		try {
			localStorage.setItem(KEEPDRAFT_KEY, keep ? "1" : "0");
		} catch {
			// 同上
		}
	}

	setPhonePreview(open: boolean): void {
		this.#mutate({ phonePreviewOpen: open });
	}

	setMobileNav(open: boolean): void {
		this.#mutate({ mobileNavOpen: open });
	}

	setRightPanel(open: boolean): void {
		this.#mutate({ rightPanelOpen: open });
		try {
			localStorage.setItem(RIGHTPANEL_KEY, open ? "1" : "0");
		} catch {
			// localStorage 不可用时仅内存态
		}
	}

	setSessionSidebarCollapsed(collapsed: boolean): void {
		this.#mutate({ sessionSidebarCollapsed: collapsed });
		try {
			localStorage.setItem(SESSIONSIDEBAR_KEY, collapsed ? "1" : "0");
		} catch {
			// localStorage 不可用时仅内存态
		}
	}

	/** 一栏的偏好宽度。范围收口在写入时做（拖拽已经 clamp 过一次，这里防的是非拖拽调用）。 */
	setPaneWidth(id: PaneId, px: number): void {
		if (!Number.isFinite(px)) return;
		this.#mutate({ paneWidths: { ...this.#state.paneWidths, [id]: px } });
		this.#persistGeometry();
	}

	setFileSplitRatio(ratio: number): void {
		if (!Number.isFinite(ratio)) return;
		this.#mutate({ fileSplitRatio: clampRatio(ratio) });
		this.#persistGeometry();
	}

	/** 宽度与比例是同一份偏好、同一个键：分两次写会让刷新后读到半套几何。 */
	#persistGeometry(): void {
		const { paneWidths, fileSplitRatio } = this.#state;
		try {
			localStorage.setItem(PANE_GEOMETRY_KEY, writePaneGeometry({ widths: paneWidths, fileSplitRatio }));
		} catch {
			// localStorage 不可用时仅内存态
		}
	}

	#mutate(patch: Partial<UiState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) {
			listener();
		}
	}
}

const uiStore = new UiStore();

export function useUiState(): UiState {
	return useSyncExternalStore(
		cb => uiStore.subscribe(cb),
		() => uiStore.getSnapshot(),
		// SSR（renderToStaticMarkup 那类渲染测试）也读得到：store 的状态是模块级初值，
		// 本来就有快照；缺这一项会让「直渲外壳/工作台」的测试直接抛 Missing getServerSnapshot。
		() => uiStore.getSnapshot(),
	);
}

/** 非 hook 访问（事件处理器内）。 */
export function getUiStore(): UiStore {
	return uiStore;
}
