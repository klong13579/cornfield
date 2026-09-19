import { contextBridge, ipcRenderer } from "electron";

/**
 * 目录选择器的答复：`canceled` 为真时**没有** `path`（用户取消是一次「什么都没发生」，
 * 与「选了一个空路径」不是一回事，所以两者形状不同而不是用空串顶替）。
 */
export type PickDirectoryResult = { canceled: true } | { canceled: false; path: string };

/**
 * 最小 preload bridge：暴露 sidecar 工作目录读写与系统目录选择器，供 web-app 调用。
 * contextIsolation=true（main.ts webPreferences 固定开启），renderer 无法直接触碰 Node。
 * 契约与 `packages/web-app/src/lib/desktop-bridge.ts` 对齐（那边是渲染层的唯一一份声明）：
 * window.api.sidecar.setWorkspaceDir(dir) / window.api.dialog.pickDirectory(defaultPath)。
 *
 * 这里只做「取一个值」或「弹一次系统选择器」，不做校验：路径成不成立、是不是已声明的
 * Project root，由消费它的一方判（serve 的 `set_project`）—— preload 不是校验层。
 */
const api = {
	sidecar: {
		setWorkspaceDir: (dir: string): Promise<{ ok: boolean; workspaceDir: string }> =>
			ipcRenderer.invoke("sidecar:set-workspace-dir", dir),
		getWorkspaceDir: (): Promise<string> => ipcRenderer.invoke("sidecar:get-workspace-dir"),
	},
	dialog: {
		/**
		 * 系统原生目录选择器。`defaultPath` 只是选择器的起始位置，用户随时可以走去别处。
		 * 取消时回 `{ canceled: true }`，选定时回绝对路径 —— 不做任何规范化或存在性检查。
		 */
		pickDirectory: (defaultPath?: string): Promise<PickDirectoryResult> =>
			ipcRenderer.invoke("dialog:pick-directory", defaultPath),
	},
	app: {
		getVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
		onUpdateAvailable: (cb: () => void): (() => void) => {
			const listener = (): void => cb();
			ipcRenderer.on("update:available", listener);
			return () => ipcRenderer.removeListener("update:available", listener);
		},
		onUpdateNotAvailable: (cb: () => void): (() => void) => {
			const listener = (): void => cb();
			ipcRenderer.on("update:not-available", listener);
			return () => ipcRenderer.removeListener("update:not-available", listener);
		},
		onUpdateProgress: (cb: (p: { percent: number; bytesPerSecond: number }) => void): (() => void) => {
			const listener = (_e: unknown, p: { percent: number; bytesPerSecond: number }): void => cb(p);
			ipcRenderer.on("update:progress", listener);
			return () => ipcRenderer.removeListener("update:progress", listener);
		},
		onUpdateDownloaded: (cb: () => void): (() => void) => {
			const listener = (): void => cb();
			ipcRenderer.on("update:downloaded", listener);
			return () => ipcRenderer.removeListener("update:downloaded", listener);
		},
		downloadUpdate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("update:download"),
		installUpdate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("update:install"),
		hasDownloadedUpdate: (): Promise<boolean> => ipcRenderer.invoke("update:has-downloaded"),
		checkUpdate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("update:check"),
	},
} as const;

contextBridge.exposeInMainWorld("api", api);
