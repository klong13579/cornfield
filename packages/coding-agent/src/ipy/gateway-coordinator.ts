import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { $flag, getClientDir, getConfigRootDir, isEnoent, logger, procmgr } from "@cornfield/utils";
import type { Subprocess } from "bun";
import { Settings } from "../config/settings";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { filterEnv, resolvePythonRuntime, selectKernelRuntime } from "./runtime";

const GATEWAY_DIR_NAME = "python-gateway";
const GATEWAY_INFO_FILE = "gateway.json";
const GATEWAY_USERS_FILE = "gateway.users";
const GATEWAY_LOCK_FILE = "gateway.lock";
const GATEWAY_STARTUP_TIMEOUT_MS = 30000;
const GATEWAY_LOCK_TIMEOUT_MS = GATEWAY_STARTUP_TIMEOUT_MS + 5000;
const GATEWAY_LOCK_RETRY_MS = 50;
const GATEWAY_LOCK_STALE_MS = GATEWAY_STARTUP_TIMEOUT_MS * 2;
const GATEWAY_LOCK_HEARTBEAT_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Where a profile's recorded gateway can live, relative to the config root.
 *
 * A profile is a client dir (`getClientDir()` — `~/.cornfield/agent` by
 * default, or whatever `CORNFIELD_CLIENT_DIR` points at). Agent homes
 * (`~/.cornfield/agents/<id>/`) and pre-migration backups each keep their own
 * `python-gateway/` under the same root, so a sweep that only looked at the
 * current client dir would happily kill a sibling profile's live gateway.
 *
 * Bounded on purpose: three shallow globs, not a walk of the whole config root
 * (the session tree alone is thousands of directories).
 */
const PROFILE_GATEWAY_INFO_GLOBS = [
	`${GATEWAY_DIR_NAME}/${GATEWAY_INFO_FILE}`,
	`agent/${GATEWAY_DIR_NAME}/${GATEWAY_INFO_FILE}`,
	`*/${GATEWAY_DIR_NAME}/${GATEWAY_INFO_FILE}`,
	`agents/*/${GATEWAY_DIR_NAME}/${GATEWAY_INFO_FILE}`,
];

export interface GatewayInfo {
	url: string;
	pid: number;
	startedAt: number;
	pythonPath?: string;
	venvPath?: string | null;
}

interface GatewayLockInfo {
	pid: number;
	startedAt: number;
}

interface AcquireResult {
	url: string;
	isShared: boolean;
}

let localGatewayProcess: Subprocess | null = null;
let localGatewayUrl: string | null = null;
let isCoordinatorInitialized = false;

async function allocatePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.unref();
	server.on("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (address && typeof address === "object") {
			const port = address.port;
			server.close((err: Error | null | undefined) => {
				if (err) {
					reject(err);
				} else {
					resolve(port);
				}
			});
		} else {
			server.close();
			reject(new Error("Failed to allocate port"));
		}
	});

	return promise;
}

function getGatewayDir(): string {
	return path.join(getClientDir(), GATEWAY_DIR_NAME);
}

function getGatewayInfoPath(): string {
	return path.join(getGatewayDir(), GATEWAY_INFO_FILE);
}

function getGatewayUsersPath(): string {
	return path.join(getGatewayDir(), GATEWAY_USERS_FILE);
}

function getGatewayLockPath(): string {
	return path.join(getGatewayDir(), GATEWAY_LOCK_FILE);
}

async function writeLockInfo(lockPath: string): Promise<void> {
	const payload: GatewayLockInfo = { pid: process.pid, startedAt: Date.now() };
	try {
		await Bun.write(lockPath, JSON.stringify(payload));
	} catch {
		// Ignore lock write failures
	}
}

async function readLockInfo(lockPath: string): Promise<GatewayLockInfo | null> {
	try {
		const raw = await Bun.file(lockPath).text();
		const parsed = JSON.parse(raw) as Partial<GatewayLockInfo>;
		if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
			return { pid: parsed.pid, startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0 };
		}
	} catch {
		// Ignore parse errors
	}
	return null;
}

async function ensureGatewayDir(): Promise<void> {
	const dir = getGatewayDir();
	await fs.promises.mkdir(dir, { recursive: true });
}

