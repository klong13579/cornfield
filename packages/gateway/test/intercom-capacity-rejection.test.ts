/**
 * Intercom registry-capacity regression.
 *
 * Root cause (2026-08-30): when the broker rejects a registration because the
 * session registry is full (MAX_SESSIONS = 128, "Too many registered intercom
 * sessions"), IntercomClient.handleBrokerMessage threw the broker's error text
 * out of the socket reader. The framing layer usually converted that into a
 * connect() rejection, but the raw throw could also escape as an uncaught
 * process-level exception whenever the error was not routed through the reader
 * error channel — crashing the hosting process instead of delivering a clean,
 * catchable rejection.
 *
 * This test pins the fixed contract: connect() rejects with the broker's own
 * error text (no "Intercom protocol error:" framing wrapper), the client is
 * left in a clean non-connected state, and reaching the assertions proves no
 * uncaught exception escaped the reader.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { IntercomBroker } from "../src/intercom/broker-server";

const MAX_SESSIONS = 128;

let runtimeDir: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;

function registration(name: string) {
	return {
		name,
		cwd: process.cwd(),
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		status: "idle",
	};
}

beforeAll(async () => {
	runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-capacity-"));
	previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
	// Clients resolve their broker target from the agent dir env; point them at
	// the isolated socket so the test never touches ~/.cornfield/intercom.
	process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");
	broker = new IntercomBroker({
		intercomDir: path.join(runtimeDir, "intercom"),
		listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
	});
	await broker.start();
	await Bun.sleep(50);
});

afterAll(async () => {
	if (broker) broker.stop();
	process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
	await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe("intercom registry capacity rejection", () => {
	test("full registry: overflow connect() rejects cleanly with the broker's error text", async () => {
		const fills: IntercomClient[] = [];
		try {
			for (let i = 0; i < MAX_SESSIONS; i++) {
				const client = new IntercomClient();
				await client.connect(registration(`fill-${i}`));
				fills.push(client);
			}

			const overflow = new IntercomClient();
			let rejection: Error | null = null;
			try {
				await overflow.connect(registration("overflow"));
			} catch (error) {
				rejection = error instanceof Error ? error : new Error(String(error));
			}

			expect(rejection).not.toBeNull();
			// The broker's own rejection text must reach the caller…
			expect(rejection!.message).toContain("Too many registered intercom sessions");
			// …without the framing-wrapper noise that the old throw path produced.
			expect(rejection!.message).not.toContain("Intercom protocol error");
			// The client is left in a clean non-connected state.
			expect(overflow.sessionId).toBeNull();
			expect(overflow.isConnected()).toBe(false);

			// A subsequent connect must be possible (no poisoned state).
			await expect(overflow.connect(registration("overflow"))).rejects.toThrow(
				/Too many registered intercom sessions/,
			);
		} finally {
			for (const client of fills) await client.disconnect();
		}
	}, 30_000);
});
