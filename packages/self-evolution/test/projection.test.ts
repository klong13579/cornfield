import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	deleteMissingConventions,
	generateConventionsMd,
	importConventionEntries,
	importConventionsMd,
	loadConventionsFromDb,
	type ParsedConventionEntry,
	parseConventionsMd,
} from "../src/projection";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";

describe("generateConventionsMd", () => {
	test("generates markdown with types and details", () => {
		const now = Date.now();
		const conventions = [
			{
				id: "c1",
				type: "negative_rule" as const,
				content: "Never use var",
				sourceEpisodeId: "ep1",
				confidence: 90,
				timesApplied: 5,
				timesViolated: 1,
				createdAt: now,
				lastSeenAt: now,
				provenance: "user_stated" as const,
			},
			{
				id: "c2",
				type: "preference" as const,
				content: "Prefer async/await",
				sourceEpisodeId: "ep2",
				confidence: 75,
				timesApplied: 3,
				timesViolated: 0,
				createdAt: now,
				lastSeenAt: now,
				provenance: "inferred" as const,
			},
		];
		const md = generateConventionsMd(conventions);
		expect(md).toContain("# Conventions");
		expect(md).toContain("## negative_rule");
		expect(md).toContain("## preference");
		expect(md).toContain("- Never use var");
		expect(md).toContain("- Prefer async/await");
		expect(md).toContain("ID: `c1`");
		expect(md).toContain("Confidence: 90%");
		expect(md).toContain("Provenance: user_stated");
		expect(md).toContain("Stats: applied 5, violated 1");
	});

	test("respects maxEntriesPerType", () => {
		const now = Date.now();
		const conventions = Array.from({ length: 5 }, (_, i) => ({
			id: `c${i}`,
			type: "negative_rule" as const,
			content: `Rule ${i}`,
			sourceEpisodeId: "ep",
			confidence: 100 - i * 10,
			timesApplied: 0,
			timesViolated: 0,
			createdAt: now,
			lastSeenAt: now,
			provenance: "inferred" as const,
		}));
		const md = generateConventionsMd(conventions, { maxEntriesPerType: 2 });
		const matches = md.match(/^- /gm);
		expect(matches).toHaveLength(2);
	});
});

describe("parseConventionsMd", () => {
	test("parses single entry with full details", () => {
		const md = `# Conventions

## negative_rule

- Never use var
  - Confidence: 90% | Created: 2026-05-10 | ID: \`c1\` | Provenance: user_stated
  - Stats: applied 5, violated 1

`;
		const entries = parseConventionsMd(md);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			id: "c1",
			type: "negative_rule",
			content: "Never use var",
			confidence: 90,
			provenance: "user_stated",
			timesApplied: 5,
			timesViolated: 1,
			createdAt: new Date("2026-05-10").getTime(),
			lastSeenAt: expect.any(Number),
		});
	});

	test("parses multiple types", () => {
		const md = `# Conventions

## negative_rule

- Rule A
  - Confidence: 50% | Created: 2026-05-01 | ID: \`a\`

## preference

- Pref B
  - Confidence: 75% | Created: 2026-05-02 | ID: \`b\`
`;
		const entries = parseConventionsMd(md);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.type).toBe("negative_rule");
		expect(entries[1]!.type).toBe("preference");
	});

	test("generates deterministic ID when missing", () => {
		const md = `# Conventions

## negative_rule

- Content without ID
  - Confidence: 60%
`;
		const entries = parseConventionsMd(md);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toStartWith("negative_rule-");
		expect(entries[0]!.content).toBe("Content without ID");
		expect(entries[0]!.confidence).toBe(60);
		expect(entries[0]!.provenance).toBe("user_stated");
	});
});

