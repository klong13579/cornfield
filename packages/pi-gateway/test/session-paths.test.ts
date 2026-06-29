/**
 * Unit tests for the session-paths contract.
 *
 * Covers the per-agent session path module: encodeCwd, cronSessionPath,
 * interactiveSessionPath, findAgentSessionPath, enumerateAgentSessions.
 *
 * The previous "global" findAgentSessionPath that walked
 * `~/.omp/agent/sessions/` has been removed; its tests lived in
 * find-agent-session.test.ts (now deleted) and tested behaviour the
 * design explicitly rejects.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cronSessionPath,
	encodeCwd,
	enumerateAgentSessions,
	findAgentSessionPath,
	interactiveSessionPath,
} from "../src/session-paths";

// ─────────────────────────────────────────────────────────────────────
// encodeCwd
// ─────────────────────────────────────────────────────────────────────
describe("encodeCwd", () => {
	it("replaces / with - and lowercases nothing (preserves case)", () => {
		expect(encodeCwd("/Users/Foo/Bar")).toBe("-Users-Foo-Bar");
	});

	it("normalises to absolute path before encoding", () => {
		// `path.resolve` of a relative cwd is process-cwd-based; just
		// assert the result is a leading-dash string with no embedded /.
		const out = encodeCwd("relative/path");
		expect(out.startsWith("-")).toBe(true);
		expect(out.includes("/")).toBe(false);
	});

	it("throws on empty cwd", () => {
		expect(() => encodeCwd("")).toThrow(/cwd required/);
	});
});

// ─────────────────────────────────────────────────────────────────────
// cronSessionPath
// ─────────────────────────────────────────────────────────────────────
describe("cronSessionPath", () => {
	it("builds <agentDir>/sessions/cron_<ts>.jsonl", () => {
		const agentDir = "/tmp/agent/hr";
		const fixed = 1_700_000_000_000;
		expect(cronSessionPath(agentDir, fixed)).toBe("/tmp/agent/hr/sessions/cron_1700000000000.jsonl");
	});

	it("uses Date.now() by default and produces a parseable filename", () => {
		const out = cronSessionPath("/tmp/agent/hr");
		expect(out.startsWith("/tmp/agent/hr/sessions/cron_")).toBe(true);
		const tail = path.basename(out);
		const m = /^cron_(\d+)\.jsonl$/.exec(tail);
		expect(m).not.toBeNull();
		expect(Number.parseInt(m![1]!, 10)).toBeGreaterThan(0);
	});

	it("throws on empty agentDir", () => {
		expect(() => cronSessionPath("", 1)).toThrow(/agentDir required/);
	});

	it("throws on non-positive now", () => {
		expect(() => cronSessionPath("/x", 0)).toThrow(/invalid now/);
		expect(() => cronSessionPath("/x", -1)).toThrow(/invalid now/);
	});
});

// ─────────────────────────────────────────────────────────────────────
// interactiveSessionPath
// ─────────────────────────────────────────────────────────────────────
describe("interactiveSessionPath", () => {
	it("encodes cwd into the path and matches OMP by-date layout", () => {
		const agentDir = "/tmp/agent/hr";
		const cwd = "/Users/sz/Desktop/Narwal/OMP-workspace-test/hr3";
		// Pin a known date so the assertion doesn't depend on the test clock.
		const fixed = new Date("2026-06-30T12:34:56");
		const out = interactiveSessionPath(agentDir, cwd, fixed);
		// Path components: <agentDir>/sessions/<encoded>/by-date/YYYYMMDD/HHMMSS__<8hex>.jsonl
		const expectedEncoded = "-Users-sz-Desktop-Narwal-OMP-workspace-test-hr3";
		const re = new RegExp(
			`^${escapeRe(agentDir)}/sessions/${escapeRe(expectedEncoded)}/by-date/20260630/123456__[0-9a-f]{8}\\.jsonl$`,
		);
		expect(out).toMatch(re);
		// Sanity: file basename pattern
		const base = path.basename(out);
		expect(base).toMatch(/^123456__[0-9a-f]{8}\.jsonl$/);
	});

	it("throws on empty agentDir", () => {
		expect(() => interactiveSessionPath("", "/x")).toThrow(/agentDir required/);
	});

	it("throws on empty cwd", () => {
		expect(() => interactiveSessionPath("/x", "")).toThrow(/cwd required/);
	});
});

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────
// findAgentSessionPath — per-agent scope
// ─────────────────────────────────────────────────────────────────────
describe("findAgentSessionPath (per-agent)", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-"));
	});
	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	/** Create <agentDir>/sessions/<rel> with explicit mtime. */
	function touch(rel: string, mtimeMs: number, content: string = "{}\n"): string {
		const full = path.join(agentDir, "sessions", rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
		fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
		return full;
	}

	it("returns undefined when the agent's sessions dir does not exist", () => {
		expect(findAgentSessionPath(agentDir, 0, Date.now())).toBeUndefined();
	});

	it("finds a cron file at the root of <agentDir>/sessions/", () => {
		const t = 1_700_000_000_000;
		const file = touch("cron_1700000000000.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBe(file);
	});

	it("finds an interactive file under <encoded-cwd>/by-date/<date>/", () => {
		const t = 1_700_000_000_000;
		const file = touch("-p/by-date/2023-11-14/120000__12345678.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBe(file);
	});

	it("scopes to the given agentDir — does NOT cross into a sibling agent", () => {
		// Create a sibling agent dir with a file in the same time window.
		const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-sibling-"));
		try {
			const t = 1_700_000_000_000;
			fs.mkdirSync(path.join(sibling, "sessions"), { recursive: true });
			const siblingFile = path.join(sibling, "sessions", "cron_1700000000000.jsonl");
			fs.writeFileSync(siblingFile, "{}\n");
			fs.utimesSync(siblingFile, new Date(t), new Date(t));

			// Agent A has no files; the sibling's file must not bleed in.
			expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
		} finally {
			fs.rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("prefers the most recent mtime within the window", () => {
		const t = 1_700_000_000_000;
		const older = touch("cron_1700000000001.jsonl", t - 1_000);
		const newer = touch("cron_1700000000002.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 5_000, t + 5_000)).toBe(newer);
		// Sanity: the older file is real and on disk
		expect(fs.existsSync(older!)).toBe(true);
	});

	it("tolerates ±5s on the window edges", () => {
		const t = 1_700_000_000_000;
		const before = touch("cron_1699999995000.jsonl", t - 5_000);
		const after = touch("cron_1700000005000.jsonl", t + 5_000);
		// window is [t, t]; ±5s tolerance includes both edges
		const r1 = findAgentSessionPath(agentDir, t, t);
		const r2 = findAgentSessionPath(agentDir, t - 100, t);
		const r3 = findAgentSessionPath(agentDir, t, t + 100);
		// Either one could win depending on mtime tie-break; just assert
		// that the result is one of the two in-window files.
		for (const r of [r1, r2, r3]) {
			expect([before, after]).toContain(r);
		}
	});

	it("rejects files outside the ±5s window", () => {
		const t = 1_700_000_000_000;
		touch("cron_too_old.jsonl", t - 5_001);
		touch("cron_too_new.jsonl", t + 5_001);
		expect(findAgentSessionPath(agentDir, t, t)).toBeUndefined();
	});

	it("rejects files that don't match the cron or interactive filename grammar", () => {
		const t = 1_700_000_000_000;
		touch("notes.jsonl", t);
		touch("readme.jsonl", t);
		touch("cron_bogus.txt", t);
		touch("cron_abc.jsonl", t); // not all digits
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
	});

	it("does not descend into hidden directories", () => {
		const t = 1_700_000_000_000;
		touch(".git/cron_1700000000000.jsonl", t);
		touch(".DS_Store/cron_1700000000000.jsonl", t);
		expect(findAgentSessionPath(agentDir, t - 100, t + 100)).toBeUndefined();
	});

	it("ignores empty agentDir", () => {
		expect(findAgentSessionPath("", 0, Date.now())).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────
// enumerateAgentSessions
// ─────────────────────────────────────────────────────────────────────
describe("enumerateAgentSessions", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-paths-enum-"));
	});
	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	function touch(rel: string, size: number, mtimeMs: number): void {
		const full = path.join(agentDir, "sessions", rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "x".repeat(size));
		fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
	}

	it("returns [] when the sessions dir doesn't exist", () => {
		expect(enumerateAgentSessions(agentDir)).toEqual([]);
	});

	it("returns [] for an empty agentDir", () => {
		expect(enumerateAgentSessions("")).toEqual([]);
	});

	it("enumerates both cron and interactive files, tagging type correctly", () => {
		const t = 1_700_000_000_000;
		touch("cron_1700000000000.jsonl", 10, t);
		touch("-p/by-date/2023-11-14/120000__12345678.jsonl", 20, t + 1);
		touch("-p/by-date/2023-11-14/130000__87654321.jsonl", 30, t + 2);
		const entries = enumerateAgentSessions(agentDir);
		expect(entries.length).toBe(3);
		const cron = entries.find(e => e.type === "cron");
		const interactive = entries.filter(e => e.type === "interactive");
		expect(cron).toBeDefined();
		expect(cron?.size).toBe(10);
		expect(interactive.length).toBe(2);
		expect(interactive.every(e => e.size > 0)).toBe(true);
	});

	it("ignores files that don't match the filename grammar", () => {
		const t = 1_700_000_000_000;
		touch("cron_1700000000000.jsonl", 10, t);
		touch("notes.jsonl", 5, t);
		touch("readme.txt", 5, t);
		touch("cron_abc.jsonl", 5, t); // not all digits
		const entries = enumerateAgentSessions(agentDir);
		expect(entries.length).toBe(1);
		expect(entries[0]?.type).toBe("cron");
	});
});
