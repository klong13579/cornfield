import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveGlobalEvolutionDir } from "./paths";
import type { NudgeHistoryStore } from "./storage/types";
import type { Nudge, NudgeRecord } from "./types";

export function createNudgeHistoryId(sessionId: string, nudgeType: string): string {
	return `${sessionId}-${nudgeType}-${Date.now()}`;
}

export async function persistNudgeRecord(
	store: NudgeHistoryStore,
	params: {
		sessionId: string;
		project: string;
		nudge: Nudge;
	},
): Promise<string> {
	const id = createNudgeHistoryId(params.sessionId, params.nudge.type);
	const record: NudgeRecord = {
		id,
		sessionId: params.sessionId,
		project: params.project,
		type: params.nudge.type,
		severity: params.nudge.severity,
		message: params.nudge.message,
		suggestion: params.nudge.suggestion,
		detectedAt: Date.now(),
		contextInjected: false,
		postToolCalls: 0,
		patternRepeated: false,
	};

	// Write to DB (with fallback warning)
	await store.insert(record).catch((err: unknown) => {
		console.warn("nudge DB insert failed:", err);
	});

	// Write to file (user-level)
	await appendNudgeToFile(params.nudge, params.project);

	return id;
}

/** Append nudge to nudges.md file. */
async function appendNudgeToFile(nudge: Nudge, project: string): Promise<void> {
	try {
		const evolutionDir = resolveGlobalEvolutionDir();
		const nudgeFilePath = path.join(evolutionDir, "nudges.md");

		const timestamp = new Date().toISOString().split("T")[0];
		const time = new Date().toLocaleString("zh-CN", { hour12: false });
		const entry =
			`### ${timestamp}\n\n` +
			`#### ${nudge.type}\n\n` +
			`- **Severity**: ${nudge.severity}\n` +
			`- **Project**: ${project || "(global)"}\n` +
			`- **Time**: ${time}\n` +
			`- **Message**: ${nudge.message}\n` +
			`- **Suggestion**: ${nudge.suggestion}\n\n` +
			`---\n\n`;

		// Read existing content or create new
		let content = "";
		try {
			content = await fs.readFile(nudgeFilePath, "utf-8");
		} catch {
			// File doesn't exist, start with header
			content = "# Nudges\n\n";
		}

		await fs.writeFile(nudgeFilePath, content + entry);
	} catch (err) {
		console.warn("Failed to write nudge to file:", err);
	}
}
