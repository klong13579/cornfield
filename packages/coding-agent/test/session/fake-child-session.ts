/**
 * A real, separate OS process that speaks the wire protocol — the stand-in for
 * `cornfield --mode wire-stdio` in the Child Session Process Supervisor tests.
 *
 * Why a fixture process instead of a mock: the supervisor's whole job is the
 * OS-process lifecycle (spawn, handshake, graceful stop, hard kill, crash).
 * Those only exist against a real subprocess, so the tests spawn one and vary
 * its *behaviour* rather than faking the process API.
 *
 * Every behaviour writes an append-only log of the frames it received, so a test
 * can prove what the supervisor actually did (e.g. that `abort` arrived before
 * stdin closed) instead of inferring it from the supervisor's own bookkeeping.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type FakeChildBehavior =
	/** Full handshake, answers every request, exits 0 on stdin EOF. */
	| "ok"
	/** Reads stdin, never writes a frame — the handshake times out. */
	| "silent"
	/** Rejects the handshake the way a legacy binary would. */
	| "hello-error"
	/** Acks with an incompatible protocol version. */
	| "bad-version"
	/** Exits before answering `hello`. */
	| "exit-on-hello"
	/** Acks, then crashes after `crashAfterMs` — the restart path. */
	| "crash-after-ready"
	/**
	 * Crashes after `crashAfterMs` on its FIRST incarnation only and behaves
	 * normally on every relaunch (detected through the fixture log), so
	 * "crash then recover" is deterministic instead of racing a timer.
	 */
	| "crash-first-boot"
	/** Acks, answers nothing, and survives both stdin EOF and SIGTERM. */
	| "eof-blind";

export interface FakeChildOptions {
	behavior?: FakeChildBehavior;
	/** Crash delay for the crash behaviours, in milliseconds. */
	crashAfterMs?: number;
	/** Exit code used by the crash behaviours. */
	crashCode?: number;
	/**
	 * Leak guard: exit on its own after this many ms (0 = never). Off by default;
	 * `eof-blind` uses it so a child that walks away from the stop ladder cannot
	 * outlive the test run.
	 */
	selfExitMs?: number;
}

export interface FakeChild {
	/** Executable path to pass as `ChildSessionCommand.bin`. */
	path: string;
	/** Environment that selects this fixture's behaviour (merge into the spawn env). */
	env: Record<string, string>;
	/** Requests the child received, in order (e.g. `["abort"]`). */
	receivedRequests(): Promise<string[]>;
	/** Every entry the child wrote to its log, in order. */
	events(): Promise<Array<Record<string, unknown>>>;
	/** True when the child recorded surviving a SIGTERM. */
	survivedSigterm(): Promise<boolean>;
	/** The child's own pid, as recorded by the child. */
	recordedPid(): Promise<number | null>;
	/**
	 * Ask the child to exit through its own control channel.
	 *
	 * Cleanup must never SIGKILL: the whole point of this suite is that a child is
	 * never destroyed, and the product deliberately declines to do it. So a child
	 * that walked away from the stop ladder is asked to leave the way any other
	 * cooperating process would — out of band from the wire protocol it ignored.
	 */
	requestExit(): Promise<void>;
	/** Wait, bounded, until the child process is gone. Returns false if it outlasts the budget. */
	awaitExit(timeoutMs?: number): Promise<boolean>;
	/**
	 * True when the child left because it was ASKED to, via the control channel.
	 *
	 * Distinguishes the intended path from the bounded self-exit backstop, so a
	 * broken control channel cannot pass as a clean teardown.
	 */
	exitedViaControl(): Promise<boolean>;
	cleanup(): Promise<void>;
}

