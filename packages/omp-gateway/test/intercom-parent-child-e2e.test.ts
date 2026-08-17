/**
 * Intercom parent-child closed-loop, end-to-end (E2E=1 gated).
 *
 * Runs WITHOUT touching the production gateway or broker: the test hosts its
 * own IntercomBroker on an isolated PI_CODING_AGENT_DIR, copies the user's
 * agent config (~/.omp/agent: models, auth) into that isolated dir so the
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
import { spawn } from "bun";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { IntercomBroker } from "../src/intercom/broker-server";

const isE2E = process.env.E2E === "1";

// Self-host an isolated broker: the injected listenTarget lives under the
// temporary runtime dir, and the child omp / parent client resolve the same
// socket from PI_CODING_AGENT_DIR (set scoped inside beforeAll, restored in
// afterAll — never mutated at module load).
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const CHILD_CMD = [process.execPath, path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "--mode", "rpc"];
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
	let childErr = "";
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
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(runtimeDir, "agent");

		// Copy the user's agent config into the isolated dir so the child has
		// model/auth credentials without touching the production broker.
		const userAgentDir = path.join(os.homedir(), ".omp/agent");
		try {
			await fs.cp(userAgentDir, path.join(runtimeDir, "agent"), { recursive: true });
		} catch {
			// No user config: the child will fail its LLM call but the
			// registration/children/completion-report assertions still hold.
		}

		broker = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		broker.start();
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
			for await (const chunk of child.stderr!) childErr += decoder.decode(chunk);
		})();

		await waitFor("child ready", () => childFrames().some(f => f.type === "ready"), 60_000);
	});

	afterAll(async () => {
		try {
			child?.stdin?.end();
		} catch {}
		await Promise.race([child?.exited, Bun.sleep(5_000)]);
		if (child?.exitCode === null) child?.kill();
		await parent.disconnect();
		broker.stop();
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	test("child registers with parentId and parent sees it", async () => {
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
			JSON.stringify({
				id: 1,
				type: "prompt",
				message: "完成一个最小任务：直接回答 OK 两个字即可。不要调用任何工具。",
			}) + "\n",
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

	test("child escalation (contact_supervisor need_decision) routes to parent and verdict returns", async () => {
		child?.stdin?.write(
			JSON.stringify({
				id: 2,
				type: "prompt",
				message:
					"你现在面临一个决策：本任务应该采用方案A还是方案B？你必须调用 contact_supervisor 工具，reason 设为 'need_decision'，message 写 '请判断：选择方案A还是方案B？请直接回复 方案A 或 方案B'。收到裁决回复后，复述收到的判断文字。",
			}) + "\n",
		);

		const ask = await waitFor(
			"routed escalation",
			() =>
				parentReceived.find(
					m =>
						m.expectsReply === true &&
						m.parentId === PARENT_SESSION &&
						m.text.includes("Subagent needs a supervisor decision.") &&
						m.text.includes("请判断"),
				),
			120_000,
		);
		expect(ask.messageId).toBeTruthy();

		const reply = await parent.send(childSessionId!, {
			text: "方案A",
			replyTo: ask.messageId,
		});
		expect(reply.delivered).toBe(true);

		await waitFor("round-2 agent_end", () => childFrames().filter(f => f.type === "agent_end").length >= 2, 120_000);

		const messageEnds = childFrames().filter(
			f => f.type === "message_end" && (f.message as { role?: string })?.role === "assistant",
		);
		const last = messageEnds[messageEnds.length - 1];
		const round2Text =
			((last?.message as { content?: Array<{ text?: string }> })?.content ?? [])
				.map((c: { text?: string }) => c.text)
				.filter(Boolean)
				.join("") ?? "";
		expect(round2Text).toContain("方案A");
	}, 240_000);
});
