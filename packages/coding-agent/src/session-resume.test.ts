import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatResumeContext, loadResumeContext } from "./session-resume";

describe("loadResumeContext", () => {
	let db: Database;
	let cwd: string;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-resume-${Date.now()}`);
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE IF NOT EXISTS episodic_records (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				event_data TEXT NOT NULL,
				importance_score REAL NOT NULL DEFAULT 0,
				ttl_seconds INTEGER,
				expiration_time INTEGER,
				archived INTEGER NOT NULL DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
	});

	function insertEvent(
		sessionId: string,
		eventType: string,
		eventData: Record<string, unknown>,
		timestamp = Date.now(),
	) {
		db.prepare(
			`INSERT INTO episodic_records (id, session_id, cwd, timestamp, event_type, event_data, importance_score, archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(crypto.randomUUID(), sessionId, cwd, timestamp, eventType, JSON.stringify(eventData), 0.5);
	}

	test("returns undefined when no previous session", async () => {
		const ctx = await loadResumeContext(db, { cwd });
		expect(ctx).toBeUndefined();
	});

	test("loads context from previous session", async () => {
		const now = Date.now();
		insertEvent(
			"s1",
			"session_ended",
			{
				toolCallCount: 10,
				errorCount: 1,
				hadRecovery: true,
				completedSuccessfully: false,
				durationMs: 30000,
			},
			now - 1000,
		);
		insertEvent("s1", "tool_called", { toolName: "edit", path: "src/auth.ts" }, now - 2000);
		insertEvent("s1", "tool_called", { toolName: "read", path: "src/main.rs" }, now - 3000);
		insertEvent("s1", "error_occurred", { errorType: "ENOENT", message: "file not found" }, now - 4000);

		const ctx = await loadResumeContext(db, { cwd });
		expect(ctx).toBeDefined();
		expect(ctx!.previousSessionId).toBe("s1");
		expect(ctx!.workSummary).toContain("10 tool calls");
		expect(ctx!.workSummary).toContain("1 error(s)");
		expect(ctx!.completedSuccessfully).toBe(false);
		expect(ctx!.recentTools).toContain("edit");
		expect(ctx!.recentTools).toContain("read");
		expect(ctx!.activeFiles).toContain("src/auth.ts");
		expect(ctx!.recentErrors).toHaveLength(1);
		expect(ctx!.recentErrors[0]!.type).toBe("ENOENT");
	});

	test("filters by maxAgeDays", async () => {
		const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
		insertEvent("s1", "session_ended", { toolCallCount: 5 }, oldTime);

		const ctx = await loadResumeContext(db, { cwd, maxAgeDays: 7 });
		expect(ctx).toBeUndefined();
	});
});

describe("formatResumeContext", () => {
	test("formats context as markdown", () => {
		const ctx = {
			previousSessionId: "s1",
			lastActiveAt: Date.now() - 2 * 60 * 60 * 1000,
			workSummary: "5 tool calls, 1 error(s)",
			recentTools: ["read", "edit"],
			activeFiles: ["src/auth.ts"],
			recentErrors: [{ type: "ENOENT", message: "not found" }],
			completedSuccessfully: false,
		};
		const md = formatResumeContext(ctx);
		expect(md).toContain("Resumed Session Context");
		expect(md).toContain("read");
		expect(md).toContain("src/auth.ts");
		expect(md).toContain("ENOENT");
		expect(md).toContain("did not complete successfully");
	});
});
