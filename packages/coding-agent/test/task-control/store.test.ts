/**
 * Durability and shape (`docs/proma-comparison/orchestration-record-contract.md` §5.3: the
 * ledger is the only recovery source; §1 invariant 3: an existing shape keeps working).
 *
 * Real files in a real temporary directory — the failure modes here are filesystem ones
 * (missing file, torn shape, rewritten history) and a mock would not have them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createLedger, recordConfirmation } from "../../src/task-control/main-worker";
import type { OrchestrationLedger } from "../../src/task-control/store";
import {
	createFileOrchestrationStore,
	ORCHESTRATION_LEDGER_SUFFIX,
	ORCHESTRATION_LEDGER_VERSION,
	orchestrationLedgerPath,
} from "../../src/task-control/store";
import { AT, violationOf, violationOfAsync } from "./fixtures";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-task-control-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A ledger with two events, so prefix checks have something to compare. */
function ledgerFixture(): OrchestrationLedger {
	const created = createLedger({
		recordId: "record-1",
		units: [{ id: "a" }, { id: "b", deps: ["a"] }],
		actor: "orchestrator",
		now: AT,
	});
	return recordConfirmation(created, ["a", "b"], { actor: "orchestrator", now: AT + 1 });
}

async function writeRaw(recordId: string, content: string): Promise<void> {
	await Bun.write(orchestrationLedgerPath(dir, recordId), content);
}

describe("round trip", () => {
	test("writes a ledger and reads back exactly what was written", async () => {
		const store = createFileOrchestrationStore(dir);
		const ledger = ledgerFixture();
		await store.save(ledger);
		expect(await store.load("record-1")).toEqual(ledger);
	});

	test("replaces the ledger atomically, leaving no staging file behind", async () => {
		const store = createFileOrchestrationStore(dir);
		const ledger = ledgerFixture();
		await store.save(ledger);
		const next = recordConfirmation(ledger, ["a"], { actor: "orchestrator", now: AT + 2 });
		await store.save(next);

		expect(await store.load("record-1")).toEqual(next);
		expect(await fs.readdir(dir)).toEqual([`record-1${ORCHESTRATION_LEDGER_SUFFIX}`]);
	});

	test("a record that was never written is null, not an empty record", async () => {
		expect(await createFileOrchestrationStore(dir).load("record-1")).toBeNull();
	});
});

describe("shape", () => {
	test("refuses JSON it cannot read", async () => {
		const store = createFileOrchestrationStore(dir);
		await writeRaw("record-1", "{ not json");
		const violation = await violationOfAsync(() => store.load("record-1"));
		expect(violation.rule).toBe("record.ledger-rejected");
		expect(violation.message).toContain("not readable JSON");
	});

	test("refuses a version this build would silently rewrite", async () => {
		const store = createFileOrchestrationStore(dir);
		await writeRaw("record-1", JSON.stringify({ ...ledgerFixture(), version: ORCHESTRATION_LEDGER_VERSION + 1 }));
		const violation = await violationOfAsync(() => store.load("record-1"));
		expect(violation.rule).toBe("record.ledger-rejected");
		expect(violation.message).toContain(`has version ${ORCHESTRATION_LEDGER_VERSION + 1}`);
	});

	test("refuses a unit status outside the vocabulary", async () => {
		const ledger = ledgerFixture();
		const broken = {
			...ledger,
			record: { ...ledger.record, units: [{ ...ledger.record.units[0], status: "done" }, ledger.record.units[1]] },
		};
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/expected one of/);
	});

	test("refuses a record that declares the same unit id twice", async () => {
		const ledger = ledgerFixture();
		const [first, second] = ledger.record.units;
		const broken = { ...ledger, record: { ...ledger.record, units: [first, { ...second, id: first.id }] } };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/declares unit id "a" twice/);
	});

	test("refuses a cap that leaves nothing schedulable", async () => {
		const ledger = ledgerFixture();
		await writeRaw("record-1", JSON.stringify({ ...ledger, record: { ...ledger.record, maxConcurrency: 0 } }));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/at least 1 slot/);
	});

	test("refuses an empty acceptance binding: it would verify nothing", async () => {
		const ledger = ledgerFixture();
		const [first, second] = ledger.record.units;
		const broken = { ...ledger, record: { ...ledger.record, units: [{ ...first, acceptance: {} }, second] } };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/empty or not an object/);
	});
});

