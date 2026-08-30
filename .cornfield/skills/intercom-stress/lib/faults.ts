/**
 * Fault injection for reliability testing. Opt-in via flags; each injection
 * records both the action and the observed broker behavior.
 */

import type { BrokerSession } from "./broker";
import type { Metrics } from "./metrics";
import { killWorker, type SpawnedWorker } from "./workers";

/** SIGKILL a worker and observe whether/how fast the broker marks it gone. */
export async function injectKillWorker(options: {
	broker: BrokerSession;
	metrics: Metrics;
	worker: SpawnedWorker;
	sessionId: string;
	timeoutMs?: number;
}): Promise<"left" | "missing"> {
	const { broker, metrics, worker, sessionId } = options;
	const detail = `role=${worker.role} session=${sessionId.slice(0, 8)}`;
	metrics.record({ t: Date.now(), kind: "fault_injected", fault: "kill-worker", detail });
	metrics.faultsInjected.push(`kill-worker ${detail}`);

	killWorker(worker, "SIGKILL");

	const left = await waitBrokerSessionGone(broker, sessionId, options.timeoutMs ?? 15_000);
	if (left) {
		metrics.record({ t: Date.now(), kind: "fault_observed", fault: "kill-worker", detail: "session_left observed" });
		metrics.faultsObserved.push(`kill-worker ${detail}: session_left observed`);
		return "left";
	}
	metrics.record({ t: Date.now(), kind: "fault_observed", fault: "kill-worker", detail: "no session_left within timeout (retention?)" });
	metrics.faultsObserved.push(`kill-worker ${detail}: no session_left within timeout`);
	return "missing";
}

/** Poll the roster until a session id disappears, or timeout. */
export async function waitBrokerSessionGone(broker: BrokerSession, sessionId: string, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const roster = await broker.client.listSessions({ timeoutMs: 4000 });
			if (!roster.some(s => s.id === sessionId)) return true;
		} catch {
			// transient list failure: keep polling
		}
		await Bun.sleep(250);
	}
	return false;
}