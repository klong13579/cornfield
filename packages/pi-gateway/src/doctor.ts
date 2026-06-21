/**
 * `gateway doctor` — health check + diagnostics for the unified gateway.
 *
 * Design intent (see docs/gateway-design-v1.md §10–11):
 *
 * The gateway already computes rich health signals — agent-bridge circuit/crash
 * state, per-account inbound queue depth, DingTalk reconnect/received/processed
 * counters, credential resolution — but until now they were locked inside the
 * daemon process and never surfaced. `loadConfig` even swallows config errors
 * and falls back to defaults, so a malformed config looks like "no config".
 *
 * The doctor's job is to make the truth observable and actionable. It reads the
 * status file the running gateway writes (channels/accounts/bridges/queues),
 * re-validates the config WITHOUT swallowing (via `validateConfig`), probes
 * credential resolution, and inspects the scheduler DB + state files directly.
 *
 * It is deliberately NOT a config-migration system (cf. OpenClaw's doctor): our
 * schema is young and has no legacy-key debt. `--fix` only performs unambiguous,
 * non-destructive repairs (clear stale PID files, fail orphaned executions).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkCredentials } from "./credential-resolver";
import { getDataDir, validateConfig } from "./config";
import { getGatewayStatus, PID_FILE, STATUS_FILE } from "./gateway";
import { getServiceStatus } from "./service-installer";
import {
	getGatewayPidPath,
	getSchedulerDbPath,
	getSchedulerDir,
	getSchedulerPidPath,
	isDaemonRunning,
	SchedulerDbStorage,
	validateCron,
} from "./scheduler";
import type { GatewayConfig } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Check framework
// ───────────────────────────────────────────────────────────────────────────

export type Severity = "ok" | "warn" | "error";

/**
 * A single diagnostic finding. `fix`, when present, is a safe repair the doctor
 * can apply under `--fix`; it returns a human-readable description of what it
 * did. Findings with severity "ok" never carry a fix.
 */
export interface Finding {
	severity: Severity;
	message: string;
	/** Optional secondary line(s) with detail, indented under the message. */
	detail?: string;
	/** Safe, idempotent repair. Presence implies the finding is fixable. */
	fix?: () => Promise<string>;
}

export interface Section {
	name: string;
	findings: Finding[];
}

export interface DoctorReport {
	sections: Section[];
	generatedAt: number;
}

function ok(message: string, detail?: string): Finding {
	return { severity: "ok", message, detail };
}
function warn(message: string, detail?: string, fix?: () => Promise<string>): Finding {
	return { severity: "warn", message, detail, fix };
}
function error(message: string, detail?: string, fix?: () => Promise<string>): Finding {
	return { severity: "error", message, detail, fix };
}

// ───────────────────────────────────────────────────────────────────────────
// Individual check sections
// ───────────────────────────────────────────────────────────────────────────

