import { describe, expect, test } from "bun:test";
import type { Convention } from "../src/types";
import { conventionsToDedupEntries, type DedupEntry, deduplicateEntries } from "../src/unified-dedup-gate";

describe("UnifiedDedupGate", () => {
	function makeEntry(overrides: Partial<DedupEntry> = {}): DedupEntry {
		return {
			id: overrides.id ?? "test-1",
			source: overrides.source ?? "convention",
			content: overrides.content ?? "use async await",
			confidence: overrides.confidence ?? 80,
			provenance: overrides.provenance ?? "inferred",
			original: overrides.original ?? {},
		};
	}

	test("keeps distinct entries", () => {
		const entries = [
			makeEntry({ id: "a", content: "use async await for all code" }),
			makeEntry({ id: "b", content: "prefer TypeScript over JavaScript always" }),
		];
		const result = deduplicateEntries(entries);
		expect(result.kept).toHaveLength(2);
		expect(result.duplicates).toHaveLength(0);
	});

	test("detects near-identical duplicates", () => {
		const entries = [
			makeEntry({ id: "a", content: "always use async await instead of callbacks" }),
			makeEntry({ id: "b", content: "always use async await instead callbacks" }),
		];
		const result = deduplicateEntries(entries);
		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0]!.similarity).toBeGreaterThan(0.8);
	});

	test("higher provenance wins in duplicate", () => {
		const entries = [
			makeEntry({ id: "a", content: "never use console log for debugging", provenance: "inferred" }),
			makeEntry({ id: "b", content: "never use console log for debugging", provenance: "user_stated" }),
		];
		const result = deduplicateEntries(entries);
		expect(result.kept).toHaveLength(1);
		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0]!.kept.provenance).toBe("user_stated");
	});

	test("same provenance — higher confidence wins", () => {
		const entries = [
			makeEntry({
				id: "a",
				content: "use structured tools for code search",
				confidence: 60,
				provenance: "inferred",
			}),
			makeEntry({
				id: "b",
				content: "use structured tools for code search",
				confidence: 85,
				provenance: "inferred",
			}),
		];
		const result = deduplicateEntries(entries);
		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]!.confidence).toBe(85);
	});

	test("detects cross-source conflicts", () => {
		const entries = [
			makeEntry({
				id: "a",
				content: "use ast grep for structural search patterns matching code",
				source: "convention",
				provenance: "inferred",
			}),
			makeEntry({
				id: "b",
				content: "use ast grep for structural search patterns within code",
				source: "skill",
				provenance: "implied",
			}),
		];
		const result = deduplicateEntries(entries);
		expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
	});
});

describe("conventionsToDedupEntries", () => {
	test("converts conventions to dedup entries", () => {
		const conventions: Convention[] = [
			{
				id: "c1",
				type: "negative_rule",
				content: "do not use console.log",
				sourceEpisodeId: "ep1",
				confidence: 90,
				timesApplied: 3,
				timesViolated: 0,
				createdAt: Date.now(),
				lastSeenAt: Date.now(),
				provenance: "user_stated",
			},
		];
		const entries = conventionsToDedupEntries(conventions);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.source).toBe("convention");
		expect(entries[0]!.provenance).toBe("user_stated");
	});
});
