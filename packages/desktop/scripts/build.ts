#!/usr/bin/env bun
/**
 * OMP Desktop 一键打包：web-app → omp 二进制 → desktop 壳 JS → electron-builder。
 *
 * 用法（均在 packages/desktop 下）：
 *   bun run build:desktop        # 完整构建，产出 dmg + zip
 *   bun scripts/build.ts --dir   # 离屏验证：只产出 app 目录（不产出 dmg/zip）
 */

import * as path from "node:path";

const desktopDir = path.join(import.meta.dir, "..");
const webAppDir = path.join(desktopDir, "..", "web-app");
const codingAgentDir = path.join(desktopDir, "..", "coding-agent");

async function runCommand(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env: Bun.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	const dirMode = Bun.argv.includes("--dir");

	// 1. web-app 前端（vite build → packages/web-app/dist）。
	await runCommand(["bun", "run", "build"], webAppDir);

	// 2. omp 二进制（build-binary.ts → packages/coding-agent/dist/cornfield）。
	await runCommand(["bun", "run", "build"], codingAgentDir);

	// 3. desktop 壳 JS（esbuild → packages/desktop/dist/{main,sidecar}.js + preload.cjs）。
	await runCommand(["bun", "run", "build"], desktopDir);

	// 4. electron-builder：默认出 dmg+zip；--dir 只出 app 目录。
	const builderArgs = dirMode ? ["--dir"] : [];
	await runCommand(["bun", "x", "electron-builder", ...builderArgs], desktopDir);
}

await main();
