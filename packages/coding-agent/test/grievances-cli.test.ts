/**
 * `cornfield grievances` — the only exit for auto-QA reports. Covers the
 * time-ranged filter (including databases that predate timestamps), the
 * markdown digest that is meant to reach a human, the export marker, and the
 * destructive clean action.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanGrievances,
	exportGrievances,
	listGrievances,
	parseSinceCutoff,
} from "@cornfield/coding-agent/cli/grievances-cli";
import { getAutoQaDbPath } from "@cornfield/coding-agent/tools/report-tool-issue";
import { getConfigRootDir, setAgentDir } from "@cornfield/utils";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-15T12:00:00.000Z");

let testAgentDir = "";
const originalAgentDir = process.env.CORNFIELD_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-grievances-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.CORNFIELD_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

interface SeedRow {
	tool: string;
	report: string;
	createdAt: number | null;
	sessionId?: string | null;
}

/** Write a database directly — the reader must not depend on the tool running first. */
function seed(rows: SeedRow[], options: { legacy?: boolean } = {}): void {
	const db = new Database(getAutoQaDbPath());
	try {
		const columns = options.legacy
			? "id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, version TEXT NOT NULL, tool TEXT NOT NULL, report TEXT NOT NULL"
			: "id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, version TEXT NOT NULL, tool TEXT NOT NULL, report TEXT NOT NULL, createdAt INTEGER, sessionId TEXT, exported INTEGER NOT NULL DEFAULT 0";
		db.run(`CREATE TABLE grievances (${columns})`);
		const insert = options.legacy
			? db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES ('seed/model', '1.0.0', ?, ?)")
			: db.prepare(
					"INSERT INTO grievances (model, version, tool, report, createdAt, sessionId) VALUES ('seed/model', '1.0.0', ?, ?, ?, ?)",
				);
		for (const row of rows) {
			if (options.legacy) insert.run(row.tool, row.report);
			else insert.run(row.tool, row.report, row.createdAt, row.sessionId ?? null);
		}
	} finally {
		db.close();
	}
}

function readAll(): Array<{ id: number; tool: string; exported: number }> {
	const db = new Database(getAutoQaDbPath(), { readonly: true });
	try {
		return db.prepare("SELECT id, tool, exported FROM grievances ORDER BY id").all() as Array<{
			id: number;
			tool: string;
			exported: number;
		}>;
	} finally {
		db.close();
	}
}

async function capture(run: () => Promise<void>): Promise<string[]> {
	// `spyOn` returns the already-installed spy on a second call, so clear the
	// accumulated calls instead of pretending each capture starts empty. The
	// digest streams through `process.stdout.write`, the status lines through
	// `console.log` — both belong to the command's output.
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	logSpy.mockClear();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	writeSpy.mockClear();
	await run();
	return [
		...logSpy.mock.calls.map(call => String(call[0] ?? "")),
		...writeSpy.mock.calls.map(call => String(call[0] ?? "")),
	].map(line => Bun.stripANSI(line));
}

describe("parseSinceCutoff", () => {
	it("treats durations as relative to now", () => {
		expect(parseSinceCutoff("7d", NOW)).toBe(NOW - 7 * DAY);
		expect(parseSinceCutoff("36h", NOW)).toBe(NOW - 36 * 3_600_000);
		expect(parseSinceCutoff("90m", NOW)).toBe(NOW - 90 * 60_000);
		expect(parseSinceCutoff("2w", NOW)).toBe(NOW - 2 * 7 * DAY);
		expect(parseSinceCutoff(" 3D ", NOW)).toBe(NOW - 3 * DAY);
	});

	it("accepts an absolute date", () => {
		expect(parseSinceCutoff("2026-09-01", NOW)).toBe(Date.parse("2026-09-01"));
	});

	it("refuses values it cannot interpret", () => {
		expect(() => parseSinceCutoff("", NOW)).toThrow(/Unrecognized --since/);
		expect(() => parseSinceCutoff("7x", NOW)).toThrow(/Unrecognized --since/);
		expect(() => parseSinceCutoff("last week", NOW)).toThrow(/Unrecognized --since/);
		expect(() => parseSinceCutoff("7", NOW)).toThrow(/Unrecognized --since/);
	});
});