async function withGatewayLock<T>(handler: () => Promise<T>): Promise<T> {
	await ensureGatewayDir();
	const lockPath = getGatewayLockPath();
	const start = Date.now();
	while (true) {
		let fd: fs.promises.FileHandle | undefined;
		try {
			fd = await fs.promises.open(lockPath, "wx");
			let heartbeatRunning = true;
			const heartbeat = (async () => {
				while (heartbeatRunning) {
					await Bun.sleep(GATEWAY_LOCK_HEARTBEAT_MS);
					if (!heartbeatRunning) break;
					try {
						const now = new Date();
						await fs.promises.utimes(lockPath, now, now);
					} catch {
						// Ignore heartbeat errors
					}
				}
			})();
			try {
				await writeLockInfo(lockPath);
				return await handler();
			} finally {
				heartbeatRunning = false;
				void heartbeat.catch(() => {}); // Don't await - let it die naturally
				try {
					await fd.close();
					await fs.promises.unlink(lockPath);
				} catch {
					// Ignore lock cleanup errors
				}
			}
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "EEXIST") {
				let removedStale = false;
				try {
					const lockStat = await fs.promises.stat(lockPath);
					const lockInfo = await readLockInfo(lockPath);
					const lockPid = lockInfo?.pid;
					const lockAgeMs = lockInfo?.startedAt ? Date.now() - lockInfo.startedAt : Date.now() - lockStat.mtimeMs;
					const staleByTime = lockAgeMs > GATEWAY_LOCK_STALE_MS;
					const staleByPid = lockPid !== undefined && !procmgr.isPidRunning(lockPid);
					const staleByMissingPid = lockPid === undefined && staleByTime;
					if (staleByPid || staleByMissingPid) {
						await fs.promises.unlink(lockPath);
						removedStale = true;
						logger.warn("Removed stale shared gateway lock", { path: lockPath, pid: lockPid });
					}
				} catch {
					// Ignore stat errors; keep waiting
				}
				if (!removedStale) {
					if (Date.now() - start > GATEWAY_LOCK_TIMEOUT_MS) {
						throw new Error("Timed out waiting for shared gateway lock");
					}
					await Bun.sleep(GATEWAY_LOCK_RETRY_MS);
				}
				continue;
			}
			throw err;
		}
	}
}

async function readGatewayInfo(): Promise<GatewayInfo | null> {
	return await readGatewayInfoFile(getGatewayInfoPath());
}

/** Parse a `gateway.json` at an explicit path — used by the orphan sweep to
 *  read *other* profiles' records, not just this one's. Any unreadable or
 *  malformed file is `null`: a profile we cannot read is a profile we cannot
 *  prove safe to kill. */
