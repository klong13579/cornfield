/**
 * bridge.status host tool — read-only diagnostic.
 *
 * The LLM-facing `bridge.status` tool returns AgentBridge.getSnapshot()
 * plus a derived `summary` field. The handler is a thin wrapper — most
 * of the value is in:
 *
 *   - the description (teaches the LLM the state machine)
 *   - the summary (one-sentence read so the LLM doesn't have to
 *     interpret the state field every time)
 *
 * This test pins:
 *   - bridge null → errResult with "bridge not initialized"
 *   - each lifecycle state returns the right `state` + a `summary`
 *     that mentions the actionable signal
 *   - the full AgentBridgeSnapshot is returned (not a stripped subset)
 *   - no parameters — calling with extra args does not throw
 */

import { describe, expect, it } from "bun:test";
import type { AgentBridge, AgentBridgeSnapshot } from "../src/agent-bridge";
import { createBridgeStatusToolDefinitions } from "../src/bridge-status-tool";

function stubBridge(snapshot: AgentBridgeSnapshot): AgentBridge {
	return {
		getSnapshot: () => snapshot,
	} as unknown as AgentBridge;
}

const IDLE_SNAPSHOT: AgentBridgeSnapshot = {
	state: "idle",
	running: true,
	ready: true,
	pid: 12345,
	pendingPrompts: 0,
	pendingCommands: 0,
	circuitState: "closed",
	circuitFailures: 0,
	crashCount: 0,
	crashWindowCount: 0,
	crashSuppressed: false,
	reconnecting: false,
};

function asText(body: { content: Array<{ type: string; text: string }>; isError?: boolean }): {
	text: string;
	isError: boolean;
} {
	return { text: body.content.map(c => c.text).join(""), isError: body.isError === true };
}

describe("bridge.status host tool — factory", () => {
	it("registers exactly one tool named 'bridge.status'", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		expect(tools).toHaveLength(1);
		expect(tools[0]!.definition.name).toBe("bridge.status");
	});

	it("definition has empty parameters (no LLM-supplied input)", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		expect(tools[0]!.definition.parameters).toBeDefined();
	});

	it("description mentions each lifecycle state", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const desc = tools[0]!.definition.description;
		for (const s of ["stopped", "starting", "idle", "busy", "restarting", "degraded", "error"]) {
			expect(desc).toContain(`\`${s}\``);
		}
	});
});

describe("bridge.status host tool — bridge not initialized", () => {
	it("returns errResult when getBridge() returns null", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => null });
		const result = await tools[0]!.handle({});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("bridge not initialized");
	});
});

describe("bridge.status host tool — each lifecycle state", () => {
	const cases: Array<{
		name: string;
		snap: AgentBridgeSnapshot;
		summaryContains: string;
		stateExpect: string;
	}> = [
		{
			name: "idle — healthy",
			snap: IDLE_SNAPSHOT,
			summaryContains: "healthy and ready",
			stateExpect: "idle",
		},
		{
			name: "busy — processing a prompt with one queued",
			snap: {
				...IDLE_SNAPSHOT,
				state: "busy",
				activePromptId: "p-42",
				activeSessionPath: "/tmp/sess.jsonl",
				pendingPrompts: 1,
			},
			summaryContains: "promptId=p-42",
			stateExpect: "busy",
		},
		{
			name: "busy — processing a prompt, nothing queued",
			snap: {
				...IDLE_SNAPSHOT,
				state: "busy",
				activePromptId: "p-7",
				pendingPrompts: 0,
			},
			summaryContains: "Wait for it to finish",
			stateExpect: "busy",
		},
		{
			name: "stopped — OMP down",
			snap: {
				...IDLE_SNAPSHOT,
				state: "stopped",
				running: false,
				ready: false,
				pid: undefined,
			},
			summaryContains: "not running",
			stateExpect: "stopped",
		},
		{
			name: "starting — waiting for first ready",
			snap: {
				...IDLE_SNAPSHOT,
				state: "starting",
				running: false,
				ready: false,
				pid: undefined,
			},
			summaryContains: "starting up",
			stateExpect: "starting",
		},
		{
			name: "restarting — OMP crashed, backoff",
			snap: {
				...IDLE_SNAPSHOT,
				state: "restarting",
				reconnecting: true,
				crashCount: 2,
				crashWindowCount: 2,
			},
			summaryContains: "crashCount=2",
			stateExpect: "restarting",
		},
		{
			name: "degraded — circuit open with 10 failures",
			snap: {
				...IDLE_SNAPSHOT,
				state: "degraded",
				circuitState: "open",
				circuitFailures: 10,
				circuitOpenedAt: Date.now() - 5_000,
			},
			summaryContains: "10 consecutive failures",
			stateExpect: "degraded",
		},
		{
			name: "error — suppressed after too many crashes",
			snap: {
				...IDLE_SNAPSHOT,
				state: "error",
				crashSuppressed: true,
				crashCount: 5,
				crashWindowCount: 5,
				running: false,
				ready: false,
				lastError: "process exited before ready",
			},
			summaryContains: "suppressed state",
			stateExpect: "error",
		},
	];

	for (const c of cases) {
		it(`${c.name}: returns state=${c.stateExpect} + summary mentioning "${c.summaryContains}"`, async () => {
			const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(c.snap) });
			const result = await tools[0]!.handle({});
			const { text, isError } = asText(result);
			expect(isError).toBe(false);
			const payload = JSON.parse(text) as AgentBridgeSnapshot & { summary: string };
			expect(payload.state).toBe(c.stateExpect);
			expect(payload.summary).toContain(c.summaryContains);
		});

		it(`${c.name}: full snapshot is returned (not a stripped subset)`, async () => {
			const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(c.snap) });
			const result = await tools[0]!.handle({});
			const payload = JSON.parse(asText(result).text) as Record<string, unknown>;
			// Every non-undefined field on the snapshot is present in the
			// payload (JSON.stringify drops `undefined` values, so we only
			// check defined fields). The summary field is added on top.
			for (const [key, value] of Object.entries(c.snap)) {
				if (value !== undefined) {
					expect(payload).toHaveProperty(key);
				}
			}
			expect(payload).toHaveProperty("summary");
		});
	}
});

describe("bridge.status host tool — input tolerance", () => {
	it("ignores extra arguments without error", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({ junk: "ignored", n: 42 } as unknown as Record<string, unknown>);
		const { isError } = asText(result);
		expect(isError).toBe(false);
	});

	it("works when called with empty args", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({});
		const { isError } = asText(result);
		expect(isError).toBe(false);
	});
});

describe("bridge.status host tool — summary phrasing", () => {
	it("idle summary says 'no prompts in flight'", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary.toLowerCase()).toContain("no prompts in flight");
	});

	it("degraded summary tells the LLM when retries may be accepted", async () => {
		const snap: AgentBridgeSnapshot = {
			...IDLE_SNAPSHOT,
			state: "degraded",
			circuitState: "open",
			circuitFailures: 10,
			circuitOpenedAt: Date.now() - 12_000,
		};
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(snap) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary).toContain("12s ago");
		expect(payload.summary).toContain("cooldown");
	});

	it("error summary tells the LLM to escalate to operator", async () => {
		const snap: AgentBridgeSnapshot = {
			...IDLE_SNAPSHOT,
			state: "error",
			crashSuppressed: true,
			crashWindowCount: 5,
		};
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(snap) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary.toLowerCase()).toContain("operator");
	});
});
