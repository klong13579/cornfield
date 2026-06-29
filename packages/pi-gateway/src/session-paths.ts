/**
 * Session path contract — single source of truth for cron and interactive
 * session file locations.
 *
 * Why this module exists
 * ----------------------
 * Before this module, agent session JSONL files could land in TWO places:
 *
 *   1. <agentDir>/sessions/cron_<ts>.jsonl
 *      (set explicitly by the gateway cron path)
 *
 *   2. ~/.omp/agent/sessions/<encoded-cwd>/by-date/...
 *      (computed silently by the OMP child when no explicit path was set)
 *
 * That ambiguity is the root cause of:
 *   - "agent session path" being empty in the executions table for some runs
 *   - sibling `cron_<id>/` directories that no .jsonl ever lives in
 *   - the old `findAgentSessionPath` having to walk the entire
 *     `~/.omp/agent/sessions/` tree to find any cron session
 *
 * After this module, ALL session files for an agent live in a single tree:
 *
 *   <agentDir>/sessions/
 *   ├── cron_<ts>.jsonl                          (gateway cron, flat)
 *   └── <encoded-cwd>/                           (interactive, by-date)
 *       └── <YYYY-MM-DD>/
 *           └── <HHMMSS>[-<slug>]__<8hex>.jsonl
 *
 * No code outside this module is allowed to build session paths via raw
 * `path.join(...)`. If you find yourself doing that, add a function here
 * first, then call it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Path constructors
// ---------------------------------------------------------------------------

/**
 * Encode an absolute cwd as a directory name.
 *
 * Rule: replace every path separator with `-`. The result preserves case
 * (so `/Users/.../Foo` → `-Users-...-Foo`). This matches the OMP `by-date`
 * layout in production; if OMP ever changes its encoding, update this
 * function in lockstep.
 */
export function encodeCwd(cwd: string): string {
	if (!cwd) throw new Error("encodeCwd: cwd required");
	const normalized = path.resolve(cwd);
	return normalized.replace(/[\\/]/g, "-");
}

/**
 * Path for a gateway cron session file. Flat, timestamp-based.
 *
 *   <agentDir>/sessions/cron_<ts>.jsonl
 */
export function cronSessionPath(agentDir: string, now: number = Date.now()): string {
	if (!agentDir) throw new Error("cronSessionPath: agentDir required");
	if (!Number.isFinite(now) || now <= 0) throw new Error(`cronSessionPath: invalid now=${now}`);
	return path.join(agentDir, "sessions", `cron_${now}.jsonl`);
}

/**
 * Path for an interactive (non-cron) session file. Goes under the
 * encoded cwd's `by-date/<YYYY-MM-DD>/` tree, matching OMP's convention.
 *
 *   <agentDir>/sessions/<encoded-cwd>/by-date/<YYYY-MM-DD>/<HHMMSS>__<8hex>.jsonl
 */
export function interactiveSessionPath(agentDir: string, cwd: string, now: Date = new Date()): string {
	if (!agentDir) throw new Error("interactiveSessionPath: agentDir required");
	if (!cwd) throw new Error("interactiveSessionPath: cwd required");
	const encoded = encodeCwd(cwd);
	const stamp = timeStamp(now);
	const tail = randomHex(8);
	const dateDir = yyyymmdd(now);
	const fileName = `${stamp}__${tail}.jsonl`;
	return path.join(agentDir, "sessions", encoded, "by-date", dateDir, fileName);
}

// ---------------------------------------------------------------------------
// Filename grammar helpers
// ---------------------------------------------------------------------------

/** YYYYMMDD in local time, matching OMP's `by-date` directory naming. */
function yyyymmdd(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}${m}${day}`;
}

/** HHMMSS in local time, matching OMP's `timeStamp()` in session-paths.ts. */
function timeStamp(d: Date): string {
	const h = String(d.getHours()).padStart(2, "0");
	const mi = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}${mi}${s}`;
}

/** 8-char lowercase hex (4 random bytes). Matches OMP's session ID tail. */
function randomHex(n: number): string {
	return crypto
		.randomBytes(Math.ceil(n / 2))
		.toString("hex")
		.slice(0, n);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Filename regex for a cron session file. */
const CRON_FILE = /^cron_\d+\.jsonl$/;

/** Filename regex for an interactive session file. Matches OMP convention. */
const INTERACTIVE_FILE = /^\d{6}(?:-[a-z0-9-]+)?__[0-9a-f]{8}\.jsonl$/;

/**
 * Find the OMP agent session JSONL for a given agent, created during
 * the [startedAt, endedAt] window (with ±5s tolerance, matching the
 * previous implementation).
 *
 * Scans ONLY `<agentDir>/sessions/`. Does NOT fall back to
 * `~/.omp/agent/sessions/` — that path is no longer authoritative for
 * gateway-managed agents.
 *
 * Returns the path of the most recently mtime'd match, or undefined.
 */
export function findAgentSessionPath(agentDir: string, startedAt: number, endedAt: number): string | undefined {
	if (!agentDir) return undefined;
	const root = path.join(agentDir, "sessions");
	if (!fs.existsSync(root)) return undefined;

	const toleranceMs = 5_000;
	let best: { full: string; mtimeMs: number } | undefined;

	const consider = (full: string): void => {
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(full).mtimeMs;
		} catch {
			return;
		}
		if (mtimeMs < startedAt - toleranceMs) return;
		if (mtimeMs > endedAt + toleranceMs) return;
		if (!best || mtimeMs > best.mtimeMs) {
			best = { full, mtimeMs };
		}
	};

	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name.startsWith(".")) continue;
				walk(full);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
			if (CRON_FILE.test(ent.name) || INTERACTIVE_FILE.test(ent.name)) {
				consider(full);
			}
		}
	};

	walk(root);
	return best?.full;
}

/**
 * Enumerate all session files under an agent's sessions root.
 * Intended for downstream scanners / debug tooling.
 */
export interface AgentSessionEntry {
	readonly path: string;
	readonly type: "cron" | "interactive";
	readonly size: number;
	readonly mtimeMs: number;
}

export function enumerateAgentSessions(agentDir: string): AgentSessionEntry[] {
	if (!agentDir) return [];
	const root = path.join(agentDir, "sessions");
	if (!fs.existsSync(root)) return [];

	const out: AgentSessionEntry[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name.startsWith(".")) continue;
				walk(full);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
			let type: AgentSessionEntry["type"];
			if (CRON_FILE.test(ent.name)) type = "cron";
			else if (INTERACTIVE_FILE.test(ent.name)) type = "interactive";
			else continue;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			out.push({ path: full, type, size: stat.size, mtimeMs: stat.mtimeMs });
		}
	};
	walk(root);
	return out;
}
