/**
 * Bootstrap learnings from a static seed file (post–/evolution clear or new project).
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { validateLearningContent } from "./learning-admission";
import type { SqliteLearningStore } from "./storage/learnings";
import type { Learning, LearningKind } from "./types";

export interface LearningSeedEntry {
	kind: LearningKind;
	content: string;
	/** When true (default), learning is pinned → active and injected immediately */
	pin?: boolean;
}

export interface ApplyLearningsSeedResult {
	loaded: number;
	pinned: number;
	skipped: number;
	errors: string[];
}

function parseKind(raw: string): LearningKind | null {
	const k = raw.trim().toLowerCase();
	if (k === "preference" || k === "fact" || k === "procedure" || k === "skill_hint") return k;
	return null;
}

function learningId(content: string, kind: LearningKind): string {
	return `lrn_${Bun.hash(`seed:${kind}:${content}`).toString(36)}`;
}

export function parseLearningsSeedJson(text: string): LearningSeedEntry[] {
	const parsed = JSON.parse(text) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error("Seed file must be a JSON array");
	}
	const entries: LearningSeedEntry[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const kind = parseKind(String(row.kind ?? ""));
		const content = String(row.content ?? "").trim();
		if (!kind || !validateLearningContent(content)) continue;
		entries.push({
			kind,
			content,
			pin: row.pin === undefined ? true : Boolean(row.pin),
		});
	}
	return entries;
}

export async function readLearningsSeedFile(seedPath: string): Promise<LearningSeedEntry[]> {
	try {
		const text = await Bun.file(seedPath).text();
		return parseLearningsSeedJson(text);
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`Seed file not found: ${seedPath}`);
		}
		throw err;
	}
}

export function defaultLearningsSeedPath(outputDir: string): string {
	return path.join(outputDir, "learnings-seed.json");
}

export async function applyLearningsSeed(
	store: SqliteLearningStore,
	cwd: string,
	entries: LearningSeedEntry[],
): Promise<ApplyLearningsSeedResult> {
	const result: ApplyLearningsSeedResult = { loaded: 0, pinned: 0, skipped: 0, errors: [] };
	const now = Date.now();

	for (const entry of entries) {
		if (!validateLearningContent(entry.content)) {
			result.skipped++;
			result.errors.push(`Skipped (invalid): ${entry.content.slice(0, 60)}`);
			continue;
		}
		const pin = entry.pin !== false;
		const learning: Learning = {
			id: learningId(entry.content, entry.kind),
			cwd,
			kind: entry.kind,
			content: entry.content,
			source: pin ? "manual_pin" : "session_llm",
			confidence: 5,
			lifecycle: pin ? "active" : "candidate",
			scope: "global" as import("./types").LearningScope,
			sessionId: "seed",
			createdAt: now,
			updatedAt: now,
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
		};
		await store.insert(learning);
		result.loaded++;
		if (pin) {
			await store.pin(learning.id);
			result.pinned++;
		}
	}

	return result;
}
