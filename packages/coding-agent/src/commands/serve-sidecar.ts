/**
 * `omp serve` sidecar 监督逻辑（从 packages/desktop/src/sidecar.ts 平搬）。
 *
 * 职责：确保 `127.0.0.1:7891` 上有一个 `omp serve` sidecar 在跑，并负责其
 * spawn / 守护 / 崩溃重启 / 版本（二进制解析）的对外语义。桌面壳（Electron）
 * 与原生壳（Zed fork 的 zomp_shell）共享同一套 spawn/守护契约：
 * - 空闲 → spawn 新 sidecar（cwd=工作目录，注入 OMP_SIDECAR=1）；
 * - 被遗留的我方 sidecar 占用 → 接管：SIGTERM 后重启；
 * - 被非我方进程占用 → 复用，不杀、不重启（返回 `{ state: "reused" }`）。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as timers from "node:timers/promises";
import { logger } from "@cornfield/utils";

export const SERVE_HOST = "127.0.0.1";
export const SERVE_PORT = 7891;
export const SIDECAR_ENV = "OMP_SIDECAR";
export const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), "workspace");

const SIDECAR_DRAIN_MS = 3000;
const PORT_FREE_POLL_INTERVAL_MS = 200;
const PORT_FREE_TIMEOUT_MS = 5000;

export interface SidecarOptions {
	/** sidecar（`omp serve`）的工作目录，对应 web-app「工作目录」设置。 */
	workspaceDir: string;
	/** 打包后的 resources 目录（Electron `process.resourcesPath`），用于定位打包内嵌的 omp 二进制。 */
	resourcesPath: string;
}

export interface SidecarHandle {
	child: childProcess.ChildProcess | null;
	state: "spawned" | "reused";
}

export type PortState = "free" | "ours" | "foreign";

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 解析工作目录：展开 `~/`，缺省/空/`~` 回退 `~/workspace`。 */
export function resolveWorkspaceDir(override?: string): string {
	const raw = override?.trim() ?? "";
	if (raw === "" || raw === "~" || raw === "~/") return DEFAULT_WORKSPACE_DIR;
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return path.resolve(raw);
}

/** 解析 omp 二进制路径，优先级与 gateway 的 `resolveDefaultOmpPath` 对齐并前插打包内嵌路径。 */
export function resolveOmpBinary(resourcesPath: string): string {
	const explicit = process.env.OMP_BINARY?.trim();
	if (explicit) return explicit;

	// 1. 打包内嵌（electron-builder extraResources 复制 ../coding-agent/dist/omp → omp-binary/omp）。
	const packaged = path.join(resourcesPath, "omp-binary", "omp");
	if (isExecutable(packaged)) return packaged;

	// 2. 规范安装位置（scripts/install.sh 产物）。
	const installed = path.join(os.homedir(), ".local", "bin", "omp");
	if (isExecutable(installed)) return installed;

	// 3. 开发 checkout 的构建产物。
	const devBuild = path.resolve(import.meta.dirname, "../../dist/omp");
	if (isExecutable(devBuild)) return devBuild;

	// 回退 PATH（开发机尚未构建二进制时）。
	return "omp";
}

function execFileOut(file: string, args: string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	childProcess.execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => {
		if (err) reject(err);
		else resolve(stdout);
	});
	return promise;
}

async function listenerPids(port: number): Promise<number[]> {
	try {
		const out = await execFileOut("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
		return out
			.split("\n")
			.map(line => Number.parseInt(line.trim(), 10))
			.filter(pid => Number.isInteger(pid) && pid > 0);
	} catch {
		return [];
	}
}

async function hasSidecarEnv(pid: number): Promise<boolean> {
	if (process.platform === "linux") {
		try {
			const environ = fs.readFileSync(path.join("/proc", String(pid), "environ"), "utf8");
			return environ.split("\0").includes(`${SIDECAR_ENV}=1`);
		} catch {
			return false;
		}
	}
	// macOS/BSD：`ps eww -p <pid> -o command=` 会把环境变量拼到命令行后。
	try {
		const out = await execFileOut("ps", ["eww", "-p", String(pid), "-o", "command="]);
		return out.includes(`${SIDECAR_ENV}=1`);
	} catch {
		return false;
	}
}

export function isPortListening(host: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host, port, timeout: 500 });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** 探测 7891 归属：free（空闲）/ ours（我方 sidecar 遗留）/ foreign（他方占用）。 */
export async function probePortState(): Promise<PortState> {
	const pids = await listenerPids(SERVE_PORT);
	if (pids.length > 0) {
		for (const pid of pids) {
			if (await hasSidecarEnv(pid)) return "ours";
		}
		return "foreign";
	}
	// lsof 缺失/权限不足时用 TCP 探测兜底，确认端口是否真的空闲。
	return (await isPortListening(SERVE_HOST, SERVE_PORT)) ? "foreign" : "free";
}

function spawnSidecar(options: SidecarOptions): childProcess.ChildProcess {
	const bin = resolveOmpBinary(options.resourcesPath);
	const child = childProcess.spawn(bin, ["serve", "--port", String(SERVE_PORT), "--host", SERVE_HOST], {
		cwd: options.workspaceDir,
		env: { ...process.env, [SIDECAR_ENV]: "1" },
		stdio: "ignore",
	});
	child.on("error", err => {
		logger.error("serve: failed to spawn omp serve sidecar", { bin, error: String(err) });
	});
	return child;
}

async function terminateOrphanSidecars(): Promise<void> {
	const pids = await listenerPids(SERVE_PORT);
	for (const pid of pids) {
		if (await hasSidecarEnv(pid)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// 进程在 lsof 与 kill 之间已退出，忽略。
			}
		}
	}
}

async function waitForPortFree(): Promise<void> {
	const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if ((await probePortState()) === "free") return;
		await timers.setTimeout(PORT_FREE_POLL_INTERVAL_MS);
	}
}

/**
 * 确保 7891 上有一个 `omp serve` sidecar：
 * - 空闲 → spawn 新 sidecar（cwd=工作目录，注入 OMP_SIDECAR=1）；
 * - 被遗留的我方 sidecar 占用 → 接管：SIGTERM 后重启；
 * - 被非我方进程占用 → 复用，不杀、不重启（返回 `{ state: "reused" }`）。
 */
export async function ensureSidecar(options: SidecarOptions): Promise<SidecarHandle> {
	const state = await probePortState();
	if (state === "foreign") {
		return { child: null, state: "reused" };
	}
	if (state === "ours") {
		await terminateOrphanSidecars();
		await waitForPortFree();
	}
	fs.mkdirSync(options.workspaceDir, { recursive: true });
	return { child: spawnSidecar(options), state: "spawned" };
}

/** 优雅终止 sidecar（SIGTERM，非 SIGKILL）；给一个排空窗口，超时后不再强杀。 */
export async function terminateSidecar(sidecar: SidecarHandle | null): Promise<void> {
	const child = sidecar?.child ?? null;
	if (!child?.pid) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("exit", () => resolve());
	child.kill("SIGTERM");
	await Promise.race([promise, timers.setTimeout(SIDECAR_DRAIN_MS)]);
}
