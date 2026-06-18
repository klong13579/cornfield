/**
 * Real OMP/LLM gateway integration test.
 *
 * Opt in with PI_GATEWAY_REAL_OMP_TEST=1. This spawns a real `omp --mode rpc`
 * process and may call the configured model provider.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge, type AgentBridgeSnapshot } from "../src/agent-bridge";
import { parseRobotMessage } from "../src/channels/dingtalk";
import type { SessionRecord } from "../src/types";
import { sampleTextMessage } from "./fixtures/sample-messages";

const runRealOmp = process.env.PI_GATEWAY_REAL_OMP_TEST === "1";
const realTest = runRealOmp ? test : test.skip;

function makeRawDingTalkMessage(prompt: string) {
	return sampleTextMessage({
		conversationId: "real-conv",
		msgId: `real-${Date.now()}`,
		senderStaffId: "real-user",
		senderId: "real-user",
		senderNick: "Real User",
		text: { content: prompt },
	});
}

function makeSession(sessionPath: string): SessionRecord {
	return {
		id: "real-session",
		channelId: "dingtalk",
		accountId: "real",
		userId: "real-user",
		conversationId: "real-conv",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

async function waitForBridgeState(
	bridge: AgentBridge,
	predicate: (snapshot: AgentBridgeSnapshot) => boolean,
	timeoutMs: number,
	description: string,
): Promise<AgentBridgeSnapshot> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const snapshot = bridge.getSnapshot();
		if (predicate(snapshot)) return snapshot;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for bridge state: ${description}`);
}

describe("real OMP gateway integration", () => {
	realTest(
		"parses a raw DingTalk message, calls real omp rpc, and writes the session log",
		async () => {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-real-omp-"));
			const ompPath = process.env.PI_GATEWAY_REAL_OMP_PATH ?? "omp";
			const model = process.env.PI_GATEWAY_REAL_OMP_MODEL;
			const prompt = process.env.PI_GATEWAY_REAL_OMP_PROMPT ?? "Reply with exactly: OK";
			const sessionPath = path.join(tmpDir, "sessions", "real-conv.jsonl");
			const bridge = new AgentBridge({ ompPath, cwd: tmpDir, model, timeoutMs: 180_000 });

			try {
				await ensureAgentDir(tmpDir);
				await bridge.start();
				const raw = makeRawDingTalkMessage(prompt);
				const inbound = parseRobotMessage(raw, "dingtalk", "real", raw.msgId);
				if (!inbound) throw new Error("raw DingTalk message did not parse");

				const response = await bridge.forward(inbound, makeSession(sessionPath));

				expect(response).toBeTruthy();
				expect(response?.trim().length).toBeGreaterThan(0);

				const sessionLog = await Bun.file(sessionPath).text();
				expect(sessionLog).toContain(prompt);
				expect(sessionLog).toContain("assistant");
			} finally {
				bridge.stop();
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		},
		190_000,
	);

	realTest(
		"accepts abort during a real omp rpc turn and returns to idle",
		async () => {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-real-omp-abort-"));
			const ompPath = process.env.PI_GATEWAY_REAL_OMP_PATH ?? "omp";
			const model = process.env.PI_GATEWAY_REAL_OMP_MODEL;
			const prompt =
				process.env.PI_GATEWAY_REAL_OMP_ABORT_PROMPT ??
				"Write a long numbered list of 200 items, one item per line.";
			const sessionPath = path.join(tmpDir, "sessions", "real-conv.jsonl");
			const bridge = new AgentBridge({ ompPath, cwd: tmpDir, model, timeoutMs: 180_000 });

			try {
				await ensureAgentDir(tmpDir);
				expect(bridge.getSnapshot().state).toBe("stopped");
				await bridge.start();
				expect(bridge.getSnapshot()).toMatchObject({ state: "idle", running: true, ready: true });

				const raw = makeRawDingTalkMessage(prompt);
				const inbound = parseRobotMessage(raw, "dingtalk", "real", raw.msgId);
				if (!inbound) throw new Error("raw DingTalk message did not parse");

				const pending = bridge.forward(inbound, makeSession(sessionPath));
				const busy = await waitForBridgeState(
					bridge,
					snapshot => snapshot.state === "busy" && snapshot.pendingPrompts > 0,
					10_000,
					"real prompt to become busy",
				);
				expect(busy.activeSessionPath).toBe(sessionPath);

				expect(await bridge.abort()).toBe(true);
				const response = await pending;
				expect(response === null || typeof response === "string").toBe(true);

				const idle = await waitForBridgeState(
					bridge,
					snapshot => snapshot.state === "idle" || snapshot.state === "degraded",
					30_000,
					"bridge to settle after abort",
				);
				expect(idle.pendingPrompts).toBe(0);
			} finally {
				bridge.stop();
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		},
		190_000,
	);
});
