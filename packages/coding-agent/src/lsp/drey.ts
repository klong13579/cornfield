import * as fs from "node:fs";
import * as path from "node:path";
import { $flag, $which, getLogsDir, logger } from "@cornfield/utils";

/**
 * drey integration for LSP server multiplexing.
 *
 * drey fronts a language server on stdio and forwards to a daemon that owns one
 * real server per workspace, so N sessions share one instance instead of
 * spawning N. Measured on this repo on 2026-09-19 (TS 6.0.3, `vmmap` physical
 * footprint): one `typescript-language-server` per session costs 1.1–4.0GB and
 * a session actually spawns two `tsserver` processes, so four TUI sessions held
 * ~12.5GB. Two clients attached to one drey backend shared it with no new
 * `tsserver` process, and two clients holding *different unsaved edits to the
 * same file* each received only their own diagnostics.
 *
 * Why drey and not lspmux, which already multiplexes rust-analyzer for us:
 * lspmux drops server-initiated requests, and typescript-language-server sends
 * a `workspace/configuration` request for every document it opens (measured:
 * 61 requests for 61 opened documents). With those answered by nobody, each
 * opened file stalls. drey forwards server requests and answers them from the
 * lowest attached client id.
 *
 * Integration is transparent: without drey installed — or if its daemon cannot
 * be started — the command is returned unchanged and the server is spawned
 * directly.
 */

// =============================================================================
// Types
// =============================================================================

export interface DreyWrappedCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * LSP server commands drey fronts, mapped to drey's own builtin server name.
 *
 * Only typescript-language-server: it is the one server measured to hold GBs per
 * session, and drey ships a builtin profile for it. Adding a server here means
 * drey's builtin must exist under that name and use the same args (see
 * `DREY_BUILTIN_ARGS`) — a name drey does not know is rejected by its daemon.
 */
const DREY_SERVER_NAMES: Record<string, string> = {
	"typescript-language-server": "typescript",
};

/**
 * Args drey's builtin profile passes to each server. When cornfield's config
 * asks for something different we decline to multiplex instead of handing the
 * server over: the daemon spawns with *its* args, so a configured flag would be
 * silently dropped — a wrong answer disguised as a working one.
 */
const DREY_BUILTIN_ARGS: Record<string, string[]> = {
	typescript: ["--stdio"],
};

/** Timeout for the daemon liveness check (`drey status`). */
const LIVENESS_TIMEOUT_MS = 1_000;

/** How long to wait for a freshly started daemon to answer. */
const DAEMON_STARTUP_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the daemon. */
const DAEMON_POLL_INTERVAL_MS = 250;

// =============================================================================
// Paths
// =============================================================================

/** Path of the drey daemon log (~/.cornfield/logs/drey.log). */
export function getDreyLogPath(): string {
	return path.join(getLogsDir(), "drey.log");
}

// =============================================================================
// Detection
// =============================================================================

/** Whether drey has a profile that can front this server command. */
export function isDreySupported(command: string): boolean {
	return DREY_SERVER_NAMES[path.basename(command)] !== undefined;
}

/**
 * Locate the drey binary. Returns null when drey is not installed or when
 * multiplexing is disabled via CORNFIELD_DISABLE_DREY=1.
 */
export async function findDreyBinary(): Promise<string | null> {
	if ($flag("CORNFIELD_DISABLE_DREY")) {
		return null;
	}
	return $which("drey");
}

/**
 * Is a drey daemon answering? `drey status` exits non-zero when none is
 * running, which is the only signal we need.
 */
