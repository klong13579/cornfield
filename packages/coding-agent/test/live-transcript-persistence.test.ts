/**
 * Voice transcript → session JSONL integration test (P0e acceptance).
 * Real SessionManager in a real temp dir, real JSONL on disk — no fakes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";
import { LiveTranscriptRecorder, VOICE_MESSAGE_TYPE } from "../src/live/transcript-recorder";

let tempDir = "";

afterEach(async () => {
	if (tempDir) {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

describe("voice transcript persistence (real SessionManager)", () => {
	test("final voice turns land in the session JSONL and rehydrate", async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-voice-p0e-"));
		const manager = SessionManager.create(process.cwd(), tempDir);

		const recorder = new LiveTranscriptRecorder({ sessionManager: manager });
		recorder.record({ role: "user", text: "帮我看下 TODO 有几条待办", final: true });
		recorder.record({ role: "user", text: "帮我", final: false }); // partial: ignored
		recorder.record({ role: "assistant", text: "TODO 里有 3 条待办。", final: true });

		// 1. In-memory branch carries the voice entries in order.
		const branch = manager.getBranch();
		const voiceEntries = branch.filter(
			entry => entry.type === "custom_message" && (entry as { customType?: string }).customType === VOICE_MESSAGE_TYPE,
		);
		expect(voiceEntries.length).toBe(2);
		// Writes are queued asynchronously; flush before asserting on disk.
		await manager.flush();

		// 2. The JSONL on disk contains them with the voice marker and attribution.
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const raw = await fs.promises.readFile(sessionFile!, "utf8");
		const lines = raw
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const persisted = lines.filter(l => l.type === "custom_message" && l.customType === VOICE_MESSAGE_TYPE);
		expect(persisted.length).toBe(2);
		expect(persisted[0]).toMatchObject({ attribution: "user", details: { role: "user", source: "voice" } });
		expect(persisted[1]).toMatchObject({ attribution: "agent", details: { role: "assistant", source: "voice" } });

		// 3. Reopening the session rehydrates the voice turns into history.
		const reopened = await SessionManager.open(sessionFile!);
		const rehydrated = reopened
			.getBranch()
			.filter(
				entry =>
					entry.type === "custom_message" && (entry as { customType?: string }).customType === VOICE_MESSAGE_TYPE,
			);
		expect(rehydrated.length).toBe(2);
	});
});
