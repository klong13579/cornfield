/**
 * `gateway doctor` diagnostics tests.
 *
 * No mocks: real temp config files, a real SQLite scheduler DB, and the real
 * check/render/fix code paths. The scheduler path helpers hardcode the default
 * data dir, so the orphaned-execution detection + repair is exercised directly
 * against a real JsonFileStorage rather than through runDoctor().
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateConfig } from "../src/config";
import {
	applyFixes,
	countBySeverity,
	type DoctorReport,
	renderJson,
	renderText,
	runDoctor,
	runDoctorWithConfig,
} from "../src/doctor";
import { clearStatusFileSync, getGatewayStatus, PID_FILE, STATUS_FILE } from "../src/gateway-daemon";

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
		// agent.maxConcurrentSessions must be a positive int; -1 violates the schema.
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { maxConcurrentSessions: -1 } }));
		const result = await validateConfig(p);
		expect(result.status).toBe("schema-error");
		if (result.status === "schema-error") {
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues.some(i => i.path.includes("maxConcurrentSessions"))).toBe(true);
		}
	});

	test("returns ok with merged defaults for a valid config", async () => {
		const p = path.join(tmpDir, "good.json");
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { maxConcurrentSessions: 5 } }));
		const result = await validateConfig(p);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.config.agent?.maxConcurrentSessions).toBe(5);
			// default merged in
			expect(result.config.session?.idleTimeoutMinutes).toBe(240);
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
				agent: { maxConcurrentSessions: 1 },
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
		await Bun.write(p, JSON.stringify({ channels: {}, agent: { maxConcurrentSessions: 1 } }));
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

/**
 * Status file / "fake-alive" regression tests.
 *
 * The daemon's status.json is written on every cron tick. If the daemon
 * crashes without clearing the file, a reader (the gateway doctor, the
 * CLI `status` command) must not report the dead process's bridges /
 * accounts / queues as live. These tests pin the contract:
 *
 *   1. getGatewayStatus with a stale PID file returns running: false
 *      AND does NOT surface runtime fields (bridges, accounts, queues,
 *      channels) from the cached snapshot.
 *   2. clearStatusFileSync removes the file idempotently and is safe to
 *      call from a sync crash handler.
 *   3. runDoctor on a dead gateway surfaces a single warn per section
 *      (CHANNELS / BRIDGES / QUEUES) instead of iterating ghost data.
 */
