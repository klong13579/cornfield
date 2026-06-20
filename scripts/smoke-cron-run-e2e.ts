#!/usr/bin/env bun
/**
 * Realistic e2e: simulate a gateway agent cron run.
 *
 * The gateway calls findAgentSessionPath(startedAt, endedAt) after running
 * the task. During an "agent" task, OMP creates a new session file under
 * <sessionDir>/by-date/<today>/<HHMMSS>__<8hex>.jsonl.
 *
 * We simulate that here by:
 *   1. recording startedAt
 *   2. creating a real by-date/ file (with a real session id and a UUIDv7)
 *   3. recording endedAt
 *   4. calling findAgentSessionPath(startedAt, endedAt) — same call site
 *      as gateway.ts:905 and cli-commands.ts:294
 *   5. asserting the returned path matches the file we just created
 *   6. cleanup: remove the file
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findAgentSessionPath } from "../packages/pi-gateway/src/scheduler/cli-commands";
import { sessionFilePath } from "../packages/coding-agent/src/session/session-paths";

const sessionDir = path.join(os.homedir(), ".omp", "agent", "sessions", "-Desktop-Narwal-oh-my-pi");

// A real UUIDv7-shaped id (last 8 hex = b8c75295 in this test run, deterministic suffix)
const sessionId = "019ee0c7-7493-7000-93bf-1d5bb8c75295";
const date = new Date();

const filePath = sessionFilePath(sessionDir, sessionId, date);
const dateDir = path.dirname(filePath);
fs.mkdirSync(dateDir, { recursive: true });
// Write a minimal valid session header so the JSONL parses if anything tries to read it.
const header = {
	type: "session",
	version: 3,
	id: sessionId,
	timestamp: date.toISOString(),
	cwd: "/Users/sz-0203015357/Desktop/Narwal/oh-my-pi",
	title: "smoke-test-cron-run",
};
fs.writeFileSync(filePath, JSON.stringify(header) + "\n");

const startedAt = Date.now() - 100;
const endedAt = Date.now() + 100;
const found = findAgentSessionPath(startedAt, endedAt);

const ok = found === filePath;
console.log(ok ? "✓ PASS" : "✗ FAIL");
console.log("  expected:", filePath);
console.log("  got:     ", found ?? "undefined");

// cleanup
fs.unlinkSync(filePath);
// Remove the date dir if empty
try { fs.rmdirSync(dateDir); } catch { /* not empty, leave it */ }

process.exit(ok ? 0 : 1);
