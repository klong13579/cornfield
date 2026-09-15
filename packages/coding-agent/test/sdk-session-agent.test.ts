/**
 * WP4 wiring: `createAgentSession` resolves the session's Agent and records it.
 *
 * The unit cases in `session-agent.test.ts` cover the policy; these go through the real
 * factory so the wiring itself (resolution → `SessionManager.create` → header on disk,
 * and the drift check on a resumed session) is observed rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@cornfield/coding-agent/sdk";
import { SessionAgentError } from "@cornfield/coding-agent/session/session-agent";
import { SessionManager } from "@cornfield/coding-agent/session/session-manager";
import { registerAgent } from "@cornfield/coding-agent/skeleton/registry";

const ENV_KEYS = ["HOME", "CORNFIELD_CONFIG_DIR"] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	home = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-wp4-sdk-"));
	process.env.HOME = home;
	delete process.env.CORNFIELD_CONFIG_DIR;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(home, { recursive: true, force: true });
});

function sessionOptions(agentDir: string, cwd: string): CreateAgentSessionOptions {
	return {
		cwd,
		agentDir,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	};
}

describe("createAgentSession agent resolution", () => {
	test("records the Agent the process runs as", async () => {
		const agentDir = path.join(home, "agents", "hr");
		await fs.mkdir(agentDir, { recursive: true });
		await registerAgent("hr", agentDir);
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const { session } = await createAgentSession(sessionOptions(agentDir, cwd));
		try {
			const header = session.sessionManager.getHeader();
			expect(header?.agentId).toBe("hr");
			expect(header?.agentSource).toBe("bootstrap");

			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("expected a session file");
			// Nothing is written until the session has content; force it for the assertion.
			await session.sessionManager.ensureOnDisk();
			const firstLine = (await Bun.file(sessionFile).text()).split("\n")[0];
			expect(JSON.parse(firstLine).agentId).toBe("hr");
			expect(JSON.parse(firstLine).agentSource).toBe("bootstrap");
		} finally {
			await session.dispose();
		}
	});

	test("a bare process records the client's own Agent", async () => {
		const agentDir = path.join(home, ".cornfield", "agent");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });

		const { session } = await createAgentSession(sessionOptions(agentDir, cwd));
		try {
			expect(session.sessionManager.getHeader()?.agentId).toBe("default");
			expect(session.sessionManager.getHeader()?.agentSource).toBe("bootstrap");
		} finally {
			await session.dispose();
		}
	});

	test("a resumed session whose Agent vanished fails loudly instead of re-resolving", async () => {
		const agentDir = path.join(home, ".cornfield", "agent");
		const cwd = path.join(home, "work");
		await fs.mkdir(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, path.join(home, "sessions"), undefined, {
			agentId: "ghost",
			source: "project",
		});

		let failure: unknown;
		try {
			await createAgentSession({ ...sessionOptions(agentDir, cwd), sessionManager });
		} catch (err) {
			failure = err;
		}
		expect(failure).toBeInstanceOf(SessionAgentError);
		expect((failure as SessionAgentError).failure).toEqual({
			kind: "agent-unknown",
			source: "session",
			agentId: "ghost",
		});
	});
});
