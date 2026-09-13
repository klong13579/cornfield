#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";
import { detectHostAvx2Support } from "./host-detect"

interface NativeBuildVariant {
	name: "baseline" | "modern";
	rustflags: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const targetPlatform = Bun.env.TARGET_PLATFORM || process.platform;
const targetArch = Bun.env.TARGET_ARCH || process.arch;
/**
 * `aes` 0.9 compiles its VAES512 backend into every x86_64 build: the module is
 * reached only through runtime CPU detection, but the AVX-512 instructions land
 * in the artifact either way — and the x86-64-v2/v3 addons must not contain them
 * (AGENTS.md).
 *
 * Measured 2026-09-13: adding `pdf-inspector` (→ `lopdf` → `aes`) broke the
 * native job on `vbroadcasti32x4 … %zmm0`, the opcode of
 * `aes-0.9.3/src/backends/x86_vaes512/encdec.rs::broadcast_keys`. That code sits
 * behind a const-generic dispatch and is instantiated into the *calling* crate's
 * codegen unit, so it does not appear in `aes`'s own object file — verified on an
 * x86_64-unknown-linux-gnu build: without this cfg the caller's object carries 5
 * AVX-512 instructions, with it, zero.
 *
 * Forcing the soft backend is `aes`'s documented knob for this, and the only one
 * that keeps the 512-bit module out of the binary. It costs AES-NI/VAES on these
 * builds, which is acceptable because the variants exist for the linux-x64 test
 * addons only — the shipped darwin-arm64 addon is built without variants and
 * keeps its intrinsics.
 */
const AES_SOFT_BACKEND_CFG = '--cfg aes_backend="soft"';

const variantConfigs: Record<NativeBuildVariant["name"], NativeBuildVariant> = {
	baseline: {
		name: "baseline",
		rustflags: `-C target-cpu=x86-64-v2 ${AES_SOFT_BACKEND_CFG}`,
	},
	modern: {
		name: "modern",
		rustflags: `-C target-cpu=x86-64-v3 ${AES_SOFT_BACKEND_CFG}`,
	},
};

function parseTargetVariants(): NativeBuildVariant[] {
	const rawVariants = (Bun.env.TARGET_VARIANTS ?? "").trim();
	if (!rawVariants) return [];

	return rawVariants.split(/\s+/).map((rawVariant) => {
		const variant = variantConfigs[rawVariant as keyof typeof variantConfigs];
		if (!variant) {
			throw new Error(`Unsupported TARGET_VARIANTS entry: ${rawVariant}. Expected baseline or modern.`);
		}
		return variant;
	});
}

function resolveExpectedAddons(variants: NativeBuildVariant[]): string[] {
	if (variants.length > 0) {
		return variants.map(variant => `${targetPlatform}-${targetArch}-${variant.name}`);
	}

	if (targetArch === "x64") {
		return [`${targetPlatform}-${targetArch}-${detectHostAvx2Support() ? "modern" : "baseline"}`];
	}

	return [`${targetPlatform}-${targetArch}`];
}

async function runNativeBuild(env: Record<string, string | undefined>, label: string): Promise<void> {
	if (isDryRun) {
		const variant = env.TARGET_VARIANT ? ` TARGET_VARIANT=${env.TARGET_VARIANT}` : "";
		const rustflags = env.RUSTFLAGS ? ` RUSTFLAGS=${JSON.stringify(env.RUSTFLAGS)}` : "";
		console.log(`DRY RUN bun --cwd=packages/natives run build [${label}]${variant}${rustflags}`);
		return;
	}

	console.log(`Building natives [${label}]...`);
	await $`bun --cwd=packages/natives run build`.cwd(repoRoot).env(env);
}

async function verifyBuiltAddons(expectedAddons: string[]): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun scripts/ci-release-verify-natives.ts PI_NATIVE_EXPECTED_ADDONS=${expectedAddons.join(" ")}`);
		return;
	}

	await $`bun scripts/ci-release-verify-natives.ts`
		.cwd(repoRoot)
		.env({
			...Bun.env,
			PI_NATIVE_EXPECTED_ADDONS: expectedAddons.join(" "),
		});
}

async function main(): Promise<void> {
	const variants = parseTargetVariants();
	if (variants.length === 0) {
		await runNativeBuild(Bun.env, "default");
		await verifyBuiltAddons(resolveExpectedAddons([]));
		return;
	}

	for (const variant of variants) {
		await runNativeBuild(
			{
				...Bun.env,
				RUSTFLAGS: variant.rustflags,
				CFLAGS: variant.name === "modern" ? "-march=x86-64-v3" : "-march=x86-64-v2",
				CXXFLAGS: variant.name === "modern" ? "-march=x86-64-v3" : "-march=x86-64-v2",
				TARGET_VARIANT: variant.name,
			},
			variant.name,
		);
	}

	await verifyBuiltAddons(resolveExpectedAddons(variants));
}

await main();
