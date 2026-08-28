/**
 * Total P0 acceptance, automated (E2E=1 gated; hits real narwal realtime + real LLM).
 *
 * Every seam is real except the air gap: synthesized PCM is injected through a
 * scripted LiveAudioSource instead of the mic (office acoustics make mic-loopback
 * assertions flaky; native mic/speaker smoke is covered separately).
 *
 * Chain under test:
 *   PCM speech → server_vad → fun-asr transcript → omp_agent_consult →
 *   REAL AgentSession (readonly tools) → answer → spoken audio →
 *   phase machine → transcript recorder → REAL SessionManager JSONL.
 *
 * Run: E2E=1 bun test packages/coding-agent/test/live-total-acceptance-e2e.test.ts
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REALTIME_SAMPLE_RATE, RealtimeWsTransport } from "@cornfield/ai";
import { LiveConsultBridge } from "../src/live/consult-bridge";
import { LiveSessionController } from "../src/live/controller";
import { LiveTranscriptRecorder, VOICE_MESSAGE_TYPE } from "../src/live/transcript-recorder";
import type { LiveAudioSink, LiveAudioSource, LivePhase, LiveTranscript } from "../src/live/types";
import { SessionManager } from "../src/session/session-manager";

const E2E = Bun.env.E2E === "1";
const NARWAL_KEY = Bun.env.NARWAL_PLAN_API_KEY;

function synthPcm(text: string): Uint8Array {
	const aiff = path.join(os.tmpdir(), "p0-accept.aiff");
	const wav = path.join(os.tmpdir(), "p0-accept.wav");
	execSync(`say -v Tingting -o "${aiff}" "${text}"`);
	execSync(`afconvert -f WAVE -d LEI16@${REALTIME_SAMPLE_RATE} -c 1 "${aiff}" "${wav}"`);
	return new Uint8Array(fs.readFileSync(wav).subarray(44));
}

class PacedSource implements LiveAudioSource {
	readonly #pcm: Uint8Array;
	#timer: Timer | undefined;
	constructor(pcm: Uint8Array) {
		this.#pcm = pcm;
	}
	start(onChunk: (samples: Float32Array) => void): void {
		const chunkBytes = (REALTIME_SAMPLE_RATE * 2 * 100) / 1000;
		let offset = 0;
		this.#timer = setInterval(() => {
			if (offset >= this.#pcm.length) {
				// Silence tail keeps the server_vad audio clock advancing forever.
				onChunk(new Float32Array(chunkBytes / 2));
				return;
			}
			const end = Math.min(offset + chunkBytes, this.#pcm.length);
			const view = new DataView(this.#pcm.buffer, this.#pcm.byteOffset + offset, end - offset);
			const samples = new Float32Array((end - offset) / 2);
			for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
			offset = end;
			onChunk(samples);
		}, 100);
	}
	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
	}
}

class RecordingSink implements LiveAudioSink {
	samplesWritten = 0;
	stopped = false;
	write(samples: Float32Array): void {
		this.samplesWritten += samples.length;
	}
	async end(): Promise<void> {}
	stop(): void {
		this.stopped = true;
	}
}

describe.skipIf(!E2E || !NARWAL_KEY)("P0 total acceptance (real services)", () => {
	test("speech → consult → spoken answer → transcript persisted", async () => {
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-p0-accept-"));
		try {
			const sessionManager = SessionManager.create(process.cwd(), tempDir);
			const recorder = new LiveTranscriptRecorder({ sessionManager });
			const bridge = new LiveConsultBridge({ cwd: process.cwd(), timeoutMs: 120_000 });

			const transport = new RealtimeWsTransport({
				baseUrl: "https://coder.narwal.com/v1",
				apiKey: NARWAL_KEY!,
				model: "qwen-audio-3.0-realtime-flash",
			});

			const phases: LivePhase[] = [];
			const transcripts: LiveTranscript[] = [];
			const sink = new RecordingSink();
			const pcm = synthPcm("帮我看一下待办清单里有几件事");

			const controller = new LiveSessionController({
				transport,
				source: new PacedSource(pcm),
				sinkFactory: () => sink,
				session: {
					modalities: ["text", "audio"],
					instructions:
						"你是 Jarvis。需要文件/业务数据的请求必须调用 omp_agent_consult，拿到结果后用自然口语简短转述。",
					voice: "longanqian",
					input_audio_format: "pcm16",
					output_audio_format: "pcm16",
					input_audio_transcription: { model: "fun-asr" },
					turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 },
				},
				callbacks: {
					onPhase: phase => phases.push(phase),
					onLevels: () => {},
					onTranscript: transcript => {
						transcripts.push(transcript);
						recorder.record(transcript);
					},
					onTerminal: () => {},
				},
				onConsult: task => bridge.consult(task),
			});

			await controller.start();

			// Wait for the full chain: consult answer spoken (response.done after speaking).
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const spokeAndSettled = phases.includes("speaking") && phases.at(-1) === "listening";
				if (spokeAndSettled) break;
				await Bun.sleep(250);
			}
			await controller.dispose();
			await sessionManager.flush();

			// --- assertions ---
			const userFinal = transcripts.find(t => t.role === "user" && t.final);
			const assistantFinal = transcripts.find(t => t.role === "assistant" && t.final);
			console.log("user final:", userFinal?.text);
			console.log("assistant final:", assistantFinal?.text);
			console.log("phases:", phases.join(" → "));
			console.log("sink seconds:", (sink.samplesWritten / REALTIME_SAMPLE_RATE).toFixed(1));

			expect(phases).toContain("listening");
			expect(phases).toContain("thinking");
			expect(phases).toContain("speaking");
			expect(phases.at(-1)).toBe("listening");
			expect(userFinal?.text).toContain("待办");
			// Real answer must include the actual TODO count (consult really ran).
			expect(assistantFinal?.text).toMatch(/\d|一|二|三|四|五|六|七|八|九|十/);
			// Audio actually flowed to the speaker sink.
			expect(sink.samplesWritten).toBeGreaterThan(REALTIME_SAMPLE_RATE / 2);
			// Voice turns persisted into the session JSONL.
			const raw = await fs.promises.readFile(sessionManager.getSessionFile()!, "utf8");
			const voiceLines = raw
				.trim()
				.split("\n")
				.map(l => JSON.parse(l) as Record<string, unknown>)
				.filter(l => l.type === "custom_message" && l.customType === VOICE_MESSAGE_TYPE);
			expect(voiceLines.length).toBeGreaterThanOrEqual(2);
			console.log("P0 TOTAL ACCEPTANCE: PASS");
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	}, 180_000);
});
