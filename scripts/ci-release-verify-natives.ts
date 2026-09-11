#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const nativeDir = path.resolve(Bun.env.PI_NATIVE_VERIFY_DIR ?? path.join(repoRoot, "packages", "natives", "native"));
const defaultExpectedAddons = [
	"linux-x64-modern",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64-modern",
	"darwin-x64-baseline",
	"darwin-arm64",
	"win32-x64-modern",
	"win32-x64-baseline",
] as const;
const x64LinuxIsaContracts = [
	{ addon: "linux-x64-baseline", filename: "cornfield_natives.linux-x64-baseline.node", label: "x86-64-v2" },
	{ addon: "linux-x64-modern", filename: "cornfield_natives.linux-x64-modern.node", label: "x86-64-v3" },
] as const;
const AVX512_REGISTER_PATTERN = /%(?:zmm\d+|k[0-7])\b/;

export function findAvx512Markers(disassembly: string): string[] {
	const markers: string[] = [];
	let symbol = "<unknown symbol>";
	for (const line of disassembly.split("\n")) {
		if (/^[0-9a-f]+ <[^>]+>:$/.test(line.trim())) {
			symbol = line.trim();
			continue;
		}
		const columns = line.split("\t");
		if (columns.length < 3) continue;

		const bytes = columns[1]?.trim() ?? "";
		const instruction = columns.slice(2).join("\t").trim();
		const hasRegister = AVX512_REGISTER_PATTERN.test(instruction);
		const hasEvex = bytes.startsWith("62 ") && /^[a-z]/i.test(instruction) && !instruction.startsWith(".byte");
		if (hasRegister || hasEvex) markers.push(`${symbol}\n${line.trim()}`);
	}
	return markers;
}

export function hasAvx512Markers(disassembly: string): boolean {
	return findAvx512Markers(disassembly).length > 0;
}

const DARWIN_SYSTEM_PREFIXES = ["/usr/lib/", "/System/"];
/** The addon's own install_name — `otool -L` lists it as a self-reference. */
const SELF_INSTALL_NAME = /(^|\/)libcornfield_natives\.dylib$/;

/**
 * Non-system dynamic dependencies reported by `otool -L`.
 *
 * A released binary may only link libraries every user machine already has. A
 * dependency such as `/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib` makes the
 * addon fail to load for anyone without Homebrew — measured 2026-09-11, when
 * pcre2-sys picked up the local library instead of its bundled sources; fixed by
 * pinning `PCRE2_SYS_STATIC=1` in `.cargo/config.toml`. This check is what makes
 * that invariant hold for the next dependency too.
 */
export function findNonSystemDependencies(otoolOutput: string): string[] {
	const deps: string[] = [];
	for (const rawLine of otoolOutput.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.endsWith(":")) continue;
		const match = /^([/@][^\s(]*)/.exec(line);
		if (!match) continue;
		const dep = match[1] ?? "";
		if (dep === "") continue;
		if (DARWIN_SYSTEM_PREFIXES.some((prefix) => dep.startsWith(prefix))) continue;
		if (SELF_INSTALL_NAME.test(dep)) continue;
		deps.push(dep);
	}
	return deps;
}

function linkedLibraries(binaryPath: string): string {
	const otoolPath = Bun.which("otool");
	if (!otoolPath) {
		throw new Error("otool is required to verify darwin native linkage contracts.");
	}
	const result = Bun.spawnSync([otoolPath, "-L", binaryPath], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`otool failed for ${binaryPath}: ${result.stderr.toString("utf-8").trim()}`);
	}
	return result.stdout.toString("utf-8");
}

function disassemble(binaryPath: string): string {
	const objdumpPath = Bun.which("objdump");
	if (!objdumpPath) {
		throw new Error("objdump is required to verify linux-x64 native ISA contracts.");
	}

	const result = Bun.spawnSync([objdumpPath, "-d", binaryPath], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString("utf-8").trim();
		throw new Error(`objdump failed for ${binaryPath}${stderr ? `:\n${stderr}` : ""}`);
	}

	return result.stdout.toString("utf-8");
}

function resolveExpectedAddons(): string[] {
	const configured = (Bun.env.PI_NATIVE_EXPECTED_ADDONS ?? "").trim();
	if (!configured) {
		return [...defaultExpectedAddons];
	}

	return configured.split(/[\s,]+/).filter(Boolean);
}

async function main(): Promise<void> {
	const entries = await fs.readdir(nativeDir);
	const expectedAddons = resolveExpectedAddons();

	console.log(`Native addons downloaded from ${nativeDir}:`);
	for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
		console.log(`  ${entry}`);
	}
	console.log();
	console.log(`Expected addons: ${expectedAddons.join(", ")}`);

	const missingAddons = expectedAddons.filter((platform) => !entries.includes(`cornfield_natives.${platform}.node`));
	if (missingAddons.length > 0) {
		for (const platform of missingAddons) {
			console.error(`MISSING cornfield_natives.${platform}.node`);
		}
		process.exit(1);
	}

	for (const platform of expectedAddons) {
		console.log(`OK cornfield_natives.${platform}.node`);
	}

	const isaFailures: string[] = [];
	for (const contract of x64LinuxIsaContracts) {
		if (!expectedAddons.includes(contract.addon)) {
			continue;
		}

		const binaryPath = path.join(nativeDir, contract.filename);
		const disassembly = disassemble(binaryPath);
		const markers = findAvx512Markers(disassembly);
		if (markers.length > 0) {
			isaFailures.push(
				`${contract.filename} contains AVX-512 markers; ${contract.label} artifacts must stay below x86-64-v4.\n${markers.slice(0, 3).join("\n")}`,
			);
			continue;
		}
		console.log(`OK ${contract.filename} contains no AVX-512 markers`);
	}

	if (isaFailures.length > 0) {
		for (const failure of isaFailures) {
			console.error(failure);
		}
		process.exit(1);
	}

	// Linkage contract: only macOS addons are checked, because only they ship
	// (AGENTS.md: releases are macOS-only; the linux-x64 addon exists so the test
	// jobs can run).
	const linkageFailures: string[] = [];
	for (const platform of expectedAddons.filter((entry) => entry.startsWith("darwin-"))) {
		const filename = `cornfield_natives.${platform}.node`;
		const binaryPath = path.join(nativeDir, filename);
		const nonSystem = findNonSystemDependencies(linkedLibraries(binaryPath));
		if (nonSystem.length > 0) {
			linkageFailures.push(
				`${filename} links non-system libraries:\n${nonSystem.join("\n")}\n` +
					"A released addon must not depend on libraries user machines may lack. " +
					"For the pcre2 case, keep `PCRE2_SYS_STATIC = { value = \"1\", force = true }` in .cargo/config.toml.",
			);
			continue;
		}
		console.log(`OK ${filename} links only system libraries`);
	}

	if (linkageFailures.length > 0) {
		for (const failure of linkageFailures) {
			console.error(failure);
		}
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
