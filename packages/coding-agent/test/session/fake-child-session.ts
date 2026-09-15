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
	/** True when the child recorded surviving a SIGTERM — only SIGKILL could follow. */
	survivedSigterm(): Promise<boolean>;
	/** The child's own pid, as recorded by the child. */
	recordedPid(): Promise<number | null>;
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

// eof-blind must also survive SIGTERM, so the supervisor has to escalate to SIGKILL.
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
	await fs.writeFile(scriptPath, SCRIPT, { mode: 0o755 });
	await fs.writeFile(logPath, "");

	return {
		path: scriptPath,
		env: {
			FAKE_CHILD_BEHAVIOR: options.behavior ?? "ok",
			FAKE_CHILD_CRASH_MS: String(options.crashAfterMs ?? 50),
			FAKE_CHILD_CRASH_CODE: String(options.crashCode ?? 7),
			FAKE_CHILD_LOG: logPath,
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
		async recordedPid(): Promise<number | null> {
			const entries = await readLog(logPath);
			const ready = entries.find(entry => entry.event === "ready");
			return ready ? Number(ready.pid) : null;
		},
		async cleanup(): Promise<void> {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
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
