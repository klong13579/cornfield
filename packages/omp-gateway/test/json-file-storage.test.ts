/**
 * JsonFileStorage cross-process change detection tests.
 *
 * Regression target: the CLI and the long-lived gateway are separate
 * processes sharing `jobs.json`. Before the fix, `#ensureLoaded()` read
 * the file exactly once per instance; the gateway never saw CLI
 * create/update/delete writes (its next `#flush()` even overwrote them
 * with its own stale in-memory copy), and its tick classified CLI
 * test-run markers as "task deleted".
 *
 * The two-instance pattern below simulates the two processes: an
 * instance is constructed and read (the gateway's cache), then a
 * second instance mutates the same jobs.json (the CLI), then the first
 * instance is read again and MUST see the change without a restart.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import { getTestRunMarkerPath, writeTestRunMarkerRaw } from "../src/scheduler/test-run-marker";
import type { ScheduledTask } from "../src/scheduler/types";

let tmpDir: string;
let jobsPath: string;

function makeTask(name: string, overrides: Partial<ScheduledTask> = {}): Omit<ScheduledTask, "id"> {
	return {
		name,
		cron: "0 9 * * *",
		command: `echo ${name}`,
		status: "active",
		scheduleType: "cron",
		taskType: "shell",
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		...overrides,
	};
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gateway-storage-"));
	jobsPath = path.join(tmpDir, "jobs.json");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("JsonFileStorage cross-process change detection", () => {
	it("reloads a CLI-added task without a new instance (create visible)", () => {
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks()).toHaveLength(0); // gateway loads the (absent) file first

		// CLI process adds a task to the shared file.
		const cli = new JsonFileStorage(jobsPath);
		cli.addTask(makeTask("cli-added"));

		// Gateway's long-lived instance must see it.
		const names = gw.listTasks().map(t => t.name);
		expect(names).toContain("cli-added");
	});

	it("reloads a CLI-updated task's fields", () => {
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks()).toHaveLength(0);

		const cli = new JsonFileStorage(jobsPath);
		const task = cli.addTask(makeTask("cli-edited"));

		cli.updateTask(task.id, { timeoutMs: 9999, cron: "0 12 * * *" });

		const seen = gw.getTask(task.id);
		expect(seen?.timeoutMs).toBe(9999);
		expect(seen?.cron).toBe("0 12 * * *");
	});

	it("reloads a CLI-deleted task (remove visible)", () => {
		const cli = new JsonFileStorage(jobsPath);
		const task = cli.addTask(makeTask("to-remove"));

		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks()).toHaveLength(1);

		cli.deleteTask(task.id);
		expect(gw.listTasks()).toHaveLength(0);
	});

	it("does not flush over CLI-added tasks with stale in-memory state", () => {
		// Gateway caches a snapshot of the file.
		const seed = new JsonFileStorage(jobsPath);
		const keeper = seed.addTask(makeTask("keeper"));
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks().map(t => t.name)).toEqual(["keeper"]);

		// CLI adds a task to disk (gateway's cache does not know it yet).
		const cli = new JsonFileStorage(jobsPath);
		cli.addTask(makeTask("cli-new"));

		// Gateway updates a field on its cached task → flush must not
		// overwrite the CLI's addition with the stale in-memory map.
		gw.updateTask(keeper.id, { runCount: 5 });

		const onDisk = new JsonFileStorage(jobsPath)
			.listTasks()
			.map(t => t.name)
			.sort();
		expect(onDisk).toEqual(["cli-new", "keeper"]);
	});

	it("keeps the cached task map when jobs.json is transiently corrupt, then reloads after repair", () => {
		const seed = new JsonFileStorage(jobsPath);
		const task = seed.addTask(makeTask("survivor"));
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks().map(t => t.name)).toEqual(["survivor"]);

		// CLI writes a corrupt file.
		fs.writeFileSync(jobsPath, '{"version": 1, "tasks": [BROKEN');

		// Cache must survive the bad read.
		expect(gw.listTasks().map(t => t.name)).toEqual(["survivor"]);

		// CLI repairs the file (different content).
		const repaired: ScheduledTask = {
			...makeTask("replacement"),
			id: "replacement-id",
		};
		fs.writeFileSync(
			jobsPath,
			JSON.stringify({ version: 1, tasks: [repaired], metadata: { updatedAt: Date.now() } }),
		);

		const names = gw.listTasks().map(t => t.name);
		expect(names).toEqual(["replacement"]);
		expect(names).not.toContain("survivor");
		expect(gw.getTask(task.id)).toBeUndefined();
	});

	it("treats a deleted jobs.json as an empty task map on the next read", () => {
		const seed = new JsonFileStorage(jobsPath);
		seed.addTask(makeTask("gone"));
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks()).toHaveLength(1);

		fs.rmSync(jobsPath);
		expect(gw.listTasks()).toHaveLength(0);
		// And a later write still works on the fresh state.
		gw.addTask(makeTask("after-delete"));
		expect(gw.listTasks().map(t => t.name)).toEqual(["after-delete"]);
	});

	it("serves unchanged reads from cache without re-reading the file", () => {
		const seed = new JsonFileStorage(jobsPath);
		const task = seed.addTask(makeTask("cached"));

		const gw = new JsonFileStorage(jobsPath);
		const first = gw.getTask(task.id)!;
		const again = gw.getTask(task.id)!;
		expect(again).toBe(first); // same object reference → no reload happened
		expect(gw.listTasks()[0]!.id).toBe(task.id);
	});

	it("recovers an orphan test-run marker for a CLI-created task instead of misreading it as deleted", () => {
		// Gateway loads an empty state first.
		const gw = new JsonFileStorage(jobsPath);
		expect(gw.listTasks()).toHaveLength(0);

		// CLI process: create task, rewrite it to the +<n>s test-run
		// shape, and leave a restore marker (as a dead CLI would).
		const cli = new JsonFileStorage(jobsPath);
		const task = cli.addTask(makeTask("cli-test-run"));
		cli.updateTask(task.id, {
			cron: "+60s",
			scheduleType: "once",
			nextRunAt: Date.now() + 60_000,
		});
		writeTestRunMarkerRaw(
			{
				version: 1,
				taskId: task.id,
				taskName: task.name,
				snapshot: {
					cron: "0 9 * * *",
					scheduleType: "cron",
					nextRunAt: undefined,
					status: "active",
					lastRunAt: undefined,
					runCount: 0,
					failCount: 0,
					consecutiveFailures: 0,
					repeatCompleted: undefined,
					lastDeliveryError: undefined,
				},
				startedAt: Date.now(),
				pid: 424_242, // not this process → cross-process orphan
			},
			path.dirname(jobsPath),
		);

		// The gateway tick must restore the snapshot, not declare the
		// (visible-on-disk) task deleted.
		const consumed = gw.consumeOrphanTestRunMarker();
		expect(consumed).toBe(true);
		expect(gw.getTask(task.id)?.cron).toBe("0 9 * * *");
		expect(gw.getTask(task.id)?.scheduleType).toBe("cron");
		expect(fs.existsSync(getTestRunMarkerPath(path.dirname(jobsPath)))).toBe(false);
	});
});
