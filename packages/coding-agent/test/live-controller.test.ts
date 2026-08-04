/**
 * LiveSessionController tests. Real local WS server (per repo policy), scripted
 * audio source/sink — no hardware, no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pcm16ToBase64, RealtimeWsTransport } from "@oh-my-pi/pi-ai";
import { LiveSessionController } from "../src/live/controller";
import type { LiveAudioSink, LivePhase, LiveTranscript } from "../src/live/types";

// ------------------------------------------------------------ WS server ---

interface TestServer {
	url: string;
	received: Array<Record<string, unknown>>;
	send(obj: unknown): void;
	stop(): void;
}

function startServer(options: { ackConfig?: boolean } = {}): TestServer {
	const ackConfig = options.ackConfig ?? true;
	const received: Array<Record<string, unknown>> = [];
	let current: { send(data: string): void } | undefined;
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("nope", { status: 400 });
		},
		websocket: {
			open(ws) {
				current = ws;
				ws.send(JSON.stringify({ type: "session.created", session: { id: "s1", model: "m" } }));
			},
			message(ws, msg) {
				const parsed = JSON.parse(String(msg)) as Record<string, unknown>;
				received.push(parsed);
				// Real servers ack session.update with session.updated; the uplink
				// gate waits for this (or its timeout fallback).
				if (ackConfig && parsed.type === "session.update") {
					ws.send(JSON.stringify({ type: "session.updated", session: {} }));
				}
			},
			close() {
				current = undefined;
			},
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		received,
		send(obj) {
			current?.send(JSON.stringify(obj));
		},
		stop() {
			server.stop(true);
		},
	};
}

// ---------------------------------------------------------------- fakes ---

class ScriptedSource {
	onChunk: ((samples: Float32Array) => void) | undefined;
	started = false;
	start(cb: (samples: Float32Array) => void): void {
		this.onChunk = cb;
		this.started = true;
	}
	stop(): void {
		this.started = false;
	}
	emit(level: number, frames = 480): void {
		const samples = new Float32Array(frames).fill(level);
		this.onChunk?.(samples);
	}
}

class ScriptedSink implements LiveAudioSink {
	writes = 0;
	stopped = false;
	ended = false;
	#gate: Promise<void> | undefined;
	#release: (() => void) | undefined;
	constructor(holdEnd: boolean) {
		if (holdEnd) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#gate = promise;
			this.#release = resolve;
		}
	}
	write(): void {
		this.writes++;
	}
	end(): Promise<void> {
		this.ended = true;
		return this.#gate ?? Promise.resolve();
	}
	stop(): void {
		this.stopped = true;
		// stop() aborts playback — a pending drain must settle, never hang.
		this.#release?.();
	}
	releaseEnd(): void {
		this.#release?.();
	}
}

interface SessionUpdateMsg {
	session?: { tools?: Array<{ name: string; type?: string }> };
}

interface ConversationItemMsg {
	item?: { output?: string };
}

interface Harness {
	controller: LiveSessionController;
	server: TestServer;
	source: ScriptedSource;
	sinks: ScriptedSink[];
	phases: LivePhase[];
	transcripts: LiveTranscript[];
	terminals: Array<Error | undefined>;
}

interface HarnessOptions {
	bargeInLevel?: number;
	bargeInEnabled?: boolean;
	onConsult?: (task: string) => Promise<string>;
	/** Server acks session.update with session.updated (default true). */
	ackConfig?: boolean;
	/** Hold sink.end() until releaseEnd() — simulates playback still draining. */
	holdSinkEnd?: boolean;
}

