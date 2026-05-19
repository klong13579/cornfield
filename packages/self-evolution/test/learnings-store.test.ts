import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";
import { SqliteLearningStore } from "../src/storage/learnings";
import type { Learning } from "../src/types";

describe("SqliteLearningStore", () => {
	let tmpDir = "";
	let cwd = "";

	afterEach(async () => {
		if (cwd) closeEvolutionDb(cwd, false);
		if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("insert and listForInjection respects pin", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lrn-"));
		cwd = path.join(tmpDir, "repo");
		await fs.mkdir(path.join(cwd, ".omp", "evolution"), { recursive: true });

		const db = getEvolutionDb(cwd, false);
		const store = new SqliteLearningStore(db);
		const learning: Learning = {
			id: "lrn_pinme",
			cwd,
			kind: "preference",
			content: "Use bun test for targeted runs only",
			source: "session_llm",
			confidence: 4,
			lifecycle: "candidate",
			scope: "project" as const,
			sessionId: "ep",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
		};
		await store.insert(learning);
		expect((await store.listForInjection(cwd)).length).toBe(0);

		await store.pin("lrn_pinme");
		const injectable = await store.listForInjection(cwd);
		expect(injectable.length).toBe(1);
		expect(injectable[0]?.id).toBe("lrn_pinme");
	});
});
