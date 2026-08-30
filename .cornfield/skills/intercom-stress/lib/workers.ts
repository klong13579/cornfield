/**
 * Worker lifecycle: locate the pi binary, spawn headless interactive pi
 * sessions under a sized PTY, discover their intercom session ids by cwd/pid,
 * and kill them for fault injection.
 */

import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { $ } from "bun";
import type { BrokerSession } from "./broker";
import type { SessionInfo } from "../../../../packages/coding-agent/src/intercom-extension/types";

export interface SpawnedWorker {
	role: string;
	workdir: string;
	wrapperPid: number;
	childPid: number | null;
	session: SessionInfo | null;
}

export async function resolvePiBin(): Promise<string> {
	const candidates: string[] = [];
	const envPi = process.env.PI_INTERCOM_PI_BIN?.trim() || process.env.PI_BIN?.trim();
	if (envPi) candidates.push(envPi);
	// The worker processes must ship the intercom extension. The bare `pi`
	// wrapper script may not (it is a node shim without the compiled agent);
	// prefer the compiled binary the project installs as `cornfield`.
	candidates.push("cornfield", "~/.local/bin/cornfield");
	candidates.push("pi");

	for (const candidate of candidates) {
		if (candidate.startsWith("~/")) {
			const resolved = join(homedir(), candidate.slice(2));
			try {
				const info = await stat(resolved);
				if (info.isFile()) return resolved;
			} catch {
				// try the next candidate
			}
			continue;
		}
		if (candidate.includes("/")) {
			try {
				const info = await stat(candidate);
				if (info.isFile()) return candidate;
			} catch {
				// try the next candidate
			}
			continue;
		}
		const which = await $`which ${candidate}`.quiet().nothrow();
		if (which.exitCode === 0) {
			const resolved = which.stdout.toString().trim();
			if (resolved) return resolved;
		}
	}
	throw new Error("worker binary not found: set PI_INTERCOM_PI_BIN or PI_BIN, or put cornfield/pi on PATH");
}

function ptyHelperPath(): string {
	return join(dirname(new URL(import.meta.url).pathname), "pty-helper.py");
}

export async function spawnWorker(options: { role: string; baseDir: string; piBin: string }): Promise<SpawnedWorker> {
	const workdir = join(options.baseDir, options.role);
	await mkdir(workdir, { recursive: true });

	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(["python3", ptyHelperPath(), options.piBin], {
			cwd: workdir,
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to start worker via python3 pty (is python3 installed?): ${message}`);
	}

	const childPid = await readChildPid(proc);

	return {
		role: options.role,
		workdir,
		wrapperPid: proc.pid,
		childPid,
		session: null,
	};
}

async function readChildPid(proc: Bun.Subprocess): Promise<number | null> {
	const stream = proc.stdout;
	if (!stream) return null;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		let buffer = "";
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (value) buffer += decoder.decode(value);
			const nl = buffer.indexOf("\n");
			if (nl >= 0) {
				const match = /^CHILD_PID (\d+)/.exec(buffer.slice(0, nl).trim());
				return match ? Number(match[1]) : null;
			}
			if (done) break;
		}
		return null;
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

export async function discoverWorker(
	broker: BrokerSession,
	worker: SpawnedWorker,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SessionInfo> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const pollMs = options.pollMs ?? 500;
	let target: string;
	try {
		target = await realpath(worker.workdir);
	} catch {
		target = worker.workdir;
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sessions = await broker.client.listSessions({ timeoutMs: 4000 });
		for (const session of sessions) {
			let sessionCwd = session.cwd;
			try {
				sessionCwd = await realpath(session.cwd);
			} catch {
				// keep the raw cwd as reported
			}
			if (sessionCwd !== target) continue;
			if (worker.childPid !== null && session.pid !== worker.childPid) continue;
			worker.session = session;
			return session;
		}
		await Bun.sleep(pollMs);
	}
	throw new Error(`worker '${worker.role}' (${worker.workdir}) did not register with the intercom broker within ${timeoutMs}ms`);
}

export function killWorker(worker: SpawnedWorker, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
	if (worker.childPid !== null) {
		try {
			process.kill(worker.childPid, signal);
		} catch {
			// already dead
		}
	}
	// The pty wrapper exits once its child is gone; nudge it anyway.
	try {
		process.kill(worker.wrapperPid, "SIGTERM");
	} catch {
		// already dead
	}
}

export function shutdownWorkers(workers: SpawnedWorker[]): void {
	for (const worker of workers) killWorker(worker, "SIGTERM");
}