async function waitForPhase(h: Pick<Harness, "controller">, want: LivePhase, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (h.controller.phase === want) return;
		await Bun.sleep(5);
	}
	throw new Error(`phase "${want}" not reached, still "${h.controller.phase}"`);
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
	const server = startServer({ ackConfig: options.ackConfig ?? true });
	const source = new ScriptedSource();
	const sinks: ScriptedSink[] = [];
	const phases: LivePhase[] = [];
	const transcripts: LiveTranscript[] = [];
	const terminals: Array<Error | undefined> = [];
	const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "k", model: "m" });
	const controller = new LiveSessionController({
		transport,
		source,
		sinkFactory: () => {
			const sink = new ScriptedSink(options.holdSinkEnd ?? false);
			sinks.push(sink);
			return sink;
		},
		session: { modalities: ["text", "audio"] },
		callbacks: {
			onPhase: p => phases.push(p),
			onLevels: () => {},
			onTranscript: t => transcripts.push(t),
			onTerminal: err => terminals.push(err),
		},
		bargeInLevel: options.bargeInLevel,
		bargeInEnabled: options.bargeInEnabled,
		onConsult: options.onConsult,
	});
	await controller.start();
	// Deterministic handshake: config sent on session.created, acked by the
	// server, uplink gate opens → listening. Skipped for no-ack servers.
	if (options.ackConfig !== false) await waitForPhase({ controller }, "listening");
	return { controller, server, source, sinks, phases, transcripts, terminals };
}

const loudPcm = pcm16ToBase64(new Uint8Array(960).fill(120));
/** Playback at realistic speech RMS (~0.08); loudPcm's 0.94 puts the echo floor out of reach. */
const moderatePcm = pcm16ToBase64(new Uint8Array(960).fill(10));

/** Polls until a message of `type` lands on the server (send/receive races are real over WS). */
async function waitForMessage(server: TestServer, type: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = server.received.find(m => m.type === type);
		if (found) return found;
		await Bun.sleep(10);
	}
	throw new Error(`server never received ${type}`);
}

function lastAppendAudio(server: TestServer): Uint8Array | undefined {
	const appends = server.received.filter(m => m.type === "input_audio_buffer.append") as Array<{ audio: string }>;
	const last = appends.at(-1);
	return last ? Buffer.from(last.audio, "base64") : undefined;
}

