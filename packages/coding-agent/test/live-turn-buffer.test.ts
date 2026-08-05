/**
 * LiveTurnBuffer tests — the design §7 dedup rule: one utterance = one record
 * in the main session.
 */
import { describe, expect, test } from "bun:test";
import { LiveTurnBuffer, type TurnBufferTarget } from "../src/live/turn-buffer";

class FakeRecorder implements TurnBufferTarget {
	recorded: Array<{ role: string; text: string; final: boolean }> = [];
	record(transcript: { role: "user" | "assistant"; text: string; final: boolean }): void {
		this.recorded.push(transcript);
	}
}

describe("LiveTurnBuffer", () => {
	test("flush records the held utterance exactly once", () => {
		const recorder = new FakeRecorder();
		const buffer = new LiveTurnBuffer(recorder);
		buffer.hold("查一下天气");
		buffer.flush();
		buffer.flush(); // second flush is a no-op
		expect(recorder.recorded).toEqual([{ role: "user", text: "查一下天气", final: true }]);
		expect(buffer.pending).toBe(false);
	});

	test("drop suppresses the held utterance (task injection is canonical)", () => {
		const recorder = new FakeRecorder();
		const buffer = new LiveTurnBuffer(recorder);
		buffer.hold("把 TODO.md 第一条标完成");
		buffer.drop();
		buffer.flush();
		expect(recorder.recorded).toEqual([]);
	});

	test("timeout auto-flushes (direct chat answers never classify)", async () => {
		const recorder = new FakeRecorder();
		const buffer = new LiveTurnBuffer(recorder, 20);
		buffer.hold("你好");
		await Bun.sleep(60);
		expect(recorder.recorded).toEqual([{ role: "user", text: "你好", final: true }]);
	});

	test("hold replaces a previous pending turn without recording it", () => {
		const recorder = new FakeRecorder();
		const buffer = new LiveTurnBuffer(recorder);
		buffer.hold("第一条");
		buffer.hold("第二条");
		buffer.flush();
		expect(recorder.recorded).toEqual([{ role: "user", text: "第二条", final: true }]);
	});

	test("flush/drop without a pending turn are no-ops", () => {
		const recorder = new FakeRecorder();
		const buffer = new LiveTurnBuffer(recorder);
		buffer.flush();
		buffer.drop();
		expect(recorder.recorded).toEqual([]);
	});
});
