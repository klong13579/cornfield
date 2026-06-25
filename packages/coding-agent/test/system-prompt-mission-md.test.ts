/**
 * Contract: buildSystemPrompt suppresses the hardcoded <role> when mission.md
 * is present in contextFiles, letting mission.md + SYSTEM.md define the
 * agent's identity without conflicting with the default "Distinguished
 * staff engineer" role.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir, setConfigRootDir } from "@oh-my-pi/pi-utils";
import { buildSystemPrompt } from "../src/system-prompt";

const HARDCODED_ROLE = "Distinguished staff engineer";

let tmpDir: string;
let originalAgentDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-mission-test-"));
	originalAgentDir = (await import("@oh-my-pi/pi-utils")).getAgentDir();
	originalEnv = process.env.PI_CODING_AGENT_DIR;
	setConfigRootDir(tmpDir);
	setAgentDir(tmpDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (originalEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalEnv;
	}
	setConfigRootDir(undefined);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildSystemPrompt — mission.md role suppression", () => {
	test("suppresses hardcoded role when mission.md is in contextFiles", async () => {
		const rendered = await buildSystemPrompt({
			cwd: tmpDir,
			toolNames: [],
			contextFiles: [
				{ path: path.join(tmpDir, "mission.md"), content: "# 助手\n\n你是一个企业内部助手。" },
			],
		});
		expect(rendered).toContain("<role>");
		expect(rendered).toContain("mission.md");
		expect(rendered).not.toContain(HARDCODED_ROLE);
	});

	test("keeps hardcoded role when mission.md is absent", async () => {
		const rendered = await buildSystemPrompt({
			cwd: tmpDir,
			toolNames: [],
			contextFiles: [],
		});
		expect(rendered).toContain("<role>");
		expect(rendered).toContain(HARDCODED_ROLE);
	});
});
