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

const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;

/** Load commands that introduce a dependency on another dylib. */
const DYLIB_COMMANDS = new Set([0x0c, 0x80000018, 0x8000001f]);
const MACH_HEADER_64_SIZE = 32;
const MACH_HEADER_SIZE = 28;
const FAT_ARCH_SIZE = 20;

/**
 * Dynamic dependencies of a Mach-O image, read from its own load commands.
 *
 * A released binary may only link libraries every user machine already has. A
 * dependency such as `/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib` makes the
 * addon fail to load for anyone without Homebrew — measured 2026-09-11, when
 * pcre2-sys picked up the local library instead of its bundled sources; fixed by
 * pinning `PCRE2_SYS_STATIC=1` in `.cargo/config.toml`. This check is what makes
 * that invariant hold for the next dependency too.
 *
 * Parsed in-process instead of shelling out to `otool -L` because the job that
 * verifies the shipped darwin addon runs on Linux, where otool does not exist
 * (measured 2026-09-12: the v1.1.4 preflight died on exactly that gap). Reading
 * the load commands works on any host, so the shipping gate is never skipped.
 */
export function readMachODependencies(bytes: Uint8Array, label: string): string[] {
	if (bytes.byteLength < 8) {
		throw new Error(`${label}: too small to be a Mach-O image`);
	}

	const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
	if (magic !== FAT_MAGIC && magic !== FAT_CIGAM) {
		return readThinMachODependencies(bytes, 0, label);
	}

	// Fat binaries carry one slice per architecture; every slice ships, so every
	// slice has to satisfy the linkage contract.
	// Fat header fields (fat_header/fat_arch) are big-endian; FAT_CIGAM is the
	// byte-swapped variant. Note the DataView flag is littleEndian, not bigEndian —
	// naming it after the header's byte order is what inverted this read once.
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const littleEndian = magic === FAT_CIGAM;
	const sliceCount = view.getUint32(4, littleEndian);
	const dependencies = new Set<string>();
	for (let slice = 0; slice < sliceCount; slice++) {
		const entry = 8 + slice * FAT_ARCH_SIZE;
		if (entry + FAT_ARCH_SIZE > bytes.byteLength) {
			throw new Error(`${label}: truncated fat header`);
		}
		const offset = view.getUint32(entry + 8, littleEndian);
		for (const dependency of readThinMachODependencies(bytes, offset, label)) {
			dependencies.add(dependency);
		}
	}
	return [...dependencies];
}

function readThinMachODependencies(bytes: Uint8Array, start: number, label: string): string[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (start + 4 > bytes.byteLength) {
		throw new Error(`${label}: truncated Mach-O header`);
	}

	const magic = view.getUint32(start, false);
	const littleEndian = magic === MH_CIGAM || magic === MH_CIGAM_64;
	const is64Bit = magic === MH_MAGIC_64 || magic === MH_CIGAM_64;
	if (!littleEndian && magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
		throw new Error(`${label}: not a Mach-O image (magic 0x${magic.toString(16)})`);
	}

	const commandCount = view.getUint32(start + 16, littleEndian);
	let cursor = start + (is64Bit ? MACH_HEADER_64_SIZE : MACH_HEADER_SIZE);
	const names: string[] = [];
	for (let i = 0; i < commandCount; i++) {
		if (cursor + 8 > bytes.byteLength) {
			throw new Error(`${label}: truncated load command`);
		}
		const command = view.getUint32(cursor, littleEndian);
		const commandSize = view.getUint32(cursor + 4, littleEndian);
		if (commandSize < 8 || cursor + commandSize > bytes.byteLength) {
			throw new Error(`${label}: malformed load command at offset ${cursor}`);
		}

		if (DYLIB_COMMANDS.has(command) && commandSize >= 24) {
			const nameOffset = view.getUint32(cursor + 8, littleEndian);
			const nameStart = cursor + nameOffset;
			const limit = cursor + commandSize;
			if (nameStart >= cursor + 24 && nameStart < limit) {
				let end = nameStart;
				while (end < limit && bytes[end] !== 0) end++;
				const name = new TextDecoder().decode(bytes.subarray(nameStart, end));
				if (name !== "") names.push(name);
			}
		}
		cursor += commandSize;
	}
	return names;
}

/** Mach-O load commands already list only real dependencies, so any entry that is
 * not a system path and not self-relative is a release blocker. */
export function findNonSystemDependencies(dependencies: readonly string[]): string[] {
	return dependencies.filter((dep) => !DARWIN_SYSTEM_PREFIXES.some((prefix) => dep.startsWith(prefix)));
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
		const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
		const nonSystem = findNonSystemDependencies(readMachODependencies(bytes, filename));
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
