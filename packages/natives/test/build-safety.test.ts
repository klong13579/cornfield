import { describe, expect, it } from "bun:test";
import {
	findNonSystemDependencies,
	hasAvx512Markers,
	readMachODependencies,
} from "../../../scripts/ci-release-verify-natives";
import { buildZigArgs } from "../scripts/zig-safe-wrapper";

const LC_LOAD_DYLIB = 0x0c;
const LC_LOAD_WEAK_DYLIB = 0x80000018;

/** Builds a minimal 64-bit Mach-O image carrying the given dylib load commands. */
function machO(dependencies: ReadonlyArray<{ name: string; command?: number }>): Uint8Array {
	const headerSize = 32;
	const commands = dependencies.map(({ name, command }) => {
		const raw = new TextEncoder().encode(`${name}\0`);
		const nameOffset = 24;
		const size = nameOffset + raw.byteLength;
		const padded = size + ((8 - (size % 8)) % 8);
		return { raw, nameOffset, size: padded, command: command ?? LC_LOAD_DYLIB };
	});
	const commandsSize = commands.reduce((sum, command) => sum + command.size, 0);
	const bytes = new Uint8Array(headerSize + commandsSize);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64 (little-endian on disk)
	view.setUint32(16, commands.length, true);
	view.setUint32(20, commandsSize, true);
	let cursor = headerSize;
	for (const command of commands) {
		view.setUint32(cursor, command.command, true);
		view.setUint32(cursor + 4, command.size, true);
		view.setUint32(cursor + 8, command.nameOffset, true);
		bytes.set(command.raw, cursor + command.nameOffset);
		cursor += command.size;
	}
	return bytes;
}

/** Wraps thin images in a fat header (big-endian), as lipo would produce. */
function fatMachO(slices: readonly Uint8Array[]): Uint8Array {
	const headerSize = 8 + slices.length * 20;
	const bytes = new Uint8Array(headerSize + slices.reduce((sum, slice) => sum + slice.byteLength, 0));
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0xcafebabe, false); // FAT_MAGIC
	view.setUint32(4, slices.length, false);
	let offset = headerSize;
	slices.forEach((slice, index) => {
		const entry = 8 + index * 20;
		view.setUint32(entry + 8, offset, false);
		view.setUint32(entry + 12, slice.byteLength, false);
		bytes.set(slice, offset);
		offset += slice.byteLength;
	});
	return bytes;
}

describe("native build safety", () => {
	describe("buildZigArgs", () => {
		it("pins host zig build to the requested cpu contract", () => {
			expect(
				buildZigArgs(["build", "-Doptimize=ReleaseFast"], { target: "x86_64-linux-gnu", cpu: "x86_64_v2" }),
			).toEqual(["build", "-Doptimize=ReleaseFast", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v2"]);
		});

		it("does not override explicit zig target or cpu flags", () => {
			expect(
				buildZigArgs(["build", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v3"], {
					target: "x86_64-linux-gnu",
					cpu: "x86_64_v2",
				}),
			).toEqual(["build", "-Dtarget=x86_64-linux-gnu", "-Dcpu=x86_64_v3"]);
		});

		it("leaves non-build zig commands untouched", () => {
			expect(buildZigArgs(["version"], { target: "x86_64-linux-gnu", cpu: "x86_64_v2" })).toEqual(["version"]);
		});
	});

	describe("hasAvx512Markers", () => {
		it("flags AVX-512 register markers in disassembly", () => {
			expect(hasAvx512Markers("60ba1df:\tc4 c1 78 92 c9\t\tkmovw  %r9d,%k1")).toBe(true);
			expect(hasAvx512Markers("123456:\t62 f1 7d 48 6f c0\tvmovdqa32 %zmm0,%zmm1")).toBe(true);
		});

		it("flags EVEX-encoded AVX-512 even without zmm or mask registers", () => {
			expect(hasAvx512Markers("401000:\t62 f3 75 28 25 c2 96\tvpternlogd $0x96,%ymm2,%ymm1,%ymm0")).toBe(true);
		});

		it("ignores ordinary x86-64 disassembly", () => {
			expect(hasAvx512Markers("401000:\t48 89 e5\t\tmov %rsp,%rbp")).toBe(false);
			expect(hasAvx512Markers("401004:\tc5 f5 fe c2\tvpaddd %ymm2,%ymm1,%ymm0")).toBe(false);
			expect(hasAvx512Markers("58b83d7:\t62 00 00 00 ")).toBe(false);
		});

		it("ignores AVX-512-like text outside the instruction column", () => {
			expect(hasAvx512Markers("0000000000000000 <worker_k1>:")).toBe(false);
			expect(hasAvx512Markers("Disassembly of section .text.zmm0_helper:")).toBe(false);
		});
	});

	describe("readMachODependencies", () => {
		it("reads dylib load commands from a thin 64-bit image", () => {
			const bytes = machO([{ name: "/usr/lib/libSystem.B.dylib" }, { name: "@rpath/libpcre2-8.0.dylib" }]);
			expect(readMachODependencies(bytes, "addon.node")).toEqual([
				"/usr/lib/libSystem.B.dylib",
				"@rpath/libpcre2-8.0.dylib",
			]);
		});

		it("reads weak-linked dependencies too — a missing weak dylib still breaks loading", () => {
			const bytes = machO([{ name: "/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib", command: LC_LOAD_WEAK_DYLIB }]);
			expect(readMachODependencies(bytes, "addon.node")).toEqual(["/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib"]);
		});

		it("reads every architecture slice of a fat image", () => {
			const fat = fatMachO([
				machO([{ name: "/usr/lib/libSystem.B.dylib" }]),
				machO([{ name: "/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib" }]),
			]);
			expect(readMachODependencies(fat, "addon.node").sort()).toEqual(
				["/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib", "/usr/lib/libSystem.B.dylib"].sort(),
			);
		});

		it("rejects a non-Mach-O image rather than reporting zero dependencies", () => {
			expect(() =>
				readMachODependencies(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), "addon.node"),
			).toThrow(/not a Mach-O image/);
			expect(() => readMachODependencies(new Uint8Array([1, 2, 3]), "addon.node")).toThrow(/too small/);
		});
	});

	describe("findNonSystemDependencies", () => {
		it("flags a non-system (e.g. Homebrew) dependency", () => {
			expect(
				findNonSystemDependencies(["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib"]),
			).toEqual(["/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib"]);
		});

		it("accepts system libraries and frameworks", () => {
			expect(
				findNonSystemDependencies([
					"/usr/lib/libSystem.B.dylib",
					"/usr/lib/libobjc.A.dylib",
					"/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
				]),
			).toEqual([]);
		});

		it("flags an rpath dependency: user machines cannot be assumed to provide it", () => {
			expect(findNonSystemDependencies(["@rpath/libpcre2-8.0.dylib"])).toEqual(["@rpath/libpcre2-8.0.dylib"]);
		});

		it("returns nothing for an image with no dependencies", () => {
			expect(findNonSystemDependencies([])).toEqual([]);
		});
	});
});