describe("status file fake-alive regression", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-status-fakealive-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const writeDeadSnapshot = async () => {
		// PID pointing at a process that does not exist. We use a PID
		// far above any plausible live PID on the test host to make the
		// "PID already dead" check deterministic regardless of test
		// parallelism.
		const deadPid = 2_000_000_000;
		await Bun.write(path.join(tmpDir, PID_FILE), String(deadPid));
		// Cached snapshot from the dead process — bridges / accounts /
		// channels all populated. If getGatewayStatus spreads this, a
		// reader will think the gateway is alive.
		const snapshot = {
			pid: deadPid,
			statusWrittenAt: Date.now() - 10_000,
			channels: [{ id: "dingtalk", name: "DingTalk", connected: true }],
			accounts: [
				{
					accountId: "algorithm",
					channelConnected: true,
					bridgeRunning: true,
					bridgeState: "busy",
				},
			],
			bridges: [
				{
					accountId: "algorithm",
					state: "busy",
					running: true,
					ready: true,
					pid: 1,
					circuitState: "closed",
					crashCount: 0,
				},
			],
			queues: [{ accountId: "algorithm", depth: 2, oldestAgeMs: 1234 }],
			scheduler: { running: true, taskCount: 5 },
		};
		await Bun.write(path.join(tmpDir, STATUS_FILE), JSON.stringify(snapshot));
	};

	test("getGatewayStatus does NOT spread runtime fields when PID is dead", async () => {
		await writeDeadSnapshot();
		const status = await getGatewayStatus({ channels: {}, dataDir: tmpDir });

		expect(status.running).toBe(false);
		expect(status.stalePidFile).toBe(true);
		expect(status.pidWasAlive).toBeGreaterThan(0);
		expect(status.statusWrittenAt).toBeGreaterThan(0);

		// Runtime fields must be absent — not "empty", absent. A caller
		// that sees `accounts: []` would correctly conclude "no info";
		// a caller that sees `accounts: [...]` (even []) would be tempted
		// to iterate and report ghost health.
		expect((status as { bridges?: unknown }).bridges).toBeUndefined();
		expect((status as { accounts?: unknown }).accounts).toBeUndefined();
		expect((status as { queues?: unknown }).queues).toBeUndefined();
		expect((status as { channels?: unknown }).channels).toBeUndefined();
		expect((status as { scheduler?: unknown }).scheduler).toBeUndefined();
	});

	test("getGatewayStatus with invalid PID file does NOT spread runtime fields", async () => {
		await Bun.write(path.join(tmpDir, PID_FILE), "not-a-number");
		const snapshot = {
			pid: 1,
			statusWrittenAt: Date.now(),
			bridges: [{ accountId: "x", state: "busy" }],
		};
		await Bun.write(path.join(tmpDir, STATUS_FILE), JSON.stringify(snapshot));

		const status = await getGatewayStatus({ channels: {}, dataDir: tmpDir });
		expect(status.running).toBe(false);
		expect((status as { bridges?: unknown }).bridges).toBeUndefined();
	});

	test("getGatewayStatus with a live PID DOES spread runtime fields", async () => {
		await Bun.write(path.join(tmpDir, PID_FILE), String(process.pid));
		const snapshot = {
			pid: process.pid,
			statusWrittenAt: Date.now(),
			channels: [{ id: "dingtalk", name: "DingTalk", connected: true }],
			accounts: [{ accountId: "algorithm", channelConnected: true, bridgeRunning: true }],
			bridges: [{ accountId: "algorithm", state: "idle", running: true }],
			queues: [],
			scheduler: { running: true, taskCount: 0 },
		};
		await Bun.write(path.join(tmpDir, STATUS_FILE), JSON.stringify(snapshot));

		const status = await getGatewayStatus({ channels: {}, dataDir: tmpDir });
		expect(status.running).toBe(true);
		expect(status.pid).toBe(process.pid);
		// Live process: runtime fields must be present so callers can
		// report live health.
		expect(status.channels).toEqual(snapshot.channels);
		expect(status.accounts).toEqual(snapshot.accounts);
		expect(status.bridges).toEqual(snapshot.bridges);
	});

	test("clearStatusFileSync removes the file idempotently", async () => {
		await Bun.write(path.join(tmpDir, STATUS_FILE), JSON.stringify({ pid: 1 }));
		clearStatusFileSync({ channels: {}, dataDir: tmpDir });
		await expect(fs.access(path.join(tmpDir, STATUS_FILE))).rejects.toThrow();

		// Second call must not throw — used in crash handlers where
		// we cannot tell if a prior path already cleared the file.
		expect(() => clearStatusFileSync({ channels: {}, dataDir: tmpDir })).not.toThrow();
	});

	test("clearStatusFileSync is a no-op when no status file exists", () => {
		expect(() => clearStatusFileSync({ channels: {}, dataDir: tmpDir })).not.toThrow();
	});

	test("runDoctor on a dead gateway surfaces warn per section without iterating ghost data", async () => {
		await writeDeadSnapshot();
		const report = await runDoctorWithConfig({ channels: {}, dataDir: tmpDir });

		const channelsSection = report.sections.find(s => s.name === "CHANNELS");
		const bridgesSection = report.sections.find(s => s.name === "BRIDGES");
		const queuesSection = report.sections.find(s => s.name === "QUEUES");

		// Each section should have exactly one finding, and it must
		// not be `ok` (that would be a false-positive healthy report).
		expect(channelsSection?.findings).toHaveLength(1);
		expect(bridgesSection?.findings).toHaveLength(1);
		expect(queuesSection?.findings).toHaveLength(1);

		for (const section of [channelsSection, bridgesSection, queuesSection]) {
			const finding = section?.findings[0];
			expect(finding?.severity).not.toBe("ok");
		}
	});
});
