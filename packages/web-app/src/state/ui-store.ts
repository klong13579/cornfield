import { useSyncExternalStore } from "react";

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
}

const DRAFT_KEY = "omp.workspace.draft";
const KEEPDRAFT_KEY = "omp.keepDraft";

const RIGHTPANEL_KEY = "omp.workspace.rightPanel";

function loadString(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

class UiStore {
	#state: UiState = {
		draft: loadString(DRAFT_KEY),
		phonePreviewOpen: false,
		keepDraft: loadString(KEEPDRAFT_KEY) !== "0",
		mobileNavOpen: false,
		rightPanelOpen: loadString(RIGHTPANEL_KEY) === "1",
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
	);
}

/** 非 hook 访问（事件处理器内）。 */
export function getUiStore(): UiStore {
	return uiStore;
}
