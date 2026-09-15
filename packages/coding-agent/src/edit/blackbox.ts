/**
 * Local corpus of edit parse regressions.
 *
 * Every edit that leaves a file unparseable is appended with the exact bytes on
 * both sides, so localization and adoption rules can be evaluated offline
 * against real failures instead of against the cases we happened to imagine.
 * Recording is diagnostic: a failure to record must never turn a reported edit
 * into a different outcome, so it never propagates to the caller.
 *
 * Off by default (`edit.blackbox.enabled`): the corpus carries whole file
 * contents and is only worth its disk when something reads it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@cornfield/utils";
import type { ToolSession } from "../tools";

const CORPUS_FILE = "edit-blackbox.jsonl";
const CORPUS_ROTATED_FILE = "edit-blackbox.jsonl.1";

/** One parse regression, as written to the corpus. */
export interface EditParseRegression {
	/** ISO-8601 time the regression was detected. */
	timestamp: string;
	/** Display path of the file that stopped parsing. */
	path: string;
	/** Canonical tree-sitter language of the file. */
	language: string;
	/** 1-based line of the first error/missing node, when known. */
	badLine?: number;
	/** File content before the edit — the parseable pre-image. */
	before: string;
	/** File content after the edit — the content that no longer parsed. */
	after: string;
	/** Whether an auto-repair candidate was adopted and kept. */
	adopted: boolean;
}

/** What the caller observed; the recorder supplies the timestamp. */
export type EditParseRegressionInput = Omit<EditParseRegression, "timestamp">;

/**
 * Move the corpus aside once it reaches `maxBytes`, so the log keeps one
 * generation of history instead of growing without bound.
 *
 * The check runs before the append, so the file can exceed the limit by one
 * record — a bounded overshoot that keeps every record whole.
 */
async function rotateCorpus(file: string, maxBytes: number): Promise<void> {
	if (maxBytes <= 0) return;
	let size: number;
	try {
		size = (await fs.stat(file)).size;
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	if (size < maxBytes) return;
	await fs.rename(file, path.join(path.dirname(file), CORPUS_ROTATED_FILE));
}

/**
 * Append one parse regression to `<agentDir>/edit-blackbox.jsonl`. No-op when
 * `edit.blackbox.enabled` is off.
 */
export async function recordEditParseRegression(
	session: ToolSession,
	regression: EditParseRegressionInput,
): Promise<void> {
	if (!session.settings.get("edit.blackbox.enabled")) return;

	const file = path.join(session.settings.getAgentDir(), CORPUS_FILE);
	const record: EditParseRegression = { timestamp: new Date().toISOString(), ...regression };
	try {
		await rotateCorpus(file, session.settings.get("edit.blackbox.maxBytes"));
		// The agent dir is not guaranteed to exist yet in a fresh or isolated
		// environment, and `appendFile` does not create parents.
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.appendFile(file, `${JSON.stringify(record)}\n`);
	} catch (err) {
		// The edit has already been decided at this point; a telemetry failure must
		// not change what the caller reports.
		logger.debug("edit-blackbox: failed to record parse regression", {
			path: file,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
