/**
 * Intercom parent-child edge (cross-process orchestration).
 *
 * Registers a real IntercomBroker (bound to an isolated socket via the
 * injectable listenTarget — no global env mutation at module load) and drives
 * it with two real IntercomClients from the coding-agent extension — one
 * acting as the parent, one as a child that declares `parentId` at
 * registration. Covers the broker contract of the parent-child feature:
 *
 *   - child registration carries parentId; `list` returns it back
 *   - presence updates preserve parentId (it is not a presence field)
 *   - a session without parentId stays a plain peer
 *   - a blank parentId is rejected at registration
 *   - messages from the parent to the child carry the child's parentId in
 *     the `from` session info (so the child can verify the sender is its
 *     declared parent)
 *
 * The extension-side behaviours (auto completion report, ask→parent routing,
 * `intercom({action:"children"})` list) build on this broker contract and are
 * not exercised here — they live in the coding-agent extension and require a
 * full extension runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { IntercomBroker } from "../src/intercom/broker-server";

let runtimeDir: string;
let previousAgentDir: string | undefined;

function registration(name: string, extra?: Record<string, unknown>) {
	return {
		name,
		runtimeFallbackAlias: false,
		cwd: process.cwd(),
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		status: "idle",
		...extra,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await Bun.sleep(20);
	}
}

describe("intercom parent-child broker edge", () => {
	let broker: InstanceType<typeof IntercomBroker>;
	let parent: InstanceType<typeof IntercomClient>;
	let child: InstanceType<typeof IntercomClient>;

	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-parent-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(runtimeDir, "agent");
		broker = new IntercomBroker({
			// Clients resolve the socket from PI_CODING_AGENT_DIR: agentDir is
			// <tmp>/agent, so the intercom dir (dirname) is <tmp>/intercom — keep
			// the injected listener on the same path.
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		broker.start();
		await Bun.sleep(50);

		parent = new IntercomClient();
		await parent.connect(registration("parent-session", { stableId: undefined }), "parent-stable-id");

		child = new IntercomClient();
		await child.connect(registration("child-session", { parentId: "parent-stable-id" }), "child-session-id");
	});

	afterAll(async () => {
		if (child) await child.disconnect();
		if (parent) await parent.disconnect();
		if (broker) {
			broker.stop();
		}
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	test("child registration carries parentId through list", async () => {
		const sessions = await parent.listSessions();
		const childRow = sessions.find(s => s.id === "child-session-id");
		expect(childRow).toBeDefined();
		expect(childRow?.parentId).toBe("parent-stable-id");
	});

	test("parent session itself has no parentId", async () => {
		const sessions = await child.listSessions();
		const parentRow = sessions.find(s => s.id === "parent-stable-id");
		expect(parentRow).toBeDefined();
		expect(parentRow?.parentId).toBeUndefined();
	});

	test("peer session without parentId stays a plain peer", async () => {
		const peer = new IntercomClient();
		try {
			await peer.connect(registration("peer-session"), "peer-session-id");
			const sessions = await parent.listSessions();
			const peerRow = sessions.find(s => s.id === "peer-session-id");
			expect(peerRow?.parentId).toBeUndefined();
		} finally {
			await peer.disconnect();
		}
	});

	test("presence updates preserve parentId", async () => {
		const seen = new Map<string, { status?: string; parentId?: string }>();
		const handler = (session: { id: string; status?: string; parentId?: string }) => {
			seen.set(session.id, { status: session.status, parentId: session.parentId });
		};
		parent.on("presence_update", handler);
		try {
			child.updatePresence({ status: "thinking" });
			await waitFor(() => seen.get("child-session-id")?.status === "thinking");
			// The presence event carries the full session info including parentId.
			expect(seen.get("child-session-id")?.parentId).toBe("parent-stable-id");
		} finally {
			parent.off("presence_update", handler);
		}
		const sessions = await parent.listSessions();
		expect(sessions.find(s => s.id === "child-session-id")?.parentId).toBe("parent-stable-id");
	});

	test("blank parentId is rejected at registration", async () => {
		const bad = new IntercomClient();
		try {
			await expect(bad.connect(registration("bad-session", { parentId: "  " }), "bad-session-id")).rejects.toThrow();
		} finally {
			await bad.disconnect().catch(() => undefined);
		}
	});

	test("message from parent to child carries no parentId on sender (peer-to-peer rather than parent-forced)", async () => {
		const received: Array<{ from: { id: string; parentId?: string }; text: string }> = [];
		const childOf = new IntercomClient();
		try {
			await childOf.connect(registration("child-2", { parentId: "parent-stable-id" }), "child-2-id");
			childOf.on("message", (from, message) => {
				received.push({ from, text: message.content.text });
			});
			await parent.send("child-2-id", { text: "hello child" });
			await waitFor(() => received.length >= 1);
			expect(received[0]?.from.id).toBe("parent-stable-id");
			// The sender is a parent session: its own parentId is undefined.
			expect(received[0]?.from.parentId).toBeUndefined();
			expect(received[0]?.text).toBe("hello child");
		} finally {
			await childOf.disconnect();
		}
	});
});