const SCRIPT = `#!/usr/bin/env bun
// Fake child session: a real process speaking the wire protocol on stdio.
import { appendFileSync, readFileSync } from "node:fs";

const behavior = process.env.FAKE_CHILD_BEHAVIOR ?? "ok";
const crashAfterMs = Number(process.env.FAKE_CHILD_CRASH_MS ?? 50);
const crashCode = Number(process.env.FAKE_CHILD_CRASH_CODE ?? 7);
const logPath = process.env.FAKE_CHILD_LOG;

const log = (entry) => {
	if (!logPath) return;
	try {
		appendFileSync(logPath, JSON.stringify(entry) + "\\n");
	} catch {}
};

// Out-of-band control channel. The supervisor never force-kills, so a behaviour
// that ignores stdin EOF and SIGTERM needs a way to leave that is not a signal:
// the test writes the control file and this process exits on its own.
const controlPath = process.env.FAKE_CHILD_CONTROL;
if (controlPath) {
	setInterval(() => {
		try {
			if (readFileSync(controlPath, "utf8").includes('"action":"exit"')) {
				log({ event: "control-exit" });
				process.exit(0);
			}
		} catch {}
	}, 50);
}

// Leak guard: a bounded lifetime, so a child that ignores everything still
// cannot outlive the test run.
const selfExitMs = Number(process.env.FAKE_CHILD_SELF_EXIT_MS ?? 0);
if (selfExitMs > 0) setTimeout(() => process.exit(0), selfExitMs);

const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");

// A relaunch is a fresh process; the log is what tells it this is not the first boot.
const isRelaunch = () => {
	if (!logPath) return false;
	try {
		return readFileSync(logPath, "utf8").includes('"event":"ready"');
	} catch {
		return false;
	}
};

/** True on a crash-first-boot incarnation that dies without answering anything. */
let doomed = false;

// eof-blind walks away from the whole ladder: EOF and SIGTERM are both ignored,
// so the supervisor has to report a stop it could not complete. It leaves only
// via the control channel or the bounded self-exit — never because it was killed.
if (behavior === "eof-blind") process.on("SIGTERM", () => log({ event: "sigterm-ignored" }));

function crashSoon() {
	setTimeout(() => process.exit(crashCode), crashAfterMs).unref?.();
}

function handleLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return;
	let frame;
	try {
		frame = JSON.parse(trimmed);
	} catch {
		return;
	}

	if (frame.type === "hello") {
		if (behavior === "exit-on-hello") process.exit(crashCode);
		if (behavior === "silent") return;
		if (behavior === "hello-error") {
			emit({ type: "hello_error", error: "legacy binary: no wire protocol support" });
			process.exit(1);
		}
		if (behavior === "bad-version") {
			emit({ type: "hello_ack", connectionId: "fake-child", protocolVersion: 0 });
			return;
		}
		// Read the log BEFORE recording this boot, or this boot would look like a relaunch.
		doomed = behavior === "crash-first-boot" && !isRelaunch();
		emit({ type: "hello_ack", connectionId: "fake-child", protocolVersion: 1 });
		log({ event: "ready", pid: process.pid });
		if (behavior === "crash-after-ready") crashSoon();
		if (doomed) crashSoon();
		return;
	}

	if (frame.type === "request") {
		const command = frame.command?.type ?? "unknown";
		log({ event: "request", command });
		// A doomed incarnation answers nothing — it dies with the request in flight.
		if (doomed || behavior === "eof-blind") return;
		// Faithful to the real server: the response carries command.id, not the
		// frame's own id. Answering with frame.id would hide a client that only
		// stamps the frame and never the command.
		const responseId = frame.command && frame.command.id ? frame.command.id : frame.id;
		emit({ type: "response", id: responseId, ok: true, result: { command, pid: process.pid } });
	}
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\\n");
	while (newline !== -1) {
		handleLine(buffered.slice(0, newline));
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\\n");
	}
}
handleLine(buffered);

log({ event: "stdin-eof" });
// eof-blind ignores EOF and SIGTERM on purpose; it leaves via the control channel
// or the bounded self-exit, never because something killed it.
if (behavior === "eof-blind") setInterval(() => {}, 1000);
else process.exit(0);
`;

/**
 * Write the fixture to a temp dir and return a handle.
 *
 * Each fixture gets its own log file so a test can assert exactly what this
 * child received, including after it is gone.
 */
export async function createFakeChildSession(options: FakeChildOptions = {}): Promise<FakeChild> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-child-"));
	const scriptPath = path.join(dir, "fake-child");
	const logPath = path.join(dir, "received.jsonl");
	const controlPath = path.join(dir, "control.json");
	await fs.writeFile(scriptPath, SCRIPT, { mode: 0o755 });
	await fs.writeFile(logPath, "");
	// eof-blind ignores everything the stop ladder can send, so it gets the bounded
	// self-exit as a leak guard; every other behaviour exits on stdin EOF. The guard
	// is far longer than any cleanup budget, so a passing test can only be the
	// control channel doing the work.
	const selfExitMs = options.selfExitMs ?? (options.behavior === "eof-blind" ? 30_000 : 0);
	// A local closure rather than `this`: the methods below are handed out as a
	// plain object, and reaching through `this` makes the handle's own type depend
	// on how it was built.
	const recordedPid = async (): Promise<number | null> => {
		const entries = await readLog(logPath);
		const ready = entries.find(entry => entry.event === "ready");
		return ready ? Number(ready.pid) : null;
	};

	return {
		path: scriptPath,
		env: {
			FAKE_CHILD_BEHAVIOR: options.behavior ?? "ok",
			FAKE_CHILD_CRASH_MS: String(options.crashAfterMs ?? 50),
			FAKE_CHILD_CRASH_CODE: String(options.crashCode ?? 7),
			FAKE_CHILD_LOG: logPath,
			FAKE_CHILD_CONTROL: controlPath,
			FAKE_CHILD_SELF_EXIT_MS: String(selfExitMs),
		},
		async receivedRequests(): Promise<string[]> {
			const entries = await readLog(logPath);
			return entries.filter(entry => entry.event === "request").map(entry => String(entry.command));
		},
		async events(): Promise<Array<Record<string, unknown>>> {
			return await readLog(logPath);
		},
		async survivedSigterm(): Promise<boolean> {
			const entries = await readLog(logPath);
			return entries.some(entry => entry.event === "sigterm-ignored");
		},
		recordedPid,
		async requestExit(): Promise<void> {
			await fs.writeFile(controlPath, JSON.stringify({ action: "exit" }));
		},
		async awaitExit(timeoutMs = 8_000): Promise<boolean> {
			const pid = await recordedPid();
			if (pid === null) return true;
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (!isProcessAlive(pid)) return true;
				await Bun.sleep(20);
			}
			return false;
		},
		async exitedViaControl(): Promise<boolean> {
			const entries = await readLog(logPath);
			return entries.some(entry => entry.event === "control-exit");
		},
		async cleanup(): Promise<void> {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await Bun.file(logPath).text();
		return text
			.split("\n")
			.filter(line => line.trim())
			.map(line => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is Record<string, unknown> => entry !== null);
	} catch {
		return [];
	}
}