export async function checkDaemonRunning(binaryPath: string): Promise<boolean> {
	try {
		const proc = Bun.spawn([binaryPath, "status"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const exited = await Promise.race([proc.exited, Bun.sleep(LIVENESS_TIMEOUT_MS).then(() => null)]);
		if (exited === null) {
			proc.kill();
			return false;
		}
		return exited === 0;
	} catch (err) {
		logger.debug("drey status failed", { binaryPath, error: String(err) });
		return false;
	}
}

/** Poll `drey status` until the daemon answers (or timeout). */
export async function pollDaemonRunning(
	binaryPath: string,
	timeoutMs: number = DAEMON_STARTUP_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await checkDaemonRunning(binaryPath)) {
			return true;
		}
		await Bun.sleep(DAEMON_POLL_INTERVAL_MS);
	}
	return false;
}

/**
 * Start the drey daemon detached, with its stdio redirected to a log file.
 *
 * Detached on purpose: a daemon started by a `drey serve` shim inherits the
 * shim's stdio — which is cornfield's pipe — and then outlives the session still
 * holding it, so the client never sees EOF. Starting it ourselves, once, with
 * stdio on a log file is what keeps that from happening.
 */
export async function ensureDreyDaemon(binaryPath: string): Promise<boolean> {
	const logPath = getDreyLogPath();
	try {
		await Bun.write(logPath, ""); // ensure the logs dir and file exist
		const logFd = fs.openSync(logPath, "a");
		const proc = Bun.spawn([binaryPath, "daemon"], {
			stdin: "ignore",
			stdout: logFd,
			stderr: logFd,
			detached: true,
		});
		proc.unref?.();
		// The child holds its own copy of the descriptor; ours would leak.
		fs.closeSync(logFd);
	} catch (err) {
		logger.error("drey daemon failed to start", { binaryPath, logPath, error: String(err) });
		return false;
	}

	// A second daemon losing the socket bind race exits on its own, so a
	// successful poll only needs *some* daemon to be answering.
	return await pollDaemonRunning(binaryPath);
}

// =============================================================================
// Command Wrapping
// =============================================================================

/**
 * Wrap a server command so drey fronts it.
 *
 * @param command - The configured LSP server command (e.g. "typescript-language-server")
 * @param args - The configured args; must match drey's builtin profile to qualify
 * @param binaryPath - drey binary, or null to decline multiplexing
 */
export function wrapWithDrey(
	command: string,
	args: string[] | undefined,
	binaryPath: string | null,
): DreyWrappedCommand {
	const identity: DreyWrappedCommand = { command, args: args ?? [] };
	if (!binaryPath) {
		return identity;
	}

	const serverName = DREY_SERVER_NAMES[path.basename(command)];
	if (!serverName) {
		return identity;
	}

	const builtinArgs = DREY_BUILTIN_ARGS[serverName] ?? [];
	// Absent args mean "use the defaults", which is what drey's own profile does.
	const configuredArgs = args ?? builtinArgs;
	if (configuredArgs.length !== builtinArgs.length || configuredArgs.some((arg, i) => arg !== builtinArgs[i])) {
		logger.debug("drey declined: configured args differ from its builtin profile", {
			command,
			configuredArgs,
			builtinArgs,
		});
		return identity;
	}

	return { command: binaryPath, args: ["serve", serverName] };
}

/**
 * Get the drey-wrapped command when drey can front it, otherwise the original.
 * This is the entry point used by the multiplexer resolver.
 *
 * The daemon is verified — and if necessary started — *before* the shim is
 * handed out, because a shim that autostarts its own daemon produces the
 * inherited-stdio problem described on `ensureDreyDaemon`. Without a daemon the
 * shim is never used.
 */
export async function getDreyCommand(command: string, args?: string[]): Promise<DreyWrappedCommand> {
	const identity: DreyWrappedCommand = { command, args: args ?? [] };
	if (!isDreySupported(command)) {
		return identity;
	}

	const binaryPath = await findDreyBinary();
	if (!binaryPath) {
		return identity;
	}

	if (!(await checkDaemonRunning(binaryPath))) {
		const started = await ensureDreyDaemon(binaryPath);
		if (!started) {
			logger.warn("drey daemon unavailable; spawning the language server directly", { command, binaryPath });
			return identity;
		}
	}

	return wrapWithDrey(command, args, binaryPath);
}