describe("listGrievances", () => {
	it("shows when and which session each report came from", async () => {
		seed([{ tool: "bash", report: "grep returned nothing", createdAt: NOW - DAY, sessionId: "01a0a484" }]);

		const lines = await capture(() => listGrievances({ limit: 20, json: false }));

		const body = lines.join("\n");
		expect(body).toContain("#1");
		expect(body).toContain("bash");
		expect(body).toContain(new Date(NOW - DAY).toISOString());
		expect(body).toContain("01a0a484");
		expect(body).toContain("grep returned nothing");
	});

	it("filters to the requested window", async () => {
		seed([
			{ tool: "read", report: "old", createdAt: NOW - 30 * DAY },
			{ tool: "write", report: "recent", createdAt: NOW - DAY },
		]);
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		const lines = await capture(() => listGrievances({ limit: 20, json: false, since: "7d" }));

		const body = lines.join("\n");
		expect(body).toContain("recent");
		expect(body).not.toContain("old");
		expect(body).toContain("Showing 1 most recent");
	});

	it("reports legacy rows it had to exclude from a time-ranged query", async () => {
		seed([{ tool: "bash", report: "before timestamps existed", createdAt: null }], { legacy: true });
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		const lines = await capture(() => listGrievances({ limit: 20, json: false, since: "7d" }));

		const body = lines.join("\n");
		expect(body).toContain("No reports in that window");
		expect(body).toContain("1 record(s) have no timestamp and were excluded");
	});

	it("reads a legacy database without the added columns at all", async () => {
		seed([{ tool: "bash", report: "legacy row", createdAt: null }], { legacy: true });

		const lines = await capture(() => listGrievances({ limit: 20, json: false }));

		const body = lines.join("\n");
		expect(body).toContain("legacy row");
		expect(body).toContain("no timestamp");
		expect(body).toContain("unknown session");
	});

	it("emits the new fields as JSON", async () => {
		seed([{ tool: "bash", report: "x", createdAt: NOW - DAY, sessionId: "sess-1" }]);

		const lines = await capture(() => listGrievances({ limit: 20, json: true }));

		const parsed = JSON.parse(lines.join("\n")) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ tool: "bash", createdAt: NOW - DAY, sessionId: "sess-1", exported: 0 });
	});

	it("renders a markdown digest, oldest first, with counts per tool", async () => {
		seed([
			{ tool: "bash", report: "first report", createdAt: NOW - 3 * DAY, sessionId: "sess-a" },
			{ tool: "bash", report: "second report", createdAt: NOW - 2 * DAY, sessionId: "sess-b" },
			{ tool: "write", report: "third report", createdAt: NOW - DAY, sessionId: "sess-c" },
		]);
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		const lines = await capture(() => listGrievances({ limit: 20, json: false, markdown: true, since: "7d" }));

		const body = lines.join("\n");
		expect(body).toContain(`# Auto-QA grievances — since ${new Date(NOW - 7 * DAY).toISOString()} (--since 7d)`);
		expect(body).toContain("3 reports · 2 tools");
		expect(body).toContain("| bash | 2 |");
		expect(body).toContain("| write | 1 |");
		expect(body.indexOf("first report")).toBeLessThan(body.indexOf("second report"));
		expect(body.indexOf("second report")).toBeLessThan(body.indexOf("third report"));
		expect(body).toContain("- session: sess-a");
	});

	it("says so when there is nothing in range instead of printing an empty digest", async () => {
		seed([{ tool: "bash", report: "old", createdAt: NOW - 30 * DAY }]);
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		const lines = await capture(() => listGrievances({ limit: 20, json: false, markdown: true, since: "7d" }));

		expect(lines.join("\n")).toContain("No reports in range.");
	});

	it("refuses the two output formats at once", () => {
		expect(() => listGrievances({ limit: 20, json: true, markdown: true })).toThrow(/mutually exclusive/);
	});

	it("handles a missing database", async () => {
		const lines = await capture(() => listGrievances({ limit: 20, json: false }));
		expect(lines.join("\n")).toContain("No grievances database found");

		const jsonLines = await capture(() => listGrievances({ limit: 20, json: true }));
		expect(jsonLines.join("\n")).toBe("[]");
	});
});

describe("cleanGrievances", () => {
	it("deletes every report for one tool", async () => {
		seed([
			{ tool: "yield", report: "noise", createdAt: null },
			{ tool: "yield", report: "more noise", createdAt: null },
			{ tool: "bash", report: "keep me", createdAt: NOW },
		]);

		const lines = await capture(() => cleanGrievances({ tool: "yield" }));

		expect(lines.join("\n")).toContain("Deleted 2 grievances for yield.");
		expect(readAll().map(row => row.tool)).toEqual(["bash"]);
	});

	it("deletes a single report by id", async () => {
		seed([
			{ tool: "bash", report: "first", createdAt: NOW },
			{ tool: "read", report: "second", createdAt: NOW },
		]);

		const lines = await capture(() => cleanGrievances({ id: 2 }));

		expect(lines.join("\n")).toContain("Deleted 1 grievance #2.");
		expect(readAll().map(row => row.id)).toEqual([1]);
	});

	it("restarts the id sequence when everything is deleted", async () => {
		seed([
			{ tool: "bash", report: "first", createdAt: NOW },
			{ tool: "read", report: "second", createdAt: NOW },
		]);

		await capture(() => cleanGrievances({ all: true }));
		expect(readAll()).toHaveLength(0);

		const db = new Database(getAutoQaDbPath());
		try {
			db.prepare(
				"INSERT INTO grievances (model, version, tool, report, createdAt, sessionId) VALUES ('m', 'v', 'bash', 'fresh', ?, null)",
			).run(NOW);
			const row = db.prepare("SELECT MAX(id) AS id FROM grievances").get() as { id: number };
			expect(row.id).toBe(1);
		} finally {
			db.close();
		}
	});

	it("refuses ambiguous or missing selectors", async () => {
		seed([{ tool: "bash", report: "x", createdAt: NOW }]);

		await expect(cleanGrievances({})).rejects.toThrow(/exactly one of --id, --tool, or --all/);
		await expect(cleanGrievances({ id: 1, all: true })).rejects.toThrow(/mutually exclusive/);
		expect(readAll()).toHaveLength(1);
	});

	it("does not create a database just to clean it", async () => {
		const lines = await capture(() => cleanGrievances({ tool: "yield" }));

		expect(lines.join("\n")).toContain("No grievances database found");
		expect(existsSync(getAutoQaDbPath())).toBe(false);
	});

	it("reports the deletion count as JSON", async () => {
		seed([
			{ tool: "yield", report: "a", createdAt: null },
			{ tool: "yield", report: "b", createdAt: null },
		]);

		const lines = await capture(() => cleanGrievances({ tool: "yield", json: true }));

		expect(JSON.parse(lines.join("\n"))).toEqual({ deleted: 2, scope: "for yield" });
	});
});

