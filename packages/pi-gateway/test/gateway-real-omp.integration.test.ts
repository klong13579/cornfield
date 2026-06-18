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
import { AgentBridge } from "../src/agent-bridge";
import { ensureAgentDir } from "../src/setup";
import type { InboundMessage, SessionRecord } from "../src/types";

const runRealOmp = process.env.PI_GATEWAY_REAL_OMP_TEST === "1";
const realTest = runRealOmp ? test : test.skip;

function makeMessage(text: string): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId: "real",
		userId: "real-user",
		conversationId: "real-conv",
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
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

describe("real OMP gateway integration", () => {
	realTest(
		"spawns real omp rpc and receives a model response",
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
				const response = await bridge.forward(makeMessage(prompt), makeSession(sessionPath));

				expect(response).toBeTruthy();
				expect(response?.trim().length).toBeGreaterThan(0);
			} finally {
				bridge.stop();
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		},
		190_000,
	);
});
