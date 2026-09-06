/**
 * Update CLI command handler.
 *
 * Handles `cornfield update` to check for and install updates.
 * Version source: GitHub Releases API. Install method: download the release
 * binary from GitHub Releases — the npm registry is not a distribution
 * channel (no @cornfield/* package has ever been published there).
 */
import * as fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@cornfield/utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";

export const REPO = "klong13579/cornfield";

interface ReleaseInfo {
	tag: string;
	version: string;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

/**
 * Get the latest release info from the GitHub Releases API.
 *
 * Same source as the desktop app's electron-updater feed. The npm registry is
 * NOT a distribution channel for this project — no @cornfield/* package has
 * ever been published there — so the previous npm check 404'd unconditionally
 * and version checks could never see a new release.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	return fetchLatestReleaseFromGithub(REPO);
}

/**
 * Fetch the latest stable release of `repo` (owner/name) from the GitHub
 * Releases API. Exported so the startup check in main.ts shares one source
 * and one parsing path with the manual `update` command.
 */
export async function fetchLatestReleaseFromGithub(repo: string, signal?: AbortSignal): Promise<ReleaseInfo> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": APP_NAME },
		signal,
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}
	const data = (await response.json()) as { tag_name?: string };
	const tag = data.tag_name;
	if (!tag) {
		throw new Error("Failed to fetch release info: releases/latest returned no tag_name");
	}
	return { tag, version: tag.replace(/^v/, "") };
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `cornfield` maps to in the user's PATH.
 */
function resolveCornfieldPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved cornfield binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(
	expectedVersion: string,
): Promise<{ ok: boolean; actual?: string; path?: string }> {
	const cornfieldPath = resolveCornfieldPath();
	if (!cornfieldPath) return { ok: false };
	try {
		const result = await $`${cornfieldPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: cornfieldPath };
		const output = result.text().trim();
		// Output format: "cornfield/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: cornfieldPath };
	} catch {
		return { ok: false, path: cornfieldPath };
	}
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
		return;
	}
	if (result.actual) {
		console.log(
			chalk.yellow(
				`\nWarning: ${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`,
			),
		);
	} else {
		console.log(
			chalk.yellow(`\nWarning: could not verify updated version${result.path ? ` at ${result.path}` : ""}`),
		);
	}
	console.log(
		chalk.yellow(
			`You may need to reinstall: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
		),
	);
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);
	// Re-sign the binary on macOS to ensure valid signature after download
	if (process.platform === "darwin") {
		try {
			await $`codesign --force --deep --sign - ${tempPath}`.quiet();
		} catch {
			// Ignore signing errors - binary might still work
		}
	}
	console.log(chalk.dim("Installing update..."));
	try {
		try {
			await fs.promises.unlink(backupPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(targetPath, backupPath);
		await fs.promises.rename(tempPath, targetPath);
		await fs.promises.unlink(backupPath);

		await printVerification(expectedVersion);
		console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
	} catch (err) {
		if (fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
			await fs.promises.rename(backupPath, targetPath);
		}
		if (fs.existsSync(tempPath)) {
			await fs.promises.unlink(tempPath);
		}
		throw err;
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = Bun.semver.order(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Every install is a release binary (the npm registry is not a distribution
	// channel), so update the PATH-resolved binary in place.
	try {
		const cornfieldPath = resolveCornfieldPath();
		if (!cornfieldPath) {
			throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
		}
		await updateViaBinaryAt(cornfieldPath, release.version);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