describe("importConventionEntries", () => {
	let db: Database;
	let cwd: string;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-proj-${Date.now()}`);
		db = getEvolutionDb(cwd);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("inserts new entries", () => {
		const entries: ParsedConventionEntry[] = [
			{
				id: "c1",
				type: "negative_rule",
				content: "Never use var",
				confidence: 90,
				provenance: "user_stated",
				timesApplied: 0,
				timesViolated: 0,
				createdAt: Date.now(),
				lastSeenAt: Date.now(),
			},
		];
		const result = importConventionEntries(db, entries);
		expect(result.imported).toBe(1);
		expect(result.updated).toBe(0);

		const row = db
			.prepare("SELECT id, type, content, confidence, provenance FROM conventions WHERE id = ?")
			.get("c1") as
			| { id: string; type: string; content: string; confidence: number; provenance: string }
			| undefined;
		expect(row).toBeDefined();
		expect(row!.content).toBe("Never use var");
		expect(row!.confidence).toBe(90);
		expect(row!.provenance).toBe("user_stated");
	});

	test("updates existing entries", () => {
		const now = Date.now();
		db.prepare(`
			INSERT INTO conventions (id, type, content, source_episode_id, confidence, times_applied, times_violated, created_at, last_seen_at, provenance)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("c2", "negative_rule", "old", "ep", 30, 0, 0, now, now, "inferred");

		const entries: ParsedConventionEntry[] = [
			{
				id: "c2",
				type: "preference",
				content: "new",
				confidence: 95,
				provenance: "user_stated",
				timesApplied: 5,
				timesViolated: 1,
				createdAt: now + 1000,
				lastSeenAt: now + 1000,
			},
		];
		const result = importConventionEntries(db, entries);
		expect(result.imported).toBe(0);
		expect(result.updated).toBe(1);

		const row = db.prepare("SELECT content, confidence, provenance FROM conventions WHERE id = ?").get("c2") as
			| { content: string; confidence: number; provenance: string }
			| undefined;
		expect(row!.content).toBe("new");
		expect(row!.confidence).toBe(95);
		expect(row!.provenance).toBe("user_stated");
	});
});

describe("deleteMissingConventions", () => {
	let db: Database;
	let cwd: string;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-proj-del-${Date.now()}`);
		db = getEvolutionDb(cwd);
		const now = Date.now();
		db.prepare(`
			INSERT INTO conventions (id, type, content, source_episode_id, confidence, times_applied, times_violated, created_at, last_seen_at, provenance)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("keep", "negative_rule", "keep me", "ep", 50, 0, 0, now, now, "inferred");
		db.prepare(`
			INSERT INTO conventions (id, type, content, source_episode_id, confidence, times_applied, times_violated, created_at, last_seen_at, provenance)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("remove", "negative_rule", "remove me", "ep", 50, 0, 0, now, now, "inferred");
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("deletes entries not in the provided set", () => {
		const deleted = deleteMissingConventions(db, new Set(["keep"]));
		expect(deleted).toBe(1);

		const rows = db.prepare("SELECT id FROM conventions").all() as Array<{ id: string }>;
		expect(rows.map(r => r.id)).toEqual(["keep"]);
	});
});

describe("importConventionsMd", () => {
	let db: Database;
	let cwd: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = os.tmpdir();
		cwd = path.join(tmpDir, `test-proj-md-${Date.now()}`);
		db = getEvolutionDb(cwd);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("imports from file and syncs", async () => {
		const mdPath = path.join(tmpDir, `conventions-${Date.now()}.md`);
		const md = `# Conventions

## negative_rule

- Use strict TypeScript
  - Confidence: 90% | Created: 2026-05-12 | ID: \`ts-01\` | Provenance: user_stated
  - Stats: applied 3, violated 0
`;
		await Bun.write(mdPath, md);

		const result = await importConventionsMd(db, mdPath, { sync: true });
		expect(result.imported).toBe(1);
		expect(result.entries).toHaveLength(1);
	});

	test("returns empty result for missing file", async () => {
		const result = await importConventionsMd(db, "/nonexistent/conventions.md");
		expect(result.imported).toBe(0);
		expect(result.entries).toHaveLength(0);
	});
});

describe("loadConventionsFromDb + roundtrip", () => {
	let db: Database;
	let cwd: string;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `test-proj-rt-${Date.now()}`);
		db = getEvolutionDb(cwd);
	});

	afterEach(() => {
		closeEvolutionDb(cwd);
	});

	test("roundtrip: insert → load → generate → parse → import", () => {
		const now = Date.now();
		db.prepare(`
			INSERT INTO conventions (id, type, content, source_episode_id, confidence, times_applied, times_violated, created_at, last_seen_at, provenance)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run("rt1", "negative_rule", "Always await promises", "ep1", 85, 4, 0, now, now, "implied");

		const loaded = loadConventionsFromDb(db);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.content).toBe("Always await promises");

		const md = generateConventionsMd(loaded);
		expect(md).toContain("Always await promises");
		expect(md).toContain("ID: `rt1`");

		const parsed = parseConventionsMd(md);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.id).toBe("rt1");
		expect(parsed[0]!.confidence).toBe(85);
		expect(parsed[0]!.provenance).toBe("implied");
		expect(parsed[0]!.timesApplied).toBe(4);
		expect(parsed[0]!.timesViolated).toBe(0);
	});
});
