/**
 * `gateway doctor` diagnostics tests.
 *
 * No mocks: real temp config files, a real SQLite scheduler DB, and the real
 * check/render/fix code paths. The scheduler path helpers hardcode the default
 * data dir, so the orphaned-execution detection + repair is exercised directly
 * against a real SchedulerDbStorage rather than through runDoctor().
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateConfig } from "../src/config";
import { applyFixes, countBySeverity, type DoctorReport, renderJson, renderText, runDoctor } from "../src/doctor";
import { SchedulerDbStorage } from "../src/scheduler";

describe("validateConfig (non-swallowing)", () => {
	let tmpDir: string;
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-doctor-cfg-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("reports missing file distinctly", async () => {
		const result = await validateConfig(path.join(tmpDir, "nope.json"));
		expect(result.status).toBe("missing");
	});

	test("reports JSON5 parse errors distinctly", async () => {
		const p = path.join(tmpDir, "bad.json");
		await Bun.write(p, "{ this is not json ]");
		const result = await validateConfig(p);
		expect(result.status).toBe("parse-error");
	});

	test("reports schema violations with field paths", async () => {
		const p = path.join(tmpDir, "schema.json");
		// agent.timeoutMs must be a positive int; -5 violates the schema.
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { timeoutMs: -5 } }));
		const result = await validateConfig(p);
		expect(result.status).toBe("schema-error");
		if (result.status === "schema-error") {
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues.some(i => i.path.includes("timeoutMs"))).toBe(true);
		}
	});

	test("returns ok with merged defaults for a valid config", async () => {
		const p = path.join(tmpDir, "good.json");
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { timeoutMs: 300000 } }));
		const result = await validateConfig(p);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.config.agent?.timeoutMs).toBe(300000);
			// default merged in
			expect(result.config.session?.idleTimeoutMinutes).toBe(60);
		}
	});
});

describe("runDoctor end-to-end", () => {
	let tmpDir: string;
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-doctor-run-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("missing config yields a CONFIG error and exits non-clean", async () => {
		const report = await runDoctor(path.join(tmpDir, "absent.json"));
		const config = report.sections.find(s => s.name === "CONFIG");
		expect(config).toBeDefined();
		expect(config!.findings.some(f => f.severity === "error")).toBe(true);
		// All standard sections are always present.
		const names = report.sections.map(s => s.name);
		for (const n of [
			"CONFIG",
			"CREDENTIALS",
			"CHANNELS",
			"BRIDGES",
			"QUEUES",
			"SCHEDULER",
			"STATE FILES",
			"SERVICE",
		]) {
			expect(names).toContain(n);
		}
	});

	test("flags unset agent.timeoutMs as a warning", async () => {
		const p = path.join(tmpDir, "no-timeout.json");
		await Bun.write(p, JSON.stringify({ channels: {} }));
		const report = await runDoctor(p);
		const config = report.sections.find(s => s.name === "CONFIG")!;
		expect(config.findings.some(f => f.severity === "warn" && f.message.includes("agent.timeoutMs"))).toBe(true);
	});

	test("flags unresolved $ENV appSecret as an error", async () => {
		const p = path.join(tmpDir, "env-secret.json");
		await Bun.write(
			p,
			JSON.stringify({
				channels: {
					dingtalk: {
						enabled: true,
						accounts: { hr: { appKey: "k", appSecret: "$DOCTOR_TEST_UNSET_SECRET" } },
					},
				},
				agent: { timeoutMs: 120000 },
			}),
		);
		delete process.env.DOCTOR_TEST_UNSET_SECRET;
		const report = await runDoctor(p);
		const config = report.sections.find(s => s.name === "CONFIG")!;
		expect(config.findings.some(f => f.severity === "error" && f.message.includes("DOCTOR_TEST_UNSET_SECRET"))).toBe(
			true,
		);
	});

	test("renderText and renderJson agree on severity counts", async () => {
		const p = path.join(tmpDir, "cfg.json");
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { timeoutMs: 120000 } }));
		const report = await runDoctor(p);
		const counts = countBySeverity(report);

		const text = renderText(report);
		expect(text).toContain("Gateway Doctor");
		expect(text).toContain(`${counts.error} error(s)`);

		const json = JSON.parse(renderJson(report)) as {
			summary: { error: number; warn: number; ok: number; fixable: number };
			sections: Array<{ name: string }>;
		};
		expect(json.summary.error).toBe(counts.error);
		expect(json.summary.warn).toBe(counts.warn);
		expect(json.sections.length).toBe(report.sections.length);
	});
});

describe("orphaned-execution detection and repair", () => {
	let dbPath: string;
	let storage: SchedulerDbStorage;

	beforeEach(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-doctor-db-"));
		dbPath = path.join(dir, "scheduler.db");
		storage = new SchedulerDbStorage(dbPath);
	});
	afterEach(async () => {
		storage.close();
		await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
	});

	test("getRunningExecutions returns only running rows with task name", () => {
		const task = storage.addTask({
			name: "demo",
			cron: "0 9 * * *",
			command: "echo hi",
			status: "active",
			consecutiveFailures: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});
		// One running, one completed.
		storage.recordExecution({ taskId: task.id, startedAt: Date.now() - 7_200_000, status: "running" });
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			endedAt: Date.now(),
			exitCode: 0,
			status: "success",
		});

		const running = storage.getRunningExecutions();
		expect(running.length).toBe(1);
		expect(running[0]!.taskName).toBe("demo");
		expect(running[0]!.status).toBe("running");
	});

	test("a stuck running execution can be marked failed (the --fix repair)", () => {
		const task = storage.addTask({
			name: "stuck-demo",
			cron: "0 9 * * *",
			command: "sleep 9999",
			status: "active",
			consecutiveFailures: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});
		const exec = storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() - 7_200_000, // 2h ago, no end
			status: "running",
		});

		// Simulate the doctor's repair.
		storage.updateExecution(exec.id, {
			status: "failure",
			endedAt: Date.now(),
			stderr: "Marked failed by `gateway doctor --fix` (orphaned running execution).",
		});

		expect(storage.getRunningExecutions().length).toBe(0);
		const after = storage.getExecutions(task.id, 10).find(e => e.id === exec.id);
		expect(after?.status).toBe("failure");
		expect(after?.stderr).toContain("doctor --fix");
	});
});

describe("runDoctor --fix autonomously repairs (real fix closure, real DB)", () => {
	let dir: string;
	let dbPath: string;
	let cfgPath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-doctor-e2e-"));
		dbPath = path.join(dir, "scheduler.db");
		cfgPath = path.join(dir, "gateway.json");
		await Bun.write(cfgPath, JSON.stringify({ channels: {}, agent: { timeoutMs: 120000 } }));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("detects a stuck execution, then applyFixes marks it failed in the DB", async () => {
		// Seed a genuinely orphaned execution (2h old, no end).
		let execId: string;
		{
			const seed = new SchedulerDbStorage(dbPath);
			try {
				const task = seed.addTask({
					name: "e2e-stuck",
					cron: "0 9 * * *",
					command: "sleep 9999",
					status: "active",
					consecutiveFailures: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					runCount: 0,
					failCount: 0,
				});
				execId = seed.recordExecution({
					taskId: task.id,
					startedAt: Date.now() - 7_200_000,
					status: "running",
				}).id;
			} finally {
				seed.close();
			}
		}

		// Run the REAL doctor against the temp DB via the test seam.
		const report = await runDoctor(cfgPath, { schedulerDbPath: dbPath });
		const sched = report.sections.find(s => s.name === "SCHEDULER")!;
		const stuckFinding = sched.findings.find(f => f.message.includes("stuck in"));
		expect(stuckFinding).toBeDefined();
		expect(stuckFinding!.fix).toBeDefined();

		// Drive the ACTUAL fix closure (not a simulation).
		const applied = await applyFixes(report);
		expect(applied.some(a => a.includes("Marked 1 stuck execution"))).toBe(true);

		// Verify the repair persisted to the real DB.
		const verify = new SchedulerDbStorage(dbPath);
		try {
			expect(verify.getRunningExecutions().length).toBe(0);
			const row = verify.getExecutions(verify.getTaskByName("e2e-stuck")!.id, 10).find(e => e.id === execId);
			expect(row?.status).toBe("failure");
			expect(row?.stderr).toContain("doctor --fix");
		} finally {
			verify.close();
		}
	});

	test("re-running after fix reports no stuck executions (idempotent)", async () => {
		// Seed + fix once.
		{
			const seed = new SchedulerDbStorage(dbPath);
			try {
				const task = seed.addTask({
					name: "e2e-stuck-2",
					cron: "0 9 * * *",
					command: "sleep 9999",
					status: "active",
					consecutiveFailures: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					runCount: 0,
					failCount: 0,
				});
				seed.recordExecution({ taskId: task.id, startedAt: Date.now() - 7_200_000, status: "running" });
			} finally {
				seed.close();
			}
		}
		await applyFixes(await runDoctor(cfgPath, { schedulerDbPath: dbPath }));

		// Second run must find nothing to fix.
		const report2 = await runDoctor(cfgPath, { schedulerDbPath: dbPath });
		const sched2 = report2.sections.find(s => s.name === "SCHEDULER")!;
		expect(sched2.findings.some(f => f.message.includes("stuck in"))).toBe(false);
		expect(countBySeverity(report2).fixable).toBe(0);
	});
});

describe("applyFixes", () => {
	test("returns empty when no finding carries a fix", async () => {
		const report: DoctorReport = {
			generatedAt: Date.now(),
			sections: [{ name: "CONFIG", findings: [{ severity: "ok", message: "fine" }] }],
		};
		const applied = await applyFixes(report);
		expect(applied).toEqual([]);
	});

	test("invokes each fix and collects its description", async () => {
		let called = 0;
		const report: DoctorReport = {
			generatedAt: Date.now(),
			sections: [
				{
					name: "STATE FILES",
					findings: [
						{
							severity: "warn",
							message: "stale thing",
							fix: async () => {
								called++;
								return "cleaned 1 thing";
							},
						},
					],
				},
			],
		};
		const applied = await applyFixes(report);
		expect(called).toBe(1);
		expect(applied).toEqual(["cleaned 1 thing"]);
	});
});