async function checkConfig(configPath?: string): Promise<{ section: Section; config?: GatewayConfig }> {
	const findings: Finding[] = [];
	const result = await validateConfig(configPath);

	switch (result.status) {
		case "missing":
			findings.push(error(`Config file not found: ${result.path}`, "Run `pi-gateway setup` to create one."));
			return { section: { name: "CONFIG", findings } };
		case "parse-error":
			findings.push(error(`Config file is not valid JSON5: ${result.path}`, result.error));
			return { section: { name: "CONFIG", findings } };
		case "schema-error":
			findings.push(error(`Config failed schema validation: ${result.path}`));
			for (const issue of result.issues) {
				findings.push(error(`  ${issue.path}: ${issue.message}`));
			}
			return { section: { name: "CONFIG", findings } };
	}

	const config = result.config;
	findings.push(ok(`${result.path} valid`));

	// agent.timeoutMs — the root cause of the RPC-timeout incident. The default
	// is 120s; interactive cron-creation can exceed that, so flag when unset.
	if (config.agent?.timeoutMs == null) {
		findings.push(
			warn(
				"agent.timeoutMs not set (defaults to 120000ms)",
				"Long agent turns (e.g. interactive cron creation) can exceed 120s and surface as an RPC timeout. Consider setting agent.timeoutMs.",
			),
		);
	} else {
		findings.push(ok(`agent.timeoutMs = ${config.agent.timeoutMs}ms`));
	}

	// DingTalk accounts: count + secret-resolution sanity. validateConfig only
	// checks schema shape; here we report account count and surface $ENV refs
	// whose env var is missing (which would make getDingTalkConfig return null).
	const dingtalk = config.channels?.dingtalk as
		| { accounts?: Record<string, { appKey?: string; appSecret?: string }>; appKey?: string; appSecret?: string }
		| undefined;
	if (!dingtalk) {
		findings.push(warn("No DingTalk channel configured"));
	} else {
		const accounts = dingtalk.accounts ?? {};
		const accountIds = Object.keys(accounts);
		const hasTopLevel = !!dingtalk.appKey;
		const total = accountIds.length + (hasTopLevel ? 1 : 0);
		if (total === 0) {
			findings.push(warn("DingTalk channel present but no accounts configured"));
		} else {
			findings.push(ok(`${total} DingTalk account(s) configured`));
		}
		// Unresolved $ENV secret refs.
		const entries: Array<[string, { appSecret?: string }]> = [
			...accountIds.map(id => [id, accounts[id]!] as [string, { appSecret?: string }]),
			...(hasTopLevel ? ([["(top-level)", dingtalk]] as Array<[string, { appSecret?: string }]>) : []),
		];
		for (const [id, acct] of entries) {
			const secret = acct.appSecret;
			if (secret && secret.startsWith("$")) {
				const envName = secret.slice(1);
				if (!process.env[envName]) {
					findings.push(
						error(
							`Account "${id}" appSecret references $${envName} but that env var is unset`,
							"The account will fail to start until the variable is exported.",
						),
					);
				}
			}
		}
	}

	return { section: { name: "CONFIG", findings }, config };
}

async function checkCredentialsSection(config?: GatewayConfig): Promise<Section> {
	const findings: Finding[] = [];

	// ompPath binary must exist and be runnable for agent tasks/RPC.
	const ompPath = config?.agent?.ompPath ?? "omp";
	if (ompPath === "omp" || !ompPath.includes("/")) {
		findings.push(ok(`ompPath: "${ompPath}" (resolved from PATH at spawn time)`));
	} else {
		try {
			await fs.access(ompPath, (await import("node:fs")).constants.X_OK);
			findings.push(ok(`ompPath: ${ompPath} exists and is executable`));
		} catch {
			findings.push(error(`ompPath: ${ompPath} not found or not executable`));
		}
	}

	const cred = checkCredentials();
	if (!cred.modelsYmlFound) {
		findings.push(warn("~/.omp/agent/models.yml not found", "No provider→API-key mappings to verify."));
	}
	if (!cred.agentDbFound) {
		findings.push(warn("~/.omp/agent/agent.db not found", "Stored credentials cannot be resolved; run `omp login`."));
	}
	if (cred.providers.length === 0) {
		if (cred.modelsYmlFound) findings.push(ok("No provider API-key references in models.yml"));
	} else {
		for (const p of cred.providers) {
			if (p.source === "missing") {
				findings.push(
					error(
						`Provider "${p.provider}" API key missing (env ${p.envVar} unset, not in agent.db)`,
						"Agent LLM calls for this provider will fail. Run `omp login`.",
					),
				);
			} else {
				findings.push(ok(`Provider "${p.provider}" → resolved from ${p.source}`));
			}
		}
	}

	return { name: "CREDENTIALS", findings };
}

