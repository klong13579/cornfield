/**
 * OpenAI Realtime protocol types with wire-variant normalization.
 *
 * Verified against narwal-plan + qwen-audio-3.0-realtime (2026-08-04 bench):
 * - Audio deltas arrive as `response.audio.delta` / `response.audio_transcript.delta`
 *   (NOT the documented `response.output_audio.*` names). Both are accepted and
 *   folded into canonical names.
 * - fun-asr streaming transcription deltas carry `stash`/`text` fields instead of
 *   the standard `delta`. All three are normalized into a single `delta` string.
 */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Session metadata reported by `session.created` / `session.updated`. */
export interface RealtimeSessionInfo {
	id?: string;
	model?: string;
	voice?: string;
	modalities?: string[];
	raw: UnknownRecord;
}

/** Turn-detection configuration (server-side VAD). */
export interface RealtimeTurnDetection {
	type: "server_vad";
	threshold?: number;
	silence_duration_ms?: number;
	prefix_padding_ms?: number;
}

/** Function tool registered on the realtime session. `type` is always "function". */
export interface RealtimeFunctionTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Client-side session configuration sent via `session.update`. */
export interface RealtimeSessionConfig {
	modalities?: Array<"text" | "audio">;
	instructions?: string;
	voice?: string;
	input_audio_format?: "pcm16";
	output_audio_format?: "pcm16";
	input_audio_transcription?: { model: string };
	turn_detection?: RealtimeTurnDetection | null;
	tools?: RealtimeFunctionTool[];
	tool_choice?: "auto" | "none" | "required";
}

/** Events the client sends over the socket. */
export type RealtimeClientEvent =
	| { type: "session.update"; session: RealtimeSessionConfig }
	| { type: "input_audio_buffer.append"; audio: string }
	| { type: "input_audio_buffer.commit" }
	| { type: "input_audio_buffer.clear" }
	| { type: "response.create" }
	| { type: "response.cancel" }
	| { type: "conversation.item.create"; item: UnknownRecord };

/** Normalized server events. Wire aliases are folded into canonical names. */
export type RealtimeServerEvent =
	| { type: "session.created" | "session.updated"; session: RealtimeSessionInfo }
	| { type: "response.audio.delta"; delta: string }
	| { type: "response.created"; responseId?: string }
	| { type: "response.audio_transcript.delta"; delta: string }
	| { type: "response.audio_transcript.done"; transcript: string }
	| { type: "response.text.delta"; delta: string }
	| {
			type: "response.function_call_arguments.done";
			callId: string;
			name: string;
			arguments: string;
			responseId?: string;
	  }
	| { type: "response.done"; responseId?: string; raw: UnknownRecord }
	| { type: "input_audio_buffer.speech_started"; audioStartMs?: number; itemId?: string }
	| { type: "input_audio_buffer.speech_stopped"; audioEndMs?: number; itemId?: string }
	| { type: "input_audio_buffer.committed"; itemId?: string }
	| { type: "conversation.item.created"; item: UnknownRecord }
	| { type: "conversation.item.input_audio_transcription.delta"; delta: string; itemId?: string }
	| { type: "conversation.item.input_audio_transcription.completed"; transcript: string; itemId?: string }
	| { type: "conversation.item.truncated"; itemId?: string }
	| { type: "error"; message: string; code?: string; raw: UnknownRecord }
	| { type: "unknown"; wireType: string; raw: UnknownRecord };

function parseSession(raw: UnknownRecord): RealtimeSessionInfo {
	const session = isRecord(raw.session) ? raw.session : {};
	return {
		id: asString(session.id),
		model: asString(session.model),
		voice: asString(session.voice),
		modalities: Array.isArray(session.modalities) ? session.modalities.filter(m => typeof m === "string") : undefined,
		raw: session,
	};
}

/**
 * Parses one raw wire message into a normalized server event.
 * Unknown or malformed payloads become `{ type: "unknown" }` so callers never crash
 * on protocol drift — they decide what to ignore.
 */
export function parseRealtimeServerEvent(raw: unknown): RealtimeServerEvent {
	if (!isRecord(raw)) {
		return { type: "unknown", wireType: "<non-object>", raw: {} };
	}
	const wireType = asString(raw.type) ?? "<missing>";

	switch (wireType) {
		case "session.created":
		case "session.updated":
			return { type: wireType, session: parseSession(raw) };

		// narwal/qwen wire: response.audio.delta; OpenAI docs: response.output_audio.delta
		case "response.audio.delta":
		case "response.output_audio.delta":
			return { type: "response.audio.delta", delta: asString(raw.delta) ?? "" };

		case "response.audio_transcript.delta":
		case "response.output_audio_transcript.delta":
			return { type: "response.audio_transcript.delta", delta: asString(raw.delta) ?? "" };

		case "response.audio_transcript.done":
		case "response.output_audio_transcript.done":
			return { type: "response.audio_transcript.done", transcript: asString(raw.transcript) ?? "" };

		case "response.text.delta":
		case "response.output_text.delta":
			return { type: "response.text.delta", delta: asString(raw.delta) ?? "" };

		case "response.function_call_arguments.done":
			return {
				type: "response.function_call_arguments.done",
				callId: asString(raw.call_id) ?? "",
				name: asString(raw.name) ?? "",
				arguments: asString(raw.arguments) ?? "",
				responseId: asString(raw.response_id),
			};

		case "response.done":
			return {
				type: "response.done",
				responseId: isRecord(raw.response) ? asString(raw.response.id) : undefined,
				raw,
			};

		case "response.created":
			return {
				type: "response.created",
				responseId: isRecord(raw.response) ? asString(raw.response.id) : undefined,
			};

		case "input_audio_buffer.speech_started":
			return {
				type: "input_audio_buffer.speech_started",
				audioStartMs: asNumber(raw.audio_start_ms),
				itemId: asString(raw.item_id),
			};

		case "input_audio_buffer.speech_stopped":
			return {
				type: "input_audio_buffer.speech_stopped",
				audioEndMs: asNumber(raw.audio_end_ms),
				itemId: asString(raw.item_id),
			};

		case "input_audio_buffer.committed":
			return { type: "input_audio_buffer.committed", itemId: asString(raw.item_id) };

		case "conversation.item.created":
			return { type: "conversation.item.created", item: isRecord(raw.item) ? raw.item : {} };

		case "conversation.item.input_audio_transcription.delta": {
			// fun-asr uses `stash` (partial) and `text` (committed-so-far); standard is `delta`.
			const delta = asString(raw.delta) ?? asString(raw.stash) ?? asString(raw.text) ?? "";
			return { type: "conversation.item.input_audio_transcription.delta", delta, itemId: asString(raw.item_id) };
		}

		case "conversation.item.input_audio_transcription.completed":
			return {
				type: "conversation.item.input_audio_transcription.completed",
				transcript: asString(raw.transcript) ?? "",
				itemId: asString(raw.item_id),
			};

		case "conversation.item.truncated":
		case "response.output_audio_item.output_audio_truncated":
			return { type: "conversation.item.truncated", itemId: asString(raw.item_id) };

		case "error": {
			const err = isRecord(raw.error) ? raw.error : {};
			return {
				type: "error",
				message: asString(err.message) ?? "unknown realtime error",
				code: asString(err.code),
				raw,
			};
		}

		default:
			return { type: "unknown", wireType, raw };
	}
}
