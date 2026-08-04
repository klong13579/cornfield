/**
 * LiveTranscriptRecorder tests — real recorder against a recording target.
 */
import { describe, expect, test } from "bun:test";
import { LiveTranscriptRecorder, VOICE_MESSAGE_TYPE } from "../src/live/transcript-recorder";

interface RecordedEntry {
	customType: string;
	content: unknown;
	display: boolean;
	details: unknown;
	attribution: string;
}

function makeTarget() {
	const entries: RecordedEntry[] = [];
	const target = {
		sessionManager: {
			appendCustomMessageEntry(
				customType: string,
				content: unknown,
				display: boolean,
				details?: unknown,
				attribution?: "user" | "agent",
			) {
				entries.push({ customType, content, display, details, attribution: attribution ?? "agent" });
				return "id";
			},
		},
	};
	return { entries, target };
}

describe("LiveTranscriptRecorder", () => {
	test("final user and assistant transcripts become voice entries", () => {
		const { entries, target } = makeTarget();
		const recorder = new LiveTranscriptRecorder(target);
		recorder.record({ role: "user", text: "帮我看下待办", final: true });
		recorder.record({ role: "assistant", text: "三条待办。", final: true });

		expect(entries.length).toBe(2);
		expect(entries[0]).toEqual({
			customType: VOICE_MESSAGE_TYPE,
			content: "帮我看下待办",
			display: true,
			details: { role: "user", source: "voice" },
			attribution: "user",
		});
		expect(entries[1]).toMatchObject({ attribution: "agent", details: { role: "assistant", source: "voice" } });
	});

	test("partial transcripts and empty text are ignored", () => {
		const { entries, target } = makeTarget();
		const recorder = new LiveTranscriptRecorder(target);
		recorder.record({ role: "user", text: "帮我", final: false });
		recorder.record({ role: "user", text: "   ", final: true });
		expect(entries.length).toBe(0);
	});

	test("identical consecutive finals are deduped", () => {
		const { entries, target } = makeTarget();
		const recorder = new LiveTranscriptRecorder(target);
		recorder.record({ role: "assistant", text: "三条。", final: true });
		recorder.record({ role: "assistant", text: "三条。", final: true });
		expect(entries.length).toBe(1);
		// A partial marks a new turn: the same sentence records again.
		recorder.record({ role: "assistant", text: "三条", final: false });
		recorder.record({ role: "assistant", text: "三条。", final: true });
		expect(entries.length).toBe(2);
		recorder.record({ role: "user", text: "三条。", final: true });
		expect(entries.length).toBe(3);
	});
});
