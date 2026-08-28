#!/usr/bin/env bun

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface ArchiveTarget {
	id: string;
	binaryName: string;
	archiveName: string;
	executableName: string;
	gatewayBinaryName: string;
	gatewayExecutableName: string;
	nativeAddons: string[];
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const archivesDir = path.join(binariesDir, ".archives");

const targets: ArchiveTarget[] = [
	{
		id: "darwin-arm64",
		binaryName: "cornfield-darwin-arm64",
		archiveName: "cornfield-darwin-arm64.tar.gz",
		executableName: "cornfield",
		gatewayBinaryName: "cornfield-gateway-darwin-arm64",
		gatewayExecutableName: "cornfield-gateway",
		nativeAddons: ["cornfield_natives.darwin-arm64.node"],
	},
	{
		id: "darwin-x64",
		binaryName: "cornfield-darwin-x64",
		archiveName: "cornfield-darwin-x64.tar.gz",
		executableName: "cornfield",
		gatewayBinaryName: "cornfield-gateway-darwin-x64",
		gatewayExecutableName: "cornfield-gateway",
		nativeAddons: ["cornfield_natives.darwin-x64-modern.node", "cornfield_natives.darwin-x64-baseline.node"],
	},
	{
		id: "linux-x64",
		binaryName: "cornfield-linux-x64",
		archiveName: "cornfield-linux-x64.tar.gz",
		executableName: "cornfield",
		gatewayBinaryName: "cornfield-gateway-linux-x64",
		gatewayExecutableName: "cornfield-gateway",
		nativeAddons: ["cornfield_natives.linux-x64-modern.node", "cornfield_natives.linux-x64-baseline.node"],
	},
	{
		id: "linux-arm64",
		binaryName: "cornfield-linux-arm64",
		archiveName: "cornfield-linux-arm64.tar.gz",
		executableName: "cornfield",
		gatewayBinaryName: "cornfield-gateway-linux-arm64",
		gatewayExecutableName: "cornfield-gateway",
		nativeAddons: ["cornfield_natives.linux-arm64.node"],
	},
	{
		id: "win32-x64",
		binaryName: "cornfield-windows-x64.exe",
		archiveName: "cornfield-windows-x64.tar.gz",
		executableName: "cornfield.exe",
		gatewayBinaryName: "cornfield-gateway-windows-x64.exe",
		gatewayExecutableName: "cornfield-gateway.exe",
		nativeAddons: ["cornfield_natives.win32-x64-modern.node", "cornfield_natives.win32-x64-baseline.node"],
	},
];

async function copyRequiredFile(source: string, destination: string): Promise<void> {
	try {
		await fs.copyFile(source, destination);
	} catch (error) {
		throw new Error(`Missing release archive input ${path.relative(repoRoot, source)}: ${String(error)}`);
	}
}

async function createArchive(target: ArchiveTarget): Promise<void> {
	const stagingDir = path.join(archivesDir, target.id);
	await fs.rm(stagingDir, { recursive: true, force: true });
	await fs.mkdir(stagingDir, { recursive: true });

	await copyRequiredFile(path.join(binariesDir, target.binaryName), path.join(stagingDir, target.executableName));
	await copyRequiredFile(
		path.join(binariesDir, target.gatewayBinaryName),
		path.join(stagingDir, target.gatewayExecutableName),
	);
	for (const addonName of target.nativeAddons) {
		await copyRequiredFile(path.join(binariesDir, addonName), path.join(stagingDir, addonName));
	}

	if (target.executableName === "cornfield") {
		await fs.chmod(path.join(stagingDir, target.executableName), 0o755);
		await fs.chmod(path.join(stagingDir, target.gatewayExecutableName), 0o755);
	}

	const archivePath = path.join(binariesDir, target.archiveName);
	await fs.rm(archivePath, { force: true });
	await $`tar -czf ${archivePath} -C ${stagingDir} .`.quiet();
}

async function main(): Promise<void> {
	await fs.mkdir(binariesDir, { recursive: true });
	await fs.rm(archivesDir, { recursive: true, force: true });
	await fs.mkdir(archivesDir, { recursive: true });

	for (const target of targets) {
		await createArchive(target);
	}

	await fs.rm(archivesDir, { recursive: true, force: true });
}

await main();
