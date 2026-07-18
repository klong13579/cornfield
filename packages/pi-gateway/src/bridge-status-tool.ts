/**
 * `bridge_status` host tool — read-only diagnostic for the AgentBridge.
 *
 * The LLM-facing `bridge_status` tool is registered with the OMP subprocess
 * via `set_host_tools` and invoked through the `host_tool_call` frame.
 * The handler reads `AgentBridge.getSnapshot()` (computed in
 * `agent-bridge.ts:325`) and returns it as a structured JSON payload
 * plus a one-sentence `summary` that pre-classifies the state for
 * the LLM.
 *
 * **Why expose this:** when the LLM-side tool returns an error like
 * "system busy" / "circuit open" / a user complaint that a message
 * never landed, the LLM needs to know whether the bridge is the
 * problem (`state: degraded` / `error` / `restarting`) or whether
 * the bridge is healthy and the issue is elsewhere
 * (`state: idle` / `busy`). Without this, the LLM either retries
 * blindly (and burns the circuit cooldown) or gives up
 * prematurely. The `summary` field tells the LLM in one line
 * what to do next; the full snapshot has the numeric detail.
 *
 * **State machine** (matches `AgentBridge.getSnapshot().state`):
 *   - `stopped`    — OMP subprocess not running. Bridge is dead.
 *   - `starting`   — bridge spawning OMP / waiting for first `ready`.
 *   - `idle`       — healthy; no prompts in flight.
 *   - `busy`       — processing a prompt. Don't re-dispatch yet.
 *   - `restarting` — OMP crashed, gateway is restarting with backoff.
 *   - `degraded`   — circuit breaker open; new prompts fast-fail
 *                    until `circuitCooldownMs` elapses.
 *   - `error`      — too many crashes; bridge is suppressed and
 *                    NOT auto-restarting. Operator intervention.
 *
 * The `state` field is the primary signal; `circuitState`, `crashCount`,
 * `crashSuppressed`, `reconnecting`, `lastError` are diagnostic detail
 * the LLM may surface to the user verbatim.
 */

import { Type } from "@sinclair/typebox";
import type { AgentBridge, AgentBridgeSnapshot } from "./agent-bridge";
import type { HostToolHandler, HostToolResultBody, RpcHostToolDefinition } from "./host-tool-dispatcher";

const BRIDGE_STATUS_PARAMETERS = Type.Object({});

const BRIDGE_STATUS_DEFINITION: RpcHostToolDefinition = {
	name: "bridge_status",
	label: "Bridge Status",
	description:
		"Read-only diagnostic for THIS AGENT's AgentBridge (the OMP subprocess serving this account). " +
		"Call this when:\n" +
		"  - The user reports a message wasn't delivered and you suspect the bridge is the cause\n" +
		"  - Your own tool call returned a 'system busy' / 'circuit open' error and you need to know when to retry\n" +
		"  - You need to confirm whether the bridge is healthy before promising the user a follow-up\n" +
		"\n" +
		"**Do NOT call this speculatively** — the bridge is healthy most of the time, and polling the status costs an extra tool round-trip.\n" +
		"\n" +
		"**State field** is the primary signal:\n" +
		"  - `idle`       — healthy, ready to take prompts. No action needed.\n" +
		"  - `busy`       — currently processing a prompt (see `activePromptId`). Wait for it to finish before dispatching another.\n" +
		"  - `starting`   — bridge spawning the OMP subprocess; first prompt may take a few seconds.\n" +
		"  - `stopped`    — OMP subprocess is down. Tell the user the agent is unavailable; the gateway will auto-restart on the next inbound message.\n" +
		"  - `restarting` — OMP crashed, gateway is restarting with backoff. Brief window of unavailability.\n" +
		"  - `degraded`   — circuit breaker is open after consecutive failures. New prompts are fast-failed until the cooldown (default 30s) expires. Read `circuitFailures` and `circuitOpenedAt` to estimate when retries will be accepted again.\n" +
		"  - `error`      — too many crashes; bridge is suppressed and NOT auto-restarting. Operator (human) must intervene. Tell the user the agent is down and the gateway operator needs to restart it.\n" +
		"\n" +
		"**Diagnostic fields** (when the state is not `idle`):\n" +
		"  - `circuitState` / `circuitFailures` / `circuitOpenedAt` — circuit breaker health\n" +
		"  - `crashCount` / `crashWindowCount` / `crashSuppressed` — crash recovery state\n" +
		"  - `reconnecting` — true while a restart is in progress\n" +
		"  - `lastError` — most recent error message from the OMP subprocess (may be null)\n" +
		"  - `activeSessionPath` / `activePromptId` — what the bridge is currently doing (when `busy`)\n" +
		"  - `pendingPrompts` — prompts queued behind the current one (0 when idle)\n" +
		"  - `pid` — OMP subprocess pid (undefined when `stopped`)\n" +
		"\n" +
		"**`summary` field** is a pre-computed one-sentence read of the state for quick consumption. The full `state` + numeric fields are still returned for cases the summary doesn't cover.",
	parameters: BRIDGE_STATUS_PARAMETERS as unknown as Record<string, unknown>,
};

