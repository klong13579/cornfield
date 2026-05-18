import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { isLearningEligibleForInjection } from "../learning-admission";
import type { Learning } from "../types";

function rowToLearning(row: Record<string, unknown>): Learning {
	return {
		id: String(row.id),
		cwd: String(row.cwd),
		kind: row.kind as Learning["kind"],
		content: String(row.content),
		source: row.source as Learning["source"],
		confidence: Number(row.confidence),
		lifecycle: row.lifecycle as Learning["lifecycle"],
		sessionId: String(row.session_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		timesInjected: Number(row.times_injected),
		timesHelped: Number(row.times_helped),
		timesIgnored: Number(row.times_ignored),
	};
}

export async function projectLearnings(db: Database, options: { outputDir: string }): Promise<void> {
	const rows = db.prepare("SELECT * FROM learnings ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
	const learnings = rows.map(rowToLearning);
	const injectable = learnings.filter(isLearningEligibleForInjection);
	const pinned = learnings.filter(l => l.source === "manual_pin" && l.lifecycle !== "archived");
	const show = new Map<string, Learning>();
	for (const l of [...pinned, ...injectable]) show.set(l.id, l);

	const lines: string[] = [
		"# Learnings (V3)",
		"",
		"Active and pinned rules extracted from sessions. Regenerated after each archived session.",
		"",
	];

	if (show.size === 0) {
		lines.push("_No active learnings yet. Use `/evolution learnings pin <id>` after extraction._");
	} else {
		for (const l of show.values()) {
			lines.push(`- **${l.kind}** (${l.source}, conf ${l.confidence}): ${l.content}`);
			lines.push(`  - id: \`${l.id}\` | injected ${l.timesInjected}, helped ${l.timesHelped}`);
		}
	}

	lines.push("");
	lines.push(
		`_Candidate pool: ${learnings.filter(l => l.lifecycle === "candidate").length} | Archived: ${learnings.filter(l => l.lifecycle === "archived").length}_`,
	);

	await Bun.write(path.join(options.outputDir, "learnings.md"), lines.join("\n"));
}