describe("events", () => {
	test("refuses an event whose id does not match its sequence", async () => {
		const ledger = ledgerFixture();
		const [first, ...rest] = ledger.events;
		const broken = { ...ledger, events: [{ ...first, sequence: 99 }, ...rest] };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/does not match its sequence/);
	});

	test("refuses events that are out of append order", async () => {
		const ledger = ledgerFixture();
		const [first, second, third] = ledger.events;
		const broken = { ...ledger, events: [first, third, second] };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/out of append order/);
	});

	test("refuses an event about a unit the record does not have", async () => {
		const ledger = ledgerFixture();
		const [first, ...rest] = ledger.events;
		const broken = { ...ledger, events: [{ ...first, unitId: "ghost" }, ...rest] };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/names unit "ghost"/);
	});

	test("refuses an event type this build does not know", async () => {
		const ledger = ledgerFixture();
		const [first, ...rest] = ledger.events;
		const broken = { ...ledger, events: [{ ...first, type: "unit.vanished" }, ...rest] };
		await writeRaw("record-1", JSON.stringify(broken));
		await expect(createFileOrchestrationStore(dir).load("record-1")).rejects.toThrow(/unknown type/);
	});
});

describe("append-only history", () => {
	test("refuses a save that drops events", async () => {
		const store = createFileOrchestrationStore(dir);
		const ledger = ledgerFixture();
		await store.save(ledger);
		const truncated = { ...ledger, events: ledger.events.slice(1) };
		const violation = await violationOfAsync(() => store.save(truncated));
		expect(violation.rule).toBe("record.ledger-rejected");
		expect(violation.message).toContain("append-only");
	});

	test("refuses a save that rewrites the payload of an event that is already recorded", async () => {
		const store = createFileOrchestrationStore(dir);
		const ledger = ledgerFixture();
		await store.save(ledger);
		// Same event count, same sequences, same ids, still a legal shape — only which unit each event is
		// about moved. An id-based check would wave this through, which is why the comparison is by content.
		const [created, first, second] = ledger.events;
		const rewritten = {
			...ledger,
			events: [created, { ...first, unitId: second.unitId }, { ...second, unitId: first.unitId }],
		};
		await expect(store.save(rewritten)).rejects.toThrow(/append-only/);
	});

	test("accepts a save that appends", async () => {
		const store = createFileOrchestrationStore(dir);
		const ledger = ledgerFixture();
		await store.save(ledger);
		const appended = recordConfirmation(ledger, ["a"], { actor: "orchestrator", now: AT + 3 });
		await store.save(appended);
		expect(await store.load("record-1")).toEqual(appended);
	});
});

describe("record identity", () => {
	test("never returns another record's facts under the id it was asked for", async () => {
		const store = createFileOrchestrationStore(dir);
		await writeRaw("other", JSON.stringify(ledgerFixture()));
		const violation = await violationOfAsync(() => store.load("other"));
		expect(violation.rule).toBe("record.ledger-rejected");
		expect(violation.message).toContain('holds record "record-1" but was read as record "other"');
	});
});

describe("record ids are file names", () => {
	test("refuses an id that would write outside the store directory", async () => {
		const store = createFileOrchestrationStore(dir);
		expect(violationOf(() => orchestrationLedgerPath(dir, "../escaped")).rule).toBe("record.ledger-rejected");
		const ledger = ledgerFixture();
		const escaped = { ...ledger, record: { ...ledger.record, id: "../escaped" } };
		expect((await violationOfAsync(() => store.save(escaped))).rule).toBe("record.ledger-rejected");
		expect(await fs.readdir(dir)).toEqual([]);
	});

	test("refuses an id with a path separator", () => {
		expect(violationOf(() => orchestrationLedgerPath(dir, "nested/record")).rule).toBe("record.ledger-rejected");
		expect(violationOf(() => orchestrationLedgerPath(dir, "")).rule).toBe("record.ledger-rejected");
	});

	test("accepts the ids the dialect actually uses", () => {
		expect(orchestrationLedgerPath(dir, "agent-first-d")).toBe(
			path.join(dir, `agent-first-d${ORCHESTRATION_LEDGER_SUFFIX}`),
		);
	});
});
