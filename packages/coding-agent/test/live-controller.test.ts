/**
 * LiveSessionController tests. Real local WS server (per repo policy), scripted
 * audio source/sink — no hardware, no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pcm16ToBase64, RealtimeWsTransport } from "@oh-my-pi/pi-ai";
import { LiveSessionController } from "../src/live/controller";
import type { LiveAudioSink, LiveIntent, LivePhase, LiveTranscript } from "../src/live/types";

// ------------------------------------------------------------ WS server ---

interface TestServer {
	url: string;
	received: Array<Record<string, unknown>>;
	send(obj: unknown): void;
	stop(): void;
}

function startServer(options: { ackConfig?: boolean; rejectCreateWhileInProgress?: boolean } = {}): TestServer {
	const ackConfig = options.ackConfig ?? true;
	const rejectCreate = options.rejectCreateWhileInProgress ?? false;
	let responseInProgress = false;
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
				// Strict mode mirrors narwal-plan: response.create during an active
				// response is rejected; response.cancel clears the active state.
				if (rejectCreate) {
					if (parsed.type === "response.create") {
						if (responseInProgress) {
							ws.send(
								JSON.stringify({
									type: "error",
									error: { message: "Cannot create response while another response is in progress." },
								}),
							);
						} else {
							responseInProgress = true;
						}
					}
					if (parsed.type === "response.cancel") responseInProgress = false;
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
	intents: LiveIntent[];
}

interface HarnessOptions {
	bargeInLevel?: number;
	bargeInEnabled?: boolean;
	consultHandoffMs?: number;
	onConsult?: (task: string) => Promise<string>;
	onTask?: (task: string) => Promise<string>;
	onConfirmDecision?: (decision: "confirm" | "cancel" | "unclear") => void;
	onControl?: (action: "status" | "steer" | "cancel", text?: string) => Promise<string>;
	/** Server acks session.update with session.updated (default true). */
	ackConfig?: boolean;
	/** Strict narwal mode: reject response.create while a response is in progress. */
	rejectCreateWhileInProgress?: boolean;
	/** Gate state probe for the short-transcript noise guard exception. */
	isConfirmationPending?: () => boolean;
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
	const server = startServer({
		ackConfig: options.ackConfig ?? true,
		rejectCreateWhileInProgress: options.rejectCreateWhileInProgress,
	});
	const source = new ScriptedSource();
	const sinks: ScriptedSink[] = [];
	const phases: LivePhase[] = [];
	const transcripts: LiveTranscript[] = [];
	const terminals: Array<Error | undefined> = [];
	const intents: LiveIntent[] = [];
	const buildController = (): LiveSessionController => {
		const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "k", model: "m" });
		return new LiveSessionController({
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
				onIntent: intent => intents.push(intent),
				onTerminal: err => terminals.push(err),
			},
			bargeInLevel: options.bargeInLevel,
			bargeInEnabled: options.bargeInEnabled,
			consultHandoffMs: options.consultHandoffMs,
			onConsult: options.onConsult,
			onTask: options.onTask,
			onConfirmDecision: options.onConfirmDecision,
			onControl: options.onControl,
			isConfirmationPending: options.isConfirmationPending,
		});
	};
	let controller = buildController();
	try {
		await controller.start();
	} catch {
		// Infra flake: under load the local WS handshake occasionally dies (1006
		// racing a previous server's forced stop). Rebuild once against the same
		// live server before failing the test.
		await controller.dispose().catch(() => {});
		controller = buildController();
		await controller.start();
	}
	// Deterministic handshake: config sent on session.created, acked by the
	// server, uplink gate opens → listening. Skipped for no-ack servers.
	if (options.ackConfig !== false) await waitForPhase({ controller }, "listening");
	return { controller, server, source, sinks, phases, transcripts, terminals, intents };
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

	test("consult fast path: quick result returns directly as function_call_output", async () => {
		const h = await makeHarness({ onConsult: async () => "结果是 3 条待办", consultHandoffMs: 200 });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "c1",
			name: "omp_agent_consult",
			arguments: JSON.stringify({ task: "查待办" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.type).toBe("function_call_output");
		expect(output.item.output).toContain("结果是 3 条待办");
		await h.controller.dispose();
	});

	test("consult slow path: handoff filler first, real result delivered as a fresh turn", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		const h = await makeHarness({ onConsult: () => promise, consultHandoffMs: 50 });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "c1",
			name: "omp_agent_consult",
			arguments: JSON.stringify({ task: "查天气" }),
		});

		// The filler goes out fast — the voice session never stalls in silence.
		const filler = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(filler.item.type).toBe("function_call_output");
		expect(filler.item.output).toContain("后台处理");

		// When the background consult lands, it becomes a fresh user turn + response.
		resolve("深圳今天 25 度");
		await Bun.sleep(80);
		const items = h.server.received.filter(m => m.type === "conversation.item.create") as Array<{
			item: Record<string, unknown>;
		}>;
		expect(items.length).toBe(2);
		expect(items[1]!.item.role).toBe("user");
		expect(JSON.stringify(items[1]!.item.content)).toContain("深圳今天 25 度");
		expect(h.server.received.filter(m => m.type === "response.create").length).toBeGreaterThanOrEqual(2);
		await h.controller.dispose();
	});

	test("barge-in injects the interrupted note so the model can continue naturally", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: moderatePcm });
		await waitForPhase(h, "speaking");

		for (let i = 0; i < 5; i++) h.source.emit(0.5);
		await Bun.sleep(20);

		const notes = h.server.received.filter(m => m.type === "conversation.item.create") as Array<{
			item: Record<string, unknown>;
		}>;
		expect(notes.length).toBe(1);
		expect(JSON.stringify(notes[0]!.item)).toContain("打断了");
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

	// ---------------------------------------------------------------- P1a ---

	test("session.update registers consult, task, confirm and control functions", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		const sessionUpdate = (await waitForMessage(h.server, "session.update")) as SessionUpdateMsg;
		const tools = sessionUpdate?.session?.tools ?? [];
		for (const name of ["omp_agent_consult", "omp_agent_task", "omp_voice_confirm", "omp_agent_control"]) {
			expect(tools.some(t => t.name === name && t.type === "function")).toBe(true);
		}
		await h.controller.dispose();
	});

	test("task fast path: result returns as function_call_output, intent fires", async () => {
		const h = await makeHarness({ onTask: async () => "改完了，两处", consultHandoffMs: 200 });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "t1",
			name: "omp_agent_task",
			arguments: JSON.stringify({ task: "改代码" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.type).toBe("function_call_output");
		expect(output.item.output).toContain("改完了，两处");
		expect(h.intents).toContain("task");
		await h.controller.dispose();
	});

	test("task slow path: handoff filler first, summary delivered as a deferred task turn", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		const h = await makeHarness({ onTask: () => promise, consultHandoffMs: 50 });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "t1",
			name: "omp_agent_task",
			arguments: JSON.stringify({ task: "慢任务" }),
		});

		const filler = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(filler.item.type).toBe("function_call_output");
		expect(filler.item.output).toContain("后台处理");

		resolve("任务完成了，测试通过");
		await Bun.sleep(80);
		const items = h.server.received.filter(m => m.type === "conversation.item.create") as Array<{
			item: Record<string, unknown>;
		}>;
		expect(items.length).toBe(2);
		expect(items[1]!.item.role).toBe("user");
		// Task framing, not the consult "后台任务" framing.
		expect(JSON.stringify(items[1]!.item.content)).toContain("语音任务已完成");
		expect(JSON.stringify(items[1]!.item.content)).toContain("任务完成了，测试通过");
		await h.controller.dispose();
	});

	test("confirm function forwards a normalized decision", async () => {
		const decisions: string[] = [];
		const h = await makeHarness({ onConfirmDecision: decision => decisions.push(decision) });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "f1",
			name: "omp_voice_confirm",
			arguments: JSON.stringify({ decision: "confirm" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.type).toBe("function_call_output");
		expect(output.item.output).toContain("已转达");
		expect(decisions).toEqual(["confirm"]);
		expect(h.intents).toContain("confirm");
		await h.controller.dispose();
	});

	test("invalid confirm decision asks the model to retry without a callback", async () => {
		const decisions: string[] = [];
		const h = await makeHarness({ onConfirmDecision: decision => decisions.push(decision) });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "f1",
			name: "omp_voice_confirm",
			arguments: JSON.stringify({ decision: "yes" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.output).toContain("无法识别");
		expect(decisions).toEqual([]);
		await h.controller.dispose();
	});

	test("speakConfirmationNote injects a note turn; false after dispose", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		expect(h.controller.speakConfirmationNote("（系统：需要确认）")).toBe(true);
		const item = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: Record<string, unknown>;
		};
		expect(item.item.role).toBe("user");
		expect(JSON.stringify(item.item.content)).toContain("需要确认");
		expect(h.server.received.filter(m => m.type === "response.create").length).toBeGreaterThanOrEqual(1);

		await h.controller.dispose();
		expect(h.controller.speakConfirmationNote("x")).toBe(false);
	});

	test("control dispatch forwards action and text", async () => {
		const calls: Array<{ action: string; text?: string }> = [];
		const h = await makeHarness({
			onControl: async (action, text) => {
				calls.push({ action, text });
				return "（正在执行：read: TODO.md）";
			},
		});
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "s1",
			name: "omp_agent_control",
			arguments: JSON.stringify({ action: "status" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.type).toBe("function_call_output");
		expect(output.item.output).toContain("read: TODO.md");
		expect(calls).toEqual([{ action: "status", text: undefined }]);

		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "s2",
			name: "omp_agent_control",
			arguments: JSON.stringify({ action: "steer", text: "先看 src/foo.ts" }),
		});
		await Bun.sleep(50);
		expect(calls).toEqual([
			{ action: "status", text: undefined },
			{ action: "steer", text: "先看 src/foo.ts" },
		]);
		await h.controller.dispose();
	});

	test("invalid control action asks the model to retry without a callback", async () => {
		const calls: string[] = [];
		const h = await makeHarness({
			onControl: async action => {
				calls.push(action);
				return "x";
			},
		});
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "s1",
			name: "omp_agent_control",
			arguments: JSON.stringify({ action: "pause" }),
		});

		const output = (await waitForMessage(h.server, "conversation.item.create")) as {
			item: { type: string; output?: string };
		};
		expect(output.item.output).toContain("无法识别");
		expect(calls).toEqual([]);
		await h.controller.dispose();
	});

	// --------------------------------------- response.create collision fix ---

	test("note injection sends response.cancel before response.create", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		expect(h.controller.speakConfirmationNote("（系统：需要确认）")).toBe(true);
		await Bun.sleep(30);
		const types = h.server.received.map(m => m.type);
		const cancel = types.indexOf("response.cancel");
		const item = types.indexOf("conversation.item.create");
		const create = types.indexOf("response.create");
		expect(cancel).toBeGreaterThanOrEqual(0);
		expect(item).toBeGreaterThan(cancel);
		expect(create).toBeGreaterThan(item);
		await h.controller.dispose();
	});

	test("repeated note injection survives a strict in-progress server (regression)", async () => {
		// Before the fix, a bare response.create during an active response was
		// rejected ("Cannot create response while another response is in progress");
		// three rejections tripped the error breaker and killed the voice session.
		const h = await makeHarness({ rejectCreateWhileInProgress: true });
		servers.push(h.server);
		for (let i = 0; i < 4; i++) {
			expect(h.controller.speakConfirmationNote(`（系统：确认 ${i}）`)).toBe(true);
			await Bun.sleep(20);
		}
		expect(h.terminals.length).toBe(0);
		expect(h.controller.phase).not.toBe("error");
		await h.controller.dispose();
	});

	test("function output path cancels before creating the verbalization response", async () => {
		const h = await makeHarness({ onConsult: async () => "结果" });
		servers.push(h.server);
		h.server.send({
			type: "response.function_call_arguments.done",
			callId: "c1",
			name: "omp_agent_consult",
			arguments: JSON.stringify({ task: "x" }),
		});
		await waitForMessage(h.server, "response.create");
		const types = h.server.received.map(m => m.type);
		const cancel = types.indexOf("response.cancel");
		const item = types.indexOf("conversation.item.create");
		const create = types.indexOf("response.create");
		expect(cancel).toBeGreaterThanOrEqual(0);
		expect(item).toBeGreaterThan(cancel);
		expect(create).toBeGreaterThan(item);
		await h.controller.dispose();
	});

	test("short transcripts are dropped unless a confirmation is pending", async () => {
		let confirmPending = false;
		const h = await makeHarness({ isConfirmationPending: () => confirmPending });
		servers.push(h.server);

		// 2-char transcript with no confirmation pending: P0 noise guard drops it.
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "确认" });
		await Bun.sleep(30);
		expect(h.transcripts.filter(t => t.final && t.role === "user")).toEqual([]);

		// Same transcript while a confirmation is pending: it is a legitimate
		// answer ("确认"/"做"/"好") and must reach the panel/recorder.
		confirmPending = true;
		h.server.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "确认" });
		await Bun.sleep(30);
		const finals = h.transcripts.filter(t => t.final && t.role === "user");
		expect(finals.length).toBe(1);
		expect(finals[0]!.text).toBe("确认");
		await h.controller.dispose();
	});
});