describe("exportGrievances", () => {
	it("writes a digest of the unexported rows and marks exactly those", async () => {
		seed([
			{ tool: "bash", report: "first report", createdAt: NOW - DAY, sessionId: "sess-a" },
			{ tool: "write", report: "second report", createdAt: NOW, sessionId: "sess-b" },
		]);
		const out = path.join(testAgentDir, "digest.md");

		const lines = await capture(() => exportGrievances({ out }));

		expect(lines.join("\n")).toContain(`Exported 2 report(s) to ${out}.`);
		const digest = await fs.readFile(out, "utf8");
		expect(digest).toContain("# Auto-QA grievances — unexported reports");
		expect(digest).toContain("first report");
		expect(digest).toContain("second report");
		expect(digest.indexOf("first report")).toBeLessThan(digest.indexOf("second report"));
		expect(readAll().map(row => row.exported)).toEqual([1, 1]);

		// Second run: nothing new, and it must not rewrite the digest.
		const again = await capture(() => exportGrievances({ out }));
		expect(again.join("\n")).toContain("No new reports to export.");
	});

	it("prints to stdout when no destination is given", async () => {
		seed([{ tool: "bash", report: "only report", createdAt: NOW }]);

		const lines = await capture(() => exportGrievances({}));

		expect(lines.join("\n")).toContain("only report");
		expect(lines.join("\n")).toContain("Exported 1 report(s) to stdout.");
		expect(readAll().map(row => row.exported)).toEqual([1]);
	});

	it("leaves untimed rows queued when the export is time-ranged", async () => {
		seed([
			{ tool: "bash", report: "no timestamp", createdAt: null },
			{ tool: "bash", report: "recent", createdAt: NOW - DAY },
		]);
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const out = path.join(testAgentDir, "window.md");

		await capture(() => exportGrievances({ out, since: "7d" }));

		const digest = await fs.readFile(out, "utf8");
		expect(digest).toContain("recent");
		// The excluded row must not appear as an entry (the footnote deliberately
		// mentions the count, so assert on the entry's own field).
		expect(digest).not.toContain("- when: no timestamp");
		expect(digest).toContain("1 report(s) carry no timestamp and are excluded");
		expect(readAll().map(row => row.exported)).toEqual([0, 1]);
	});

	it("says why a windowed export came back empty", async () => {
		seed([{ tool: "bash", report: "no timestamp", createdAt: null }]);
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		const lines = await capture(() => exportGrievances({ out: path.join(testAgentDir, "empty.md"), since: "7d" }));

		expect(lines.join("\n")).toContain("No new reports to export.");
		expect(lines.join("\n")).toContain("1 report(s) have no timestamp and are excluded by --since.");
		expect(readAll().map(row => row.exported)).toEqual([0]);
	});

	it("keeps the rows queued when the destination cannot be written", async () => {
		seed([{ tool: "bash", report: "stays queued", createdAt: NOW }]);

		// A directory is not a writable destination.
		await expect(exportGrievances({ out: testAgentDir })).rejects.toThrow();
		expect(readAll().map(row => row.exported)).toEqual([0]);
	});

	it("reports the export result as JSON when a destination is given", async () => {
		seed([{ tool: "bash", report: "x", createdAt: NOW }]);
		const out = path.join(testAgentDir, "digest.md");

		const lines = await capture(() => exportGrievances({ json: true, out }));

		expect(JSON.parse(lines.join("\n"))).toMatchObject({ exported: 1, out, ids: [1] });
		expect(await fs.readFile(out, "utf8")).toContain("x");
	});

	it("refuses a JSON result without a destination, and needs a database", async () => {
		await expect(exportGrievances({ json: true })).rejects.toThrow(/--json requires --out/);

		const lines = await capture(() => exportGrievances({}));
		expect(lines.join("\n")).toContain("No grievances database found");
		expect(existsSync(getAutoQaDbPath())).toBe(false);
	});
});
