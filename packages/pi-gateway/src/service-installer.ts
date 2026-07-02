/**
 * System service installer for pi-gateway.
 *
 * Supports:
 * - macOS: launchd (user-level agent)
 * - Linux: systemd (user-level service)
 *
 * User-level services do not require sudo.
 *
 * Dev / prod detection:
 *   The plist's `ProgramArguments` is built from `process.execPath` and
 *   (in dev mode) `process.argv[1]`. Dev mode is detected the same way as
 *   the daemonize path in `coding-agent/src/commands/gateway.ts`:
 *     - argv[1] ends with `.ts` or `.js` → dev (we're inside a bun run)
 *     - otherwise → prod (we're inside the compiled `omp` binary)
 *   In dev the plist invokes `bun <entry> gateway start --foreground`; in
 *   prod it invokes `omp gateway start --foreground`. Both end up at the
 *   same oclif gateway command.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { scanAndKillRemainingGatewayProcesses } from "./gateway-daemon";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const SERVICE_NAME = "com.narwal.pi-gateway";
const SERVICE_LABEL = "Oh My Pi Gateway";

// ═══════════════════════════════════════════════════════════════════════
// Platform Detection
// ═══════════════════════════════════════════════════════════════════════

export type Platform = "darwin" | "linux" | "unsupported";

export function detectPlatform(): Platform {
	const platform = process.platform;
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	return "unsupported";
}

// ═══════════════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════════════

export function getServicePaths() {
	const platform = detectPlatform();
	const home = os.homedir();
	const dataDir = path.join(home, ".omp", "gateway-data");
	const logDir = path.join(dataDir, "logs");

	switch (platform) {
		case "darwin":
			return {
				platform,
				configDir: path.join(home, "Library", "LaunchAgents"),
				configPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_NAME}.plist`),
				logDir,
				logPath: path.join(logDir, "service.log"),
			};
		case "linux":
			return {
				platform,
				configDir: path.join(home, ".config", "systemd", "user"),
				configPath: path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
				logDir,
				logPath: path.join(logDir, "service.log"),
			};
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Config Generation
// ═══════════════════════════════════════════════════════════════════════

/**
 * True when the current process is running from a .ts/.js entry under bun,
 * i.e. `bun run packages/coding-agent/src/cli.ts gateway service install`.
 * False when running from a compiled binary (`omp gateway service install`).
 */
function detectDevMode(): boolean {
	const entry = process.argv[1];
	return !!(entry && (entry.endsWith(".ts") || entry.endsWith(".js")));
}

/**
 * Build the argv that launchd / systemd should exec.
 *
 *   dev: [bun, /abs/path/to/entry.ts, gateway, start, --foreground]
 *   prod: [/abs/path/to/omp, gateway, start, --foreground]
 */
function buildServiceArgv(): string[] {
	const runtime = process.execPath;
	if (detectDevMode() && process.argv[1]) {
		return [runtime, process.argv[1], "gateway", "start", "--foreground"];
	}
	return [runtime, "gateway", "start", "--foreground"];
}

function generateLaunchdPlist(logPath: string): string {
	const argv = buildServiceArgv();
	const argTags = argv.map(a => `\t\t<string>${a}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_NAME}</string>
	<key>ProgramArguments</key>
	<array>
${argTags}
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
		<string>${process.env.HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>`;
}

function generateSystemdService(logPath: string): string {
	const argv = buildServiceArgv();
	const execStart = argv.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ");
	return `[Unit]
Description=${SERVICE_LABEL}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}
Environment="PATH=${process.env.HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

[Install]
WantedBy=default.target`;
}

// ═══════════════════════════════════════════════════════════════════════
// Core Operations
// ═══════════════════════════════════════════════════════════════════════

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	pid?: number;
	platform: Platform;
	configPath: string;
	logPath: string;
}

/**
 * Install pi-gateway as a system service.
 *
 * The plist / unit is built from the current `process.execPath` and
 * (in dev mode) `process.argv[1]`. See the file header for the dev/prod
 * detection contract.
 */
