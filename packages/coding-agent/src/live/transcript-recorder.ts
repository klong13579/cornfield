/**
 * LiveTranscriptRecorder — merges finalized voice turns into the main session.
 *
 * Every final transcript (user or assistant) becomes a `custom_message` entry
 * with customType "voice" in the session tree, so it lands in BOTH the JSONL
 * log and the LLM context for subsequent turns (text and voice share one
 * history — the OpenClaw "session merge" pattern).
 *
 * Partial transcripts are ignored; the controller emits finals once per turn.
 */
import type { SessionManager } from "../session/session-manager";
import type { LiveTranscript } from "./types";

export interface TranscriptSessionTarget {
	sessionManager: Pick<SessionManager, "appendCustomMessageEntry">;
}

export const VOICE_MESSAGE_TYPE = "voice";

export class LiveTranscriptRecorder {
	readonly #target: TranscriptSessionTarget;
	/** Dedup guard: the same final text can arrive twice (done + response.done). */
	#lastRecorded: { role: string; text: string } | undefined;

	constructor(target: TranscriptSessionTarget) {
		this.#target = target;
	}

	record(transcript: LiveTranscript): void {
		if (!transcript.final) {
			// A partial marks a new turn in progress — reset the dedup guard.
			this.#lastRecorded = undefined;
			return;
		}
		const text = transcript.text.trim();
		if (!text) return;
		if (this.#lastRecorded?.role === transcript.role && this.#lastRecorded.text === text) return;
		this.#lastRecorded = { role: transcript.role, text };
		this.#target.sessionManager.appendCustomMessageEntry(
			VOICE_MESSAGE_TYPE,
			text,
			true,
			{ role: transcript.role, source: "voice" },
			transcript.role === "user" ? "user" : "agent",
		);
	}
}
