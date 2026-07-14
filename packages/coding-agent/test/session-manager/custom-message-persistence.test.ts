import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFile, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

describe("custom_message persistence", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-custom-msg-persist-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("persists a display:true custom_message even before the first assistant message", async () => {
		// Reproduces the moa-extension regression: a slash command emits a
		// visible custom message in a session that has not yet produced any LLM
		// output. The session file must be flushed so the custom message survives
		// resume / reopen.
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendCustomMessageEntry("moa-result", "## MOA Run\n- workers: 3/3", true);
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		const customEntries = entries.filter(
			(e): e is { type: "custom_message"; customType: string } =>
				typeof e === "object" && e !== null && "type" in e && (e as { type: unknown }).type === "custom_message",
		);
		expect(customEntries).toHaveLength(1);
		expect(customEntries[0]?.customType).toBe("moa-result");
	});

	it("does not persist a display:false custom_message when no assistant message exists", async () => {
		// display:false custom messages are internal (e.g. tool-call prompts).
		// A session that contains only those should not create a file — it never
		// produced user-visible output.
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendCustomMessageEntry("skill-prompt", "internal", false);
		await session.flush();

		const sessionFile = session.getSessionFile();
		// The session file should not have been created — no visible content.
		if (sessionFile) {
			const exists = fs.existsSync(sessionFile);
			expect(exists).toBe(false);
		}
	});
});
