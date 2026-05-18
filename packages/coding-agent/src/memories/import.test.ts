import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	deleteMissingEntries,
	importMemoryEntries,
	importMemoryMd,
	type ParsedMemoryEntry,
	parseMemoryMd,
} from "./import";
import { insertVectorEmbedding, openMemoryDb } from "./storage";

describe("parseMemoryMd", () => {
	test("parses single entry with full details", () => {
		const md = `# Memory Report

## conventions

- Always use async/await over callbacks
  - Importance: 85% | Last accessed: 2026-05-10 | ID: \`conv-001\`
  - Metadata: style=async, scope=global

`;
		const entries = parseMemoryMd(md);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			id: "conv-001",
			namespace: "conventions",
			content: "Always use async/await over callbacks",
			importance: 0.85,
			lastAccessedAt: new Date("2026-05-10").getTime(),
			metadata: { style: "async", scope: "global" },
		});
	});

	test("parses multiple namespaces", () => {
		const md = `# Memory Report

## conventions

- Rule A
  - Importance: 50% | Last accessed: 2026-05-01 | ID: \`a\`

## preferences

- Pref B
  - Importance: 75% | Last accessed: 2026-05-02 | ID: \`b\`
`;
		const entries = parseMemoryMd(md);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.namespace).toBe("conventions");
		expect(entries[1]!.namespace).toBe("preferences");
	});

	test("generates deterministic ID when missing", () => {
		const md = `# Memory Report

## ns

- Content without ID
  - Importance: 60%
`;
		const entries = parseMemoryMd(md);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toStartWith("ns-");
		expect(entries[0]!.content).toBe("Content without ID");
		expect(entries[0]!.importance).toBe(0.6);
	});

	test("parses metadata with numbers and booleans", () => {
		const md = `# Memory Report

## test

- Entry
  - Importance: 100% | Last accessed: 2026-01-01 | ID: \`x\`
  - Metadata: count=42, enabled=true, ratio=3.14, name=hello
`;
		const entries = parseMemoryMd(md);
		expect(entries[0]!.metadata).toEqual({
			count: 42,
			enabled: true,
			ratio: 3.14,
			name: "hello",
		});
	});

	test("ignores continuation lines and raw memory sections", () => {
		const md = `# Memory Report

## conventions

- Rule 1
  - Importance: 50% | Last accessed: 2026-05-01 | ID: \`r1\`

_... and 5 more entries_

# Raw Memory Dump

## Thread: abc

Some raw content
`;
		const entries = parseMemoryMd(md);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("r1");
	});
});

describe("importMemoryEntries", () => {
	let db: Database;

	beforeEach(() => {
		const tmpDir = os.tmpdir();
		const dbPath = path.join(tmpDir, `test-import-${Date.now()}.db`);
		db = openMemoryDb(dbPath);
	});

	afterEach(() => {
		db.close();
	});

	test("inserts new entries", () => {
		const entries: ParsedMemoryEntry[] = [
			{ id: "e1", namespace: "ns", content: "hello", importance: 0.8, lastAccessedAt: Date.now() },
		];
		const result = importMemoryEntries(db, entries);
		expect(result.imported).toBe(1);
		expect(result.updated).toBe(0);

		const row = db
			.prepare("SELECT id, namespace, content, importance FROM vector_embeddings WHERE id = ?")
			.get("e1") as { id: string; namespace: string; content: string; importance: number } | undefined;
		expect(row).toBeDefined();
		expect(row!.content).toBe("hello");
		expect(row!.importance).toBe(0.8);
	});

	test("updates existing entries", () => {
		const now = Date.now();
		insertVectorEmbedding(db, {
			id: "e2",
			namespace: "ns",
			content: "old",
			embedding: [],
			importance: 0.3,
			createdAt: now,
			lastAccessedAt: now,
		});

		const entries: ParsedMemoryEntry[] = [
			{ id: "e2", namespace: "ns", content: "new", importance: 0.9, lastAccessedAt: now + 1000 },
		];
		const result = importMemoryEntries(db, entries);
		expect(result.imported).toBe(0);
		expect(result.updated).toBe(1);

		const row = db.prepare("SELECT content, importance FROM vector_embeddings WHERE id = ?").get("e2") as
			| { content: string; importance: number }
			| undefined;
		expect(row!.content).toBe("new");
		expect(row!.importance).toBe(0.9);
	});
});

describe("deleteMissingEntries", () => {
	let db: Database;

	beforeEach(() => {
		const tmpDir = os.tmpdir();
		const dbPath = path.join(tmpDir, `test-import-del-${Date.now()}.db`);
		db = openMemoryDb(dbPath);
	});

	afterEach(() => {
		db.close();
	});

	test("deletes entries not in the provided set", () => {
		const now = Date.now();
		insertVectorEmbedding(db, {
			id: "keep",
			namespace: "ns",
			content: "keep me",
			embedding: [],
			importance: 0.5,
			createdAt: now,
			lastAccessedAt: now,
		});
		insertVectorEmbedding(db, {
			id: "remove",
			namespace: "ns",
			content: "remove me",
			embedding: [],
			importance: 0.5,
			createdAt: now,
			lastAccessedAt: now,
		});

		const deleted = deleteMissingEntries(db, new Set(["keep"]));
		expect(deleted).toBe(1);

		const rows = db.prepare("SELECT id FROM vector_embeddings").all() as Array<{ id: string }>;
		expect(rows.map(r => r.id)).toEqual(["keep"]);
	});
});

describe("importMemoryMd", () => {
	let db: Database;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = os.tmpdir();
		const dbPath = path.join(tmpDir, `test-import-md-${Date.now()}.db`);
		db = openMemoryDb(dbPath);
	});

	afterEach(() => {
		db.close();
	});

	test("imports from file and syncs", async () => {
		const mdPath = path.join(tmpDir, `memory-${Date.now()}.md`);
		const md = `# Memory Report

## conventions

- Use strict TypeScript
  - Importance: 90% | Last accessed: 2026-05-12 | ID: \`ts-01\`
`;
		await Bun.write(mdPath, md);

		const result = await importMemoryMd(db, mdPath, { sync: true });
		expect(result.imported).toBe(1);
		expect(result.entries).toHaveLength(1);
	});

	test("returns empty result for missing file", async () => {
		const result = await importMemoryMd(db, "/nonexistent/MEMORY.md");
		expect(result.imported).toBe(0);
		expect(result.entries).toHaveLength(0);
	});
});
