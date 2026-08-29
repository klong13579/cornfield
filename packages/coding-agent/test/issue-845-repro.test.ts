import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@cornfield/utils";
import { _resolveUpdateMethodForTest } from "../src/cli/update-cli";

// Issue #845: on Windows with Bun installed via Scoop, ~/.bun is a junction
// to scoop\persist\Oven-sh.Bun\.bun. `bun pm bin -g` and the cornfield path that
// $which finds may end up referring to the same directory through different
// path strings (one through the junction, one through the real target).
// `isPathInDirectory` did purely lexical comparison via path.resolve, which
// does not follow filesystem links, so it misclassified Bun-installed cornfield
// as "binary" and tried to swap cornfield.exe in place – which fails on Windows
// because Bun has the file open (EPERM on unlink of .bak).
//
// We reproduce the realpath-resolution bug with a symlink (works on macOS /
// Linux; the bug is realpath, not junction-specific).

describe("issue-845: resolveUpdateMethod follows symlinks/junctions", () => {
	let tmpRoot: string;
	let realBinDir: string;
	let linkedBinDir: string;
	let cornfieldPathViaLink: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cornfield-issue-845-"));
		realBinDir = path.join(tmpRoot, "real", "bin");
		fs.mkdirSync(realBinDir, { recursive: true });
		fs.writeFileSync(path.join(realBinDir, APP_NAME), "#!/bin/sh\n", { mode: 0o755 });

		linkedBinDir = path.join(tmpRoot, "link-bin");
		fs.symlinkSync(realBinDir, linkedBinDir, "dir");
		cornfieldPathViaLink = path.join(linkedBinDir, APP_NAME);
	});

	afterAll(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("classifies cornfield reached through a symlinked bin dir as bun-managed", () => {
		// $which resolves through the symlink, `bun pm bin -g` returns the real path
		// (or vice versa). Either direction must be recognized.
		const method = _resolveUpdateMethodForTest(cornfieldPathViaLink, realBinDir);
		expect(method).toBe("bun");
	});

	it("classifies cornfield at the real bin dir as bun-managed when bunBinDir is symlinked", () => {
		const cornfieldAtReal = path.join(realBinDir, APP_NAME);
		const method = _resolveUpdateMethodForTest(cornfieldAtReal, linkedBinDir);
		expect(method).toBe("bun");
	});
});