/**
 * Public factory: returns the registered `bridge_status` host tool.
 * Mirrors the `createCronToolDefinitions` factory in
 * `scheduler/host-tool.ts` so the gateway can wire both tools with
 * the same `dispatcher.setTools([...cron, ...bridgeStatus])` pattern.
 */
export interface BridgeStatusToolContext {
	/** Returns the active AgentBridge for the dispatcher. Lazy because
	 *  the bridge is constructed after the dispatcher in the gateway's
	 *  start sequence. `null` if the bridge has not been created yet
	 *  (e.g. the gateway's start sequence threw before bridge construction). */
	getBridge: () => AgentBridge | null;
}

export function createBridgeStatusToolDefinitions(ctx: BridgeStatusToolContext): HostToolHandler[] {
	return [
		{
			definition: BRIDGE_STATUS_DEFINITION,
			handle: () => {
				const bridge = ctx.getBridge();
				if (!bridge) {
					return errResult("bridge not initialized (gateway is still starting up)");
				}
				const snapshot = bridge.getSnapshot();
				return ok({ ...snapshot, summary: buildSummary(snapshot) });
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One-sentence read of the snapshot. Phrased so the LLM can surface it
 * to the user verbatim or use it to decide whether to retry / wait /
 * escalate. The full snapshot is always returned alongside — the
 * summary is for fast triage, not a substitute for the detail.
 */
function buildSummary(snap: AgentBridgeSnapshot): string {
	switch (snap.state) {
		case "stopped":
			return "OMP subprocess is not running; bridge is down. The gateway will auto-restart on the next inbound message.";
		case "starting":
			return "OMP subprocess is starting up (waiting for first ready event).";
		case "idle":
			return "OMP is healthy and ready. No prompts in flight.";
		case "busy": {
			const id = snap.activePromptId ? ` (promptId=${snap.activePromptId})` : "";
			const pending = snap.pendingPrompts > 0 ? `, ${snap.pendingPrompts} pending behind it` : "";
			return `OMP is currently processing a prompt${id}${pending}. Wait for it to finish before dispatching another.`;
		}
		case "restarting":
			return `OMP crashed; gateway is restarting with backoff. crashCount=${snap.crashCount}, windowCount=${snap.crashWindowCount}.`;
		case "degraded": {
			const openedSec = snap.circuitOpenedAt
				? `${Math.round((Date.now() - snap.circuitOpenedAt) / 1000)}s ago`
				: "unknown";
			return `Circuit breaker is open after ${snap.circuitFailures} consecutive failures (opened ${openedSec}). New prompts fast-fail until the cooldown elapses.`;
		}
		case "error":
			return `Bridge is in suppressed state after too many crashes (windowCount=${snap.crashWindowCount}). NOT auto-restarting. Operator intervention required.`;
	}
}

function ok(payload: unknown): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function errResult(message: string): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text: `error: ${message}` }],
		isError: true,
	};
}
