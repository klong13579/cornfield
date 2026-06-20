import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir, setConfigRootDir } from "@oh-my-pi/pi-utils";
import { buildSystemPrompt } from "../src/system-prompt";

/**
 * Contract: buildSystemPrompt injects the user's declarative persona from
 * `~/.omp/user.md` (user-level configRoot) into a `<user>` block, and omits it when absent.
 *
 * Isolation: `setConfigRootDir(tempDir)` repoints getConfigRootDir() at a per-test temp
 * directory; cwd is also the temp dir so AGENTS.md / context discovery is empty.
 */
let tmpDir: string;
let originalAgentDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-user-test-"));
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

describe("buildSystemPrompt — user persona injection", () => {
	test("injects <user> block when user.md exists", async () => {
		await Bun.write(path.join(tmpDir, "user.md"), "# User\n\n## basics\n- name: 彭梦龙\n- role: GM\n");
		const rendered = await buildSystemPrompt({ cwd: tmpDir, toolNames: [] });
		expect(rendered).toContain("<user>");
		expect(rendered).toContain("彭梦龙");
		expect(rendered).toContain("</user>");
	});

	test("renders empty-state <user> block when user.md is absent", async () => {
		const rendered = await buildSystemPrompt({ cwd: tmpDir, toolNames: [] });
		expect(rendered).toContain("<user>");
		expect(rendered).toContain("No user persona is on file");
		expect(rendered).not.toContain("彭梦龙");
	});
});
