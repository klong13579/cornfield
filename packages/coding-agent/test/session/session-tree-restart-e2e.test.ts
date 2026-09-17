/**
 * Parent process restart, with a parent that is really a process (E2E=1).
 *
 * `session-tree-e2e.test.ts` rebuilds a manager in-process to stand in for a
 * restart. This file does not stand in for anything: a real parent host process
 * (`./session-tree-parent-host.ts`) delegates a real Child Session, the parent is
 * killed, and a *second* host process settles the ledger that the first one left
 * on disk.
 *
 * What the sequence proves, none of which an in-process test can:
 *
 *   1. the ledger entry reached the disk *before* the crash — the second host
 *      reads it and the first host is no longer there to write it,
 *   2. the child really dies with its parent (its stdin pipe is the parent), so
 *      "the child is gone" is not something the test arranged,
 *   3. nothing wrote a terminal status for that child while the parent was alive,
 *      so the second host is not reading a convenient answer — it has to reach
 *      the conclusion itself, from the ledger and the broker.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { IntercomBroker } from "@cornfield/gateway/src/intercom/broker-server";
import { isEnoent } from "@cornfield/utils";
import { IntercomClient } from "../../src/intercom-extension/broker/client";
import { SessionManager } from "../../src/session/session-manager";
import { SessionLogTreeStore } from "../../src/session/session-tree-store";

const isE2E = process.env.E2E === "1";

function resolveCornfieldBinary(): string | undefined {
	const explicit = process.env.CORNFIELD_BINARY?.trim();
	if (explicit) return explicit;
	const installed = path.join(os.homedir(), ".local", "bin", "cornfield");
	try {
		fsSync.accessSync(installed, fsSync.constants.X_OK);
		return installed;
	} catch {
		return Bun.which("cornfield") ?? undefined;
	}
}

const binary = isE2E ? resolveCornfieldBinary() : undefined;
const describeE2E = binary ? describe : describe.skip;

const TREE_PARENT = "wp7-restart-parent";
const CHILD_ID = "restart-child";
const hostScript = fileURLToPath(new URL("./session-tree-parent-host.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

interface HostResult {
	applied: Array<{ sessionId: string; disposition: string; status: string; reason: string }>;
	decisions: Array<{ sessionId: string; disposition: string; status: string; reason: string }>;
	ledger: Array<{ sessionId: string; status: string }>;
}

let runtimeDir: string;
let ledgerFile: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;
let observer: IntercomClient;
const hosts: Array<ReturnType<typeof Bun.spawn>> = [];

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(what: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Read one JSON line from a host process's stdout, bounded.
 *
 * A single `read()` promise is carried across polls: issuing a fresh read on
 * every tick would drop the chunk the previous read had already resolved with.
 * On timeout the host's stderr tail is included — a host that died with an error
 * must not be reported as "no output".
 */
async function readJsonLine(
	proc: ReturnType<typeof Bun.spawn>,
	what: string,
	timeoutMs: number,
	stderrTail: () => string = () => "",
): Promise<unknown> {
	const stream = proc.stdout;
	if (!(stream instanceof ReadableStream)) throw new Error(`${what}: host produced no stdout pipe`);
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let pending: ReturnType<typeof reader.read> | null = null;
	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});
	const deadline = Date.now() + timeoutMs;

	try {
		for (;;) {
			pending ??= reader.read();
			const outcome = await Promise.race([
				pending.then(result => ({ kind: "read" as const, result })),
				Bun.sleep(200).then(() => ({ kind: "tick" as const })),
			]);
			if (outcome.kind === "tick") {
				if (Date.now() >= deadline || exited) break;
				continue;
			}
			pending = null;
			if (outcome.result.done) break;
			buffered += decoder.decode(outcome.result.value, { stream: true });
			for (const line of buffered.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) continue;
				try {
					return JSON.parse(trimmed);
				} catch {
					// Not the line we are after; keep reading.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const stderr = stderrTail().trim().slice(-2000);
	throw new Error(
		`${what}: no JSON line from the host (exit ${await proc.exited}; stdout so far: ${JSON.stringify(buffered.slice(-500))})` +
			(stderr ? `\nhost stderr:\n${stderr}` : "\nhost produced no stderr"),
	);
}

/** Drain a stream into a growing buffer, so a failed run can report what the host said. */
function capture(stream: ReadableStream | number | undefined): () => string {
	let text = "";
	if (stream instanceof ReadableStream) {
		void (async () => {
			const decoder = new TextDecoder();
			const reader = stream.getReader();
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					text += decoder.decode(chunk.value, { stream: true });
				}
			} catch {
				// The host died; whatever was read is still worth reporting.
			}
		})();
	}
	return () => text;
}

