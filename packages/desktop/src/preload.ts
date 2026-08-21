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
} as const;

contextBridge.exposeInMainWorld("api", api);
