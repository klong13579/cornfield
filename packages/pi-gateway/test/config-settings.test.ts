/**
 * Tests for `config-settings.ts` — the per-account `disabledExtensions` resolver
 * that the gateway uses to filter the IM skill picker.
 *
 * We use temp dirs for both the user-level and project-level config files
 * (with PI_CONFIG_DIR override) to avoid touching real user state. The
 * production code reads `<homedir>/<configDirName>/agent/config.yml` and
 * `<agentDir>/.omp/config.yml` — we use the same paths under temp dirs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveDisabledExtensions } from "../src/config-settings";

let homeDir: string;
let agentDir: string;
let savedConfigDir: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cfg-home-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cfg-agent-"));
	// PI_CONFIG_DIR can be absolute (skips <home>), so point it at the temp
	// home dir to fully isolate from real user state. Restore in afterEach.
	savedConfigDir = process.env.PI_CONFIG_DIR;
	process.env.PI_CONFIG_DIR = homeDir;
	savedHome = process.env.HOME;
	process.env.HOME = homeDir;
});

afterEach(async () => {
	if (savedConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = savedConfigDir;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	await fs.rm(homeDir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function writeUserConfig(content: string): Promise<void> {
	await fs.mkdir(path.join(homeDir, "agent"), { recursive: true });
	await Bun.write(path.join(homeDir, "agent", "config.yml"), content);
}

async function writeProjectConfig(content: string): Promise<void> {
	await fs.mkdir(path.join(agentDir, ".omp"), { recursive: true });
	await Bun.write(path.join(agentDir, ".omp", "config.yml"), content);
}

describe("resolveDisabledExtensions", () => {
	test("returns [] when neither user nor project config exists", async () => {
		expect(await resolveDisabledExtensions(agentDir)).toEqual([]);
	});

	test("returns [] when configs exist but have no disabledExtensions field", async () => {
		await writeUserConfig("defaultThinkingLevel: high\n");
		await writeProjectConfig("defaultThinkingLevel: low\n");
		expect(await resolveDisabledExtensions(agentDir)).toEqual([]);
	});

	test("reads user-level disabledExtensions", async () => {
		await writeUserConfig(
			"disabledExtensions:\n  - skill:superpowers:test-driven-development\n  - skill:remember:remember\n",
		);
		const result = await resolveDisabledExtensions(agentDir);
		expect(result).toEqual(["skill:superpowers:test-driven-development", "skill:remember:remember"]);
	});

	test("reads project-level disabledExtensions", async () => {
		await writeProjectConfig(
			"disabledExtensions:\n  - skill:superpowers:brainstorming\n  - slash-command:ralph-loop:ralph-loop\n",
		);
		const result = await resolveDisabledExtensions(agentDir);
		expect(result).toEqual(["skill:superpowers:brainstorming", "slash-command:ralph-loop:ralph-loop"]);
	});

	test("merges user + project, dedup-preserving user-first order", async () => {
		await writeUserConfig("disabledExtensions:\n  - skill:a\n  - skill:b\n  - skill:c\n");
		await writeProjectConfig("disabledExtensions:\n  - skill:b\n  - skill:d\n");
		const result = await resolveDisabledExtensions(agentDir);
		// User first (a, b, c), then project-only additions (d); b not duplicated.
		expect(result).toEqual(["skill:a", "skill:b", "skill:c", "skill:d"]);
	});

	test("ignores non-string entries in the array (defensive parse)", async () => {
		await writeUserConfig("disabledExtensions:\n  - skill:valid\n  - 42\n  - null\n  - skill:also-valid\n");
		const result = await resolveDisabledExtensions(agentDir);
		expect(result).toEqual(["skill:valid", "skill:also-valid"]);
	});

	test("tolerates malformed yaml without throwing", async () => {
		await writeUserConfig("disabledExtensions: [unclosed bracket\n");
		// Should not throw — return [] on parse error.
		const result = await resolveDisabledExtensions(agentDir);
		expect(result).toEqual([]);
	});

	test("treats non-object yaml as empty", async () => {
		await writeUserConfig("- just a list\n- not a mapping\n");
		const result = await resolveDisabledExtensions(agentDir);
		expect(result).toEqual([]);
	});
});
