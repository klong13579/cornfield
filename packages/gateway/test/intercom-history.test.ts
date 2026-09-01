/**
 * Intercom message history (journal + query) tests.
 *
 * Covers the history feature: live delivery, mailbox queuing, attachment path
 * preservation, direction filtering, and journal persistence across broker restart.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { IntercomBroker } from "../src/intercom/broker-server";

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
	runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-history-"));
	previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
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

describe("intercom message history", () => {
	test("live delivery: history entry present with queued=false", async () => {
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice"));
			await bob.connect(registration("bob"));

			const result = await alice.send("bob", {
				text: "Hello from alice",
			});
			expect(result.delivered).toBe(true);

			await Bun.sleep(50);

			// Bob queries history: should see the inbound message
			const bobHistory = await bob.history({ direction: "in" });
			expect(bobHistory.length).toBeGreaterThanOrEqual(1);
			const entry = bobHistory.find(e => e.message.content.text === "Hello from alice");
			expect(entry).toBeDefined();
			expect(entry!.from.name).toBe("alice");
			expect(entry!.to.id).toBe(bob.sessionId);
			expect(entry!.queued).toBe(false);

			// Bob queries outbound: should be empty
			const bobOut = await bob.history({ direction: "out" });
			expect(bobOut.some(e => e.message.content.text === "Hello from alice")).toBe(false);

			// Alice queries outbound: should see the message she sent
			const aliceOut = await alice.history({ direction: "out" });
			expect(aliceOut.some(e => e.message.content.text === "Hello from alice")).toBe(true);
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);

	test("history with attachment path preserved", async () => {
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice-path"));
			await bob.connect(registration("bob-path"));

			const result = await alice.send("bob-path", {
				text: "Review attachment test",
				attachments: [
					{
						type: "file",
						name: "/tmp/review.md",
						content: "one-line summary",
						path: "/tmp/review.md",
					},
				],
			});
			expect(result.delivered).toBe(true);

			await Bun.sleep(50);

			const bobHistory = await bob.history({ direction: "in" });
			const entry = bobHistory.find(e => e.message.content.text === "Review attachment test");
			expect(entry).toBeDefined();
			expect(entry!.message.content.attachments).toBeDefined();
			expect(entry!.message.content.attachments!.length).toBe(1);
			const att = entry!.message.content.attachments![0]!;
			expect(att.type).toBe("file");
			expect(att.path).toBe("/tmp/review.md");
			expect(att.content).toBe("one-line summary");
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);

	test("history with since filter", async () => {
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice-since"));
			await bob.connect(registration("bob-since"));

			await Bun.sleep(50);
			const before = Date.now();
			await Bun.sleep(10);

			await alice.send("bob-since", { text: "message after since" });
			await Bun.sleep(50);

			const bobHistory = await bob.history({ direction: "in", since: before });
			expect(bobHistory.length).toBeGreaterThanOrEqual(1);
			expect(bobHistory.some(e => e.message.content.text === "message after since")).toBe(true);

			// Query with future timestamp: should be empty
			const farFuture = Date.now() + 60_000;
			const futureHistory = await bob.history({ direction: "in", since: farFuture });
			expect(futureHistory.length).toBe(0);
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);

	test("history with direction=both", async () => {
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice-both"));
			await bob.connect(registration("bob-both"));

			await alice.send("bob-both", { text: "alice to bob" });
			await bob.send("alice-both", { text: "bob to alice" });
			await Bun.sleep(50);

			const aliceHistory = await alice.history({ direction: "both" });
			expect(aliceHistory.some(e => e.message.content.text === "alice to bob")).toBe(true);
			expect(aliceHistory.some(e => e.message.content.text === "bob to alice")).toBe(true);
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);

	test("disconnected target: queued=true in history", async () => {
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice-q"));
			await bob.connect(registration("bob-q"));

			// Disconnect bob
			await bob.disconnect();
			await Bun.sleep(50);

			// Send to bob while disconnected (goes to mailbox)
			const result = await alice.send("bob-q", { text: "queued message" });
			expect(result.delivered).toBe(true);

			// Alice queries outbound: should show queued=true
			const aliceOut = await alice.history({ direction: "out" });
			const entry = aliceOut.find(e => e.message.content.text === "queued message");
			expect(entry).toBeDefined();
			expect(entry!.queued).toBe(true);
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);

	test("journal persistence across broker restart", async () => {
		const persistDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-persist-"));
		const intercomDir = path.join(persistDir, "intercom");
		const listenTarget = path.join(intercomDir, "broker.sock");

		// Save the original env and set a new one that maps to persistDir
		const savedAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(persistDir, "agent");

		const persistBroker = new IntercomBroker({ intercomDir, listenTarget });
		try {
			await persistBroker.start();
			await Bun.sleep(50);

			const alice = new IntercomClient();
			const bob = new IntercomClient();
			await alice.connect(registration("alice-p"));
			await bob.connect(registration("bob-p"));

			const sendResult = await alice.send("bob-p", { text: "persist test message" });
			expect(sendResult.delivered).toBe(true);
			await Bun.sleep(100);

			await alice.disconnect();
			await bob.disconnect();
			persistBroker.stop();
			await Bun.sleep(100);

			// Start a new broker on the same dir
			// Verify journal file was written
			const journalPath = path.join(intercomDir, "journal.jsonl");
			const journalExists = await fs.stat(journalPath).then(() => true, () => false);
			expect(journalExists).toBe(true);
			if (journalExists) {
				const journalContent = await fs.readFile(journalPath, "utf-8");
				expect(journalContent).toContain("persist test message");
			}

			const reloadBroker = new IntercomBroker({ intercomDir, listenTarget });
			try {
				await reloadBroker.start();
				await Bun.sleep(50);

				const bobReload = new IntercomClient();
				await bobReload.connect(registration("bob-p"));

				const bobHistory = await bobReload.history({ direction: "in" });
				expect(bobHistory.some(e => e.message.content.text === "persist test message")).toBe(true);

				await bobReload.disconnect();
			} finally {
				reloadBroker.stop();
			}
		} finally {
			process.env.CORNFIELD_AGENT_DIR = savedAgentDir;
			await fs.rm(persistDir, { recursive: true, force: true });
		}
	}, 20_000);

	test("e2e: busy agent retrieves missed command via history", async () => {
		// Scenario: Alice is connected but "busy" (not actively processing incoming
		// messages). Bob sends a command. Alice later queries history, finds the
		// message, and reads it to take action.
		const alice = new IntercomClient();
		const bob = new IntercomClient();
		try {
			await alice.connect(registration("alice-e2e"));
			await bob.connect(registration("bob-e2e"));
			await Bun.sleep(50);

			// Bob sends a command message to Alice
			const cmdMsg = "帮我查一下今天的工单状态";
			const result = await bob.send("alice-e2e", {
				text: cmdMsg,
				attachments: [
					{
						type: "file",
						name: "daily-report.md",
						content: "2026-09-01 工单摘要",
						path: "/data/reports/daily-report.md",
					},
				],
			});
			expect(result.delivered).toBe(true);

			// Alice is "busy" — she was connected but didn't see the message come in.
			// Now she queries history to find missed messages.
			const entries = await alice.history({ direction: "in", limit: 10 });
			expect(entries.length).toBeGreaterThanOrEqual(1);

			// Find the specific command message
			const cmdEntry = entries.find(e => e.message.content.text === cmdMsg);
			expect(cmdEntry).toBeDefined();
			expect(cmdEntry!.queued).toBe(false); // was delivered live but missed
			expect(cmdEntry!.from.name).toBe("bob-e2e");

			// Alice reads the message content and decides what to do with it.
			// In the real system, the LLM agent would see this text in the
			// history output and act on it.
			const cmdText = cmdEntry!.message.content.text;
			expect(cmdText).toBe(cmdMsg);
			expect(cmdText.includes("工单")).toBe(true);
			expect(cmdText.includes("状态")).toBe(true);

			// Alice also reads the attachment for context
			const att = cmdEntry!.message.content.attachments?.[0];
			expect(att).toBeDefined();
			expect(att!.type).toBe("file");
			expect(att!.name).toBe("daily-report.md");
			expect(att!.path).toBe("/data/reports/daily-report.md");
			expect(att!.content).toBe("2026-09-01 工单摘要");
		} finally {
			await alice.disconnect();
			await bob.disconnect();
		}
	}, 15_000);
});