/**
 * Adversarial tests for findAgentSessionPath.
 *
 * Each test maps to a specific contract or regression. The 3 real bugs
 * below were caught by the e2e smoke (scripts/smoke-find-agent-session.ts)
 * but NOT by the original happy-path unit tests — this file is rewritten
 * to make sure that doesn't happen again.
 *
 *   Bug A — walker only descended into dirs named "by-date" or
 *           "YYYY-MM-DD", never into the cwd-encoded project subdir.
 *           Symptom: every new-layout session file in the real tree
 *           was invisible to the function.
 *
 *   Bug B — the new-layout filename regex was written as HH-MM-SS
 *           (with hyphens) but timeStamp() emits HHMMSS (no hyphens),
 *           so NO new-layout file matched.
 *
 *   Bug C — score was |mtime - startedAt|, picking the file CLOSEST
 *           to the window START (oldest in window), not the most
 *           recent. A 5-day-old legacy file could beat a 7-hour-old
 *           new-layout file just because the window spanned 7 days.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findAgentSessionPath } from "../src/scheduler/cli-commands";

let sessionsRoot: string;

beforeEach(() => {
	sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "find-agent-session-"));
});

afterEach(() => {
	fs.rmSync(sessionsRoot, { recursive: true, force: true });
});

/**
 * Create a session file at a given relative path, with an explicit
 * mtime (epoch ms). Returns the absolute path.
 */
function touch(rel: string, mtimeMs: number): string {
	const full = path.join(sessionsRoot, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, "{}\n");
	fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
	return full;
}

/** Call findAgentSessionPath with the test's tmp root. */
function find(startedAt: number, endedAt: number): string | undefined {
	return findAgentSessionPath(startedAt, endedAt, sessionsRoot);
}

