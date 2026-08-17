import { useSyncExternalStore } from "react";

/**
 * UI 偏好 store（zustand 后续接，当前为原生 useSyncExternalStore 实现）。
 * 仅存 UI 态（宽度/草稿/预览开关），不进会话权威数据。
 */

export interface ContentPreviewState {
	title: string;
	kind: "mermaid" | "drawio" | "web";
}

export interface UiState {
	sidebarWidth: number;
	draft: string;
	phonePreviewOpen: boolean;
	contentPreview: ContentPreviewState | null;
}

const SIDEBAR_KEY = "omp.side.w";
const DRAFT_KEY = "omp.workspace.draft";

function loadNumber(key: string, fallback: number): number {
	try {
		const raw = localStorage.getItem(key);
		const num = raw === null ? NaN : Number.parseInt(raw, 10);
		return Number.isFinite(num) ? num : fallback;
	} catch {
		return fallback;
	}
}

function loadString(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

class UiStore {
	#state: UiState = {
		sidebarWidth: loadNumber(SIDEBAR_KEY, 300),
		draft: loadString(DRAFT_KEY),
		phonePreviewOpen: false,
		contentPreview: null,
	};
	#listeners = new Set<() => void>();

	getSnapshot(): UiState {
		return this.#state;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setSidebarWidth(width: number): void {
		const clamped = Math.min(520, Math.max(240, width));
		this.#mutate({ sidebarWidth: clamped });
		try {
			localStorage.setItem(SIDEBAR_KEY, String(clamped));
		} catch {
			// localStorage 不可用（隐私模式）时仅内存态
		}
	}

	resetSidebarWidth(): void {
		this.setSidebarWidth(300);
	}

	setDraft(draft: string): void {
		this.#mutate({ draft });
		try {
			localStorage.setItem(DRAFT_KEY, draft);
		} catch {
			// 同上
		}
	}

	setPhonePreview(open: boolean): void {
		this.#mutate({ phonePreviewOpen: open });
	}

	setContentPreview(preview: ContentPreviewState | null): void {
		this.#mutate({ contentPreview: preview });
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
