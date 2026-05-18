import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRegressionFixtureFromTrace } from "../src/regression/fixture-from-trace";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteSessionTraceStore } from "../src/storage/session-traces";
import type { SessionTrace, TraceEntry } from "../src/types";

describe("regression fixture hydration", () => {
	let tmpDir: string;
	let cwd: string;

	afterEach(async () => {
		if (cwd) closeEvolutionDb(cwd);
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("loads tool entries from session_traces when fixture is persisted", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fx-hydrate-"));
		cwd = tmpDir;
		const db = getEvolutionDb(cwd);
		const traceStore = new SqliteSessionTraceStore(db);
		const fixtureStore = new SqliteRegressionFixtureStore(db);

		const entries: TraceEntry[] = [
			{ type: "tool_result", toolName: "bash", isError: true, result: "ENOENT", timestamp: 1 },
			{ type: "tool_result", toolName: "read", isError: false, result: "ok", timestamp: 2 },
		];
		const trace: SessionTrace = {
			sessionId: "sess-hydrate",
			cwd: tmpDir,
			userPrompt: "fix it",
			startTime: 100,
			endTime: 200,
			toolCallCount: 2,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: false,
			entries,
		};
		await traceStore.upsert(trace, "ep-1");

		const fixture = buildRegressionFixtureFromTrace(trace, "ep-1");
		expect(fixture).not.toBeNull();
		await fixtureStore.insert(fixture!);

		const loaded = await fixtureStore.listRecent(1);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.entries).toHaveLength(2);
		expect(loaded[0]?.entries[0]?.toolName).toBe("bash");
		expect(loaded[0]?.entries[1]?.toolName).toBe("read");
	});
});
