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
// Environment persistence
// ═══════════════════════════════════════════════════════════════════════

/**
 * Env vars whose values are written into the launchd plist / systemd
 * service file at install time. The values are resolved in this order:
 *
 *   1. The operator's shell value at install time (explicit override).
 *      An empty string is treated the same as unset — both fall through
 *      to step 2 — so a stale `export OMP_GATEWAY_TEST_MODE=` in the
 *      shell cannot silently disable the test-injection endpoint.
 *   2. The `PERSISTED_ENV_DEFAULTS` value for the var.
 *   3. (No default → var is omitted from the config.)
 *
 * `OMP_GATEWAY_TEST_MODE=1` turns on the POST /test/inject endpoint
 * (see gateway.ts#startTestServer), and `OMP_GATEWAY_TEST_PORT`
 * controls which port that endpoint binds to. These two are defaulted
 * to "1" / "7890" so the test-injection surface is available out of
 * the box after `omp gateway service install` — the prior behaviour
 * (only persist if set in the shell) required every reinstall to
 * re-source the env, and a missed `export` silently disabled the
 * endpoint with no signal until the next `curl /test/inject` 404.
 *
 * To add a new persisted var: append it here AND add its default to
 * `PERSISTED_ENV_DEFAULTS` (or omit the default to keep the
 * "only-if-set" semantics). The generator below picks both up
 * automatically; the launchd plist will get a <key>NAME</key> entry
 * and the systemd unit will get an Environment="NAME=VALUE" line.
 *
 * Opt-out: set the var to a non-empty value in your shell before
 * running `service install`, e.g. `export OMP_GATEWAY_TEST_MODE=0`
 * to keep the endpoint off.
 */
export const PERSISTED_ENV_VARS = ["OMP_GATEWAY_TEST_MODE", "OMP_GATEWAY_TEST_PORT"] as const;

/**
 * Default values applied when the operator's shell has not set the
 * corresponding var. Indexed by `PERSISTED_ENV_VARS` member. Vars
 * present in `PERSISTED_ENV_VARS` but not in this map retain the
 * pre-existing "only-if-set" behaviour (no default; unset ⇒ omitted).
 */
export const PERSISTED_ENV_DEFAULTS: Partial<Record<(typeof PERSISTED_ENV_VARS)[number], string>> = {
	OMP_GATEWAY_TEST_MODE: "1",
	OMP_GATEWAY_TEST_PORT: "7890",
};

/**
 * PATH written into the supervised gateway's plist / unit file.
 *
 * `~/.local/bin` is listed first so user-installed CLIs (`dws`, `agent`,
 * `hermes`, `uv`, `cursor`, ...) are visible to the gateway out of the
 * box — a freshly installed gateway without this entry would have a
 * `command not found: dws` for any agent tool that shells out to
 * user-local binaries (the symptom is intermittent, because the agent's
 * non-interactive bash does NOT source `~/.zshrc`, so the `~/.local/bin`
 * that the operator's interactive shell has does not propagate).
 *
 * Both the launchd plist and the systemd unit pull from this single
 * helper so the two configs can't drift apart on a future edit. Add
 * new common dirs here when they show up in install support issues;
 * do NOT inline a new path in only one of the two templates.
 */
export function gatewayServicePath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME ?? process.env.HOME ?? "";
	return [
		`${home}/.local/bin`,
		`${home}/.bun/bin`,
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	].join(":");
}

/** Escape a value for inclusion in a launchd plist XML <string> element. */
function xmlEscape(value: string): string {
	return value.replace(/[&<>"']/g, ch => {
		switch (ch) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&apos;";
			default:
				return ch;
		}
	});
}

/** Escape a value for inclusion in a systemd `Environment="KEY=VALUE"` line. */
function systemdEscapeValue(value: string): string {
	// systemd allows escaping inside double-quoted values: \" \\ \$
	// We only need to escape " and \ for correctness in our use case
	// (test mode values are "1" or a port number, but be robust).
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Resolve the env entries to write into the plist / unit file.
 *
 * For each name in `PERSISTED_ENV_VARS`, in declaration order:
 *   - If the operator's shell has a non-empty value, use that.
 *   - Else if `PERSISTED_ENV_DEFAULTS` has an entry, use the default.
 *   - Else omit the var entirely.
 *
 * Returns a `Record<name, value>` so callers don't have to re-look-up
 * `env[name]` when rendering. Empty-string values are coerced to
 * "use the default" so a stale `export NAME=` in the shell cannot
 * silently disable a defaulted feature.
 */
export function resolvePersistedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of PERSISTED_ENV_VARS) {
		const explicit = env[name];
		if (explicit !== undefined && explicit !== "") {
			out[name] = explicit;
		} else {
			const def = PERSISTED_ENV_DEFAULTS[name];
			if (def !== undefined) out[name] = def;
		}
	}
	return out;
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

