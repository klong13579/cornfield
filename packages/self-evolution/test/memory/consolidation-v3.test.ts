import { describe, expect, test } from "bun:test";
import {
	containsLegacyEvolutionContent,
	sanitizeConsolidatedMemoryMd,
	sanitizeConsolidatedMemorySummary,
} from "../../src/memory/consolidation-v3";

describe("consolidation-v3 sanitize", () => {
	test("detects legacy convention extractor text", () => {
		expect(containsLegacyEvolutionContent("ConventionExtractor.extract()")).toBe(true);
		expect(containsLegacyEvolutionContent("Use Bun for tests.")).toBe(false);
	});

	test("strips legacy sections and appends V3 block", () => {
		const input = `# Doc

## OMP Evolution System
- Produces conventions.md
- ConventionExtractor extracts procedural_rule

## Testing
- Use bun test paths
`;
		const out = sanitizeConsolidatedMemoryMd(input);
		expect(out).not.toContain("## OMP Evolution System");
		expect(out).not.toContain("Produces conventions.md");
		expect(out).toContain("## Self-Evolution System (V3)");
		expect(out).toContain("SessionLearner");
		expect(out).toContain("## Testing");
	});

	test("replaces legacy memory_summary with derive from memory_md", () => {
		const md = sanitizeConsolidatedMemoryMd("# Hi\n\n## Self-Evolution System (V3)\n- learnings\n");
		const summary = sanitizeConsolidatedMemorySummary(
			"OMP evolution pipeline extracts conventions (confidence>=80)",
			md,
		);
		expect(summary).not.toContain("conventions (confidence");
		expect(summary).toContain("Self-Evolution System (V3)");
	});
});
