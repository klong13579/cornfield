#!/usr/bin/env bun
/**
 * CornField 一键打包：web-app → omp 二进制 → desktop 壳 JS → electron-builder。
 *
 * 用法（均在 packages/desktop 下）：
 *   bun run build:desktop        # 完整构建，产出 dmg + zip
 *   bun scripts/build.ts --dir   # 离屏验证：只产出 app 目录（不产出 dmg/zip）
 *   bun scripts/build.ts --agent-binary <path>   # 复用已构建的 omp 二进制
 *
 * `--agent-binary` 用于 CI：release_binary 已经为同一个 commit 构建过目标二进制，
 * 这里直接拷进 packages/coding-agent/dist/cornfield，不再重跑 coding-agent 的
 * build（它内部会重建 Rust native + 重编译二进制，在 macos runner 上是分钟级开销）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const desktopDir = path.join(import.meta.dir, "..");
const webAppDir = path.join(desktopDir, "..", "web-app");
const codingAgentDir = path.join(desktopDir, "..", "coding-agent");
const agentBinaryPath = path.join(codingAgentDir, "dist", "cornfield");

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

function parseAgentBinaryArg(): string | undefined {
	const flagIndex = Bun.argv.indexOf("--agent-binary");
	if (flagIndex === -1) return undefined;
	const value = Bun.argv[flagIndex + 1];
	if (!value || value.startsWith("--")) {
		throw new Error("--agent-binary requires the path of a prebuilt cornfield binary");
	}
	return path.resolve(value);
}

async function stageAgentBinary(prebuiltBinary: string): Promise<void> {
	// 同一个文件就是目标时直接跳过：copyFile 的 src/dst 相同会截断源文件。
	if (prebuiltBinary === agentBinaryPath) {
		console.log(`Reusing ${agentBinaryPath} in place`);
		return;
	}
	await fs.mkdir(path.dirname(agentBinaryPath), { recursive: true });
	await fs.copyFile(prebuiltBinary, agentBinaryPath);
	console.log(`Staged ${prebuiltBinary} → ${agentBinaryPath}`);
}

async function main(): Promise<void> {
	const dirMode = Bun.argv.includes("--dir");
	const prebuiltBinary = parseAgentBinaryArg();

	// 1. web-app 前端（vite build → packages/web-app/dist）。
	await runCommand(["bun", "run", "build"], webAppDir);

	// 2. omp 二进制（build-binary.ts → packages/coding-agent/dist/cornfield）。
	if (prebuiltBinary) {
		await stageAgentBinary(prebuiltBinary);
	} else {
		await runCommand(["bun", "run", "build"], codingAgentDir);
	}

	// 3. desktop 壳 JS（esbuild → packages/desktop/dist/{main,sidecar}.js + preload.cjs）。
	await runCommand(["bun", "run", "build"], desktopDir);

	// 4. electron-builder：默认出 dmg+zip；--dir 只出 app 目录。
	const builderArgs = dirMode ? ["--dir"] : [];
	await runCommand(["bun", "x", "electron-builder", ...builderArgs], desktopDir);
}

await main();
