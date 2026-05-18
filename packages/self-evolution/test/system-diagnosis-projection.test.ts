import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { projectSystemDiagnosis } from "../src/projection/system-diagnosis";
import { initSchema } from "../src/storage/db";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteSkillStore } from "../src/storage/skills";

describe("system-diagnosis projection", () => {
	test("writes system-diagnosis.md with audit and diagnosis sections", async () => {
		const db = new Database(":memory:");
		initSchema(db);
		const episodeStore = new SqliteEpisodeStore(db);
		const skillStore = new SqliteSkillStore(db);

		db.run(
			`INSERT INTO episode_diagnoses (
				episode_id, read_failures_json, cascade_patterns_json, redundant_searches,
				slow_loop, tool_efficiency, dominant_error_tool, dominant_error_pattern,
				suggested_action, recorded_at
			) VALUES (?, '[]', '[]', 0, 0, 0.8, 'read', 'ENOENT', 'verify paths', ?)`,
			["ep-test-1", Date.now()],
		);

		const outputDir = path.join(os.tmpdir(), `omp-diag-${Date.now()}`);
		const { path: outPath, report } = await projectSystemDiagnosis(db, {
			outputDir,
			maxEpisodes: 100,
			episodeStore,
			skillStore,
			diagnosisLimit: 5,
		});

		expect(outPath.endsWith("system-diagnosis.md")).toBe(true);
		expect(report.episodes).toBeDefined();
		const text = await Bun.file(outPath).text();
		expect(text).toContain("# System Diagnosis");
		expect(text).toContain("## Episodes");
		expect(text).toContain("## Recent session diagnoses");
		expect(text).toContain("ep-test-1");
		expect(text).toContain("ENOENT");
	});
});
