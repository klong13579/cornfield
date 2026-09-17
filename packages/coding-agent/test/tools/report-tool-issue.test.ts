/**
 * report_tool_issue — the QA side channel must stay honest: every accepted
 * report either lands in the grievances database with enough context to act on
 * it (when / which session) or the caller is told it was not saved. The promise
 * it must never break is "Noted, thanks!".
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { _resetToolNameWarningsForTest } from "@cornfield/coding-agent/tools/builtin-names";
import { createReportToolIssueTool, getAutoQaDbPath } from "@cornfield/coding-agent/tools/report-tool-issue";
import { getConfigRootDir, logger, setClientDir } from "@cornfield/utils";

interface Row {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
	createdAt: number | null;
	sessionId: string | null;
	exported: number;
}

let testClientDir = "";
const originalClientDir = process.env.CORNFIELD_CLIENT_DIR;
const fallbackClientDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	testClientDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-autoqa-"));
	setClientDir(testClientDir);
	_resetToolNameWarningsForTest();
	vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalClientDir) {
		setClientDir(originalClientDir);
	} else {
		setClientDir(fallbackClientDir);
		delete process.env.CORNFIELD_CLIENT_DIR;
	}
	await fs.rm(testClientDir, { recursive: true, force: true });
});

function createSession(sessionId: string | null): ToolSession {
	return {
		cwd: testClientDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModelString: () => "narwal-plan/test-model",
		getSessionId: () => sessionId,
		settings: Settings.isolated(),
	};
}

function readRows(): Row[] {
	const db = new Database(getAutoQaDbPath(), { readonly: true });
	try {
		return db
			.prepare("SELECT id, model, version, tool, report, createdAt, sessionId, exported FROM grievances ORDER BY id")
			.all() as Row[];
	} finally {
		db.close();
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("");
}

function paramSchema(tool: ReturnType<typeof createReportToolIssueTool>): Record<string, unknown> {
	return (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
}

describe("report_tool_issue", () => {
	it("records when, which session, and the reported text", async () => {
		const tool = createReportToolIssueTool(createSession("01a0a484-f1b6-7000-88fa-b0fe0f0204bd"));
		const before = Date.now();
		const result = await tool.execute("call-1", {
			tool: "bash",
			report: "grep -c returned 0 for a string that exists",
		});
		const after = Date.now();

		expect(text(result)).toBe("Noted, thanks!");
		expect(result.details).toMatchObject({ recorded: true });

		const rows = readRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			model: "narwal-plan/test-model",
			tool: "bash",
			report: "grep -c returned 0 for a string that exists",
			sessionId: "01a0a484-f1b6-7000-88fa-b0fe0f0204bd",
			// Fresh rows are queued for the next export.
			exported: 0,
		});
		expect(typeof rows[0]!.version).toBe("string");
		expect(rows[0]!.createdAt).toBeGreaterThanOrEqual(before);
		expect(rows[0]!.createdAt).toBeLessThanOrEqual(after);
	});

	it("stores a NULL session id when the session has none instead of dropping the report", async () => {
		const tool = createReportToolIssueTool(createSession(null));
		const result = await tool.execute("call-1", { tool: "read", report: "no session context available" });

		expect(result.details).toMatchObject({ recorded: true });
		expect(readRows()[0]).toMatchObject({ tool: "read", sessionId: null });
	});

	it("widens a pre-existing table instead of failing on it", async () => {
		const legacy = new Database(getAutoQaDbPath());
		legacy.run(
			"CREATE TABLE grievances (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, version TEXT NOT NULL, tool TEXT NOT NULL, report TEXT NOT NULL)",
		);
		legacy.run(
			"INSERT INTO grievances (model, version, tool, report) VALUES ('old/model', '1.0.0', 'read', 'legacy row')",
		);
		legacy.close();

		const tool = createReportToolIssueTool(createSession("sess-legacy"));
		const result = await tool.execute("call-1", { tool: "edit", report: "row added after the upgrade" });

		expect(result.details).toMatchObject({ recorded: true });
		const rows = readRows();
		expect(rows.map(row => row.id)).toEqual([1, 2]);
		// The legacy row keeps its unknown time rather than pretending to be epoch 0,
		// and it is un-exported so the next export picks it up.
		expect(rows[0]).toMatchObject({
			tool: "read",
			report: "legacy row",
			createdAt: null,
			sessionId: null,
			exported: 0,
		});
		expect(rows[1]).toMatchObject({ tool: "edit", sessionId: "sess-legacy" });
	});

	it("says the report was NOT saved when the database cannot be opened", async () => {
		await fs.mkdir(getAutoQaDbPath(), { recursive: true });
		const logSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const tool = createReportToolIssueTool(createSession("sess-fail"));
		const result = await tool.execute("call-1", { tool: "bash", report: "never stored" });

		expect(text(result)).toContain("NOT saved");
		expect(result.details).toMatchObject({ error: true, dbPath: getAutoQaDbPath() });
		expect(String((result.details as { reason?: unknown }).reason ?? "")).not.toBe("");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	it("says the report was NOT saved when the row cannot be inserted", async () => {
		// A table that exists but predates the `report` column: opening succeeds,
		// the insert does not.
		const broken = new Database(getAutoQaDbPath());
		broken.run("CREATE TABLE grievances (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, version TEXT, tool TEXT)");
		broken.close();
		vi.spyOn(logger, "error").mockImplementation(() => {});

		const tool = createReportToolIssueTool(createSession("sess-broken"));
		const result = await tool.execute("call-1", { tool: "bash", report: "never stored" });

		expect(text(result)).toContain("NOT saved");
		expect(result.details).toMatchObject({ error: true });
	});
});

describe("report_tool_issue tool scope", () => {
	it("offers an enum over the built-ins the session actually has", () => {
		const scoped = createReportToolIssueTool(createSession("sess-scope"), ["read", "bash", "glob"]);

		expect(paramSchema(scoped).tool).toMatchObject({ type: "string", enum: ["bash", "glob", "read"] });
	});

	it("falls back to a free string name when the active set is unknown", () => {
		const unscoped = createReportToolIssueTool(createSession("sess-unscoped"));

		expect(paramSchema(unscoped).tool).toMatchObject({ type: "string" });
		expect((paramSchema(unscoped).tool as { enum?: unknown }).enum).toBeUndefined();
	});

	it("refuses a report about something that is not a built-in, and says nothing was saved", async () => {
		const tool = createReportToolIssueTool(createSession("sess-scope"), ["bash", "read"]);
		const result = await tool.execute("call-1", { tool: "xd://puppeteer", report: "Unknown type" });

		expect(text(result)).toContain("Not recorded");
		expect(text(result)).toContain("Nothing was saved");
		expect(result.details).toMatchObject({ error: true, tool: "xd://puppeteer" });
		// Refused before the database is even opened.
		expect(existsSync(getAutoQaDbPath())).toBe(false);
	});

	it("normalizes a legacy tool name onto the canonical built-in instead of rejecting it", async () => {
		const tool = createReportToolIssueTool(createSession("sess-alias"), ["glob", "bash"]);
		const result = await tool.execute("call-1", { tool: "find", report: "pattern matched nothing" });

		expect(result.details).toMatchObject({ recorded: true });
		expect(readRows()[0]).toMatchObject({ tool: "glob", report: "pattern matched nothing" });
	});

	it("still records everything when no active set is known", async () => {
		const tool = createReportToolIssueTool(createSession("sess-unscoped"));
		const result = await tool.execute("call-1", { tool: "xd://puppeteer", report: "Unknown type" });

		expect(result.details).toMatchObject({ recorded: true });
		expect(readRows()[0]).toMatchObject({ tool: "xd://puppeteer" });
	});
});
