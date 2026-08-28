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
const variantConfigs: Record<NativeBuildVariant["name"], NativeBuildVariant> = {
	baseline: {
		name: "baseline",
		rustflags: "-C target-cpu=x86-64-v2",
	},
	modern: {
		name: "modern",
		rustflags: "-C target-cpu=x86-64-v3",
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


async function reportAvx512ObjectFiles(targetDir: string): Promise<void> {
	if (targetPlatform !== "linux" || targetArch !== "x64") return;
	const objdump = Bun.which("objdump");
	if (!objdump) return;
	const entries = (
		await Promise.all(
			["**/*.o", "**/*.a", "**/*.rlib"].map(pattern =>
				Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: targetDir, absolute: true })),
			),
		)
	).flat();
	for (const entry of entries) {
		const result = Bun.spawnSync([objdump, "-d", entry], { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) continue;
		const lines = result.stdout.toString("utf-8").split("\n");
		const marker = lines.find(line => /%(?:zmm\d+|k[0-7])\b/.test(line));
		if (marker) console.error(`[native-isa-source] ${entry}\n${marker.trim()}`);
	}
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
				CFLAGS_x86_64_unknown_linux_gnu: variant.name === "modern" ? "-march=x86-64-v3" : "-march=x86-64-v2",
				CXXFLAGS_x86_64_unknown_linux_gnu: variant.name === "modern" ? "-march=x86-64-v3" : "-march=x86-64-v2",
				TARGET_VARIANT: variant.name,
			},
			variant.name,
		);
		await reportAvx512ObjectFiles(path.join(repoRoot, "target", "napi-build"));
	}

	await verifyBuiltAddons(resolveExpectedAddons(variants));
}

await main();
