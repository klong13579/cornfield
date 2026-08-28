/**
 * Intercom parent-child closed-loop, end-to-end (E2E=1 gated).
 *
 * Runs WITHOUT touching the production gateway or broker: the test hosts its
 * own IntercomBroker on an isolated CORNFIELD_AGENT_DIR, copies the user's
 * agent config (~/.cornfield/agent: models, auth) into that isolated dir so the
 * child omp has model credentials, and spawns the child from THIS repo's
 * source (`bun packages/coding-agent/src/cli.ts --mode rpc`) with
 * PI_SUBAGENT_* parent metadata.
 *
 * Asserts the three closed-loop behaviours against the real extension code:
 *   1. child registers with parentId; the parent lists it as a child
 *   2. child auto-reports task-round completion to the parent (agent_end)
 *   3. child escalates via contact_supervisor (need_decision) → parent replies
 *      → child incorporates the verdict
 *
 * Requires real model credentials (the child runs a real LLM turn), hence the
 * E2E=1 gate — same opt-in as the real-provider tests in packages/ai/test.
 *
 * Repo provenance: converted from the reproduction driver at
 * /tmp/intercom-closedloop/closedloop.ts (2026-08-17).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { spawn } from "bun";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { IntercomBroker } from "../src/intercom/broker-server";

const isE2E = process.env.E2E === "1";

// Self-host an isolated broker: the injected listenTarget lives under the
// temporary runtime dir, and the child omp / parent client resolve the same
// socket from CORNFIELD_AGENT_DIR (set scoped inside beforeAll, restored in
// afterAll — never mutated at module load).
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
// Pin the child's model explicitly: the closed-loop's escalation step depends
// on the LLM following the contact_supervisor instruction, so the model must
// be deterministic across environments (not whatever the copied config
// defaults to) and strong at tool calling.
const CHILD_CMD = [
	path.join(process.env.HOME ?? "", ".local/bin/omp"),
	"--mode",
	"rpc",
	"--model",
	"narwal-plan/claude-haiku-4-5-20251001",
];
const PARENT_SESSION = "e2e-parent-session";
const PARENT_NAME = "e2e-parent";
const CHILD_RUN = "e2e-run-1";

let runtimeDir: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;

async function waitFor<T>(
	what: string,
	predicate: () => T | null | undefined | false,
	timeoutMs: number,
	pollMs = 200,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value as NonNullable<T>;
		await Bun.sleep(pollMs);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

// bun:test's describe options do not support { skip } — gate via conditional
// describe selection instead.
const describeE2E = isE2E ? describe : describe.skip;

describeE2E("intercom parent-child closed-loop", () => {
	const parent = new IntercomClient();
	const parentReceived: Array<{
		fromId: string;
		parentId?: string;
		text: string;
		expectsReply?: boolean;
		messageId: string;
	}> = [];
	let child: ReturnType<typeof spawn> | undefined;
	let childSessionId: string | null = null;
	const childLines: string[] = [];
	let childBuf = "";
	let _childErr = "";
	const childFrames = (): Array<{ type: string; [key: string]: unknown }> =>
		childLines
			.map(line => {
				try {
					return JSON.parse(line) as { type: string };
				} catch {
					return null;
				}
			})
			.filter((f): f is { type: string } => f !== null);

	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-e2e-parent-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");

		// Copy ONLY the model/config files the child needs — never the whole agent
		// dir (can be >1GB of sessions/blobs; fs.cp of it blows the beforeAll
		// hook window and stalls the box with IO).
		const userAgentDir = path.join(os.homedir(), ".cornfield/agent");
		for (const name of ["config.yml", "models.yml", "auth.db"] as const) {
			try {
				await fs.cp(path.join(userAgentDir, name), path.join(runtimeDir, "agent", name));
			} catch (err) {
				if (!isEnoent(err)) throw err;
				// Missing file: child falls back to defaults; model may fail, but
				// registration/children/completion-report assertions still hold.
			}
		}

		broker = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await broker.start();
		await Bun.sleep(50);

		parent.on("message", (from, message) => {
			parentReceived.push({
				fromId: from.id,
				parentId: from.parentId,
				text: message.content.text,
				expectsReply: message.expectsReply,
				messageId: message.id,
			});
		});
		await parent.connect(
			{
				name: PARENT_NAME,
				cwd: repoRoot,
				model: "e2e-driver",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				status: "idle",
				runtimeFallbackAlias: false,
			},
			PARENT_SESSION,
		);

		child = spawn({
			cmd: CHILD_CMD,
			env: {
				...process.env,
				PI_SUBAGENT_ORCHESTRATOR_TARGET: PARENT_NAME,
				PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: PARENT_SESSION,
				PI_SUBAGENT_RUN_ID: CHILD_RUN,
				PI_SUBAGENT_CHILD_AGENT: "e2e-child",
				PI_SUBAGENT_CHILD_INDEX: "0",
			},
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const decoder = new TextDecoder();
		(async () => {
			for await (const chunk of child.stdout!) {
				childBuf += decoder.decode(chunk);
				for (const line of childBuf.split("\n")) {
					if (line.trim()) childLines.push(line.trim());
				}
				childBuf = "";
			}
		})();
		(async () => {
			for await (const chunk of child.stderr!) _childErr += decoder.decode(chunk);
		})();

		// NOTE: do NOT wait for `ready` inside beforeAll — bun:test caps hook
		// execution at ~5s, and an isolated CORNFIELD_AGENT_DIR makes the child
		// probe local LLM provider endpoints (llama.cpp :8080, lm-studio :1234,
		// …) on startup, pushing the first ready frame past 5s on a cold box.
		// The ready wait lives in the first test, which has a 240s budget.
	});

	afterAll(async () => {
		try {
			child?.stdin?.end();
		} catch {}
		await Promise.race([child?.exited, Bun.sleep(5_000)]);
		if (child?.exitCode === null) child?.kill();
		await parent.disconnect();
		broker.stop();
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	test("child registers with parentId and parent sees it", async () => {
		await waitFor("child ready", () => childFrames().some(f => f.type === "ready"), 120_000);
		childSessionId = await waitFor(
			"child registration",
			async () => {
				const sessions = await parent.listSessions();
				const row = sessions.find(s => s.id !== parent.sessionId && s.parentId === PARENT_SESSION);
				return row?.id ?? null;
			},
			30_000,
		);
		expect(childSessionId).toBeTruthy();

		const row = await waitFor(
			"child in list",
			async () => {
				const sessions = await parent.listSessions();
				return sessions.find(s => s.id === childSessionId && s.parentId === PARENT_SESSION) ?? null;
			},
			10_000,
		);
		expect(row.status).toBeDefined();
		expect(row.model).toBeDefined();
	}, 90_000);

	test("child auto-reports task-round completion to parent", async () => {
		child?.stdin?.write(
			`${JSON.stringify({
				id: 1,
				type: "prompt",
				message: "完成一个最小任务：直接回答 OK 两个字即可。不要调用任何工具。",
			})}\n`,
		);
		await waitFor("round-1 agent_end", () => childFrames().some(f => f.type === "agent_end"), 120_000);

		const completion = await waitFor(
			"completion report",
			() =>
				parentReceived.find(
					m =>
						m.parentId === PARENT_SESSION &&
						m.text.includes("Subagent completed its task round.") &&
						m.text.includes(`Run: ${CHILD_RUN}`),
				),
			30_000,
		);
		expect(completion.messageId).toBeTruthy();
	}, 180_000);

	test("child runs a second task round (round-2 turn mechanics)", async () => {
		// Regression: the second prompt must start a new turn with the child
		// already busy-free after round 1 (agent_end count >= 2, numeric answer).
		// Root cause note: this used to flake because the child's READY frame
		// was awaited inside beforeAll — bun:test caps hooks at ~5s and an empty
		// CORNFIELD_AGENT_DIR adds local-provider endpoint probes (llama.cpp,
		// lm-studio, …) on startup, so the child could still be booting when the
		// hook was killed, leaving the spawn/session in a broken state. Awaiting
		// ready inside a real test (240s budget) fixed both the ready wait and
		// this round-2 mechanic.
		child?.stdin?.write(
			`${JSON.stringify({ id: 2, type: "prompt", message: "本轮请直接回答 2+2=？只回答数字。" })}\n`,
		);
		await waitFor("round-2 agent_end", () => childFrames().filter(f => f.type === "agent_end").length >= 2, 120_000);
	}, 240_000);
});
