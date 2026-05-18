/**
 * Post-process memory consolidation output so Phase2 does not resurrect V2 convention docs.
 */
import v3EvolutionMemoryBlock from "./prompts/v3-evolution-memory-block.md" with { type: "text" };

const LEGACY_LINE_PATTERNS: RegExp[] = [
	/ConventionExtractor/i,
	/extractConventionsWithLlm/i,
	/convention_feedback/i,
	/conventions\.md/i,
	/Convention Extraction Pipeline/i,
	/convention extraction:/i,
	/procedural_rule.*negative_rule.*preference/i,
	/--no-self-evolution-v2-writer/i,
	/SqliteConventionStore/i,
	/conventions table/i,
	/extracts conventions/i,
	/confidence\s*>=\s*80.*inject/i,
];

function isLegacyEvolutionSectionHeader(line: string): boolean {
	const h = line.trim();
	if (!/^##\s+/.test(h)) return false;
	if (/self-evolution|omp evolution|convention extraction/i.test(h)) return true;
	if (/^##\s+convention/i.test(h)) return true;
	return false;
}

export function containsLegacyEvolutionContent(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;
	return LEGACY_LINE_PATTERNS.some(re => re.test(normalized));
}

function stripLegacySections(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let skipping = false;

	for (const line of lines) {
		if (isLegacyEvolutionSectionHeader(line)) {
			skipping = true;
			continue;
		}
		if (skipping && /^##\s+/.test(line.trim())) {
			skipping = false;
		}
		if (skipping) continue;
		if (LEGACY_LINE_PATTERNS.some(re => re.test(line))) continue;
		out.push(line);
	}

	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function hasV3EvolutionSection(markdown: string): boolean {
	return /##\s+Self-Evolution System \(V3\)/i.test(markdown);
}

export function sanitizeConsolidatedMemoryMd(memoryMd: string): string {
	let text = stripLegacySections(memoryMd.trim());
	if (!hasV3EvolutionSection(text)) {
		text = text.length > 0 ? `${text}\n\n${v3EvolutionMemoryBlock.trim()}` : v3EvolutionMemoryBlock.trim();
	}
	return `${text.trim()}\n`;
}

export function sanitizeConsolidatedMemorySummary(memorySummary: string, sanitizedMemoryMd: string): string {
	const summary = memorySummary.trim();
	if (!summary || containsLegacyEvolutionContent(summary)) {
		return deriveSummaryFromMemoryMd(sanitizedMemoryMd);
	}
	return `${summary}\n`;
}

function deriveSummaryFromMemoryMd(memoryMd: string): string {
	const maxChars = 1200;
	const body = memoryMd.trim();
	if (body.length <= maxChars) return `${body}\n`;
	return `${body.slice(0, maxChars).trim()}\n`;
}
