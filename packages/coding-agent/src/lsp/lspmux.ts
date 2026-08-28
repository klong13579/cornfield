import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, $which, getLogsDir, isEnoent, logger } from "@cornfield/utils";
import { TOML } from "bun";

/**
 * lspmux integration for LSP server multiplexing.
 *
 * When lspmux is available and running, this module wraps supported LSP server
 * commands to use lspmux client mode, enabling server instance sharing across
 * multiple editor windows.
 *
 * Integration is transparent: if lspmux is unavailable, falls back to direct spawning.
 */

// =============================================================================
// Types
// =============================================================================

interface LspmuxConfig {
	instance_timeout?: number;
	gc_interval?: number;
	listen?: [string, number] | string;
	connect?: [string, number] | string;
	log_filters?: string;
	pass_environment?: string[];
}

interface LspmuxState {
	available: boolean;
	running: boolean;
	binaryPath: string | null;
	config: LspmuxConfig | null;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Servers that benefit from lspmux multiplexing.
 *
 * Only rust-analyzer for now: lspmux 0.3.0's spawn handshake requires the
 * FIRST message after `initialize` to be the initialize response
 * (src/instance.rs "first server message was not initialize response"), but
 * typescript-language-server emits startup notifications before answering
 * initialize — every first client then fails handshake and falls back to
 * lazily-retried diagnostics. tsserver instances are ~30-80MB vs rust-analyzer's
 * 1-2GB, so deferring it from multiplexing costs little and removes the
 * startup stall. Revisit when lspmux fixes trailing-arbitrary-pre-init messages.
 */
const DEFAULT_SUPPORTED_SERVERS = new Set([
	"rust-analyzer",
	// Other servers can be added after testing with lspmux
]);

/** Timeout for liveness check (ms) */
const LIVENESS_TIMEOUT_MS = 1000;

/** Cache duration for lspmux state (5 minutes) */
const STATE_CACHE_TTL_MS = 5 * 60 * 1000;

/** launchd job label for the lspmux server (macOS only). */
const LSPMUX_SERVICE_NAME = "com.cornfield.lspmux";

/** How long to wait for the lspmux server to become ready after starting it. */
const SERVER_STARTUP_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the lspmux server. */
const SERVER_POLL_INTERVAL_MS = 250;

/** PATH for the launchd-managed lspmux server (`.cargo/bin` is where rust-analyzer lives). */
function lspmuxServerPath(home: string): string {
	return `${path.join(home, ".local", "bin")}:${path.join(home, ".cargo", "bin")}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
}

// =============================================================================
// Config Path
// =============================================================================

/**
 * Get the lspmux config path based on platform.
 * Matches Rust's `dirs::config_dir()` behavior.
 */
function getConfigPath(): string {
	const home = os.homedir();
	switch (os.platform()) {
		case "win32":
			return path.join(Bun.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "lspmux", "config.toml");
		case "darwin":
			return path.join(home, "Library", "Application Support", "lspmux", "config.toml");
		default:
			return path.join(Bun.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "lspmux", "config.toml");
	}
}

// =============================================================================
// Launchd / Log Paths
// =============================================================================

/**
 * Path to the launchd plist that keeps the lspmux server alive (macOS).
 * Written on first use, then managed entirely by launchd.
 */
export function getLaunchdPlistPath(home: string = os.homedir()): string {
	return path.join(home, "Library", "LaunchAgents", `${LSPMUX_SERVICE_NAME}.plist`);
}

/** Path of the lspmux server log (~/.cornfield/logs/lspmux.log). */
export function getLspmuxLogPath(): string {
	return path.join(getLogsDir(), "lspmux.log");
}

// =============================================================================
// State Management
// =============================================================================

let cachedState: LspmuxState | null = null;
let cacheTimestamp = 0;

/**
 * Parse lspmux config.toml file.
 */
async function parseConfig(): Promise<LspmuxConfig | null> {
	try {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) {
			return null;
		}
		return TOML.parse(await file.text()) as LspmuxConfig;
	} catch {
		return null;
	}
}

/**
 * Check if lspmux server is running via `lspmux status`.
 */
async function checkServerRunning(binaryPath: string): Promise<boolean> {
	try {
		const proc = Bun.spawn([binaryPath, "status"], {
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const exited = await Promise.race([
			proc.exited,
			new Promise<null>(resolve => setTimeout(() => resolve(null), LIVENESS_TIMEOUT_MS)),
		]);

		if (exited === null) {
			proc.kill();
			return false;
		}

		return exited === 0;
	} catch {
		return false;
	}
}

/**
 * Detect lspmux availability and state.
 * Results are cached for STATE_CACHE_TTL_MS.
 *
 * Set CORNFIELD_DISABLE_LSPMUX=1 to disable.
 */
export async function detectLspmux(): Promise<LspmuxState> {
	const now = Date.now();
	if (cachedState && now - cacheTimestamp < STATE_CACHE_TTL_MS) {
		return cachedState;
	}

	if ($flag("CORNFIELD_DISABLE_LSPMUX")) {
		cachedState = { available: false, running: false, binaryPath: null, config: null };
		cacheTimestamp = now;
		return cachedState;
	}

	const binaryPath = $which("lspmux");
	if (!binaryPath) {
		cachedState = { available: false, running: false, binaryPath: null, config: null };
		cacheTimestamp = now;
		return cachedState;
	}

	const [config, running] = await Promise.all([parseConfig(), checkServerRunning(binaryPath)]);

	cachedState = { available: true, running, binaryPath, config };
	cacheTimestamp = now;

	if (running) {
		logger.debug("lspmux detected and running", { binaryPath });
	}

	return cachedState;
}

// =============================================================================
// Server Ensure (start on demand)
// =============================================================================

/**
 * Poll `lspmux status` until the server responds (or timeout).
 * Idempotent: succeeds as long as *some* server is up — under concurrent
 * startup the loser of the bind race still sees the winner via status.
 */
export async function pollServerRunning(
	binaryPath: string,
	timeoutMs: number = SERVER_STARTUP_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await checkServerRunning(binaryPath)) {
			return true;
		}
		await Bun.sleep(SERVER_POLL_INTERVAL_MS);
	}
	return false;
}

/** Generate the launchd plist that keeps the lspmux server alive (macOS). */
export function generateLspmuxPlist(binaryPath: string, home: string = os.homedir()): string {
	const logPath = getLspmuxLogPath();
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LSPMUX_SERVICE_NAME}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${binaryPath}</string>
		<string>server</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${logPath}</string>
	<key>StandardErrorPath</key>
	<string>${logPath}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${lspmuxServerPath(home)}</string>
	</dict>
</dict>
</plist>`;
}

/**
 * Run a short-lived process and return its exit code (null on timeout/kill).
 */
async function runDetached(argv: string[], timeoutMs = 3_000): Promise<number | null> {
	try {
		const proc = Bun.spawn(argv, {
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const exited = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
		if (exited === null) {
			proc.kill();
			return null;
		}
		return exited;
	} catch (err) {
		logger.error("lspmux launchd command failed", { argv, error: String(err) });
		return null;
	}
}

/**
 * macOS: register the lspmux server as a launchd LaunchAgent (idempotent) and
 * wait for it to respond. Once registered, launchd owns the lifecycle
 * (KeepAlive restarts, RunAtLoad on next login) — no per-cornfield spawning.
 */
async function ensureLspmuxServerLaunchd(binaryPath: string): Promise<boolean> {
	const home = os.homedir();
	const plistPath = getLaunchdPlistPath(home);
	const domain = `gui/${os.userInfo().uid}`;
	const target = `${domain}/${LSPMUX_SERVICE_NAME}`;

	// 1. Write the plist if missing (launchd owns it afterwards).
	let plistExists = false;
	try {
		await Bun.file(plistPath).text();
		plistExists = true;
	} catch (err) {
		if (isEnoent(err)) plistExists = false;
		else throw err;
	}
	if (!plistExists) {
		await Bun.write(plistPath, generateLspmuxPlist(binaryPath, home));
	}

	// 2. Bootstrap (no-op if already loaded — launchd returns non-zero, ignore).
	await runDetached(["/bin/launchctl", "print", target]);
	await runDetached(["/bin/launchctl", "bootstrap", domain, plistPath]);

	// 3. Wait for the server to answer.
	const ready = await pollServerRunning(binaryPath);
	if (ready) {
		logger.info("lspmux server ensured via launchd", { target, plistPath });
	} else {
		logger.warn("lspmux server did not come up via launchd; falling back to direct LSP spawn", { target });
	}
	return ready;
}

/**
 * Non-macOS: spawn `lspmux server` as a detached background process with the
 * log redirected to ~/.cornfield/logs/lspmux.log, then wait for it to respond.
 * Idempotent across processes via the status poll above.
 */
async function ensureLspmuxServerBare(binaryPath: string): Promise<boolean> {
	const logPath = getLspmuxLogPath();
	await Bun.write(logPath, ""); // ensure dir + file exist
	const logFd = fs.openSync(logPath, "a");
	const proc = Bun.spawn([binaryPath, "server"], {
		cwd: os.homedir(),
		stdin: "ignore",
		stdout: logFd,
		stderr: logFd,
		detached: true,
	});
	proc.unref?.();

	const ready = await pollServerRunning(binaryPath);
	if (ready) {
		logger.info("lspmux server ensured via bare spawn", { logPath });
	} else {
		logger.warn("lspmux server did not come up via bare spawn; falling back to direct LSP spawn", { logPath });
	}
	return ready;
}

/**
 * Ensure the lspmux server is running, starting it on demand.
 *
 * - lspmux not installed            → returns state unchanged (direct spawn fallback)
 * - server already running          → returns state unchanged (fast path)
 * - installed, not running          → macOS: launchd LaunchAgent (idempotent);
 *                                     other: detached bare spawn; then waits
 *                                     until `lspmux status` answers
 *
 * On success updates the module cache so later detectLspmux() calls in this
 * process see running=true immediately (no 5-minute stale window).
 */
export async function ensureLspmuxServer(state: LspmuxState): Promise<LspmuxState> {
	if (!state.available || !state.binaryPath || state.running) {
		return state;
	}

	const started =
		os.platform() === "darwin"
			? await ensureLspmuxServerLaunchd(state.binaryPath)
			: await ensureLspmuxServerBare(state.binaryPath);

	if (started) {
		const updated: LspmuxState = { ...state, running: true };
		cachedState = updated;
		cacheTimestamp = Date.now();
		return updated;
	}
	return state;
}

// =============================================================================
// Command Wrapping
// =============================================================================
/**
 * Check if a server command is supported by lspmux.
 */
export function isLspmuxSupported(command: string): boolean {
	// Extract base command name (handle full paths)
	const baseName = command.split("/").pop() ?? command;
	return DEFAULT_SUPPORTED_SERVERS.has(baseName);
}

export interface LspmuxWrappedCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/**
 * Wrap a server command to use lspmux client mode.
 *
 * @param originalCommand - The original LSP server command (e.g., "rust-analyzer")
 * @param originalArgs - Original command arguments
 * @param state - lspmux state from detectLspmux()
 * @returns Wrapped command, args, and env vars; or original if lspmux unavailable
 */
export function wrapWithLspmux(
	originalCommand: string,
	originalArgs: string[] | undefined,
	state: LspmuxState,
): LspmuxWrappedCommand {
	if (!state.available || !state.running || !state.binaryPath) {
		return { command: originalCommand, args: originalArgs ?? [] };
	}

	if (!isLspmuxSupported(originalCommand)) {
		return { command: originalCommand, args: originalArgs ?? [] };
	}

	const baseName = originalCommand.split("/").pop() ?? originalCommand;
	const isDefaultRustAnalyzer = baseName === "rust-analyzer" && originalCommand === "rust-analyzer";
	const hasArgs = originalArgs && originalArgs.length > 0;

	// rust-analyzer from $PATH with no args - lspmux's default, simplest case
	if (isDefaultRustAnalyzer && !hasArgs) {
		return { command: state.binaryPath, args: [] };
	}

	// Use explicit `client` subcommand with LSPMUX_SERVER env var
	// Use `--` to separate lspmux options from server args
	const args = hasArgs ? ["client", "--", ...originalArgs] : ["client"];
	return {
		command: state.binaryPath,
		args,
		env: { LSPMUX_SERVER: originalCommand },
	};
}

/**
 * Get lspmux-wrapped command if available, otherwise return original.
 * This is the main entry point for config.ts integration.
 *
 * @param command - Original LSP server command
 * @param args - Original command arguments
 * @returns Command and args to use (possibly wrapped with lspmux)
 */
export async function getLspmuxCommand(command: string, args?: string[]): Promise<LspmuxWrappedCommand> {
	const state = await detectLspmux();
	// On-demand server start: if lspmux is installed but its server is not
	// running, start it (launchd on macOS, bare spawn elsewhere) and update
	// the cache so the freshly-wrapped command multiplexes instead of spawns
	// a private copy of the server.
	const effective = state.available && !state.running ? await ensureLspmuxServer(state) : state;
	return wrapWithLspmux(command, args, effective);
}
