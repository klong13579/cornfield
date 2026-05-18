import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyLearningsSeed, parseLearningsSeedJson, readLearningsSeedFile } from "../src/learnings-seed";
import { initSchema } from "../src/storage/db";
import { SqliteLearningStore } from "../src/storage/learnings";

describe("learnings-seed", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("parseLearningsSeedJson skips invalid rows and keeps valid kinds", () => {
		const json = JSON.stringify([
			{ kind: "preference", content: "Always respond in Chinese unless asked otherwise." },
			{ kind: "bogus", content: "This should be dropped because kind is invalid." },
			{ kind: "procedure", content: "short" },
		]);
		const entries = parseLearningsSeedJson(json);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe("preference");
		expect(entries[0]?.pin).toBe(true);
	});

	it("applyLearningsSeed inserts pinned active learnings", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seed-"));
		const dbPath = path.join(tmpDir, "evolution.db");
		const db = new Database(dbPath);
		initSchema(db);
		const store = new SqliteLearningStore(db);
		const cwd = "/tmp/project";

		const result = await applyLearningsSeed(store, cwd, [
			{
				kind: "fact",
				content: "Project uses Bun instead of Node for scripts and tests.",
				pin: true,
			},
		]);

		expect(result.loaded).toBe(1);
		expect(result.pinned).toBe(1);
		const injected = await store.listForInjection(cwd);
		expect(injected.some(l => l.content.includes("Bun"))).toBe(true);
		db.close();
	});

	it("readLearningsSeedFile loads from disk", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seed-file-"));
		const seedPath = path.join(tmpDir, "learnings-seed.json");
		await Bun.write(
			seedPath,
			JSON.stringify([
				{
					kind: "skill_hint",
					content: "Prefer editing packages/coding-agent for CLI behavior changes.",
				},
			]),
		);
		const entries = await readLearningsSeedFile(seedPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe("skill_hint");
	});
});
