/**
 * LiveSessionController tests. Real local WS server (per repo policy), scripted
 * audio source/sink — no hardware, no mocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pcm16ToBase64, type RealtimeServerEvent, RealtimeWsTransport } from "@oh-my-pi/pi-ai";
import { LiveSessionController } from "../src/live/controller";
import type { LiveAudioSink, LivePhase, LiveTranscript } from "../src/live/types";

// ------------------------------------------------------------ WS server ---

interface TestServer {
	url: string;
	received: Array<Record<string, unknown>>;
	send(obj: unknown): void;
	stop(): void;
}

function startServer(): TestServer {
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
			message(_ws, msg) {
				received.push(JSON.parse(String(msg)) as Record<string, unknown>);
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
	write(): void {
		this.writes++;
	}
	stop(): void {
		this.stopped = true;
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
}

async function makeHarness(
	options: { bargeInLevel?: number; onConsult?: (task: string) => Promise<string> } = {},
): Promise<Harness> {
	const server = startServer();
	const source = new ScriptedSource();
	const sinks: ScriptedSink[] = [];
	const phases: LivePhase[] = [];
	const transcripts: LiveTranscript[] = [];
	const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "k", model: "m" });
	const controller = new LiveSessionController({
		transport,
		source,
		sinkFactory: () => {
			const sink = new ScriptedSink();
			sinks.push(sink);
			return sink;
		},
		session: { modalities: ["text", "audio"] },
		callbacks: {
			onPhase: p => phases.push(p),
			onLevels: () => {},
			onTranscript: t => transcripts.push(t),
			onTerminal: () => {},
		},
		bargeInLevel: options.bargeInLevel,
		onConsult: options.onConsult,
	});
	await controller.start();
	return { controller, server, source, sinks, phases, transcripts };
}

const loudPcm = pcm16ToBase64(new Uint8Array(960).fill(120));

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

	test("barge-in: loud speech during speaking cancels response and discards sink", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
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
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await Bun.sleep(20);

		h.source.emit(0.001); // speaker bleed, below bargeInLevel
		h.server.send({ type: "input_audio_buffer.speech_started" });
		await Bun.sleep(20);

		expect(h.server.received.some(m => m.type === "response.cancel")).toBe(false);
		expect(h.phases.at(-1)).toBe("speaking"); // echo ignored: assistant keeps talking
		expect(h.sinks[0]!.stopped).toBe(false);
		await h.controller.dispose();
	});

	test("mute swaps mic frames for silence", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.controller.setMuted(true);
		h.source.emit(0.9);
		await Bun.sleep(20);
		const appends = h.server.received.filter(m => m.type === "input_audio_buffer.append");
		expect(appends.length).toBeGreaterThan(0);
		const last = appends.at(-1) as { audio: string };
		const pcm = Buffer.from(last.audio, "base64");
		expect(pcm.every(b => b === 0)).toBe(true);
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

	test("response.done returns to listening and releases the sink", async () => {
		const h = await makeHarness();
		servers.push(h.server);
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await Bun.sleep(20);
		h.server.send({ type: "response.done", response: { id: "r1" } });
		await Bun.sleep(20);
		expect(h.phases.at(-1)).toBe("listening");
		// Next response gets a fresh sink.
		h.server.send({ type: "response.audio.delta", delta: loudPcm });
		await Bun.sleep(20);
		expect(h.sinks.length).toBe(2);
		await h.controller.dispose();
	});
});

type _Unused = RealtimeServerEvent;
