/**
 * The kernel boundary (`docs/proma-comparison/orchestration-record-contract.md` §1, §7).
 *
 * Three invariants are structural, not stylistic, so they are checked mechanically rather
 * than trusted:
 *   - **no strategy vocabulary** in the kernel (§7: `worktree`, `branch`, `pane`, `herdr`,
 *     `isolation` and `git` are one strategy's payload — the day one appears here, the
 *     kernel has started to know what it is orchestrating);
 *   - **no runtime** (§1 invariant 1: no process, no daemon, no timer, no queue);
 *   - **no accidental surface** — the export list is a snapshot, so adding a scheduler or a
 *     second status set to the public surface fails the test instead of shipping.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import * as kernel from "../../src/task-control";

const SOURCE_DIR = path.join(import.meta.dir, "../../src/task-control");
const SOURCE_FILES = ["types.ts", "state-machine.ts", "events.ts", "store.ts", "main-worker.ts", "index.ts"];

/** Prose may quote the strategy; code may not. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function sourceOf(file: string): Promise<string> {
	return code(await Bun.file(path.join(SOURCE_DIR, file)).text());
}

describe("no strategy vocabulary in the kernel", () => {
	test("names none of the words §7 lists as strategy payloads", async () => {
		const forbidden = /\b(worktree|branch|pane|herdr|isolation|git)\b/i;
		for (const file of SOURCE_FILES) {
			const source = await sourceOf(file);
			const found = source.match(forbidden);
			expect({ file, found: found?.[0] ?? null }).toEqual({ file, found: null });
		}
	});
});

describe("no runtime in the kernel", () => {
	test("spawns no process, thread, timer or daemon", async () => {
		const forbidden =
			/Bun\.(spawn|\$|cron)|node:child_process|node:worker_threads|\bnew Worker\b|\bsetInterval\b|\bsetTimeout\b/;
		for (const file of SOURCE_FILES) {
			const source = await sourceOf(file);
			const found = source.match(forbidden);
			expect({ file, found: found?.[0] ?? null }).toEqual({ file, found: null });
		}
	});

	test("opens no second message channel", async () => {
		const forbidden = /intercom|websocket|WebSocket|\bsocket\b/;
		for (const file of SOURCE_FILES) {
			const source = await sourceOf(file);
			const found = source.match(forbidden);
			expect({ file, found: found?.[0] ?? null }).toEqual({ file, found: null });
		}
	});
});

describe("public surface", () => {
	test("exports the kernel and nothing else — no scheduler, no second status set", () => {
		expect(Object.keys(kernel).sort()).toEqual([
			"DEFAULT_MAX_CONCURRENCY",
			"ORCHESTRATION_LEDGER_SUFFIX",
			"ORCHESTRATION_LEDGER_VERSION",
			"OrchestrationViolationError",
			"SLOT_HOLDING_UNIT_STATUSES",
			"TERMINAL_UNIT_STATUSES",
			"UNIT_STATUSES",
			"UNIT_TRANSITIONS",
			"acceptUnit",
			"applyUnitTransition",
			"bringBackResult",
			"checkUnitTransition",
			"createFileOrchestrationStore",
			"createLedger",
			"isAcceptanceBinding",
			"isTerminalUnitStatus",
			"isUnitStatus",
			"mainWorkerStatus",
			"markResultReady",
			"nextSequence",
			"orchestrationEvent",
			"orchestrationEventId",
			"orchestrationLedgerPath",
			"planActions",
			"planUnitCount",
			"reconcile",
			"recordConfirmation",
			"recordGoSent",
			"recordStatus",
			"reworkUnit",
			"validateRecord",
		]);
	});
});
