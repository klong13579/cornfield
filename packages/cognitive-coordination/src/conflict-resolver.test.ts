import { describe, expect, test } from "bun:test";
import type { ConflictItem } from "./conflict-resolver";
import { ConflictResolver } from "./conflict-resolver";

describe("ConflictResolver", () => {
	function makeItem(id: string, content: string, provenance: ConflictItem["provenance"] = "inferred"): ConflictItem {
		return { id, content, provenance };
	}

	test("detectConflicts returns empty for < 2 items", () => {
		const resolver = new ConflictResolver();
		expect(resolver.detectConflicts([])).toHaveLength(0);
		expect(resolver.detectConflicts([makeItem("a", "test")])).toHaveLength(0);
	});

	test("detects contradiction when one negates and other affirms", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("affirm", "always use async await for all code"),
			makeItem("negate", "never use async await for any code"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports.length).toBe(1);
		expect(reports[0]!.conflictType).toBe("contradiction");
		expect(reports[0]!.reason).toContain("Contradictory stance");
	});

	test("contradiction winner is user_stated over inferred", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("inferred", "never use console.log", "inferred"),
			makeItem("user", "always use console.log for debugging", "user_stated"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports[0]!.winner.id).toBe("user");
		expect(reports[0]!.loser.id).toBe("inferred");
	});

	test("detects redundancy for near-identical content", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("a", "use structured tools for code search always"),
			makeItem("b", "use structured tools for code search always"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports.length).toBe(1);
		expect(reports[0]!.conflictType).toBe("redundancy");
	});

	test("same provenance tie goes to longer content", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("short", "use TypeScript", "inferred"),
			makeItem("long", "use TypeScript for all new code", "inferred"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports[0]!.winner.id).toBe("long");
		expect(reports[0]!.loser.id).toBe("short");
	});

	test("detects overlap for moderate similarity", () => {
		const resolver = new ConflictResolver({ redundancyThreshold: 0.95 });
		const items = [
			makeItem("a", "use ast grep for structural search patterns matching code"),
			makeItem("b", "use ast grep for structural search patterns within code"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports.length).toBeGreaterThanOrEqual(1);
		expect(reports[0]!.conflictType).toBe("overlap");
	});

	test("no conflict for completely different content", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("a", "use async await for network requests"),
			makeItem("b", "prefer immutable data structures always"),
		];
		const reports = resolver.detectConflicts(items);
		expect(reports.length).toBe(0);
	});

	test("resolve removes losers and keeps winners", () => {
		const resolver = new ConflictResolver();
		const items = [
			makeItem("high", "use TypeScript for everything", "user_stated"),
			makeItem("low", "use TypeScript", "inferred"),
		];
		const { resolved, reports } = resolver.resolve({ group1: items });
		expect(reports.length).toBe(1);
		expect(resolved.length).toBe(1);
		expect(resolved[0]!.id).toBe("high");
	});

	test("both negating items do not produce contradiction", () => {
		const resolver = new ConflictResolver();
		const items = [makeItem("a", "never use console log"), makeItem("b", "always prefer immutable data structures")];
		const reports = resolver.detectConflicts(items);
		// One negates one affirms but content differs → no conflict (similarity < 0.5)
		expect(reports.length).toBe(0);
	});

	test("custom thresholds affect detection", () => {
		const strict = new ConflictResolver({ redundancyThreshold: 0.99 });
		const items = [makeItem("a", "use TypeScript always"), makeItem("b", "use TypeScript always")];
		const reports = strict.detectConflicts(items);
		// With 0.99 threshold, exact duplicates still trigger
		expect(reports.length).toBe(1);
		expect(reports[0]!.conflictType).toBe("redundancy");
	});
});