async function ledgerStatus(sessionId: string): Promise<string | undefined> {
	const store = new SessionLogTreeStore(await SessionManager.open(ledgerFile));
	const record = (await store.load()).find(entry => entry.node.sessionId === sessionId);
	return record?.node.status;
}

async function rosterChildPids(): Promise<number[]> {
	const sessions = await observer.listSessions({ timeoutMs: 5_000 });
	return sessions.filter(session => session.parentId === TREE_PARENT).map(session => session.pid);
}

describeE2E("Session tree recovery across a real parent process restart", () => {
	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tree-restart-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");

		for (const name of ["config.yml", "models.yml", "auth.db"] as const) {
			try {
				await fs.cp(path.join(os.homedir(), ".cornfield/agent", name), path.join(runtimeDir, "agent", name));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		await fs.mkdir(path.join(runtimeDir, "agent", "sessions"), { recursive: true });

		broker = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await broker.start();

		observer = new IntercomClient();
		await observer.connect(
			{
				name: "wp7-restart-observer",
				cwd: repoRoot,
				model: "e2e-driver",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				status: "idle",
				runtimeFallbackAlias: false,
			},
			"wp7-restart-observer",
		);

		const ledger = await SessionManager.create(runtimeDir, path.join(runtimeDir, "parent-sessions"));
		await ledger.ensureOnDisk();
		ledgerFile = ledger.getSessionFile()!;
	}, 60_000);

	afterAll(async () => {
		for (const host of hosts.splice(0)) {
			if (isAlive(host.pid)) host.kill("SIGTERM");
		}
		await observer?.disconnect().catch(() => {});
		broker?.stop();
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
	});

	test("the surviving process reads a ledger the dead one wrote and settles it", async () => {
		const host1 = Bun.spawn(
			[
				process.execPath,
				hostScript,
				"delegate",
				"--ledger",
				ledgerFile,
				"--broker-id",
				"wp7-host-1",
				"--parent-id",
				TREE_PARENT,
				"--cwd",
				repoRoot,
				"--child-id",
				CHILD_ID,
				"--binary",
				binary!,
			],
			{ cwd: repoRoot, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		hosts.push(host1);
		const host1Stderr = capture(host1.stderr);

		const delegated = (await readJsonLine(host1, "host-1 delegate", 120_000, host1Stderr)) as {
			childId: string;
			pid: number;
		};
		expect(delegated.childId).toBe(CHILD_ID);
		const childPid = delegated.pid;
		expect(childPid).toBeGreaterThan(0);
		await waitFor(
			"the child to register under the tree parent",
			async () => (await rosterChildPids()).includes(childPid),
			60_000,
		);

		// The parent dies. Nothing wrote a terminal status first — the ledger the next
		// process reads says `running`, which is exactly the state a crash leaves behind.
		host1.kill("SIGTERM");
		await host1.exited;
		expect(await ledgerStatus(CHILD_ID)).toBe("running");

		// The child's stdin pipe was the parent, so the child goes with it.
		await waitFor("the child to die with its parent", () => !isAlive(childPid), 60_000);
		await waitFor(
			"the dead child to leave the roster",
			async () => !(await rosterChildPids()).includes(childPid),
			60_000,
		);

		const host2 = Bun.spawn(
			[
				process.execPath,
				hostScript,
				"reconcile",
				"--ledger",
				ledgerFile,
				"--broker-id",
				"wp7-host-2",
				"--parent-id",
				TREE_PARENT,
				"--cwd",
				repoRoot,
			],
			{ cwd: repoRoot, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		hosts.push(host2);
		const result = (await readJsonLine(host2, "host-2 reconcile", 120_000, capture(host2.stderr))) as HostResult;
		expect(await host2.exited).toBe(0);

		const decision = result.decisions.find(entry => entry.sessionId === CHILD_ID);
		expect(decision).toMatchObject({ disposition: "orphaned", status: "failed" });
		expect(decision?.reason).toContain(`child process ${childPid} is no longer registered`);
		expect(result.applied.map(entry => entry.sessionId)).toEqual([CHILD_ID]);
		expect(result.ledger.find(entry => entry.sessionId === CHILD_ID)?.status).toBe("failed");

		// And it is on disk for whoever comes next.
		expect(await ledgerStatus(CHILD_ID)).toBe("failed");
	}, 300_000);
});
