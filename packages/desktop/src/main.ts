import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
	// 关键：Squirrel 安装前会触发 before-quit-for-update（而非正常 before-quit）——
	// 必须在此设 isQuitting，否则窗口 close 拦截（托盘常驻）会阻止 app 退出，安装卡死（实测）。
	// 注：AppUpdaterEvents 类型未声明该事件，运行时真实存在（electron-updater 官方事件），用 as 断言。
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(autoUpdater as unknown as { on: (e: string, cb: () => void) => void }).on("before-quit-for-update", () => {
		isQuitting = true;
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

/**
 * renderer 请求立即更新并退出（update:install IPC）。
 *
 * 自举安装路径（绕过 Squirrel 签名校验——macOS 上 Squirrel.Mac 强制要求正式
 * Developer ID 签名（SQRLCodeSignatureErrorDomain，实测 adhoc 被拒）；但我们的
 * 部署目标是用户目录（~/Applications，可写），可以用本地脚本完成 zip 替换：
 *
 * 1. 写 helper 脚本到临时目录，detached spawn（不随 app 退出）
 * 2. helper 等旧 app 进程退出 → 解压已下载 zip → 原子替换 .app → open 重启
 *
 * 等以后有正式 Developer ID 证书，可切回 autoUpdater.quitAndInstall()（原生 Squirrel）。
 */
function installUpdate(): void {
	const { autoUpdater } = electronUpdater;
	// 下载缓存目录（electron-updater 的 updaterCacheDirName，app-update.yml 生成）。
	const cacheDir = path.join(os.homedir(), "Library", "Caches", updaterCacheDirName());
	const zipPath = findDownloadedZip(cacheDir);
	if (!zipPath) {
		console.error("desktop: install requested but no downloaded update found in", cacheDir);
		return;
	}
	const appPath = app.getAppPath(); // …/OMP Desktop.app/Contents/Resources/app.asar
	const bundleRoot = app.isPackaged ? path.dirname(path.dirname(path.dirname(appPath))) : "";
	if (!bundleRoot || !bundleRoot.endsWith(".app")) {
		console.error("desktop: cannot determine .app bundle root from", appPath);
		return;
	}
	const script = buildBootstrapScript({ zipPath, bundleRoot, targetApp: process.execPath });
	const scriptPath = path.join(os.tmpdir(), `omp-desktop-update-${Date.now()}.sh`);
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	// detached：不随 app 进程树退出，独立跑完替换+重启。
	childProcess.spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" }).unref();
	isQuitting = true;
	// 先试优雅退出（sidecar 排空），Squirrel 不再介入。
	app.quit();
}

/** electron-updater 的缓存目录名（app-update.yml updaterCacheDirName；与它读 configOnDisk 一致）。 */
function updaterCacheDirName(): string {
	return "@oh-my-pidesktop-updater";
}

/** 在缓存目录找 electron-updater 落盘的待安装 zip（pending 或根目录的 *.zip）。 */
function findDownloadedZip(cacheDir: string): string | null {
	try {
		for (const dir of [path.join(cacheDir, "pending"), cacheDir]) {
			const entries = fs.readdirSync(dir);
			const zip = entries.filter(e => e.endsWith(".zip")).map(e => path.join(dir, e));
			if (zip.length > 0) return zip[0];
		}
	} catch {
		// 目录不存在等
	}
	return null;
}

/** 生成自举安装脚本：等旧进程退出 → 解压 zip → 替换 .app → 重启。 */
function buildBootstrapScript(opts: { zipPath: string; bundleRoot: string; targetApp: string }): string {
	const { zipPath, bundleRoot, targetApp } = opts;
	// zip 内是裸 .app 目录（electron-builder mac zip 结构）。解压后取 <zipstem>.app。
	// 目标：替换整个 bundleRoot。helper 循环等旧可执行退出后执行替换。
	// 注意：模板字符串里 bash 变量引用用单引号包裹，避免被 TS 当插值。
	return `#!/bin/bash
set -e
ZIP="${zipPath}"
BUNDLE="${bundleRoot}"
# 等旧 app 完全退出（最多 30s）——用 zip 同目录的可执行名匹配
OLD_EXEC="${path.basename(targetApp)}"
for i in $(seq 1 60); do
  if ! pgrep -f "$OLD_EXEC" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
WORK=$(mktemp -d)
unzip -q -o "$ZIP" -d "$WORK"
NEW_APP=$(find "$WORK" -maxdepth 2 -name "*.app" -type d | head -1)
[ -n "$NEW_APP" ] || { echo "no .app in update zip"; exit 1; }
# 原子替换：先移旧到备份，再放新，删备份
if [ -d "$BUNDLE" ]; then rm -rf "$BUNDLE.old" 2>/dev/null || true; mv "$BUNDLE" "$BUNDLE.old" 2>/dev/null || true; fi
mv "$NEW_APP" "$BUNDLE"
rm -rf "$BUNDLE.old" "$WORK" 2>/dev/null || true
# adhoc 签名 app 本地打开不需要 Gatekeeper 放行；重启新版本
sleep 1
open "$BUNDLE"
exit 0
`;
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
