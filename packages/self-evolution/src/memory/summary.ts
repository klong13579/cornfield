import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const MIN_SUMMARY_CHARS = 200;
const DEFAULT_SUMMARY_MAX_CHARS = 1200;

/**
 * Ensure memory_summary.md is usable for prompt injection.
 * Uses LLM summary when long enough; otherwise derives from MEMORY.md body.
 */
export async function ensureMemorySummaryFromMemory(
	memoryRoot: string,
	options?: { memoryMd?: string; llmSummary?: string; maxChars?: number },
): Promise<{ written: boolean; length: number; source: "llm" | "memory_md" | "unchanged" }> {
	const maxChars = options?.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
	const summaryPath = path.join(memoryRoot, "memory_summary.md");

	const llmSummary = options?.llmSummary?.trim() ?? "";
	if (llmSummary.length >= MIN_SUMMARY_CHARS) {
		await Bun.write(summaryPath, `${llmSummary}\n`);
		return { written: true, length: llmSummary.length, source: "llm" };
	}

	let memoryMd = options?.memoryMd?.trim() ?? "";
	if (!memoryMd) {
		try {
			memoryMd = (await Bun.file(path.join(memoryRoot, "MEMORY.md")).text()).trim();
		} catch (err) {
			if (isEnoent(err)) {
				return { written: false, length: 0, source: "unchanged" };
			}
			throw err;
		}
	}

	if (memoryMd.length < MIN_SUMMARY_CHARS) {
		if (llmSummary.length > 0) {
			await Bun.write(summaryPath, `${llmSummary}\n`);
			return { written: true, length: llmSummary.length, source: "llm" };
		}
		return { written: false, length: 0, source: "unchanged" };
	}

	const derived = memoryMd.slice(0, maxChars).trim();
	await Bun.write(summaryPath, `${derived}\n`);
	return { written: true, length: derived.length, source: "memory_md" };
}