async function readGatewayInfoFile(infoPath: string): Promise<GatewayInfo | null> {
	try {
		const content = await Bun.file(infoPath).text();
		const parsed = JSON.parse(content) as Partial<GatewayInfo>;

		if (typeof parsed.url !== "string" || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") {
			return null;
		}
		return {
			url: parsed.url,
			pid: parsed.pid,
			startedAt: parsed.startedAt,
			pythonPath: typeof parsed.pythonPath === "string" ? parsed.pythonPath : undefined,
			venvPath: typeof parsed.venvPath === "string" || parsed.venvPath === null ? parsed.venvPath : undefined,
		};
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

async function writeGatewayInfo(info: GatewayInfo): Promise<void> {
	const infoPath = getGatewayInfoPath();
	const tempPath = `${infoPath}.tmp`;
	await Bun.write(tempPath, JSON.stringify(info, null, 2));
	await fs.promises.rename(tempPath, infoPath);
}

async function clearGatewayInfo(): Promise<void> {
	const infoPath = getGatewayInfoPath();
	try {
		await fs.promises.unlink(infoPath);
	} catch {
		// Ignore errors on cleanup (file may not exist)
	}
}

async function readGatewayUsers(): Promise<number[]> {
	const usersPath = getGatewayUsersPath();
	try {
		const raw = await Bun.file(usersPath).text();
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Drop pids that no longer exist. Without this the file is append-only in
		// practice: a process that dies without reaching `shutdownSharedGateway`
		// (SIGKILL, OOM, terminal closed) leaves its pid behind forever, and every
		// subsequent read carries the corpse. Observed 2026-09-19: 36 pids, of
		// which 16 gateway processes were the only ones still alive.
		return parsed.filter(
			(p): p is number =>
				typeof p === "number" && Number.isFinite(p) && (p === process.pid || procmgr.isPidRunning(p)),
		);
	} catch {
		return [];
	}
}

async function writeGatewayUsers(users: number[]): Promise<void> {
	const usersPath = getGatewayUsersPath();
	const tempPath = `${usersPath}.tmp`;
	await Bun.write(tempPath, JSON.stringify(users));
	await fs.promises.rename(tempPath, usersPath);
}

async function addGatewayUser(): Promise<void> {
	const users = await readGatewayUsers();
	if (!users.includes(process.pid)) {
		users.push(process.pid);
	}
	await writeGatewayUsers(users);
}

async function removeGatewayUser(): Promise<number[]> {
	const users = await readGatewayUsers();
	const remaining = users.filter(p => p !== process.pid);
	if (remaining.length !== users.length) {
		await writeGatewayUsers(remaining);
	}
	return remaining;
}

async function isGatewayHealthy(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/kernelspecs`, {
			signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function isGatewayAlive(info: GatewayInfo): Promise<boolean> {
	if (!procmgr.isPidRunning(info.pid)) return false;
	return await isGatewayHealthy(info.url);
}

async function startGatewayProcess(
	cwd: string,
): Promise<{ url: string; pid: number; pythonPath: string; venvPath: string | null }> {
	const settings = await Settings.init();
	const { shell, env } = settings.getShellConfig();
	const filteredEnv = filterEnv(env);
	// The preflight decides which interpreter hosts kernels; consuming the same
	// selection here is what keeps "the check passed" and "the kernel runs on it"
	// from disagreeing. `null` can only mean the preflight was skipped
	// (`PI_PYTHON_SKIP_CHECK`), where the operator opted out of probing and the
	// highest-priority candidate is used unprobed.
	const selected = $flag("PI_PYTHON_SKIP_CHECK") ? null : (await selectKernelRuntime(cwd, filteredEnv)).runtime;
	const runtime = selected ?? resolvePythonRuntime(cwd, filteredEnv);
	const snapshotPath = await getOrCreateSnapshot(shell, env).catch((err: unknown) => {
		logger.warn("Failed to resolve shell snapshot for shared Python gateway", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	});

	const kernelEnv: Record<string, string | undefined> = {
		...runtime.env,
		PYTHONUNBUFFERED: "1",
		PI_SHELL_SNAPSHOT: snapshotPath ?? undefined,
	};

	const gatewayPort = await allocatePort();
	const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

	const gatewayProcess = Bun.spawn(
		[
			runtime.pythonPath,
			"-m",
			"kernel_gateway",
			"--KernelGatewayApp.ip=127.0.0.1",
			`--KernelGatewayApp.port=${gatewayPort}`,
			"--KernelGatewayApp.port_retries=0",
			"--KernelGatewayApp.allow_origin=*",
			"--JupyterApp.answer_yes=true",
		],
		{
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			detached: true,
			env: kernelEnv,
		},
	);

	let exited = false;
	gatewayProcess.exited
		.catch(() => {})
		.then(() => {
			exited = true;
		});

	const startTime = Date.now();
	while (Date.now() - startTime < GATEWAY_STARTUP_TIMEOUT_MS) {
		if (exited) {
			throw new Error("Gateway process exited during startup");
		}
		if (await isGatewayHealthy(gatewayUrl)) {
			localGatewayProcess = gatewayProcess;
			localGatewayUrl = gatewayUrl;
			return {
				url: gatewayUrl,
				pid: gatewayProcess.pid,
				pythonPath: runtime.pythonPath,
				venvPath: runtime.venvPath ?? null,
			};
		}
		await Bun.sleep(100);
	}

	gatewayProcess.kill();
	throw new Error("Gateway startup timeout");
}

async function killGateway(pid: number, context: string): Promise<void> {
	try {
		await procmgr.terminate({ target: pid });
	} catch (err) {
		logger.warn("Failed to kill shared gateway process", {
			error: err instanceof Error ? err.message : String(err),
			pid,
			context,
		});
	}
}

// ── Orphan sweep ─────────────────────────────────────────────────────
//
// The shared-gateway design keeps exactly one gateway per machine per profile,
// reachable only through its `gateway.json`. That single handle is also its
// weakness: when the file is lost (moved aside by a migration, overwritten by
// a racing start, deleted with the client dir) the gateway keeps running with
// nothing left to reach it or to stop it, and the next session happily spawns
// another one. Observed 2026-09-19: 16 orphaned `kernel_gateway` processes,
// the oldest 8 days old, every one of them PPID=1 with no info file pointing
// at it.
//
// The sweep runs under the acquire lock (so no other process can be mid-start)
// and only touches processes for which all three of these hold:
//   1. `-m kernel_gateway` in argv — it is one of ours;
//   2. PPID 1 — the process that spawned it is gone, so no live owner exists;
//   3. no `gateway.json` anywhere in the config root records its pid.
// If the recorded-pid set cannot be enumerated, the sweep does nothing.

/**
 * Pure selection half of the sweep: which pids from a `ps -eo pid,ppid,args`
 * dump are orphaned Python kernel gateways?
 *
 * Exported for the contract test — the rules are the whole safety story here.
 */
export function selectOrphanKernelGateways(psOutput: string, referencedPids: ReadonlySet<number>): number[] {
	const orphans: number[] = [];
	for (const raw of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(raw);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		const args = match[3] ?? "";
		if (!Number.isFinite(pid) || ppid !== 1) continue;
		if (pid === process.pid) continue;
		if (referencedPids.has(pid)) continue;
		if (!/-m\s+kernel_gateway(?:\s|$)/.test(args)) continue;
		orphans.push(pid);
	}
	return orphans;
}

/**
 * Every pid recorded in any profile's `gateway.json` under the config root
 * (plus this client dir's own record).
 *
 * Returns `null` when the enumeration itself failed — the caller must not read
 * a partial set as "these are the only live gateways", because that reading is
 * what kills someone else's session.
 */
async function collectReferencedGatewayPids(): Promise<Set<number> | null> {
	const pids = new Set<number>();
	const candidates = new Set<string>([getGatewayInfoPath()]);
	const root = getConfigRootDir();
	try {
		for (const pattern of PROFILE_GATEWAY_INFO_GLOBS) {
			for await (const match of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
				candidates.add(path.join(root, match));
			}
		}
	} catch (err) {
		logger.warn("Python gateway orphan sweep: profile enumeration failed, skipping", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	for (const file of candidates) {
		const info = await readGatewayInfoFile(file);
		if (info) pids.add(info.pid);
	}
	return pids;
}

/**
 * Terminate Python kernel gateway processes nothing references any more.
 *
 * `referencedPids` is an injection point for the contract test; production
 * callers pass nothing and let the sweep enumerate the records itself.
 * Returns the pids it signalled (SIGTERM — the gateway's own shutdown path is
 * cleaner than SIGKILL for a Jupyter process holding kernels).
 */
export async function reapOrphanKernelGateways(referencedPids?: ReadonlySet<number>): Promise<number[]> {
	const referenced = referencedPids ?? (await collectReferencedGatewayPids());
	if (referenced === null) return [];

	let psOutput: string;
	try {
		const result = Bun.spawnSync(["ps", "-eo", "pid,ppid,args"]);
		if (result.exitCode !== 0) return [];
		psOutput = result.stdout.toString();
	} catch (err) {
		logger.debug("Python gateway orphan sweep: ps unavailable", {
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	const killed: number[] = [];
	for (const pid of selectOrphanKernelGateways(psOutput, referenced)) {
		logger.warn("Reaping orphaned Python kernel gateway", { pid });
		try {
			process.kill(pid, "SIGTERM");
			killed.push(pid);
		} catch (err) {
			logger.debug("Python gateway orphan sweep: kill failed", {
				pid,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return killed;
}

export async function acquireSharedGateway(cwd: string): Promise<AcquireResult | null> {
	try {
		return await withGatewayLock(async () => {
			// Sweep first, while we hold the lock: no other process can be mid-start,
			// and our own record (written below) is not needed to protect the
			// gateway we are about to reuse or spawn — the sweep only touches
			// processes nothing records any more. Best-effort: a failed sweep must
			// never fail the acquisition.
			await reapOrphanKernelGateways().catch(err => {
				logger.warn("Python gateway orphan sweep failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});

			const existingInfo = await logger.time("acquireSharedGateway:readInfo", readGatewayInfo);
			if (existingInfo) {
				if (await logger.time("acquireSharedGateway:isAlive", isGatewayAlive, existingInfo)) {
					localGatewayUrl = existingInfo.url;
					isCoordinatorInitialized = true;
					await addGatewayUser();
					logger.debug("Reusing global Python gateway", { url: existingInfo.url });
					return { url: existingInfo.url, isShared: true };
				}

				logger.debug("Cleaning up stale gateway info", { pid: existingInfo.pid });
				if (procmgr.isPidRunning(existingInfo.pid)) {
					await killGateway(existingInfo.pid, "stale");
				}
				await clearGatewayInfo();
			}

			const { url, pid, pythonPath, venvPath } = await logger.time(
				"acquireSharedGateway:startGateway",
				startGatewayProcess,
				cwd,
			);
			const info: GatewayInfo = {
				url,
				pid,
				startedAt: Date.now(),
				pythonPath,
				venvPath,
			};
			await writeGatewayInfo(info);
			isCoordinatorInitialized = true;
			await addGatewayUser();
			logger.debug("Started global Python gateway", { url, pid });
			return { url, isShared: true };
		});
	} catch (err) {
		logger.warn("Failed to acquire shared gateway, falling back to local", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export async function releaseSharedGateway(): Promise<void> {
	if (!isCoordinatorInitialized) return;
	// Per-kernel release: remove our PID from users to prevent bloat.
	// Does NOT kill the gateway or clear module state — multiple kernels
	// in the same process share one PID entry, and killing on first
	// release would break sibling kernels. Gateway lifecycle is managed
	// at executor shutdown (shutdownSharedGateway) or stale detection
	// (acquireSharedGateway).
	try {
		await withGatewayLock(async () => {
			const info = await readGatewayInfo();
			if (!info) return;
			await removeGatewayUser();
		});
	} catch (err) {
		logger.warn("Failed to release shared gateway", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function getSharedGatewayUrl(): Promise<string | null> {
	if (localGatewayUrl) return localGatewayUrl;
	return (await readGatewayInfo())?.url ?? null;
}

export async function isSharedGatewayActive(): Promise<boolean> {
	return (await getGatewayStatus()).active;
}

export interface GatewayStatus {
	active: boolean;
	url: string | null;
	pid: number | null;
	uptime: number | null;
	pythonPath: string | null;
	venvPath: string | null;
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
	const info = await readGatewayInfo();
	if (!info) {
		return {
			active: false,
			url: null,
			pid: null,
			uptime: null,
			pythonPath: null,
			venvPath: null,
		};
	}
	const active = procmgr.isPidRunning(info.pid);
	return {
		active,
		url: info.url,
		pid: info.pid,
		uptime: active ? Date.now() - info.startedAt : null,
		pythonPath: info.pythonPath ?? null,
		venvPath: info.venvPath ?? null,
	};
}

export async function shutdownSharedGateway(): Promise<void> {
	try {
		await withGatewayLock(async () => {
			const info = await readGatewayInfo();
			if (!info) return;

			// Remove our PID from the users list
			const remaining = await removeGatewayUser();

			// Filter out any dead PIDs from remaining users
			const alive = remaining.filter(p => p !== info.pid && procmgr.isPidRunning(p));

			// Only kill the gateway process if no other process is using it
			if (alive.length > 0) {
				logger.debug("Shared gateway still in use, skipping shutdown", {
					remainingUsers: alive,
				});
				return;
			}

			if (procmgr.isPidRunning(info.pid)) {
				await killGateway(info.pid, "shutdown");
			}
			await clearGatewayInfo();
		});
	} catch (err) {
		logger.warn("Failed to shutdown shared gateway", {
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		if (localGatewayProcess) {
			await killGateway(localGatewayProcess.pid, "shutdown-local");
		}
		localGatewayProcess = null;
		localGatewayUrl = null;
		isCoordinatorInitialized = false;
	}
}
