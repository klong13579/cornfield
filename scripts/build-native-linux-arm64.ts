#!/usr/bin/env bun
/**
 * Build the pi-natives native addon for linux-arm64 (aarch64-unknown-linux-gnu)
 * on a macOS/Linux host using zig as the C compiler + linker — no
 * aarch64-linux-gnu toolchain needed.
 *
 * This is the local verification channel for the linux-arm64 platform that
 * historically only ran in CI at release time (v1.1.0 burned three CI runs on
 * aarch64-only compile breakage before this existed). Run it before pushing
 * changes that touch `crates/pi-natives` or its Cargo.toml/Cargo.lock.
 *
 * Prereqs: zig on PATH (brew install zig), rustup target installed:
 *   rustup target add aarch64-unknown-linux-gnu
 * (If the rustup download stalls, set RUSTUP_DIST_SERVER to a mirror, e.g.
 * https://rsproxy.cn.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const wrapperPath = path.join(repoRoot, "scripts", "zig-cc-aarch64.sh");

const target = "aarch64-unknown-linux-gnu";
const zig = Bun.which("zig");
if (!zig) {
	console.error("zig not found on PATH. Install it first: brew install zig");
	process.exit(1);
}

await fs.promises.chmod(wrapperPath, 0o755);
const installed = await $`rustup target list --installed`.quiet().nothrow().text();
if (!installed.includes(target)) {
	console.error(`${target} is not installed. Run:`);
	console.error(`  rustup target add ${target}`);
	console.error(
		"If the download stalls (CN network), set a mirror first: RUSTUP_DIST_SERVER=https://rsproxy.cn rustup target add " +
			target,
	);
	process.exit(1);
}

console.log(`Cross-compiling cornfield-natives for ${target} via zig…`);
const build = await $`bun scripts/ci-build-native.ts`
	.cwd(repoRoot)
	.env({
		...Bun.env,
		CROSS_TARGET: target,
		TARGET_PLATFORM: "linux",
		TARGET_ARCH: "arm64",
		CC_aarch64_unknown_linux_gnu: wrapperPath,
		CXX_aarch64_unknown_linux_gnu: wrapperPath,
		CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: wrapperPath,
	})
	.nothrow();
if (build.exitCode !== 0) {
	console.error(build.stderr?.toString() ?? "cross build failed");
	process.exit(build.exitCode ?? 1);
}
console.log("Build complete — packages/natives/native/cornfield_natives.linux-arm64.node");
