import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@cornfield/utils";

/**
 * PI_SESSION_NAME fallback: the gateway injects the account id into its
 * wire-stdio children so unnamed sessions are identifiable on the intercom
 * roster instead of showing the anonymous `subagent-chat-…` alias. A name
 * persisted in the session file must always win over the env default.
 */
describe("session name PI_SESSION_NAME fallback", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.CORNFIELD_AGENT_DIR;
	const originalSessionName = process.env.PI_SESSION_NAME;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-name-env-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.CORNFIELD_AGENT_DIR;
		}
		if (originalSessionName === undefined) {
			delete process.env.PI_SESSION_NAME;
		} else {
			process.env.PI_SESSION_NAME = originalSessionName;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("falls back to PI_SESSION_NAME when the session is unnamed", () => {
		process.env.PI_SESSION_NAME = "hr";
		const session = SessionManager.create(cwd);
		expect(session.getSessionName()).toBe("hr");
	});

	it("prefers the persisted session name over the env default", async () => {
		process.env.PI_SESSION_NAME = "hr";
		const session = SessionManager.create(cwd);
		await session.setSessionName("user-renamed", "user");
		expect(session.getSessionName()).toBe("user-renamed");
	});

	it("returns undefined when no env var is set and the session is unnamed", () => {
		delete process.env.PI_SESSION_NAME;
		const session = SessionManager.create(cwd);
		expect(session.getSessionName()).toBeUndefined();
	});

	it("ignores a whitespace-only PI_SESSION_NAME", () => {
		process.env.PI_SESSION_NAME = "   ";
		const session = SessionManager.create(cwd);
		expect(session.getSessionName()).toBeUndefined();
	});
});
