import * as path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import electronUpdater from "electron-updater";
import {
	DEFAULT_WORKSPACE_DIR,
	ensureSidecar,
	resolveWorkspaceDir,
	type SidecarHandle,
	terminateSidecar,
} from "./sidecar.js";

const TRAY_ICON_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNgoBH4jwNTpJkoQ/4TiSnSjNWQ/2TiUQOoaQDF0UiVhESVpEyVzEQSAADQgJtl5l/1yAAAAABJRU5ErkJggg==";

const FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>OMP Desktop</title></head>
<body style="font-family: system-ui; padding: 2rem; background: #111; color: #eee">
<h1>OMP Desktop</h1>
<p>桌面壳已启动，连接 ws://127.0.0.1:7891/ws。通过托盘菜单「显示」管理窗口。</p>
</body>
</html>`;

let mainWindow: BrowserWindow | null = null;
let _tray: Tray | null = null;
let sidecar: SidecarHandle | null = null;
let workspaceDir: string = DEFAULT_WORKSPACE_DIR;
let isQuitting = false;

function createMainWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		show: false,
		webPreferences: {
			preload: path.join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	win.once("ready-to-show", () => win.show());
	win.on("close", event => {
		if (!isQuitting) {
			event.preventDefault();
			win.hide();
		}
	});
	win.on("closed", () => {
		if (mainWindow === win) mainWindow = null;
	});

	const devUrl = process.env.OMP_DESKTOP_DEV_URL?.trim();
	if (devUrl) {
		// 开发/覆盖：优先走 dev server。
		win.loadURL(devUrl).catch(err => console.error("desktop: load dev url failed", err));
	} else if (app.isPackaged) {
		// 生产：加载打包内 web-app dist（electron-builder extraResources → renderer/）。
		const rendererIndex = path.join(process.resourcesPath, "renderer", "index.html");
		win.loadFile(rendererIndex).catch(err => {
			console.error("desktop: load renderer failed, falling back to placeholder", err);
			win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FALLBACK_HTML)}`);
		});
	} else {
		// 开发但未配置 dev server：保持现有占位兜底。
		win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FALLBACK_HTML)}`);
	}

	return win;
}

function showMainWindow(): void {
	if (!mainWindow) {
		mainWindow = createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

function createTray(): Tray {
	const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
	icon.setTemplateImage(true);
	const item = new Tray(icon);
	item.setToolTip("OMP Desktop");
	item.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "显示", click: () => showMainWindow() },
			{ type: "separator" },
			{ label: "退出", click: () => void quitApp() },
		]),
	);
	item.on("click", () => showMainWindow());
	return item;
}

function setupIpc(): void {
	ipcMain.handle("sidecar:get-workspace-dir", () => workspaceDir);
	ipcMain.handle("sidecar:set-workspace-dir", async (_event, dir: string) => {
		const next = resolveWorkspaceDir(dir);
		const changed = next !== workspaceDir;
		workspaceDir = next;
		if (changed) {
			await restartSidecar(next);
		}
		return { ok: true, workspaceDir: next };
	});
	// 壳版本（electron-updater 对比新版本用；渲染层设置页展示）。
	ipcMain.handle("app:get-version", () => app.getVersion());
	// 更新流：renderer 触发检查/下载/安装（事件经 update:* channel 广播）。
	ipcMain.handle("update:check", () => checkUpdatesManual());
	ipcMain.handle("update:download", () => downloadUpdate());
	ipcMain.on("update:install", () => installUpdate());
}

async function restartSidecar(next: string): Promise<void> {
	await terminateSidecar(sidecar);
	sidecar = await ensureSidecar({ workspaceDir: next, resourcesPath: process.resourcesPath });
}

async function quitApp(): Promise<void> {
	isQuitting = true;
	const handle = sidecar;
	sidecar = null;
	await terminateSidecar(handle);
	app.quit();
}

function configureUpdater(): void {
	// 镜像开关：大陆环境可 export OMP_UPDATE_MIRROR=https://… 切到私有 generic 源。
	const { autoUpdater } = electronUpdater;
	const mirror = process.env.OMP_UPDATE_MIRROR?.trim();
	if (mirror) {
		autoUpdater.setFeedURL({ provider: "generic", url: mirror });
	} else {
		autoUpdater.setFeedURL({ provider: "github", owner: "klong13579", repo: "oh-my-pi" });
	}
	// 手动触发下载（不在后台静默下载）。UI 流：available → 用户点「下载」→ progress → downloaded → 用户点「重启更新」。
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	const send = (channel: string, payload?: unknown): void => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
	};
	autoUpdater.on("update-available", () => send("update:available"));
	autoUpdater.on("update-not-available", () => send("update:not-available"));
	autoUpdater.on("download-progress", p =>
		send("update:progress", { percent: p.percent, bytesPerSecond: p.bytesPerSecond }),
	);
	autoUpdater.on("update-downloaded", () => send("update:downloaded"));
	autoUpdater.on("error", err => {
		console.error("desktop: updater error (镜像/网络不可达时预期):", err.message);
	});
}

/** 启动后延迟检查更新（不打和 sidecar 竞争首帧；失败不阻塞启动）。 */
function checkForUpdates(): void {
	const { autoUpdater } = electronUpdater;
	autoUpdater.checkForUpdates().catch(err => {
		console.warn("desktop: checkForUpdates failed", err);
	});
}

/** renderer 手动触发「检查更新」（update:check IPC），结果经 update:available / update:not-available 提示。 */
async function checkUpdatesManual(): Promise<{ ok: boolean; error?: string }> {
	try {
		const { autoUpdater } = electronUpdater;
		const result = await autoUpdater.checkForUpdates();
		// electron-updater 在无新版本时只触发 update-not-available 事件，不 resolve 明确值——
		// 这里依赖事件广播即可（main.ts configureUpdater 已注册 update-not-available）。
		return { ok: true, ...(result?.updateInfo ? {} : {}) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** renderer 请求下载新版本（update:download IPC）。 */
async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
	try {
		const { autoUpdater } = electronUpdater;
		await autoUpdater.downloadUpdate();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** renderer 请求立即更新并退出（update:install IPC）。 */
function installUpdate(): void {
	const { autoUpdater } = electronUpdater;
	autoUpdater.quitAndInstall();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
	app.quit();
} else {
	app.on("second-instance", () => showMainWindow());

	app.whenReady().then(async () => {
		workspaceDir = resolveWorkspaceDir(undefined);
		sidecar = await ensureSidecar({ workspaceDir, resourcesPath: process.resourcesPath });
		setupIpc();
		mainWindow = createMainWindow();
		_tray = createTray();
		configureUpdater();
		// 启动后延迟 30s 检查更新（避开首帧/侧载竞争；失败不阻塞）。
		setTimeout(() => checkForUpdates(), 30_000);
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			mainWindow = createMainWindow();
		} else {
			showMainWindow();
		}
	});

	app.on("window-all-closed", () => {
		// 托盘常驻：关窗不退出。
	});

	app.on("before-quit", () => {
		isQuitting = true;
		if (sidecar) {
			terminateSidecar(sidecar).catch(() => {});
			sidecar = null;
		}
	});
}
