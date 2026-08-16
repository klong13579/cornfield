import { afterEach, describe, expect, test, vi } from "bun:test";
import { pcm16ToFloat32 } from "../../src/stt/pcm";
import { createStreamingTranscriber } from "../../src/stt/streaming";
import { getTranscriptionKind } from "../../src/stt/stt-controller";

/**
 * Fake WebSocket capturing sent messages + letting the test drive the event
 * side. Every constructed instance is recorded so the test can reach the one
 * `createStreamingTranscriber` actually created (Bun's WS is a global; we
 * swap it for the duration of each test and restore in afterEach).
 */
class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static CONNECTING = 0;
	readyState = FakeWebSocket.OPEN;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;

	constructor(
		public url: string,
		public init?: { headers?: Record<string, string> },
	) {
		instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	// ---- test helpers ----
	open(): void {
		this.onopen?.();
	}
	emit(type: string, payload: Record<string, unknown> = {}): void {
		this.onmessage?.({ data: JSON.stringify({ type, ...payload }) });
	}
	lastSent(): Record<string, unknown> {
		return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
	}
}

const instances: FakeWebSocket[] = [];
const originalWebSocket = globalThis.WebSocket as unknown;

function installFakeWs(): void {
	instances.length = 0;
	(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

/** The ws instance created by the last createStreamingTranscriber call. */
function fakeWs(): FakeWebSocket {
	expect(instances.length).toBeGreaterThan(0);
	return instances[instances.length - 1]!;
}

afterEach(() => {
	(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

const BASE = { baseUrl: "https://coder.narwal.com/v1", apiKey: "test-key" };
const FAST_ACK = { configAckTimeoutMs: 200 };

describe("getTranscriptionKind", () => {
	test("whisper model ids → local", () => {
		expect(getTranscriptionKind("mlx-community/whisper-large-v3-turbo")).toBe("local");
		expect(getTranscriptionKind("mlx-community/whisper-base")).toBe("local");
	});

	test("qwen audio models → streaming", () => {
		expect(getTranscriptionKind("qwen-audio-3.0-realtime-plus")).toBe("streaming");
		expect(getTranscriptionKind("qwen-audio-3.0-realtime-flash")).toBe("streaming");
		expect(getTranscriptionKind("narwal-plan/qwen-audio-3.0-realtime-plus")).toBe("streaming");
	});

	test("undefined → local (backward compatible default)", () => {
		expect(getTranscriptionKind(undefined)).toBe("local");
	});
});

describe("createStreamingTranscriber", () => {
	test("commit times out when server never sends completed (stop deadlock)", async () => {
		installFakeWs();
		const ready = createStreamingTranscriber({
			...BASE,
			...FAST_ACK,
			commitTimeoutMs: 200,
			model: "qwen-audio-3.0-realtime-plus",
		});
		const ws = fakeWs();
		ws.open();
		ws.emit("session.created");
		ws.emit("session.updated");
		await ready;

		// Feed some audio, then commit; the server stays silent.
		const transcriber = await ready;
		transcriber.feed(new Float32Array(1600));
		transcriber.feed(new Float32Array(1600));
		const commit = transcriber.commit();

		// Must resolve on the timeout, not hang forever (this is what kept
		// alt+h from stopping STT when the server never acked the commit).
		let settled = false;
		void commit.then(() => (settled = true));
		await Bun.sleep(50);
		expect(settled).toBe(false);
		await Bun.sleep(250);
		expect(settled).toBe(true);

		// A second commit after timeout must work (state was cleaned up).
		const commit2 = transcriber.commit();
		let settled2 = false;
		void commit2.then(() => (settled2 = true));
		await Bun.sleep(50);
		expect(settled2).toBe(false);

		ws.emit("conversation.item.input_audio_transcription.completed", { transcript: "ok" });
		await Bun.sleep(10);
		expect(settled2).toBe(true);
	});

	test("handshake: session.update config after session.created", async () => {
		installFakeWs();
		const onPartial = vi.fn();
		const onSegment = vi.fn();
		const ready = createStreamingTranscriber({
			...BASE,
			...FAST_ACK,
			model: "qwen-audio-3.0-realtime-plus",
			onPartial,
			onSegment,
		});
		const ws = fakeWs();

		ws.open();
		// Not ready until session.updated arrives.
		let settled = false;
		void ready.then(() => (settled = true));
		await Bun.sleep(10);
		expect(settled).toBe(false);

		ws.emit("session.created");
		const update = ws.lastSent();
		expect(update.type).toBe("session.update");
		expect(update.session).toEqual({
			modalities: ["text"],
			input_audio_format: "pcm16",
			input_audio_transcription: { model: "fun-asr" },
			turn_detection: null,
		});

		ws.emit("session.updated");
		await ready;
		expect(settled).toBe(true);
	});

	test("feed() resamples 16k→24k and appends base64 pcm16 audio", async () => {
		installFakeWs();
		const ready = createStreamingTranscriber({
			...BASE,
			...FAST_ACK,
			model: "qwen-audio-3.0-realtime-plus",
		});
		const ws = fakeWs();
		ws.open();
		ws.emit("session.created");
		ws.emit("session.updated");
		const transcriber = await ready;

		// 400 samples @16k = 400ms of audio; 24k resample ⇒ 600 samples
		// (sent as 200ms slices; flush threshold is 100ms so both slices go out).
		const samples = new Float32Array(400).map((_, i) => Math.sin(i / 10) * 0.5);
		transcriber.feed(samples);

		let sawAppend = false;
		let appendedSamples = 0;
		for (const raw of ws.sent) {
			const msg = JSON.parse(raw) as Record<string, unknown>;
			if (msg.type === "input_audio_buffer.append") {
				sawAppend = true;
				const pcm = Uint8Array.from(atob(msg.audio as string), c => c.charCodeAt(0));
				appendedSamples += pcm.length / 2;
			}
		}
		expect(sawAppend).toBe(true);
		expect(appendedSamples).toBeGreaterThanOrEqual(598);
		expect(appendedSamples).toBeLessThanOrEqual(1204);
	});

	test("delta → onPartial, completed → onSegment and commit() resolves", async () => {
		installFakeWs();
		const onPartial = vi.fn();
		const onSegment = vi.fn();
		const ready = createStreamingTranscriber({
			...BASE,
			...FAST_ACK,
			model: "qwen-audio-3.0-realtime-plus",
			onPartial,
			onSegment,
		});
		const ws = fakeWs();
		ws.open();
		ws.emit("session.created");
		ws.emit("session.updated");
		const transcriber = await ready;

		ws.emit("conversation.item.input_audio_transcription.delta", { delta: "你好" });
		ws.emit("conversation.item.input_audio_transcription.delta", { delta: "世界" });
		expect(onPartial).toHaveBeenLastCalledWith("你好世界");

		let committed = false;
		const commitPromise = transcriber.commit().then(() => (committed = true));
		expect(ws.lastSent().type).toBe("input_audio_buffer.commit");
		await Bun.sleep(10);
		expect(committed).toBe(false);

		ws.emit("conversation.item.input_audio_transcription.completed", { transcript: "你好世界" });
		await commitPromise;
		expect(onSegment).toHaveBeenCalledWith("你好世界");
		expect(committed).toBe(true);
	});

	test("rejects when session.updated never arrives", async () => {
		installFakeWs();
		const ready = createStreamingTranscriber({ ...BASE, ...FAST_ACK, model: "qwen-audio-3.0-realtime-plus" });
		const ws = fakeWs();
		ws.open();
		ws.emit("session.created");
		await expect(ready).rejects.toThrow("session config not acked");
	});

	test("audio round-trip integrity: pcm16 content preserved through base64", async () => {
		installFakeWs();
		const ready = createStreamingTranscriber({
			...BASE,
			...FAST_ACK,
			model: "qwen-audio-3.0-realtime-plus",
		});
		const ws = fakeWs();
		ws.open();
		ws.emit("session.created");
		ws.emit("session.updated");
		const transcriber = await ready;

		const samples = new Float32Array(200).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5));
		transcriber.feed(samples);

		const appends = ws.sent
			.map(raw => JSON.parse(raw) as Record<string, unknown>)
			.filter(m => m.type === "input_audio_buffer.append");
		expect(appends.length).toBeGreaterThan(0);
		const pcm = Uint8Array.from(atob(appends[0]!.audio as string), c => c.charCodeAt(0));
		const fl = pcm16ToFloat32(pcm);
		// First resampled sample ≈ first input sample (0.5). Allow resample drift.
		expect(Math.abs(fl[0]! - 0.5)).toBeLessThan(0.1);
	});
});
