/**
 * Tests for the interactive setup wizard.
 *
 * Covers the non-interactive fast-path (which is the only one we can drive
 * without a real TTY). The interactive path is covered by manual QA via
 * `omp gateway setup`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ZodError } from "zod";
import { validateAndNormalizeConfig } from "../src/config";
import { runInteractiveSetup } from "../src/setup";

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