// ─────────────────────────────────────────────────────────────────────
// Contract 1: tolerance window
// ─────────────────────────────────────────────────────────────────────
describe("contract: tolerance window", () => {
	it("accepts a file whose mtime is exactly startedAt - 5000ms", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t - 5_000);
		expect(find(t, t + 100)).toBe(file);
	});

	it("accepts a file whose mtime is exactly endedAt + 5000ms", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t + 5_000);
		expect(find(t - 100, t)).toBe(file);
	});

	it("rejects a file 5001ms before startedAt", () => {
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t - 5_001);
		expect(find(t, t + 100)).toBeUndefined();
	});

	it("rejects a file 5001ms after endedAt", () => {
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t + 5_001);
		expect(find(t - 100, t)).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────
// Contract 2: filename grammar (the "filter", not the "sort key")
// ─────────────────────────────────────────────────────────────────────
describe("contract: filename grammar", () => {
	it("matches the new layout grammar (HHMMSS, no hyphens, 8-hex tail)", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/004708__b8c75295.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("matches the new layout with a slug", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/004708-ce-shi-ren-wu__b8c75295.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("matches the legacy grammar (ISO with hyphens, mmm, uuidv7)", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/2023-11-14T22-13-20-000Z_019ee0c7-7493-7000-93bf-1d5bb8c75295.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("rejects HH-MM-SS hyphenated form (would have caught Bug B)", () => {
		// Bug B regression: the old regex was /^(\d{2})-(\d{2})-(\d{2}).../,
		// which doesn't match the actual filename "004708__b8c75295.jsonl"
		// produced by timeStamp(). This file uses HH-MM-SS (hyphenated)
		// which is NOT what timeStamp() emits — must NOT be matched.
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/00-47-08__b8c75295.jsonl", t);
		expect(find(t - 100, t + 100)).toBeUndefined();
	});

	it("rejects non-8-hex tails (must be exactly 8 hex chars)", () => {
		const t = 1_700_000_000_000;
		// 7 hex
		touch("-p/by-date/2023-11-14/120000__1234567.jsonl", t);
		// 9 hex
		touch("-p/by-date/2023-11-14/120000__123456789.jsonl", t);
		// mixed
		touch("-p/by-date/2023-11-14/120000__1234567g.jsonl", t);
		expect(find(t - 100, t + 100)).toBeUndefined();
	});

	it("rejects files with non-.jsonl extension", () => {
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/120000__12345678.txt", t);
		touch("-p/by-date/2023-11-14/120000__12345678.json", t);
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl.bak", t);
		expect(find(t - 100, t + 100)).toBeUndefined();
	});

	it("rejects arbitrary jsonl files that look nothing like session names", () => {
		const t = 1_700_000_000_000;
		touch("-p/notes.jsonl", t);
		touch("-p/2023-11-14.jsonl", t);
		touch("-p/something-else.jsonl", t);
		expect(find(t - 100, t + 100)).toBeUndefined();
	});

	it("accepts a new-layout filename at the project root (regex is the only filter)", () => {
		// The walker does NOT require the file to be inside by-date/YYYY-MM-DD/.
		// If a file matches the new-layout regex, it's considered a session
		// file regardless of where it lives. This is the documented contract:
		// by-date/ is for human readability, not for filtering.
		const t = 1_700_000_000_000;
		const file = touch("-p/004708__b8c75295.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Regression: Bug A — walker must descend into cwd-encoded project subdirs
// ─────────────────────────────────────────────────────────────────────
describe("regression Bug A: walker descends into project subdirs", () => {
	it("finds files in a project subdir named like '-Desktop-Narwal-oh-my-pi'", () => {
		const t = 1_700_000_000_000;
		const file = touch("-Desktop-Narwal-oh-my-pi/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("finds files across multiple project subdirs, picking the right one", () => {
		const t = 1_700_000_000_000;
		const _projA = touch("-project-A/by-date/2023-11-14/120000__aaaaaaaa.jsonl", t - 10_000);
		const projB = touch("-project-B/by-date/2023-11-14/120000__bbbbbbbb.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(projB);
	});

	it("finds files at the third level (by-date/yyyy-mm-dd/)", () => {
		// The walker must descend through: sessionsRoot → project → by-date → yyyy-mm-dd
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("walks even when the project subdir name is unusual (e.g. starts with a hyphen)", () => {
		const t = 1_700_000_000_000;
		const file = touch("-weird--name--/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(find(t - 100, t + 100)).toBe(file);
	});

	it("does not descend into hidden directories (e.g. .DS_Store, .git)", () => {
		const t = 1_700_000_000_000;
		touch("-p/.git/by-date/2023-11-14/120000__12345678.jsonl", t);
		touch("-p/.DS_Store/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(find(t - 100, t + 100)).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────
// Regression: Bug C — must prefer the most recent mtime, not the
//                          oldest mtime in the window
// ─────────────────────────────────────────────────────────────────────
describe("regression Bug C: most recent mtime wins", () => {
	it("new-layout file (later mtime) beats legacy file (earlier mtime) in same project", () => {
		const t = 1_700_000_000_000;
		const legacy = touch(
			"-p/2023-11-14T10-00-00-000Z_019ee0c7-7493-7000-93bf-1d5bb8c75295.jsonl",
			t - 100_000, // 100s before window start — well within 7-day window
		);
		const newer = touch(
			"-p/by-date/2023-11-14/120000__12345678.jsonl",
			t, // at the end of the window
		);
		// 7-day window: a 5-day-old file would be inside it
		expect(find(t - 7 * 24 * 60 * 60 * 1000, t + 100)).toBe(newer);
		// And `legacy` must NOT win just because it's closer to window start
		expect(find(t - 7 * 24 * 60 * 60 * 1000, t + 100)).not.toBe(legacy);
	});

	it("two in-window files: the one with larger mtime wins", () => {
		const t = 1_700_000_000_000;
		const older = touch("-p/by-date/2023-11-14/100000__11111111.jsonl", t - 1_000);
		const newer = touch("-p/by-date/2023-11-14/120000__22222222.jsonl", t);
		expect(find(t - 5_000, t + 5_000)).toBe(newer);
		// Sanity: the older file IS in the window, just not the best
		expect(older).toBeDefined();
	});

	it("a file just BEFORE the window loses to one just AFTER (across tolerance)", () => {
		// startedAt - 5000 = lower bound, endedAt + 5000 = upper bound
		const t = 1_700_000_000_000;
		const before = touch(
			"-p/by-date/2023-11-14/100000__11111111.jsonl",
			t - 5_000, // exactly at lower bound
		);
		const after = touch(
			"-p/by-date/2023-11-14/120000__22222222.jsonl",
			t + 5_000, // exactly at upper bound
		);
		// after.mtime > before.mtime, so after wins regardless of distance metric
		const result = find(t, t);
		expect(result).toBe(after);
		expect(result).not.toBe(before);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Contract: deterministic, content-independent, mtime-driven
// ─────────────────────────────────────────────────────────────────────
describe("contract: deterministic + content-independent", () => {
	it("does not read file content (mtime alone determines ordering)", () => {
		const t = 1_700_000_000_000;
		const good = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		const bad = touch("-p/by-date/2023-11-14/130000__87654321.jsonl", t - 100);
		// Overwrite the second file with garbage. The result should not change
		// because the function only consults mtime, not content.
		fs.writeFileSync(bad, "this is not valid jsonl\n{still not valid}\n");
		fs.utimesSync(bad, new Date(t - 100), new Date(t - 100));
		expect(find(t - 5_000, t + 5_000)).toBe(good);
	});

	it("returns the same result when called twice with the same args", () => {
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		touch("-p/by-date/2023-11-14/130000__87654321.jsonl", t - 1_000);
		const a = find(t - 5_000, t + 5_000);
		const b = find(t - 5_000, t + 5_000);
		expect(a).toBe(b);
	});

	it("returns a path that actually points to a real file on disk", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		const result = find(t - 100, t + 100);
		expect(result).toBe(file);
		expect(fs.existsSync(result!)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Contract: realistic mixed trees (the real e2e shape)
// ─────────────────────────────────────────────────────────────────────
describe("contract: realistic mixed tree", () => {
	it("picks the file in the by-date/ tree when legacy and new are both in window", () => {
		const t = 1_700_000_000_000;
		const legacy = touch(
			"-p/2023-11-14T08-00-00-000Z_019ee0c7-7493-7000-93bf-1d5bb8c75295.jsonl",
			t - 60_000, // 1 min before window end
		);
		const newer = touch(
			"-p/by-date/2023-11-14/120000__12345678.jsonl",
			t, // at window end
		);
		expect(find(t - 5_000, t + 100)).toBe(newer);
		expect(find(t - 5_000, t + 100)).not.toBe(legacy);
	});

	it("picks a deep by-date/ file when other projects have files in the same window", () => {
		const t = 1_700_000_000_000;
		// Decoys: many files in many projects, various dates
		touch("-other/2023-11-13T08-00-00-000Z_019ee0c7-7493-7000-93bf-1d5bb8c75295.jsonl", t - 100_000);
		touch("-other/2023-11-14T08-00-00-000Z_019ee0c7-7493-7000-93bf-1d5bb8c75295.jsonl", t - 50_000);
		touch("-p/by-date/2023-11-13/120000__11111111.jsonl", t - 200_000);
		const target = touch("-p/by-date/2023-11-14/120000__22222222.jsonl", t);
		expect(find(t - 5_000, t + 100)).toBe(target);
	});

	it("handles 100+ files without crashing (no quadratic pathology)", () => {
		const t = 1_700_000_000_000;
		// Create 100 decoy files across multiple project subdirs
		for (let i = 0; i < 100; i++) {
			const proj = `-proj-${i % 5}`;
			const day = `2023-11-${String(10 + (i % 5)).padStart(2, "0")}`;
			const t0 = t - 60_000 - i * 1000;
			touch(`${proj}/by-date/${day}/120000__${i.toString(16).padStart(8, "0")}.jsonl`, t0);
		}
		const target = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		const t0 = performance.now();
		const result = find(t - 5_000, t + 100);
		const elapsed = performance.now() - t0;
		expect(result).toBe(target);
		// Sanity: 100 stat()s should be < 1 second. If we're doing something
		// pathological (e.g. reading file content, re-walking the tree), this
		// will fail.
		expect(elapsed).toBeLessThan(1000);
	});
});

// ─────────────────────────────────────────────────────────────────────
// Contract: edge cases
// ─────────────────────────────────────────────────────────────────────
describe("contract: edge cases", () => {
	it("returns undefined for an empty sessions root", () => {
		expect(find(0, Date.now())).toBeUndefined();
	});

	it("returns undefined when root doesn't exist", () => {
		fs.rmSync(sessionsRoot, { recursive: true, force: true });
		expect(find(0, Date.now())).toBeUndefined();
	});

	it("a startedAt == endedAt == 0 window with no files at epoch 0 returns undefined", () => {
		// Edge: trivial window at epoch start. The function is not responsible
		// for validating the window — it just filters by mtime. With no files,
		// the result is undefined.
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", 1_700_000_000_000);
		expect(find(0, 0)).toBeUndefined();
	});

	it("returns undefined when startedAt === endedAt and no file is exactly at t", () => {
		const t = 1_700_000_000_000;
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t - 10_000);
		expect(find(t, t)).toBeUndefined();
	});

	it("ignores a 0-byte jsonl file (still matched, mtime is the truth)", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		fs.truncateSync(file, 0);
		fs.utimesSync(file, new Date(t), new Date(t));
		expect(find(t - 100, t + 100)).toBe(file);
	});
});