function checkChannelsAndBridges(status: Awaited<ReturnType<typeof getGatewayStatus>>): Section[] {
	const channelFindings: Finding[] = [];
	const bridgeFindings: Finding[] = [];
	const queueFindings: Finding[] = [];

	const accounts = status.accounts ?? [];
	if (!status.running) {
		channelFindings.push(warn("Gateway not running — channel/bridge/queue health is from the last status file"));
	}

	if (accounts.length === 0) {
		channelFindings.push(warn("No account channels reported in status file"));
	}
	for (const acc of accounts) {
		const h = acc.channelHealth;
		if (acc.channelConnected) {
			const meta = h
				? ` (recv=${h.receivedCount}, processed=${h.processedCount}, reconnects=${h.reconnectAttempts})`
				: "";
			channelFindings.push(ok(`${acc.accountId}: connected${meta}`));
		} else {
			const reason = h?.connectionFailed
				? "connection failed (check appKey/appSecret)"
				: "disconnected";
			const detail = h ? `reconnectAttempts=${h.reconnectAttempts}` : undefined;
			channelFindings.push(error(`${acc.accountId}: ${reason}`, detail));
		}
	}

	// Bridges
	const bridges = status.bridges ?? [];
	if (bridges.length === 0 && status.running) {
		bridgeFindings.push(ok("No agent bridges active"));
	}
	for (const b of bridges) {
		if (b.crashSuppressed || b.state === "error") {
			bridgeFindings.push(
				error(
					`${b.accountId}: ${b.state} (crash-suppressed)`,
					`crashes=${b.crashCount}, lastError=${b.lastError ?? "n/a"}`,
				),
			);
		} else if (b.circuitState === "open") {
			bridgeFindings.push(
				error(`${b.accountId}: circuit OPEN`, `failures=${b.circuitFailures}, lastError=${b.lastError ?? "n/a"}`),
			);
		} else if (b.state === "degraded" || b.circuitState === "half-open") {
			bridgeFindings.push(
				warn(`${b.accountId}: ${b.state} (circuit ${b.circuitState})`, `lastError=${b.lastError ?? "n/a"}`),
			);
		} else {
			bridgeFindings.push(ok(`${b.accountId}: ${b.state} (circuit ${b.circuitState}, crashes=${b.crashCount})`));
		}
	}

	// Queues
	const queues = status.queues ?? [];
	const MAX_DEPTH = 100; // DEFAULT_MAX_QUEUE_DEPTH in session-manager
	const STALE_AGE_MS = 5 * 60_000;
	if (queues.length === 0) {
		queueFindings.push(ok("All queues empty"));
	}
	for (const q of queues) {
		if (q.depth >= MAX_DEPTH) {
			queueFindings.push(error(`${q.accountId}: queue FULL (${q.depth}/${MAX_DEPTH})`));
		} else if (q.depth > 0 && q.oldestAgeMs > STALE_AGE_MS) {
			queueFindings.push(
				warn(`${q.accountId}: ${q.depth} queued, oldest ${Math.round(q.oldestAgeMs / 1000)}s old`),
			);
		} else if (q.depth > 0) {
			queueFindings.push(ok(`${q.accountId}: ${q.depth}/${MAX_DEPTH} queued`));
		} else {
			queueFindings.push(ok(`${q.accountId}: empty`));
		}
	}

	return [
		{ name: "CHANNELS", findings: channelFindings },
		{ name: "BRIDGES", findings: bridgeFindings },
		{ name: "QUEUES", findings: queueFindings },
	];
}

function checkScheduler(schedulerDbPath: string): Section {
	const findings: Finding[] = [];
	const dbPath = schedulerDbPath;
	let storage: SchedulerDbStorage | undefined;
	try {
		storage = new SchedulerDbStorage(dbPath);
	} catch (err) {
		findings.push(error(`Scheduler DB unreadable: ${dbPath}`, err instanceof Error ? err.message : String(err)));
		return { name: "SCHEDULER", findings };
	}

	try {
		const tasks = storage.listTasks();
		const active = tasks.filter(t => t.status === "active").length;
		const paused = tasks.filter(t => t.status === "paused").length;
		const disabled = tasks.filter(t => t.status === "disabled").length;
		findings.push(ok(`${tasks.length} task(s): ${active} active, ${paused} paused, ${disabled} disabled`));

		// Invalid cron expressions (croner would auto-disable these).
		for (const t of tasks) {
			if ((t.scheduleType ?? "cron") === "cron") {
				const v = validateCron(t.cron);
				if (!v.valid) {
					findings.push(error(`Task "${t.name}" has invalid cron "${t.cron}"`, v.error));
				}
			}
		}

		// High consecutive failures.
		for (const t of tasks) {
			if (t.consecutiveFailures >= 3) {
				findings.push(
					warn(`Task "${t.name}" has ${t.consecutiveFailures} consecutive failures`, "Check `cron logs`."),
				);
			}
		}

		// Stuck "running" executions — orphaned by a gateway crash. Fixable.
		const running = storage.getRunningExecutions();
		const STUCK_MS = 60 * 60_000; // 1h with no end is almost certainly orphaned
		const now = Date.now();
		const stuck = running.filter(e => now - e.startedAt > STUCK_MS);
		if (stuck.length > 0) {
			const ids = stuck.map(e => e.id);
			const dbPathForFix = dbPath;
			findings.push(
				warn(
					`${stuck.length} execution(s) stuck in "running" state`,
					stuck
						.map(e => `  ${e.taskName}: started ${Math.round((now - e.startedAt) / 60000)}m ago`)
						.join("\n"),
					async () => {
						// Open a fresh handle for the repair (the check's handle is closed in finally).
						const repairDb = new SchedulerDbStorage(dbPathForFix);
						try {
							for (const id of ids) {
								repairDb.updateExecution(id, {
									status: "failure",
									endedAt: Date.now(),
									stderr: "Marked failed by `gateway doctor --fix` (orphaned running execution).",
								});
							}
						} finally {
							repairDb.close();
						}
						return `Marked ${ids.length} stuck execution(s) as failed.`;
					},
				),
			);
		}
	} finally {
		storage.close();
	}

	return { name: "SCHEDULER", findings };
}

