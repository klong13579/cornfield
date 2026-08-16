#!/usr/bin/env bun
/**
 * Realtime voice passthrough probe — checks whether a realtime gateway
 * (narwal-plan by default) accepts arbitrary `voice` ids in `session.update`.
 *
 * Motivation: omp live voice (Jarvis) forwards `voice.voice` straight to the
 * gateway. Qwen's official docs create cloned voices on DashScope
 * (`POST /api/v1/services/audio/tts/customization`, target_model
 * qwen-audio-3.0-realtime-*), which the narwal proxy does NOT expose (both
 * endpoint variants return 404). The open question is therefore whether the
 * gateway validates `voice` against its own list or forwards it verbatim —
 * i.e. whether a DashScope-cloned voice_id would work through omp at all.
 *
 * Each scenario opens a FRESH connection: Qwen realtime only honors `voice`
 * on the FIRST `session.update` of a connection, so testing multiple voices
 * on one socket would silently no-op after the first.
 *
 * Usage:
 *   bun run packages/coding-agent/scripts/realtime-voice-probe.ts
 *   bun run packages/coding-agent/scripts/realtime-voice-probe.ts --voice qwen-audio-3.0-realtime-plus-myvoice-xxxxxx
 *   bun run packages/coding-agent/scripts/realtime-voice-probe.ts --api-key sk-xxx --base-url https://coder.narwal.com/v1
 *
 * Credentials: CLI --api-key > $NARWAL_PLAN_API_KEY > ~/.omp/agent/models.yml
 * (narwal-plan.apiKey may name an env var or hold a literal key).
 *
 * Exit codes: 0 = no server-side rejection (voice accepted/echoed),
 *             1 = server rejected or rewrote at least one voice,
 *             2 = probe itself failed (connect/auth/credential lookup).
 */
import { RealtimeWsTransport } from "@oh-my-pi/pi-ai";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, resolveRealtimeCredentials } from "./realtime-common";

const SYSTEM_VOICE = "longanqian";
const UPDATE_TIMEOUT_MS = 10_000;

interface ProbeOptions {
	model: string;
	baseUrl: string;
	apiKey: string;
	extraVoice: string | undefined;
}

interface ProbeResult {
	voice: string;
	kind: "system" | "fake" | "custom";
	serverVoice: string | undefined;
	error: string | undefined;
	passthrough: boolean;
}

function usage(): string {
	return [
		"realtime-voice-probe — verify gateway voice passthrough",
		"",
		"Usage: bun run packages/coding-agent/scripts/realtime-voice-probe.ts [options]",
		"",
		"Options:",
		`  --model <id>      Realtime model id (default: ${DEFAULT_MODEL})`,
		`  --base-url <url>  Gateway base URL (default: ${DEFAULT_BASE_URL})`,
		"  --api-key <key>   API key (default: $NARWAL_PLAN_API_KEY, then models.yml)",
		"  --voice <id>      Extra cloned-voice id to probe (optional)",
		"  -h, --help        Show this help",
	].join("\n");
}

function parseCliArgs(argv: string[]): ProbeOptions {
	let model = DEFAULT_MODEL;
	let baseUrl = DEFAULT_BASE_URL;
	let apiKey: string | undefined;
	let extraVoice: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (value === undefined) {
				console.error(`missing value for ${arg}`);
				process.exit(2);
			}
			i += 1;
			return value;
		};
		switch (arg) {
			case "--model":
				model = next();
				break;
			case "--base-url":
				baseUrl = next();
				break;
			case "--api-key":
				apiKey = next();
				break;
			case "--voice":
				extraVoice = next();
				break;
			case "--help":
			// biome-ignore lint/suspicious/noFallthroughSwitchClause: --help and -h share the usage/exit body
			case "-h":
				console.log(usage());
				process.exit(0);
			default:
				console.error(`unknown argument: ${arg}\n\n${usage()}`);
				process.exit(2);
		}
	}
	return { model, baseUrl, apiKey: apiKey ?? process.env.NARWAL_PLAN_API_KEY ?? "", extraVoice };
}

/**
 * Opens a fresh connection, sends ONE session.update with the given voice,
 * and resolves with the server's response. Rejected/ignored voices surface
 * as `error` events; accepted voices are echoed in `session.updated`.
 */
async function probeVoice(options: ProbeOptions, voice: string, kind: ProbeResult["kind"]): Promise<ProbeResult> {
	const transport = new RealtimeWsTransport({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		model: options.model,
	});
	const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>();
	const timeout = setTimeout(() => {
		reject(new Error(`timed out waiting for session.updated (${UPDATE_TIMEOUT_MS}ms)`));
	}, UPDATE_TIMEOUT_MS);
	const unsubscribe = transport.addEventListener(event => {
		if (event.type === "session.updated") {
			clearTimeout(timeout);
			unsubscribe();
			const serverVoice = event.session.voice;
			resolve({ voice, kind, serverVoice, error: undefined, passthrough: serverVoice === voice });
		} else if (event.type === "error") {
			clearTimeout(timeout);
			unsubscribe();
			resolve({ voice, kind, serverVoice: undefined, error: event.message, passthrough: false });
		}
	});
	try {
		await transport.connect();
		transport.send({ type: "session.update", session: { modalities: ["text"], voice } });
		return await promise;
	} finally {
		await transport.close().catch(() => undefined);
	}
}

async function main(): Promise<void> {
	const opts = await resolveProbeOptions(parseCliArgs(process.argv.slice(2)));

	const scenarios: Array<{ voice: string; kind: ProbeResult["kind"] }> = [
		{ voice: SYSTEM_VOICE, kind: "system" },
		{ voice: `probe-nonexistent-voice-${Date.now()}`, kind: "fake" },
	];
	if (opts.extraVoice) scenarios.push({ voice: opts.extraVoice, kind: "custom" });

	console.log(`probe target: ${opts.baseUrl}  model=${opts.model}  (modalities=[text], no audio generated)`);
	const results: ProbeResult[] = [];
	for (const scenario of scenarios) {
		try {
			const result = await probeVoice(opts, scenario.voice, scenario.kind);
			results.push(result);
		} catch (err) {
			results.push({
				voice: scenario.voice,
				kind: scenario.kind,
				serverVoice: undefined,
				error: err instanceof Error ? err.message : String(err),
				passthrough: false,
			});
		}
	}

	console.log("\n── results ──");
	for (const result of results) {
		console.log(JSON.stringify(result));
	}

	const rejected = results.filter(r => r.error !== undefined);
	const echoed = results.filter(r => r.error === undefined && r.passthrough);
	const silent = results.filter(r => r.error === undefined && !r.passthrough);

	console.log("\n── summary ──");
	console.log(`rejected (server error): ${rejected.length}`);
	console.log(`accepted + echoed back  : ${echoed.length}`);
	console.log(`accepted, no voice echo : ${silent.length} (server did not echo the voice field)`);
	if (rejected.length > 0) {
		console.log("verdict: gateway VALIDATES voice — cloned voice_ids are likely rejected");
		process.exit(1);
	}
	if (echoed.length === 0) {
		console.log("verdict: no server-side error, but no echo to confirm passthrough");
		process.exit(0);
	}
	console.log("verdict: gateway accepts the probed voice ids (passthrough)");
	process.exit(0);
}

async function resolveProbeOptions(options: ProbeOptions): Promise<ProbeOptions> {
	const credentials = await resolveRealtimeCredentials(options.apiKey, options.baseUrl);
	return { ...options, ...credentials };
}

void main();
