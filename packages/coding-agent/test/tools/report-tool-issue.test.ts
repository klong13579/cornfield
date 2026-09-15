/**
 * report_tool_issue — the QA side channel must stay honest: every accepted
 * report either lands in the grievances database with enough context to act on
 * it (when / which session), or the caller is told it was not saved. The
 * promise it must never break is "Noted, thanks!".
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { createReportToolIssueTool, getAutoQaDbPath } from "@cornfield/coding-agent/tools/report-tool-issue";
import { getConfigRootDir, logger, setAgentDir } from "@cornfield/utils";

interface Row {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
	createdAt: number | null;
	sessionId: string | null;
}

let testAgentDir = "";
const originalAgentDir = process.env.CORNFIELD_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-autoqa-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.CORNFIELD_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

function createSession(sessionId: string | null): ToolSession {
	return {
		cwd: testAgentDir,
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
			.prepare("SELECT id, model, version, tool, report, createdAt, sessionId FROM grievances ORDER BY id")
			.all() as Row[];
	} finally {
		db.close();
	}
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("");
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
		// The legacy row keeps its unknown time rather than pretending to be epoch 0.
		expect(rows[0]).toMatchObject({ tool: "read", report: "legacy row", createdAt: null, sessionId: null });
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
