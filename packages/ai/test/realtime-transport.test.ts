/**
 * Realtime transport tests. Uses a real local Bun.serve WebSocket server —
 * no mocks, per repo testing policy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	base64ToPcm16,
	buildRealtimeWsUrl,
	chunkPcm16,
	createSilenceChunk,
	parseRealtimeServerEvent,
	pcm16ByteCount,
	pcm16ToBase64,
	REALTIME_SAMPLE_RATE,
	RealtimeFunctionBridge,
	type RealtimeTransportState,
	RealtimeWsTransport,
} from "../src/realtime";

// ------------------------------------------------------------- protocol ---

describe("parseRealtimeServerEvent", () => {
	test("folds output_audio.* aliases into canonical names", () => {
		expect(parseRealtimeServerEvent({ type: "response.output_audio.delta", delta: "QUJD" })).toEqual({
			type: "response.audio.delta",
			delta: "QUJD",
		});
		expect(parseRealtimeServerEvent({ type: "response.output_audio_transcript.delta", delta: "你好" })).toEqual({
			type: "response.audio_transcript.delta",
			delta: "你好",
		});
	});

	test("keeps qwen-native audio event names", () => {
		expect(parseRealtimeServerEvent({ type: "response.audio.delta", delta: "QUJD" })).toEqual({
			type: "response.audio.delta",
			delta: "QUJD",
		});
		expect(parseRealtimeServerEvent({ type: "response.audio_transcript.done", transcript: "讲完了" })).toEqual({
			type: "response.audio_transcript.done",
			transcript: "讲完了",
		});
	});

	test("normalizes fun-asr stash/text transcription payloads", () => {
		expect(
			parseRealtimeServerEvent({
				type: "conversation.item.input_audio_transcription.delta",
				stash: "帮我看一下",
				text: "",
			}),
		).toEqual({ type: "conversation.item.input_audio_transcription.delta", delta: "帮我看一下", itemId: undefined });
		expect(
			parseRealtimeServerEvent({
				type: "conversation.item.input_audio_transcription.delta",
				text: "帮我看一下待办",
			}),
		).toEqual({
			type: "conversation.item.input_audio_transcription.delta",
			delta: "帮我看一下待办",
			itemId: undefined,
		});
		expect(
			parseRealtimeServerEvent({ type: "conversation.item.input_audio_transcription.delta", delta: "标准增量" }),
		).toEqual({ type: "conversation.item.input_audio_transcription.delta", delta: "标准增量", itemId: undefined });
	});

	test("maps function_call_arguments.done fields", () => {
		expect(
			parseRealtimeServerEvent({
				type: "response.function_call_arguments.done",
				call_id: "call_1",
				name: "omp_agent_consult",
				arguments: '{"task":"查TODO"}',
				response_id: "resp_1",
			}),
		).toEqual({
			type: "response.function_call_arguments.done",
			callId: "call_1",
			name: "omp_agent_consult",
			arguments: '{"task":"查TODO"}',
			responseId: "resp_1",
		});
	});

	test("parses speech_started / speech_stopped", () => {
		expect(
			parseRealtimeServerEvent({ type: "input_audio_buffer.speech_started", audio_start_ms: 12, item_id: "it" }),
		).toEqual({
			type: "input_audio_buffer.speech_started",
			audioStartMs: 12,
			itemId: "it",
		});
		expect(parseRealtimeServerEvent({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 5000 })).toEqual({
			type: "input_audio_buffer.speech_stopped",
			audioEndMs: 5000,
			itemId: undefined,
		});
	});

	test("error event carries message and code", () => {
		const event = parseRealtimeServerEvent({
			type: "error",
			error: { type: "invalid_request_error", code: "invalid_value", message: "bad param" },
		});
		expect(event).toMatchObject({ type: "error", message: "bad param", code: "invalid_value" });
	});

	test("unknown wire types and malformed payloads pass through safely", () => {
		const unknown = parseRealtimeServerEvent({ type: "rate_limits.updated", foo: 1 });
		expect(unknown).toMatchObject({ type: "unknown", wireType: "rate_limits.updated" });
		expect(parseRealtimeServerEvent(null).type).toBe("unknown");
		expect(parseRealtimeServerEvent("garbage").type).toBe("unknown");
		expect(parseRealtimeServerEvent({}).type).toBe("unknown");
	});
});

// ---------------------------------------------------------------- audio ---

describe("pcm16 codec", () => {
	test("base64 roundtrip preserves bytes", () => {
		const pcm = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);
		expect(base64ToPcm16(pcm16ToBase64(pcm))).toEqual(pcm);
	});

	test("silence chunk is zero-filled with correct byte count", () => {
		const silence = createSilenceChunk(100);
		expect(silence.length).toBe(pcm16ByteCount(100));
		expect(silence.length).toBe((REALTIME_SAMPLE_RATE * 2 * 100) / 1000);
		expect(silence.every(b => b === 0)).toBe(true);
	});

	test("chunkPcm16 splits on chunk boundaries, tail preserved", () => {
		const pcm = new Uint8Array(pcm16ByteCount(250)); // 2.5 chunks of 100ms
		const chunks = chunkPcm16(pcm, 100);
		expect(chunks.length).toBe(3);
		expect(chunks[0]!.length).toBe(pcm16ByteCount(100));
		expect(chunks[2]!.length).toBe(pcm16ByteCount(50));
		expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(pcm.length);
	});
});

// ------------------------------------------------------------------- url ---

describe("buildRealtimeWsUrl", () => {
	test("derives wss realtime URL from https base", () => {
		expect(buildRealtimeWsUrl("https://coder.narwal.com/v1", "qwen-audio-3.0-realtime-flash")).toBe(
			"wss://coder.narwal.com/v1/realtime?model=qwen-audio-3.0-realtime-flash",
		);
	});

	test("keeps an already-realtime wss URL, replaces model", () => {
		expect(buildRealtimeWsUrl("wss://example.com/v1/realtime?model=old", "new-model")).toBe(
			"wss://example.com/v1/realtime?model=new-model",
		);
	});
});

// --------------------------------------------------- integration (real WS) ---

interface TestServer {
	url: string;
	connections: Array<{ headers: Record<string, string> }>;
	received: string[];
	send(obj: unknown): void;
	closeCurrent(): void;
	stop(): void;
}

function startTestServer(options: { sessionCreated: boolean }): TestServer {
	const connections: Array<{ headers: Record<string, string> }> = [];
	const received: string[] = [];
	let current: { send(data: string): void; close(): void } | undefined;

	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			const headers: Record<string, string> = {};
			req.headers.forEach((value, key) => {
				headers[key] = value;
			});
			if (srv.upgrade(req)) {
				connections.push({ headers });
				return undefined;
			}
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				current = ws;
				if (options.sessionCreated) {
					ws.send(JSON.stringify({ type: "session.created", session: { id: "sess_test", model: "test-model" } }));
				}
			},
			message(_ws, msg) {
				received.push(String(msg));
			},
			close() {
				current = undefined;
			},
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		connections,
		received,
		send(obj) {
			current?.send(JSON.stringify(obj));
		},
		closeCurrent() {
			current?.close();
		},
		stop() {
			server.stop(true);
		},
	};
}

async function waitForState(
	transport: RealtimeWsTransport,
	want: RealtimeTransportState,
	timeoutMs = 3_000,
): Promise<void> {
	if (transport.state === want) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`state ${want} not reached, still ${transport.state}`)), timeoutMs);
	const off = transport.addStateListener(state => {
		if (state === want) {
			clearTimeout(timer);
			off();
			resolve();
		}
	});
	return promise;
}

describe("RealtimeWsTransport (local server)", () => {
	const servers: TestServer[] = [];
	afterEach(() => {
		while (servers.length) servers.pop()!.stop();
	});

	test("connects with auth headers, reaches connected, receives normalized events", async () => {
		const server = startTestServer({ sessionCreated: true });
		servers.push(server);
		const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "test-key", model: "m1" });

		const events: string[] = [];
		transport.addEventListener(e => events.push(e.type));
		await transport.connect();

		expect(transport.state).toBe("connected");
		expect(server.connections.length).toBe(1);
		expect(server.connections[0]!.headers.authorization).toBe("Bearer test-key");
		expect(server.connections[0]!.headers["openai-beta"]).toBe("realtime=v1");
		expect(events).toContain("session.created");

		server.send({ type: "response.output_audio.delta", delta: "QUJD" });
		await Bun.sleep(50);
		expect(events).toContain("response.audio.delta");

		await transport.close();
		expect(transport.state).toBe("closed");
	});

	test("send throws when not connected", async () => {
		const transport = new RealtimeWsTransport({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
		expect(() => transport.send({ type: "response.create" })).toThrow(/not connected/);
	});

	test("reconnects after unintentional drop", async () => {
		const server = startTestServer({ sessionCreated: true });
		servers.push(server);
		const transport = new RealtimeWsTransport({
			baseUrl: server.url,
			apiKey: "k",
			model: "m",
			reconnect: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 100 },
		});
		await transport.connect();
		expect(server.connections.length).toBe(1);

		server.closeCurrent();
		await waitForState(transport, "reconnecting");
		await waitForState(transport, "connected");
		expect(server.connections.length).toBe(2);

		await transport.close();
	});

	test("gives up after maxAttempts and stays closed", async () => {
		const server = startTestServer({ sessionCreated: true });
		servers.push(server);
		const transport = new RealtimeWsTransport({
			baseUrl: server.url,
			apiKey: "k",
			model: "m",
			reconnect: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 100 },
		});
		await transport.connect();
		server.stop(); // subsequent handshakes will fail
		server.closeCurrent();

		await waitForState(transport, "closed", 5_000);
		expect(transport.state).toBe("closed");
	});

	test("function bridge answers function_call_output and triggers response.create", async () => {
		const server = startTestServer({ sessionCreated: true });
		servers.push(server);
		const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "k", model: "m" });
		await transport.connect();

		const bridge = new RealtimeFunctionBridge(transport);
		bridge.registerTool({
			name: "omp_agent_consult",
			description: "delegate",
			parameters: { type: "object", properties: { task: { type: "string" } } },
		});
		expect(bridge.tools.length).toBe(1);

		let handled: { name: string; args: string } | undefined;
		bridge.attach(async call => {
			handled = { name: call.name, args: call.arguments };
			return JSON.stringify({ count: 3 });
		});

		server.send({
			type: "response.function_call_arguments.done",
			call_id: "call_9",
			name: "omp_agent_consult",
			arguments: '{"task":"查TODO"}',
		});
		await Bun.sleep(100);

		expect(handled).toEqual({ name: "omp_agent_consult", args: '{"task":"查TODO"}' });
		const sentTypes = server.received.map(raw => (JSON.parse(raw) as { type: string }).type);
		expect(sentTypes).toContain("conversation.item.create");
		expect(sentTypes).toContain("response.create");
		const outputItem = server.received
			.map(raw => JSON.parse(raw) as { type: string; item?: { output?: string } })
			.find(raw => raw.type === "conversation.item.create");
		expect(outputItem?.item?.output).toBe('{"count":3}');

		bridge.detach();
		await transport.close();
	});

	test("function bridge converts handler exceptions into error outputs", async () => {
		const server = startTestServer({ sessionCreated: true });
		servers.push(server);
		const transport = new RealtimeWsTransport({ baseUrl: server.url, apiKey: "k", model: "m" });
		await transport.connect();

		const bridge = new RealtimeFunctionBridge(transport);
		bridge.attach(async () => {
			throw new Error("agent exploded");
		});
		server.send({ type: "response.function_call_arguments.done", call_id: "c", name: "x", arguments: "{}" });
		await Bun.sleep(100);

		const outputItem = server.received
			.map(raw => JSON.parse(raw) as { type: string; item?: { output?: string } })
			.find(raw => raw.type === "conversation.item.create");
		expect(outputItem?.item?.output).toContain("agent exploded");

		await transport.close();
	});
});
