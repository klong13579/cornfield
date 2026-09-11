import { describe, expect, it } from "bun:test";
import { findNonSystemDependencies, hasAvx512Markers } from "../../../scripts/ci-release-verify-natives";
import { buildZigArgs } from "../scripts/zig-safe-wrapper";

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

	describe("findNonSystemDependencies", () => {
		it("flags a non-system (e.g. Homebrew) dependency", () => {
			const dump = [
				"/repo/packages/natives/native/cornfield_natives.darwin-arm64.node:",
				"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)",
				"\t/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib (compatibility version 16.0.0, current version 16.0.0)",
			].join("\n");
			expect(findNonSystemDependencies(dump)).toEqual(["/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib"]);
		});

		it("accepts system libraries/frameworks and the addon's own install_name", () => {
			const dump = [
				"/repo/packages/natives/native/cornfield_natives.darwin-arm64.node:",
				"\t/repo/target/aarch64-apple-darwin/ci/deps/libcornfield_natives.dylib (compatibility version 0.0.0, current version 0.0.0)",
				"\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)",
				"\t/usr/lib/libobjc.A.dylib (compatibility version 1.0.0, current version 228.0.0)",
				"\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 2420.0.0)",
			].join("\n");
			expect(findNonSystemDependencies(dump)).toEqual([]);
		});

		it("flags an rpath dependency: user machines cannot be assumed to provide it", () => {
			const dump = [
				"binary:",
				"\t@rpath/libpcre2-8.0.dylib (compatibility version 16.0.0, current version 16.0.0)",
			].join("\n");
			expect(findNonSystemDependencies(dump)).toEqual(["@rpath/libpcre2-8.0.dylib"]);
		});

		it("ignores the header line and blank lines", () => {
			expect(findNonSystemDependencies("\n/repo/x.node:\n\n")).toEqual([]);
		});
	});
});