async function checkStateFiles(
	config: GatewayConfig | undefined,
	status: Awaited<ReturnType<typeof getGatewayStatus>>,
): Promise<Section> {
	const findings: Finding[] = [];
	const dataDir = getDataDir(config);

	// gateway.pid
	const pidPath = path.join(dataDir, PID_FILE);
	if (status.running) {
		findings.push(ok(`gateway.pid → pid ${status.pid} (alive)`));
	} else if (status.stalePidFile) {
		findings.push(ok("gateway.pid was stale and has been cleared"));
	} else {
		findings.push(ok("gateway.pid absent (gateway stopped)"));
	}
	void pidPath;

	// gateway.status.json staleness.
	const statusPath = path.join(dataDir, STATUS_FILE);
	try {
		await fs.access(statusPath);
		if (status.running && status.statusWrittenAt) {
			const ageMs = Date.now() - status.statusWrittenAt;
			// Refreshed each scheduler tick (~60s); >5 ticks stale is suspicious.
			if (ageMs > 5 * 60_000) {
				findings.push(
					warn(
						`gateway.status.json is ${Math.round(ageMs / 60000)}m stale`,
						"The status refresh loop may be wedged.",
					),
				);
			} else {
				findings.push(ok(`gateway.status.json fresh (${Math.round(ageMs / 1000)}s old)`));
			}
		} else {
			findings.push(ok("gateway.status.json present"));
		}
	} catch {
		if (status.running) findings.push(warn("gateway.status.json missing while gateway is running"));
	}

	// Legacy scheduler.pid: the scheduler now runs inside the gateway, so a
	// standalone scheduler.pid for a dead process is leftover. Fixable.
	const schedulerPidPath = getSchedulerPidPath();
	try {
		await fs.access(schedulerPidPath);
		const aliveStandalone = isDaemonRunning(schedulerPidPath);
		const gatewayPidPath = getGatewayPidPath();
		const sameAsGateway = (await safeRead(schedulerPidPath)) === (await safeRead(gatewayPidPath));
		if (!aliveStandalone && !sameAsGateway) {
			findings.push(
				warn("Stale scheduler.pid (scheduler runs inside the gateway)", undefined, async () => {
					await fs.unlink(schedulerPidPath);
					return "Removed stale scheduler.pid.";
				}),
			);
		}
	} catch {
		// absent — fine
	}

	// sessions.db presence.
	const sessionsDbPath = path.join(dataDir, "sessions.db");
	try {
		await fs.access(sessionsDbPath);
		findings.push(ok("sessions.db present"));
	} catch {
		findings.push(ok("sessions.db absent (created on first session)"));
	}

	// scheduler dir presence.
	const schedDir = getSchedulerDir();
	try {
		await fs.access(schedDir);
	} catch {
		findings.push(warn(`Scheduler dir missing: ${schedDir}`));
	}

	return { name: "STATE FILES", findings };
}

