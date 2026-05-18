import { Database, type Database as DatabaseType } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { repairRegressionFixtureLabels } from "../src/regression/repair-regression-fixture-labels";
import { initSchema } from "../src/storage/db";
import { SqliteEpisodeDiagnosisStore } from "../src/storage/diagnoses";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteSessionTraceStore } from "../src/storage/session-traces";
import type { RegressionFixture, SessionTrace } from "../src/types";

function openDb(): DatabaseType {
	const db = new Database(":memory:");
	initSchema(db);
	return db;
}

describe("repairRegressionFixtureLabels", () => {
	let db: DatabaseType;

	afterEach(() => {
		db?.close();
	});

	test("fills dominant_error_tool from trace tool failures", async () => {
		db = openDb();
		const traceStore = new SqliteSessionTraceStore(db);
		const fixtureStore = new SqliteRegressionFixtureStore(db);
		const diagnosisStore = new SqliteEpisodeDiagnosisStore(db);

		const trace: SessionTrace = {
			sessionId: "sess-1",
			cwd: "/tmp",
			userPrompt: "fix read error",
			startTime: 1,
			endTime: 2,
			toolCallCount: 1,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: false,
			entries: [
				{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "x.ts" } },
				{
					type: "tool_result",
					timestamp: 2,
					toolName: "read",
					result: "ENOENT: no such file",
					isError: true,
				},
			],
		};

		await traceStore.upsert(trace, "ep-1");
		const fixture: RegressionFixture = {
			id: "fx_test",
			sessionId: "sess-1",
			episodeId: "ep-1",
			cwd: "/tmp",
			userPrompt: "fix read error",
			errorCount: 1,
			completedSuccessfully: false,
			entries: [],
			createdAt: Date.now(),
		};
		await fixtureStore.insert(fixture);

		const result = await repairRegressionFixtureLabels({
			db,
			fixtureStore,
			traceStore,
			diagnosisStore,
		});

		expect(result.updated).toBe(1);
		const repaired = (await fixtureStore.listAll())[0]!;
		expect(repaired.dominantErrorTool).toBe("read");
		expect(repaired.dominantErrorPattern).toBeDefined();
	});
});
