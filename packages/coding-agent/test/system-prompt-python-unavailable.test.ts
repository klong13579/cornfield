import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir, setConfigRootDir } from "@cornfield/utils";
import { buildSystemPrompt } from "../src/system-prompt";

/**
 * Contract: when the Python preflight fails, the session prompt states that the
 * `python` tool is missing, why, and what to use instead.
 *
 * Why: the failure used to be a log line only. The model cannot ask for a tool it
 * has no entry for, and non-interactive surfaces (gateway sessions) silence
 * console logging entirely — so the capability vanished with no observer. That
 * cost one agent six weeks of Python execution before anyone noticed.
 */
let tmpDir: string;
let originalAgentDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-python-unavailable-"));
	originalAgentDir = (await import("@cornfield/utils")).getAgentDir();
	originalEnv = process.env.CORNFIELD_AGENT_DIR;
	setConfigRootDir(tmpDir);
	setAgentDir(tmpDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (originalEnv === undefined) {
		delete process.env.CORNFIELD_AGENT_DIR;
	} else {
		process.env.CORNFIELD_AGENT_DIR = originalEnv;
	}
	setConfigRootDir(undefined);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildSystemPrompt — python unavailable notice", () => {
	test("carries the preflight reason and the bash fallback when python is unavailable", async () => {
		const reason =
			"None of the 2 Python interpreter(s) available here provides kernel_gateway + ipykernel " +
			"(checked: /tmp/work/.venv/bin/python, /tmp/home/.cornfield/python-env/bin/python). " +
			"Install for the interpreter this project uses: /tmp/work/.venv/bin/python -m pip install " +
			"jupyter_kernel_gateway ipykernel";

		const rendered = await buildSystemPrompt({
			cwd: tmpDir,
			toolNames: [],
			pythonUnavailable: { pythonPath: "/tmp/work/.venv/bin/python", reason },
		});

		expect(rendered).toContain("### Python unavailable");
		expect(rendered).toContain(reason);
		expect(rendered).toContain("Do Python work through `bash` instead");
	});

	test("omits the notice when the preflight did not fail", async () => {
		const rendered = await buildSystemPrompt({ cwd: tmpDir, toolNames: [] });

		expect(rendered).not.toContain("Python unavailable");
	});
});
