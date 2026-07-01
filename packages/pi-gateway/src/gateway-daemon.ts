/**
 * Gateway daemon — PID file management, orphan process cleanup, status reading.
 *
 * These are stateless, exported functions consumed by doctor.ts, CLI commands,
 * and service-installer.ts. They do NOT depend on the Gateway class.
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { getDataDir } from "./config";
import type { BridgeStat, QueueStat } from "./session-manager";
import type { ChannelHealth, GatewayConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

export const PID_FILE = "gateway.pid";
export const STATUS_FILE = "gateway.status.json";

// ═══════════════════════════════════════════════════════════════════════
// PID file helpers
// ═══════════════════════════════════════════════════════════════════════

/** Read PID file, return PID or null */
export async function readPidFile(pidPath: string): Promise<number | null> {
	try {
		const text = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(text.trim(), 10);
		if (!Number.isNaN(pid) && pid > 0) return pid;
	} catch {}
	return null;
}

export async function checkPidFile(dataDir: string, pidFile: string): Promise<boolean> {
	try {
		const pidText = await fs.readFile(path.join(dataDir, pidFile), "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (!Number.isNaN(pid) && pid > 0) {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		}
	} catch {}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Orphan cleanup
// ═══════════════════════════════════════════════════════════════════════

/** Kill orphaned omp --mode rpc processes (PPID=1) left from hard kills. */
export async function killOrphanRpcProcesses(): Promise<void> {
	try {
		const result = Bun.spawnSync(["ps", "-eo", "pid,ppid,args"]);
		if (result.exitCode !== 0) return;
		const lines = result.stdout.toString().trim().split("\n");
		for (const line of lines) {
			const parts = line.trim().split(/\s+/);
			if (parts.length < 3) continue;
			const pid = parseInt(parts[0], 10);
			const ppid = parseInt(parts[1], 10);
			const args = parts.slice(2).join(" ");
			if (
				!Number.isNaN(pid) &&
				!Number.isNaN(ppid) &&
				ppid === 1 &&
				args.includes("omp") &&
				args.includes("--mode rpc")
			) {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {
		// Best-effort
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway status
// ═══════════════════════════════════════════════════════════════════════

export interface GatewayDaemonStatus {
	running: boolean;
	pid?: number;
	startedAt?: string;
	stalePidFile?: boolean;
	/** Epoch ms when the status file was last written (staleness check for doctor). */
	statusWrittenAt?: number;
	channels?: Array<{ id: string; name: string; connected: boolean }>;
	accounts?: Array<{
		accountId: string;
		channelConnected: boolean;
		bridgeRunning: boolean;
		agentDir?: string;
		bridgeState?: string;
		/** Deep channel health, present when the channel exposes getHealth(). */
		channelHealth?: ChannelHealth;
	}>;
	/** Per-account agent-bridge snapshots (circuit/crash/lifecycle). */
	bridges?: BridgeStat[];
	/** Per-account inbound queue depth/age. */
	queues?: QueueStat[];
	scheduler?: { running: boolean; taskCount: number };
}

export async function getGatewayStatus(config?: GatewayConfig): Promise<GatewayDaemonStatus> {
	const dataDir = getDataDir(config);
	const pidPath = path.join(dataDir, PID_FILE);
	const statusPath = path.join(dataDir, STATUS_FILE);

	// Try to read cached status file for channel/account info
	let cachedStatus: Partial<GatewayDaemonStatus> = {};
	try {
		const statusText = await fs.readFile(statusPath, "utf-8");
		cachedStatus = JSON.parse(statusText);
	} catch {
		// status file not available
	}

	try {
		const pidText = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			await fs.unlink(pidPath).catch(() => {});
			// Same rationale as the stalePidFile branch above: don't
			// surface runtime fields from a snapshot taken under a
			// now-invalid PID file.
			return {
				running: false,
				statusWrittenAt: cachedStatus.statusWrittenAt,
			};
		}

		try {
			process.kill(pid, 0);
		} catch {
			await fs.unlink(pidPath).catch(() => {});
			// PID is dead — the cached status file is a stale snapshot of a
			// dead process. Do NOT spread its runtime fields (channels,
			// accounts, bridges, queues, scheduler) into the response: they
			// would mislead callers into thinking the gateway is still alive
			// and force them to add their own "is this PID actually alive?"
			// checks. Surface only enough metadata to diagnose the death.
			return {
				running: false,
				stalePidFile: true,
				pidWasAlive: pid,
				stoppedAt: cachedStatus.statusWrittenAt,
				statusWrittenAt: cachedStatus.statusWrittenAt,
			};
		}

		let startedAt: string | undefined;
		try {
			const stat = await fs.stat(pidPath);
			startedAt = stat.mtime.toLocaleString();
		} catch {
			// Best-effort
		}

		return { running: true, pid, startedAt, ...cachedStatus };
	} catch {
		return { running: false, ...cachedStatus };
	}
}

/**
 * Synchronously remove the gateway status file. Best-effort and idempotent.
 *
 * Crash handlers (uncaughtException, last-resort SIGTERM) cannot await
 * async cleanup — the process is about to exit and pending microtasks
 * will not complete. Callers run this in a try/catch and then
 * `process.exit(1)`.
 */
export function clearStatusFileSync(config?: GatewayConfig): void {
	try {
		const dataDir = getDataDir(config);
		const statusPath = path.join(dataDir, STATUS_FILE);
		fsSync.rmSync(statusPath, { force: true });
	} catch {
		// best-effort
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Daemon stop
// ═══════════════════════════════════════════════════════════════════════

/**
 * Stop the running gateway daemon by PID file.
 * Sends SIGTERM first, then SIGKILL if still alive.
 * Kills orphan RPC child processes in case of hard kill.
 */
export async function stopGatewayDaemon(): Promise<boolean> {
	const dataDir = getDataDir();
	const pidPath = path.join(dataDir, PID_FILE);

	try {
		const pidText = await fs.readFile(pidPath, "utf-8");
		const pid = parseInt(pidText.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) return false;

		// Check if process exists
		try {
			process.kill(pid, 0);
		} catch {
			await fs.unlink(pidPath).catch(() => {});
			return false;
		}

		// Kill orphan RPC children that might be left from previous hard kills
		await killOrphanRpcProcesses();

		// Send SIGTERM
		process.kill(pid, "SIGTERM");

		// Wait up to 5s for graceful shutdown
		for (let i = 0; i < 5; i++) {
			await Bun.sleep(1000);
			try {
				process.kill(pid, 0);
			} catch {
				await fs.unlink(pidPath).catch(() => {});
				return true;
			}
		}

		// Force kill main process + any remaining orphan children
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await killOrphanRpcProcesses();
		await fs.unlink(pidPath).catch(() => {});
		return true;
	} catch {
		return false;
	}
}