export async function installService(): Promise<void> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	logger.debug("Installing service", { platform, configPath: paths.configPath, devMode: detectDevMode() });

	// Ensure log directory exists
	await fs.mkdir(paths.logDir, { recursive: true });

	// Generate config
	const config =
		platform === "darwin" ? generateLaunchdPlist(paths.logPath) : generateSystemdService(paths.logPath);

	// Ensure config directory exists
	await fs.mkdir(paths.configDir, { recursive: true });

	// Write config file
	await Bun.write(paths.configPath, config);

	// Load/enable service (unload first to refresh cached launchd definition)
	if (platform === "darwin") {
		const uid = process.getuid?.() ?? 501;
		await $`launchctl bootout gui/${uid}/${SERVICE_NAME}`.quiet().nothrow();
		await $`launchctl bootstrap gui/${uid} ${paths.configPath}`.quiet().nothrow();
	} else {
		await $`systemctl --user daemon-reload`.quiet().nothrow();
		await $`systemctl --user enable ${SERVICE_NAME}.service`.quiet().nothrow();
	}

	logger.debug("Service installed", { configPath: paths.configPath });
}

/**
 * Uninstall the system service.
 */
export async function uninstallService(): Promise<void> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	logger.debug("Uninstalling service", { platform, configPath: paths.configPath });

	// Stop if running
	try {
		await stopService();
	} catch {
		// ignore stop errors
	}

	// Unload from launchd/systemd before removing config
	if (platform === "darwin") {
		const uid = process.getuid?.() ?? 501;
		await $`launchctl bootout gui/${uid}/${SERVICE_NAME}`.quiet().nothrow();
	}

	// Remove config
	try {
		await fs.unlink(paths.configPath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// Disable on Linux
	if (platform === "linux") {
		await $`systemctl --user disable ${SERVICE_NAME}.service`.quiet().nothrow();
		await $`systemctl --user daemon-reload`.quiet().nothrow();
	}

	logger.debug("Service uninstalled");
}

/**
 * Start the system service.
 */
export async function startService(): Promise<void> {
	const platform = detectPlatform();

	if (platform === "darwin") {
		const paths = getServicePaths();
		const uid = process.getuid?.() ?? 501;
		// bootstrap loads + starts the service from plist
		const result = await $`launchctl bootstrap gui/${uid} ${paths.configPath}`.quiet().nothrow();
		if (result.exitCode !== 0 && !result.stderr.toString().includes("already bootstrapped")) {
			throw new Error(`Failed to start service: ${result.stderr}`);
		}
	} else {
		const result = await $`systemctl --user start ${SERVICE_NAME}.service`.quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`Failed to start service: ${result.stderr}`);
		}
	}

	logger.debug("Service started");
}

/**
 * Stop the system service.
 */
export async function stopService(): Promise<void> {
	const platform = detectPlatform();

	if (platform === "darwin") {
		const uid = process.getuid?.() ?? 501;
		// bootout unloads + stops, no auto-restart
		await $`launchctl bootout gui/${uid}/${SERVICE_NAME}`.quiet().nothrow();
	} else {
		await $`systemctl --user stop ${SERVICE_NAME}.service`.quiet().nothrow();
	}

	// Clean up any remaining gateway processes not tracked by launchd/systemd
	await scanAndKillRemainingGatewayProcesses();

	logger.debug("Service stopped");
}

/**
 * Get service status.
 */
/**
 * Check whether the system service is currently installed.
 *
 * Returns true if the plist / unit file exists at the expected path.
 * Does not call launchctl / systemctl — that requires the service to be
 * loaded; `getServiceStatus()` is the right call when you need both the
 * install state AND the run state.
 */
export async function isServiceInstalled(): Promise<boolean> {
	const paths = getServicePaths();
	try {
		await fs.access(paths.configPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

export async function getServiceStatus(): Promise<ServiceStatus> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	// Check if config exists
	let installed = false;
	try {
		await fs.access(paths.configPath);
		installed = true;
	} catch {
		installed = false;
	}

	// Check if running
	let running = false;
	let pid: number | undefined;

	if (platform === "darwin") {
		const result = await $`launchctl list ${SERVICE_NAME}`.quiet().nothrow();
		if (result.exitCode === 0) {
			// Output is OpenStep-style plist: "PID" = 18821;
			const match = result.stdout.toString().match(/"PID"\s*=\s*(\d+);/);
			if (match) {
				pid = Number.parseInt(match[1], 10);
				running = pid > 0;
			}
		}
	} else {
		const result = await $`systemctl --user is-active ${SERVICE_NAME}.service`.quiet().nothrow();
		running = result.stdout.toString().trim() === "active";
		if (running) {
			const pidResult = await $`systemctl --user show ${SERVICE_NAME}.service --property=MainPID`.quiet().nothrow();
			const match = pidResult.stdout.toString().match(/MainPID=(\d+)/);
			if (match) pid = Number.parseInt(match[1], 10);
		}
	}

	return { installed, running, pid, platform, configPath: paths.configPath, logPath: paths.logPath };
}
