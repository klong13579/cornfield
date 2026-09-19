/**
 * 桌面壳（Electron）暴露到 `window.api` 的全部面 —— 渲染层**唯一一份**声明。
 *
 * 契约的对侧是 `packages/desktop/src/preload.ts`：那边 `contextBridge.exposeInMainWorld("api", …)`
 * 暴露的正是这些方法。两个包之间没有类型依赖（desktop 是壳、web-app 是页面），靠这份声明与
 * 那边的实现逐字段对齐 —— 所以 `window` 只在这里被读一次，别处再写一份 `(window as …).api`
 * 就是第二份真相，迟早与这份漂移。
 *
 * **网页直开**（`cornfield serve` + 浏览器，没有壳）时 `window` 上没有 `api`：所有访问器都返回
 * `undefined`。调用方据此**不画**依赖壳的控件 —— 画一个点了没反应的按钮比没有这个按钮更坏
 * （仓库既有纪律，见 ProjectSwitcher 的刷新钮与设置页的「检查更新」）。
 *
 * 「选一个目录」的答复形状不在这里定义：它有两条通路（壳 / serve），不是壳的私有物 ——
 * 见 `lib/path-picker`。
 */

import type { DirectoryPicker, PickDirectoryResult } from "./path-picker";

/** 原生目录选择器（`dialog:pick-directory`）。 */
export interface DesktopDialogBridge {
	pickDirectory: (defaultPath?: string) => Promise<PickDirectoryResult> | PickDirectoryResult;
}

/** sidecar 工作目录（`sidecar:*`）。 */
export interface DesktopSidecarBridge {
	setWorkspaceDir: (dir: string) => Promise<unknown> | unknown;
	getWorkspaceDir?: () => Promise<string> | string;
}

/** 壳版本与更新流（`app:*` / `update:*`）。 */
export interface DesktopAppBridge {
	getVersion: () => Promise<string> | string;
	onUpdateAvailable: (cb: () => void) => () => void;
	onUpdateNotAvailable: (cb: () => void) => () => void;
	onUpdateProgress: (cb: (p: { percent: number; bytesPerSecond: number }) => void) => () => void;
	onUpdateDownloaded: (cb: () => void) => () => void;
	downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
	installUpdate: () => Promise<{ ok: boolean; error?: string }>;
	hasDownloadedUpdate: () => Promise<boolean>;
	checkUpdate: () => Promise<{ ok: boolean; error?: string }>;
}

/** 壳暴露的全部面。每个字段都可选：旧壳没有新方法，网页直开什么都没有。 */
export interface DesktopApi {
	sidecar?: DesktopSidecarBridge;
	dialog?: DesktopDialogBridge;
	app?: DesktopAppBridge;
}

/**
 * 当前页面的壳桥，没有壳（含 SSR / 静态渲染）时 `undefined`。
 *
 * 每次调用都重读 `window`：测试里换掉 `globalThis.window` 后同一次进程内的后续调用能看到新值，
 * 不需要在模块加载时就把答案固定下来。
 */
export function desktopApi(): DesktopApi | undefined {
	if (typeof window === "undefined") return undefined;
	return (window as Window & { api?: DesktopApi }).api;
}

/**
 * 可用的目录选择器，没有壳（或旧壳没这个方法）时 `undefined` —— 调用方据此决定画不画浏览按钮。
 *
 * 返回的是**绑好接收者的调用**，不是把方法摘出来：摘出来的那一个在别处调用时丢掉 `this`，
 * 今天 preload 的实现恰好不用 `this`，明天加一行用 `this` 的代码就会静默炸在用户手里。
 */
export function directoryPicker(): DirectoryPicker | undefined {
	const api = desktopApi();
	const bridge = api?.dialog;
	if (bridge === undefined || typeof bridge.pickDirectory !== "function") return undefined;
	return (defaultPath?: string) => Promise.resolve(bridge.pickDirectory.call(bridge, defaultPath));
}
