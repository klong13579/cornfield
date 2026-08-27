import { contextBridge, ipcRenderer } from "electron";

/**
 * 最小 preload bridge：只暴露 sidecar 工作目录读写，供 web-app 设置页调用。
 * contextIsolation=true（main.ts webPreferences 固定开启），renderer 无法直接触碰 Node。
 * 契约与 T2（packages/web-app SettingsView）对齐：window.api.sidecar.setWorkspaceDir(dir)。
 */
const api = {
	sidecar: {
		setWorkspaceDir: (dir: string): Promise<{ ok: boolean; workspaceDir: string }> =>
			ipcRenderer.invoke("sidecar:set-workspace-dir", dir),
		getWorkspaceDir: (): Promise<string> => ipcRenderer.invoke("sidecar:get-workspace-dir"),
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