export function generateLaunchdPlist(logPath: string, env: NodeJS.ProcessEnv = process.env): string {
	const argv = buildServiceArgv();
	const argTags = argv.map(a => `\t\t<string>${a}</string>`).join("\n");
	// Build the persisted-env entries (defaults applied when the operator
	// has not set the var in their shell — see `resolvePersistedEnv`).
	const persistedEntries = Object.entries(resolvePersistedEnv(env)).map(
		([name, value]) => `\t\t<key>${name}</key>\n\t\t<string>${xmlEscape(value)}</string>`,
	);
	const envBlock = [
		`\t\t<key>PATH</key>`,
		`\t\t<string>${gatewayServicePath(env)}</string>`,
		...persistedEntries,
	].join("\n");
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
${envBlock}
	</dict>
</dict>
</plist>`;
}

export function generateSystemdService(logPath: string, env: NodeJS.ProcessEnv = process.env): string {
	const argv = buildServiceArgv();
	const execStart = argv.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ");
	// Same persisted-env set as the launchd plist, formatted as systemd
	// Environment= lines. Defaults are applied here too — see
	// `resolvePersistedEnv`.
	const persistedLines = Object.entries(resolvePersistedEnv(env)).map(
		([name, value]) => `Environment="${name}=${systemdEscapeValue(value)}"`,
	);
	const envBlock = [`Environment="PATH=${gatewayServicePath(env)}"`, ...persistedLines].join("\n");
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
${envBlock}

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
	const config = platform === "darwin" ? generateLaunchdPlist(paths.logPath) : generateSystemdService(paths.logPath);

	// Surface the effective env (defaults + any operator overrides)
	// that the generator is about to write into the plist / unit file.
	// Without this, `omp gateway service install` is silent about what
	// made it into the config, and a follow-up `curl /test/inject` 404
	// leaves the operator wondering whether the test mode is even on.
	// The `default` flag on each entry distinguishes operator-supplied
	// values (false) from those filled in by `PERSISTED_ENV_DEFAULTS`
	// (true), so the operator can see at a glance which came from
	// their shell vs. which the installer chose for them.
	const persisted = resolvePersistedEnv();
	const persistedSummary = Object.entries(persisted).map(([name, value]) => ({
		name,
		value,
		default: process.env[name] === undefined || process.env[name] === "",
	}));
	if (persistedSummary.length > 0) {
		logger.info("Persisted env into service config", { entries: persistedSummary });
	}

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
 *
 * On macOS, `launchctl bootstrap` against an already-loaded service
 * returns errno 5 (EIO, "Input/output error") rather than the older
 * "already bootstrapped" string. A naive bootstrap-then-throw on any
 * non-zero exit therefore fails loudly every time the operator runs
 * `omp gateway service start` immediately after `omp gateway service
 * install` (install does its own bootstrap; the subsequent start hits
 * EIO), even though the service is in fact running. The CLI prints
 * "Bootstrap failed: 5: Input/output error" and the operator has to
 * verify by hand that the gateway is actually up.
 *
 * `startService` is idempotent: it asks launchd / systemd whether the
 * service is already running and short-circuits if so. The Linux path
 * (`systemctl --user start`) is already idempotent; the macOS path now
 * is too.
 */
export async function startService(): Promise<void> {
	const platform = detectPlatform();

	if (platform === "darwin") {
		const paths = getServicePaths();
		const uid = process.getuid?.() ?? 501;

		const status = await getServiceStatus();
		if (status.running) {
			logger.debug("Service already running, start is a no-op", { pid: status.pid });
			return;
		}

		const result = await $`launchctl bootstrap gui/${uid} ${paths.configPath}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`Failed to start service: ${result.stderr}`);
		}
	} else {
		// systemctl --user start is idempotent — a no-op when already active.
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