async function checkService(): Promise<Section> {
	const findings: Finding[] = [];
	const svc = await getServiceStatus();
	if (svc.platform === "unsupported") {
		findings.push(ok("System service not supported on this platform"));
		return { name: "SERVICE", findings };
	}
	if (!svc.installed) {
		findings.push(ok(`Not installed as a system service (${svc.platform})`));
		return { name: "SERVICE", findings };
	}
	findings.push(ok(`Installed (${svc.platform})`));
	if (svc.running) {
		findings.push(ok(`Running${svc.pid ? ` (pid ${svc.pid})` : ""}`));
	} else {
		findings.push(
			error("Service installed but not running", "Run `pi-gateway service start`."),
		);
	}
	return { name: "SERVICE", findings };
}

async function safeRead(p: string): Promise<string | null> {
	try {
		return (await fs.readFile(p, "utf-8")).trim();
	} catch {
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestration
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run all checks and return a report.
 *
 * @param configPath  Path to gateway.json (defaults to ~/.omp/gateway.json).
 * @param opts.schedulerDbPath  Override the scheduler DB path. Production passes
 *   nothing and the default `getSchedulerDbPath()` is used; tests pass a temp DB
 *   so the real scheduler check (and its `--fix` repair closure) can be exercised
 *   in isolation without touching the operator's data.
 */
export async function runDoctor(
	configPath?: string,
	opts?: { schedulerDbPath?: string },
): Promise<DoctorReport> {
	const { section: configSection, config } = await checkConfig(configPath);
	const status = await getGatewayStatus(config);

	const [credSection, stateSection, serviceSection] = await Promise.all([
		checkCredentialsSection(config),
		checkStateFiles(config, status),
		checkService(),
	]);
	const cbq = checkChannelsAndBridges(status);
	const schedSection = checkScheduler(opts?.schedulerDbPath ?? getSchedulerDbPath());

	const sections: Section[] = [
		configSection,
		credSection,
		...cbq,
		schedSection,
		stateSection,
		serviceSection,
	];

	return { sections, generatedAt: Date.now() };
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────

const ICON: Record<Severity, string> = { ok: "✅", warn: "⚠️ ", error: "❌" };

export function countBySeverity(report: DoctorReport): { ok: number; warn: number; error: number; fixable: number } {
	let okN = 0;
	let warnN = 0;
	let errorN = 0;
	let fixable = 0;
	for (const s of report.sections) {
		for (const f of s.findings) {
			if (f.severity === "ok") okN++;
			else if (f.severity === "warn") warnN++;
			else errorN++;
			if (f.fix) fixable++;
		}
	}
	return { ok: okN, warn: warnN, error: errorN, fixable };
}

export function renderText(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push(`Gateway Doctor — ${new Date(report.generatedAt).toLocaleString()}`);
	lines.push("");
	for (const section of report.sections) {
		lines.push(section.name);
		if (section.findings.length === 0) {
			lines.push("  (no findings)");
		}
		for (const f of section.findings) {
			lines.push(`  ${ICON[f.severity]} ${f.message}`);
			if (f.detail) {
				for (const dl of f.detail.split("\n")) lines.push(`       ${dl}`);
			}
		}
		lines.push("");
	}
	const c = countBySeverity(report);
	lines.push(`Summary: ${c.error} error(s), ${c.warn} warning(s), ${c.fixable} fixable`);
	if (c.fixable > 0) {
		lines.push("Run `pi-gateway doctor --fix` to apply safe fixes.");
	}
	return lines.join("\n");
}

export function renderJson(report: DoctorReport): string {
	return JSON.stringify(
		{
			generatedAt: report.generatedAt,
			summary: countBySeverity(report),
			sections: report.sections.map(s => ({
				name: s.name,
				findings: s.findings.map(f => ({
					severity: f.severity,
					message: f.message,
					detail: f.detail,
					fixable: !!f.fix,
				})),
			})),
		},
		null,
		2,
	);
}

/**
 * Apply every fixable finding in the report. Returns the descriptions of the
 * repairs performed. Safe to call repeatedly; fixes are idempotent.
 */
export async function applyFixes(report: DoctorReport): Promise<string[]> {
	const applied: string[] = [];
	for (const section of report.sections) {
		for (const f of section.findings) {
			if (f.fix) {
				try {
					applied.push(await f.fix());
				} catch (err) {
					applied.push(`FAILED: ${f.message} — ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}
	return applied;
}
