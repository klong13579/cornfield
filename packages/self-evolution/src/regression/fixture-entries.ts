/**
 * Hydrate regression fixture tool entries from session_traces (single source of truth).
 */
import type { Database } from "bun:sqlite";
import type { SessionTrace, TraceEntry } from "../types";

export const FIXTURE_TRACE_ENTRY_LIMIT = 80;

export function sliceTraceEntriesForFixture(trace: SessionTrace): TraceEntry[] {
	return trace.entries.slice(-FIXTURE_TRACE_ENTRY_LIMIT);
}

export function loadFixtureEntriesFromDb(db: Database, sessionId: string): TraceEntry[] {
	const stmt = db.prepare("SELECT trace_json FROM session_traces WHERE session_id = ?");
	const row = stmt.get(sessionId) as { trace_json: string } | undefined;
	stmt.finalize();
	if (!row) return [];

	try {
		const trace = JSON.parse(row.trace_json) as SessionTrace;
		return sliceTraceEntriesForFixture(trace);
	} catch {
		return [];
	}
}