describe("LiveSessionController", () => {
	const servers: TestServer[] = [];
	afterEach(() => {
		while (servers.length) servers.pop()!.stop();
	});

	test("connects, sends session.update with consult tool, mic streams append frames", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		expect(h.phases).toContain("connecting");
		expect(h.phases).toContain("listening");

		const sessionUpdate = (await waitForMessage(h.server, "session.update")) as SessionUpdateMsg;
		const tools = sessionUpdate?.session?.tools ?? [];
		expect(tools.some(t => t.name === "omp_agent_consult" && t.type === "function")).toBe(true);

		h.source.emit(0.5);
		await Bun.sleep(20);
		expect(h.server.received.some(m => m.type === "input_audio_buffer.append")).toBe(true);
		await h.controller.dispose();
	});

	test("uplink stays gated until session.updated ack arrives", async () => {
		const h = await makeHarness({ ackConfig: false });
		servers.push(h.server);
		await waitForMessage(h.server, "session.update");
		expect(h.controller.phase).toBe("connecting");

		// No ack yet — mic frames must NOT reach the wire (config race guard).
		h.source.emit(0.5);
		await Bun.sleep(30);
		expect(h.server.received.some(m => m.type === "input_audio_buffer.append")).toBe(false);

		h.server.send({ type: "session.updated", session: {} });
		await waitForPhase(h, "listening");
		h.source.emit(0.5);
		await Bun.sleep(30);
		expect(h.server.received.some(m => m.type === "input_audio_buffer.append")).toBe(true);
		await h.controller.dispose();
	});

	test("speech_stopped → thinking; audio delta → speaking and sink receives samples", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "input_audio_buffer.speech_stopped" });
		await Bun.sleep(20);
		expect(h.phases.at(-1)).toBe("thinking");

		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await Bun.sleep(20);
		expect(h.phases.at(-1)).toBe("speaking");
		expect(h.sinks.length).toBe(1);
		expect(h.sinks[0]!.writes).toBe(1);
		await h.controller.dispose();
	});

	test("echo break: while speaking, mic chunks uplink silence instead of room audio", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await waitForPhase(h, "speaking");

		h.source.emit(0.001); // room noise / speaker bleed — must not reach the server
		await Bun.sleep(20);
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.every(b => b === 0)).toBe(true);
		await h.controller.dispose();
	});

	test("client-side barge-in: sustained loud speech during speaking cancels and reopens uplink", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await waitForPhase(h, "speaking");

		// Fewer than five loud chunks are not enough (sustain gate) — uplink stays silence.
		h.source.emit(0.5);
		h.source.emit(0.5);
		h.source.emit(0.5);
		h.source.emit(0.5);
		await Bun.sleep(20);
		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);

		h.source.emit(0.5); // 5th consecutive loud chunk → barge-in
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(true);
		expect(h.sinks[0]!.stopped).toBe(true);
		expect(h.phases).toContain("interrupted");
		expect(h.phases.at(-1)).toBe("listening");
		// The loud chunk itself is forwarded so the server hears the new turn.
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.some(b => b !== 0)).toBe(true);
		await h.controller.dispose();
	});

	test("barge-in: loud speech_started during speaking cancels response and discards sink", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await Bun.sleep(20);
		expect(h.phases.at(-1)).toBe("speaking");

		h.source.emit(0.5); // loud mic input → passes the echo gate
		h.server.send({ type: "input_audio_buffer.speech_started" });
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(true);
		expect(h.sinks[0]!.stopped).toBe(true);
		expect(h.phases).toContain("interrupted");
		expect(h.phases.at(-1)).toBe("listening");
		await h.controller.dispose();
	});

	test("echo gate: quiet speech_started during speaking is ignored", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await Bun.sleep(20);

		h.source.emit(0.001); // speaker bleed, below bargeInLevel
		h.server.send({ type: "input_audio_buffer.speech_started" });
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);
		expect(h.phases.at(-1)).toBe("speaking"); // echo ignored: assistant keeps talking
		expect(h.sinks[0]!.stopped).toBe(false);
		await h.controller.dispose();
	});


	test("barge-in disabled: loud speech during speaking never interrupts playback", async () => {
		const h = await makeHarness({ bargeInEnabled: false });
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await waitForPhase(h, "speaking");

		// Far above any threshold, sustained — with barge-in off it must be ignored.
		for (let i = 0; i < 10; i++) h.source.emit(0.9);
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);
		expect(h.phases.at(-1)).toBe("speaking"); // assistant keeps talking
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.every(b => b === 0)).toBe(true); // uplink stayed silence
		await h.controller.dispose();
	});

	test("self-loop guard: sustained bleed above the fixed floor but below the echo floor never barges in", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await waitForPhase(h, "speaking");

		// Speaker bleed: louder than the old fixed threshold (0.04) but below the
		// playback-scaled echo floor (2 × playback RMS). Sustained — the exact loop trigger.
		for (let i = 0; i < 10; i++) h.source.emit(0.1);
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);
		expect(h.phases.at(-1)).toBe("speaking");
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.every(b => b === 0)).toBe(true); // uplink stayed silence
		await h.controller.dispose();
	});

	test("drain window: echo floor stays up after response.done until the tail decays", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await waitForPhase(h, "speaking");
		h.server.send({ type: "response.done" });
		await Bun.sleep(20); // draining: phase still "speaking", tail physically playing

		expect(h.controller.phase).toBe("speaking");
		// Bleed arriving with the tail: above the fixed floor, below the echo floor.
		for (let i = 0; i < 5; i++) h.source.emit(0.1);
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.every(b => b === 0)).toBe(true);
		await h.controller.dispose();
	});

	test("mute swaps mic frames for silence", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.controller.setMuted(true);
		h.source.emit(0.9);
		await Bun.sleep(20);
		const pcm = lastAppendAudio(h.server);
		expect(pcm).toBeDefined();
		expect(pcm!.every(b => b === 0)).toBe(true);
		await h.controller.dispose();
	});

	test("consult function call routes through onConsult and returns output", async () => {
		let consulted: string | undefined;
		const h = await makeHarness({
			onConsult: async task => {
				consulted = task;
				return JSON.stringify({ count: 3 });
			},
		});
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			call_id: "c1",
			name: "omp_agent_consult",
			arguments: '{"task":"查TODO"}',
		});
		await Bun.sleep(50);
		expect(consulted).toBe("查TODO");
		const output = h.server.received.find(m => m.type === "conversation.item.create") as
			| ConversationItemMsg
			| undefined;
		expect(output?.item?.output).toBe('{"count":3}');
		expect(h.server.received.some(m => m.type === "response.create")).toBe(true);
		await h.controller.dispose();
	});

	test("transcripts flow for user and assistant", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "conversation.item.input_audio_transcription.delta", stash: "帮我" });
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "帮我看下待办。" });
		h.server.send({ type: "response.audio_transcript.delta", delta: "好的" });
		h.server.send({ type: "response.audio_transcript.done", transcript: "好的，三件事。" });
		await Bun.sleep(20);
		expect(h.transcripts).toEqual([
			{ role: "user", text: "帮我", final: false },
			{ role: "user", text: "帮我看下待办。", final: true },
			{ role: "assistant", text: "好的", final: false },
			{ role: "assistant", text: "好的，三件事。", final: true },
		]);
		await h.controller.dispose();
	});

	test("short user transcripts are dropped to starve the self-loop", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		// Bleed/reverb fragments the server can transcribe after the model finishes.
		// Without the filter these commit as full user turns and the model politely
		// answers each one, feeding the loop.
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "。" });
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "都" });
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "三" });
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "好的，明白了" });
		await Bun.sleep(30);
		expect(h.transcripts).toEqual([{ role: "user", text: "好的，明白了", final: true }]);
		await h.controller.dispose();
	});

	test("response.done holds speaking until the sink drains", async () => {
		const h = await makeHarness({ holdSinkEnd: true });
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await waitForPhase(h, "speaking");
		h.server.send({ type: "response.done", response: { id: "r1" } });
		await Bun.sleep(30);

		// Playback still draining: phase holds "speaking", uplink stays silence.
		expect(h.phases.at(-1)).toBe("speaking");
		expect(h.sinks[0]!.ended).toBe(true);
		h.source.emit(0.001);
		await Bun.sleep(20);
		const pcm = lastAppendAudio(h.server);
		expect(pcm!.every(b => b === 0)).toBe(true);

		// Hardware drained → cooldown holds phase "speaking" until room audio decays
		// → mic goes live again; next response gets a fresh sink.
		h.sinks[0]!.releaseEnd();
		await waitForPhase(h, "listening", 3_000);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await waitForPhase(h, "speaking");
		expect(h.sinks.length).toBe(2);
		await h.controller.dispose();
	});

	test("drain cooldown keeps phase speaking for room reverb after playback ends", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await waitForPhase(h, "speaking");
		h.server.send({ type: "response.done", response: { id: "r1" } });
		// Right after end() resolves the mic must still be gated (cooldown).
		await Bun.sleep(40);
		expect(h.controller.phase).toBe("speaking");
		// After the cooldown, phase returns to listening.
		await waitForPhase(h, "listening", 1_000);
		await h.controller.dispose();
	});

	test("response.done returns to listening when playback is already drained", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await Bun.sleep(20);
		h.server.send({ type: "response.done", response: { id: "r1" } });
		await waitForPhase(h, "listening");
		// Next response gets a fresh sink.
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await waitForPhase(h, "speaking");
		expect(h.sinks.length).toBe(2);
		await h.controller.dispose();
	});

	test("error breaker: three consecutive server errors end the session", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "error", error: { message: "bad config" } });
		h.server.send({ type: "error", error: { message: "bad config" } });
		await Bun.sleep(20);
		expect(h.terminals.length).toBe(0); // two strikes: halted but not terminal
		expect(h.phases.at(-1)).toBe("error");

		h.server.send({ type: "error", error: { message: "bad config" } });
		await Bun.sleep(20);
		expect(h.terminals.length).toBe(1);
		expect(h.terminals[0]?.message).toContain("voice channel failed");

		// Halted uplink: no mic frames reach the broken session.
		const appendsBefore = h.server.received.filter(m => m.type === "input_audio_buffer.append").length;
		h.source.emit(0.5);
		await Bun.sleep(20);
		expect(h.server.received.filter(m => m.type === "input_audio_buffer.append").length).toBe(appendsBefore);
		await h.controller.dispose();
	});

	test("server idle timeout ends the session cleanly instead of resurrecting", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({
			type: "error",
			error: { message: "Your session was closed because no response was generated for 180 seconds." },
		});
		await Bun.sleep(20);
		expect(h.terminals.length).toBe(1);
		expect(h.terminals[0]?.message).toContain("inactivity");
		await h.controller.dispose();
	});
});
