/**
 * Configuration loading + setup wizard tests.
 *
 * `config.test.ts` covers loadConfig / getConfigPath / getDataDir /
 * getDingTalkConfig and the env-var resolution contract.
 * `setup.test.ts` covered the wizard's non-interactive fast-path and
 * `validateAndNormalizeConfig` (also in config.ts). Both live in
 * config.ts, so they are co-located here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ZodError } from "zod";
import { getConfigPath, getDataDir, getDingTalkConfig, loadConfig, validateAndNormalizeConfig } from "../src/config";
import { runInteractiveSetup } from "../src/setup";

// ---------------------------------------------------------------------------
// loadConfig / getConfigPath / getDataDir / getDingTalkConfig
// ---------------------------------------------------------------------------

describe("config", () => {
	it("returns default config when file does not exist", async () => {
		const config = await loadConfig("/nonexistent/path.json");
		expect(config.channels).toEqual({});
		expect(config.agent?.ompPath).toBe("omp");
		expect(config.session?.idleTimeoutMinutes).toBe(240);
	});

	it("resolves config path in home directory", () => {
		const path = getConfigPath();
		expect(path).toContain(".omp/gateway.json");
	});

	it("resolves data dir", () => {
		const dir = getDataDir();
		expect(dir).toContain(".omp/gateway-data");
	});

	it("resolves DingTalk appSecret env references", () => {
		const previous = process.env.PI_GATEWAY_TEST_SECRET;
		process.env.PI_GATEWAY_TEST_SECRET = "resolved-secret";
		try {
			const config = getDingTalkConfig({
				channels: {
					dingtalk: { enabled: true, appKey: "app", appSecret: "$PI_GATEWAY_TEST_SECRET" },
				},
			});
			expect(config?.appSecret).toBe("resolved-secret");
		} finally {
			if (previous === undefined) {
				delete process.env.PI_GATEWAY_TEST_SECRET;
			} else {
				process.env.PI_GATEWAY_TEST_SECRET = previous;
			}
		}
	});

	it("rejects missing DingTalk appSecret env references", () => {
		const previous = process.env.PI_GATEWAY_MISSING_SECRET;
		delete process.env.PI_GATEWAY_MISSING_SECRET;
		try {
			const config = getDingTalkConfig({
				channels: {
					dingtalk: { enabled: true, appKey: "app", appSecret: "$PI_GATEWAY_MISSING_SECRET" },
				},
			});
			expect(config).toBeNull();
		} finally {
			if (previous !== undefined) process.env.PI_GATEWAY_MISSING_SECRET = previous;
		}
	});
});

// ---------------------------------------------------------------------------
// runInteractiveSetup (non-interactive fast path; interactive path is QA'd)
// ---------------------------------------------------------------------------

describe("runInteractiveSetup", () => {
	let tmpDir: string;
	let configPath: string;
	let savedHome: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-setup-test-"));
		configPath = path.join(tmpDir, "gateway.json");
		// loadConfig does not consult HOME for the path argument, but keep
		// HOME stable so downstream code that does (e.g. ensureAgentDir)
		// doesn't leak into the user's real ~/.omp.
		savedHome = process.env.HOME;
		process.env.HOME = tmpDir;
	});

	afterEach(async () => {
		process.env.HOME = savedHome;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns non-interactive when --non-interactive is set", async () => {
		const result = await runInteractiveSetup({ configPath, nonInteractive: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non-interactive");
		}
	});

	it("returns non-interactive when stdin is not a TTY (e.g. piped)", async () => {
		// bun:test / node pipes stdin in test contexts; `process.stdin.isTTY` is undefined.
		const result = await runInteractiveSetup({ configPath });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("non-interactive");
		}
	});

	it("does not write the config file in non-interactive mode", async () => {
		await runInteractiveSetup({ configPath, nonInteractive: true });
		// File should not exist; wizard was a no-op.
		const exists = await fs
			.access(configPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateAndNormalizeConfig (write-path is strict; data-loss guard)
// ---------------------------------------------------------------------------

describe("validateAndNormalizeConfig", () => {
	it("accepts a well-formed dingtalk config and normalizes cron defaults", () => {
		const r = validateAndNormalizeConfig({
			channels: {
				dingtalk: {
					enabled: true,
					accounts: { ops: { appKey: "k1", appSecret: "s1" } },
				},
			},
		});
		expect(r.channels.dingtalk?.accounts?.ops?.appKey).toBe("k1");
		expect(r.cron.tickIntervalMs).toBe(60_000);
	});

	it("rejects an account with a missing appKey (write path is strict)", () => {
		// This is the data-loss guard: the wizard must not write a config
		// whose accounts the gateway cannot read. loadConfig remains
		// lenient on its own; see config.ts comment.
		expect(() =>
			validateAndNormalizeConfig({
				channels: {
					dingtalk: {
						accounts: { bad: { appSecret: "x" } },
					},
				},
			}),
		).toThrow(ZodError);
	});

	it("accepts an empty config and fills in defaults", () => {
		const r = validateAndNormalizeConfig({});
		expect(r.cron.tickIntervalMs).toBe(60_000);
		expect(r.agent.ompPath).toBeDefined();
	});
});
