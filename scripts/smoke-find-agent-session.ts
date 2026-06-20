#!/usr/bin/env bun
/**
 * e2e smoke for findAgentSessionPath against the real ~/.omp/agent/sessions/ tree.
 *
 * Verifies:
 *  1. Recent time window picks up the new layout (by-date/<today>/<HHMMSS>__<8hex>.jsonl)
 *  2. Old time window (legacy era) still picks up legacy flat file (regex backwards compat)
 *  3. Empty window returns undefined
 *  4. Window with no match returns undefined
 *  5. Wide window: newest in by-date/ wins over older legacy
 */
import { findAgentSessionPath } from "../packages/pi-gateway/src/scheduler/cli-commands";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
const projectDir = path.join(sessionsRoot, "-Desktop-Narwal-oh-my-pi");

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
	} else {
		fail++;
		console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
	}
}

console.log("\n[1] New layout: 004708__b8c75295.jsonl (use file mtime as the source of truth)");
{
	const target = path.join(projectDir, "by-date", "2026-06-20", "004708__b8c75295.jsonl");
	const mtime = fs.statSync(target).mtimeMs;
	const found = findAgentSessionPath(mtime - 100, mtime + 60_000);
	check("returns the new-layout file", found === target, found ?? "undefined");
}

console.log("\n[2] Legacy file: pick the most recent legacy file by name prefix");
{
	const legacyFiles = fs
		.readdirSync(projectDir)
		.filter(f => f.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/.test(f))
		.sort()
		.reverse();
	if (legacyFiles.length === 0) {
		console.log("  (no legacy files in this dir, skipping)");
	} else {
		const newest = legacyFiles[0]!;
		const target = path.join(projectDir, newest);
		const mtime = fs.statSync(target).mtimeMs;
		const found = findAgentSessionPath(mtime - 100, mtime + 1000);
		check("returns the legacy flat file", found === target, found ?? "undefined");
	}
}

console.log("\n[3] Empty window: no match → undefined");
{
	const found = findAgentSessionPath(0, 1000);
	check("returns undefined", found === undefined, found ?? "undefined");
}

console.log("\n[4] No match: window in ancient past → undefined");
{
	const found = findAgentSessionPath(Date.parse("2000-01-01T00:00:00Z"), Date.parse("2000-01-01T00:00:01Z"));
	check("returns undefined", found === undefined, found ?? "undefined");
}

console.log("\n[5] Wide window (last 7 days): picks the file with the latest mtime in the window");
{
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const found = findAgentSessionPath(sevenDaysAgo, now + 60_000);
	if (found) {
		const rel = path.relative(projectDir, found);
		const looksByDate = rel.startsWith(`by-date${path.sep}`);
		const looksLegacy = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/.test(rel);
		check("returns a file under the project dir", found.startsWith(projectDir), found);
		check("matches by-date/ layout or legacy regex", looksByDate || looksLegacy, rel);
		// The contract is: most recent mtime in window. Verify that property:
		// re-walk and assert no other in-window file has a later mtime.
		const { readdirSync, statSync } = fs;
		const walk = (dir: string): string[] => {
			const out: string[] = [];
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					if (ent.name.startsWith(".")) continue;
					out.push(...walk(full));
				} else if (ent.name.endsWith(".jsonl") && (looksByDate ? /^(\d{6})(?:-[a-z0-9-]+)?__[0-9a-f]{8}\.jsonl$/.test(ent.name) : /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/.test(ent.name))) {
					out.push(full);
				}
			}
			return out;
		};
		const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
		const all = walk(sessionsRoot);
		const winnerMtime = statSync(found).mtimeMs;
		const anyNewer = all.some(f => statSync(f).mtimeMs > winnerMtime && statSync(f).mtimeMs <= now + 60_000 && statSync(f).mtimeMs >= sevenDaysAgo);
		check("no other in-window file has a later mtime", !anyNewer, path.basename(found));
	} else {
		check("returns SOMETHING for wide window", false, "undefined — expected a session within last 7 days");
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
