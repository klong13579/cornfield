#!/usr/bin/env bun
/**
 * intercom-stress — stress test for the pi-intercom broker, chess as the
 * vehicle.
 *
 * Modes:
 *   chess  — spawn two real pi sessions as players; this program is the
 *            referee. Every move is an intercom ask, validated against a real
 *            board (vendored chess.js). Watch live in the TUI.
 *   load   — register N synthetic vhost sessions and ramp the controller's ask
 *            rate until the broker's throttle boundary is found.
 *
 * Both modes share one metrics pipeline (events.jsonl) and one report
 * (report.json). Fault injection (--kill-*-after, --drop-connection-at,
 * --jitter-ms in load mode) is opt-in.
 *
 * Usage:
 *   bun run .cornfield/skills/intercom-stress/stress.ts --mode chess [--dummy] [flags]
 *   bun run .cornfield/skills/intercom-stress/stress.ts --mode load [flags]
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrokerSession } from "./lib/broker";
import { ChessGame, extractSan, tryApplyMove } from "./lib/chess";
import { injectKillWorker } from "./lib/faults";
import { Loadgen, type LoadConfig, type LoadOutcome } from "./lib/loadgen";
import { Metrics, summarizeOps } from "./lib/metrics";
import { Tui, type TuiState } from "./lib/tui";
import { discoverWorker, resolvePiBin, shutdownWorkers, spawnWorker, type SpawnedWorker } from "./lib/workers";

interface Options {
	mode: "chess" | "load";
	dummy: boolean;
	moves: number;
	games: number;
	timeoutMs: number;
	killWhiteAfter: number;
	killBlackAfter: number;
	respawn: boolean;
	dropAt: number;
	sessions: number;
	rampTo: number;
	rampS: number;
	soakS: number;
	aggressive: boolean;
	jitterMs: number;
	maxInflight: number;
	loadTimeoutMs: number;
	noTui: boolean;
	out: string;
	name: string;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		mode: "chess",
		dummy: false,
		moves: 100,
		games: 1,
		timeoutMs: 120_000,
		killWhiteAfter: -1,
		killBlackAfter: -1,
		respawn: false,
		dropAt: -1,
		sessions: 8,
		rampTo: 150,
		rampS: 30,
		soakS: 30,
		aggressive: false,
		jitterMs: 5,
		maxInflight: 4,
		loadTimeoutMs: 5_000,
		noTui: false,
		out: "",
		name: "intercom-stress",
	};

	const valueOf = (flag: string): string | null => {
		const index = argv.indexOf(flag);
		return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
	};
	const numOf = (flag: string, fallback: number): number => {
		const raw = valueOf(flag);
		if (raw === null) return fallback;
		const value = Number(raw);
		return Number.isFinite(value) ? value : fallback;
	};

	const mode = valueOf("--mode") ?? "chess";
	if (mode === "chess" || mode === "load") options.mode = mode;

	options.dummy = argv.includes("--dummy");
	options.aggressive = argv.includes("--aggressive");
	options.respawn = argv.includes("--respawn");
	options.noTui = argv.includes("--no-tui");

	options.moves = numOf("--moves", options.moves);
	options.games = numOf("--games", options.games);
	options.timeoutMs = numOf("--timeout-ms", options.timeoutMs);
	options.killWhiteAfter = numOf("--kill-white-after", options.killWhiteAfter);
	options.killBlackAfter = numOf("--kill-black-after", options.killBlackAfter);
	options.dropAt = numOf("--drop-connection-at", options.dropAt);
	options.sessions = numOf("--sessions", options.sessions);
	options.rampTo = numOf("--ramp-to", options.rampTo);
	options.rampS = numOf("--ramp-s", options.rampS);
	options.soakS = numOf("--soak-s", options.soakS);
	options.jitterMs = numOf("--jitter-ms", options.jitterMs);
	options.maxInflight = numOf("--max-inflight", options.maxInflight);
	options.loadTimeoutMs = numOf("--load-timeout-ms", options.loadTimeoutMs);
	options.out = valueOf("--out") ?? "";
	options.name = valueOf("--name") ?? options.name;

	return options;
}

// ---------------------------------------------------------------------------

interface Player {
	role: "white" | "black";
	worker: SpawnedWorker | null;
	sessionId: string | null;
	name: string;
}

interface GameOutcome {
	result: string;
	winner?: string;
	reason: string;
	plies: number;
	durationMs: number;
	moves: string[];
	timeouts: number;
	deliveryFailures: number;
	illegalMoves: number;
}

interface WorkerLiveState {
	status: string;
	contextPct?: number;
	lastRttMs?: number;
}

interface RunContext {
	options: Options;
	broker: BrokerSession;
	metrics: Metrics;
	tui: Tui;
	state: TuiState;
	plain: boolean;
	stoppedRef: { value: boolean };
	baseDir: string;
	players: { w: Player; b: Player };
	names: Map<string, string>;
	live: Record<string, WorkerLiveState>;
	lastMove: string | null;
	gameDurationStarted: number;
	render: () => void;
	log: (line: string) => void;
	tail: string[];
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtStat(stats: { p50?: number; p95?: number; p99?: number; count: number }): string {
	const r = (v: number | undefined) => (v === undefined ? "-" : v.toFixed(1));
	return `${r(stats.p50)} / ${r(stats.p95)} / ${r(stats.p99)} (n=${stats.count})`;
}

function fmtTable(title: string, rows: Array<[string, string]>): string {
	const width = Math.max(...rows.map(([k]) => k.length), title.length) + 2;
	const out: string[] = [];
	out.push(`== ${title} ${"=".repeat(Math.max(2, 60 - title.length - 4))}`);
	for (const [key, value] of rows) out.push(`  ${key.padEnd(width)}→ ${value}`);
	return out.join("\n");
}

// ---------------------------------------------------------------------------

interface PresenceInfo {
	id: string;
	name?: string;
	status?: string;
	contextPct?: number;
}

const STOPPED = { value: false };

// sessionId → display name, used by the ask instrumentation to label senders.
// Module-level so the broker recorder (constructed before ctx) can read it.
let askNames = new Map<string, string>();

// In-process broker sessions (dummy players) that must be disconnected before
// the process can exit — an open socket keeps bun's event loop alive.
const inProcessSessions: BrokerSession[] = [];

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const tty = Boolean(process.stdout.isTTY) && !options.noTui;
	const plain = !tty;

	if (plain) process.stdout.write(`intercom-stress · mode=${options.mode} · starting…\n`);

	const runRoot = options.out ? resolve(options.out) : join(homedir(), ".cornfield", "intercom-stress");
	const runDir = join(runRoot, timestamp());
	await mkdir(runDir, { recursive: true });

	const metrics = new Metrics(join(runDir, "events.jsonl"));
	metrics.start();

	const tail: string[] = [];
	const state: TuiState = {
		mode: options.mode,
		phase: "booting",
		elapsedMs: 0,
		workers: [],
		rttHistory: [],
		sendCount: 0,
		replyCount: 0,
		perSec: 0,
		throttleCount: 0,
		faults: [],
		eventTail: tail,
	};

	const tui = new Tui(tty, join(runDir, "live.json"));
	tui.start();

	process.on("SIGINT", () => {
		STOPPED.value = true;
	});
	process.on("SIGTERM", () => {
		STOPPED.value = true;
	});

	const players: { w: Player; b: Player } = {
		w: { role: "white", worker: null, sessionId: null, name: "white" },
		b: { role: "black", worker: null, sessionId: null, name: "black" },
	};
	const live: Record<string, WorkerLiveState> = {};
	const sessionNames = new Map<string, string>();
	askNames = sessionNames;

	const lastPresenceStatus = new Map<string, string>();

	const broker = new BrokerSession(
		{
			cwd: process.cwd(),
			model: "intercom-stress/controller",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			name: options.name,
			status: "booting",
		},
		event => {
			const now = Date.now();
			if (event.type === "presence") {
				const info = event as unknown as { type: "presence" } & PresenceInfo;
				metrics.presence(info.id, info.name ?? "?", info.status ?? "idle", info.contextPct);
				// Match the TUI worker by session id, fall back to name.
				const entry = state.workers.find(w => w.sessionId === info.id || w.name === info.name);
				if (entry) {
					entry.status = info.status ?? "idle";
					entry.contextPct = info.contextPct;
				}
				if (lastPresenceStatus.get(info.id) !== info.status) {
					lastPresenceStatus.set(info.id, info.status ?? "idle");
					pushTail(tail, `presence ${info.name ?? info.id.slice(0, 8)} → ${info.status ?? "idle"}`);
				}
				return;
			}
			if (event.type === "left") {
				metrics.record({ t: now, kind: "session_left", sessionId: event.sessionId, sessionName: "?" });
				pushTail(tail, `session left: ${event.sessionId.slice(0, 8)}`);
				for (const player of Object.values(players)) {
					if (player.sessionId === event.sessionId) {
						live[player.role] = { status: "gone" };
					}
				}
				return;
			}
			if (event.type === "receipt") {
				metrics.record({
					t: now,
					kind: "receipt",
					from: event.from.id,
					messageId: event.receipt.messageId,
					status: event.receipt.status,
					detail: event.receipt.detail,
				});
				pushTail(tail, `receipt ${event.receipt.status} ${event.receipt.messageId.slice(0, 8)}`);
				return;
			}
			if (event.type === "control") {
				metrics.record({
					t: now,
					kind: "control",
					from: event.from.id,
					messageId: event.control.messageId,
					action: event.control.action,
					detail: event.control.detail,
				});
				pushTail(tail, `control ${event.control.action} ${event.control.messageId.slice(0, 8)}`);
				return;
			}
			if (event.type === "error") {
				state.throttleCount += 1;
				metrics.record({ t: now, kind: "throttle", detail: event.error });
				pushTail(tail, `broker error: ${event.error}`);
				return;
			}
			if (event.type === "disconnected") {
				metrics.record({ t: now, kind: "disconnected" });
				pushTail(tail, "controller disconnected from broker");
			}
		},
		(record: { kind: "ask_sent"; askId: string; to: string } | { kind: "ask_delivered"; askId: string; ok: boolean; reason?: string }) => {
			const now = Date.now();
			if (record.kind === "ask_sent") {
				metrics.record({ t: now, kind: "ask_sent", askId: record.askId, to: record.to, toName: askNames.get(record.to) ?? "?" });
			} else {
				metrics.record({ t: now, kind: "ask_delivered", askId: record.askId, ok: record.ok, reason: record.reason });
			}
		},
	);

	await broker.connect();
	if (process.env.ICS_DEBUG) process.stdout.write("[dbg] controller connected\n");
	broker.updatePresence("booting");
	metrics.record({ t: Date.now(), kind: "phase", phase: `mode=${options.mode}` });

	const ctx: RunContext = {
		options,
		broker,
		metrics,
		tui,
		state,
		plain,
		stoppedRef: STOPPED,
		baseDir: runDir,
		players,
		names: sessionNames,
		live,
		lastMove: null,
		gameDurationStarted: Date.now(),
		render: () => undefined,
		log: (line: string) => {
			if (plain) process.stdout.write(`  ${line}\n`);
			else pushTail(tail, line);
		},
		tail,
	};

	ctx.render = () => render(ctx);

	let gameOutcomes: GameOutcome[] = [];
	let loadOutcome: LoadOutcome | null = null;

	try {
		if (options.mode === "chess") {
			gameOutcomes = await runChess(ctx);
		} else {
			loadOutcome = await runLoad(ctx);
		}
	} finally {
		broker.updatePresence("finalizing");
		await metrics.close();
		shutdownWorkers([ctx.players.w.worker, ctx.players.b.worker].filter((w): w is SpawnedWorker => w !== null));
		for (const session of inProcessSessions) await session.disconnect();
		await broker.disconnect();
		tui.stop();
	}

	const report = {
		timestamp: new Date().toISOString(),
		mode: options.mode,
		args: process.argv.slice(2),
		runDir,
		games: gameOutcomes.length > 0 ? gameOutcomes : undefined,
		load: loadOutcome,
		ops: summarizeOps(metrics),
		presence: {
			white: ctx.players.w.worker?.session ? metrics.presenceBreakdown(ctx.players.w.worker.session.id) : undefined,
			black: ctx.players.b.worker?.session ? metrics.presenceBreakdown(ctx.players.b.worker.session.id) : undefined,
		},
		faults: {
			injected: metrics.faultsInjected,
			observed: metrics.faultsObserved,
		},
	};
	await Bun.write(join(runDir, "report.json"), JSON.stringify(report, null, 2));

	if (!plain) {
		process.stdout.write(`\nreport written to ${join(runDir, "report.json")}\n`);
		return;
	}

	process.stdout.write(
		"\n" + fmtTable("intercom-stress report", [
			["mode", options.mode],
			["run", runDir],
			["asks sent", String(report.ops.requests)],
			["replies", String(report.ops.replies)],
			["delivery failures", String(report.ops.deliveryFailures)],
			["timeouts", String(report.ops.timeouts)],
			["throttle events", String(report.ops.rateLimitEvents)],
		]) +
			"\n" + fmtTable("ask RTT (ms)", [
				["p50 / p95 / p99", fmtStat(report.ops.askRtt)],
				["min / max", `${report.ops.askRtt.min ?? "-"} / ${report.ops.askRtt.max ?? "-"}`],
			]) +
			"\n" + fmtTable("broker hops (ms)", [
				["send→broker", fmtStat(report.ops.sendToBroker)],
				["broker hold", fmtStat(report.ops.brokerHold)],
				["broker→receiver", fmtStat(report.ops.brokerToReceiver)],
				["receiver→injected", fmtStat(report.ops.receiverToInjected)],
				["end-to-end (injected)", fmtStat(report.ops.endToEnd)],
			]) +
			"\n",
	);

	for (const game of gameOutcomes) {
		process.stdout.write(
			"\n" + fmtTable("chess game", [
				["result", game.result + (game.winner ? ` · winner ${game.winner}` : "")],
				["reason", game.reason],
				["plies", String(game.plies)],
				["duration", fmtMs(game.durationMs)],
				["illegal moves", String(game.illegalMoves)],
				["moves", game.moves.join(" ")],
			]) + "\n",
		);
	}

	if (loadOutcome) {
		process.stdout.write(
			"\n" + fmtTable("load run", [
				["throttle boundary (first)", loadOutcome.throttleFirstAtPerSec !== null ? `~${Math.round(loadOutcome.throttleFirstAtPerSec)} msg/s` : "none reached"],
				["throttle events", String(loadOutcome.throttleEvents)],
				["delivery failures", String(loadOutcome.deliveryFailures)],
				["ask timeouts", String(loadOutcome.timeouts)],
				["peak achieved", `${loadOutcome.peakAchievedPerSec} msg/s`],
				["avg reply RTT", loadOutcome.avgReplyRttMs !== null ? `${Math.round(loadOutcome.avgReplyRttMs)}ms` : "-"],
			]) + "\n",
		);
	}

	if (metrics.faultsInjected.length > 0) {
		process.stdout.write(
			"\n" + fmtTable("faults", [
				["injected", metrics.faultsInjected.join("; ")],
				["observed", metrics.faultsObserved.join("; ")],
			]) + "\n",
		);
	}

	process.stdout.write(`\nreport: ${join(runDir, "report.json")}\n`);
}

function pushTail(tail: string[], line: string): void {
	tail.push(line);
	if (tail.length > 40) tail.splice(0, tail.length - 40);
}

function render(ctx: RunContext): void {
	const { state, options } = ctx;
	state.elapsedMs = Date.now() - (options.mode === "chess" ? ctx.gameDurationStarted : 0);
	state.rttHistory = [...ctx.metrics.askRttMs];
	state.faults = ctx.metrics.faultsInjected.length > 0 ? [...ctx.metrics.faultsInjected] : [];
	ctx.tui.render(state);
}

// ---------------------------------------------------------------------------
// Chess mode

async function runChess(ctx: RunContext): Promise<GameOutcome[]> {
	const { options, broker, metrics, players } = ctx;
	const outcomes: GameOutcome[] = [];

	// Spawn players once; reuse across games.
	const piBin = await resolvePiBin();
	ctx.log(`worker binary: ${piBin}`);
	for (const side of ["w", "b"] as const) {
		const player = players[side];
		if (options.dummy) {
			if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] spawning dummy ${side}\n`);
			player.sessionId = await spawnDummyPlayer(ctx, side);
			if (player.sessionId) ctx.names.set(player.sessionId, player.name);
			if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] dummy ${side} connected ${player.sessionId?.slice(0, 8)}\n`);
			player.name = side === "w" ? "white (dummy)" : "black (dummy)";
		} else {
			const worker = await spawnWorker({
				role: player.role,
				baseDir: join(ctx.baseDir, "workers"),
				piBin,
			});
			player.worker = worker;
			const session = await discoverWorker(broker, worker, { timeoutMs: 120_000 });
			player.sessionId = session.id;
			ctx.names.set(session.id, player.name);
			ctx.log(`worker '${player.role}' registered as ${session.id.slice(0, 8)} (${session.model})`);
		}
	}

	broker.updatePresence("refereeing");
	metrics.record({ t: Date.now(), kind: "phase", phase: "chess:players-ready" });

	for (let gameIndex = 0; gameIndex < options.games && !ctx.stoppedRef.value; gameIndex++) {
		if (gameIndex > 0) {
			ctx.log(`game ${gameIndex + 1} starts…`);
		}
		outcomes.push(await playSingleGame(ctx));
	}
	return outcomes;
}

async function playSingleGame(ctx: RunContext): Promise<GameOutcome> {
	const { options, broker, metrics, players } = ctx;
	const outcome: GameOutcome = {
		result: "aborted",
		reason: "not started",
		plies: 0,
		durationMs: 0,
		moves: [],
		timeouts: 0,
		deliveryFailures: 0,
		illegalMoves: 0,
	};
	const started = Date.now();
	const game = new ChessGame();
	const moveCountForSide: Record<string, number> = { w: 0, b: 0 };
	let totalPlies = 0;

	const forfeit = (side: string, reason: string): void => {
		outcome.result = "forfeit";
		outcome.winner = side === "w" ? "black" : "white";
		outcome.reason = reason;
	};

	while (!ctx.stoppedRef.value) {
		const status = game.status();
		if (status.over) {
			outcome.result = status.reason;
			outcome.winner = status.winner;
			outcome.reason = status.reason;
			break;
		}
		if (options.moves > 0 && game.history.length >= options.moves) {
			outcome.result = "move cap";
			outcome.reason = `reached ${options.moves}-ply cap`;
			break;
		}

		const side = game.turn();
		const player = players[side];
		const killAt = side === "w" ? options.killWhiteAfter : options.killBlackAfter;

		if (killAt > 0 && player.worker && moveCountForSide[side] + 1 === killAt) {
			ctx.log(`FAULT: killing ${player.role} worker before move ${killAt}`);
			if (player.worker.session) {
				await injectKillWorker({ broker, metrics, worker: player.worker, sessionId: player.worker.session.id });
			}
			if (options.respawn) {
				const respawned = await respawnPlayer(ctx, player);
				if (!respawned) {
					forfeit(side, `${player.role} worker killed and respawn failed`);
					break;
				}
			} else {
				forfeit(side, `${player.role} worker killed (no --respawn)`);
				break;
			}
		}

		if (options.dropAt > 0 && totalPlies + 1 === options.dropAt) {
			ctx.log(`FAULT: dropping controller connection before plies=${totalPlies + 1}`);
			metrics.record({ t: Date.now(), kind: "fault_injected", fault: "drop-connection", detail: `before plies=${totalPlies + 1}` });
			metrics.faultsInjected.push(`drop-connection before plies=${totalPlies + 1}`);
			await broker.dropAndReconnect();
			metrics.record({ t: Date.now(), kind: "reconnected", sessionId: broker.sessionId ?? "" });
			metrics.faultsObserved.push("drop-connection: reconnected with new session id");
			ctx.log(`reconnected as ${(broker.sessionId ?? "").slice(0, 8)}`);
		}

		let applied = false;
		let lastTry = "";
		let lastReason = "";
		let attempts = 0;
		const maxAttempts = 4;

		while (!applied && attempts < maxAttempts && !ctx.stoppedRef.value) {
			attempts++;
			if (player.sessionId === null) break;
			const prompt = game.buildMovePrompt() + (attempts > 1
				? `\n\nYour previous reply "${lastTry}" was rejected: ${lastReason}. Reply with ONE legal SAN move.`
				: "");

				try {
				if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] ask ${player.role} ply ${totalPlies + 1} (${player.sessionId?.slice(0, 8)})\n`);
				const askStartedAt = Date.now();
				const res = await broker.ask(player.sessionId, prompt, { timeoutMs: options.timeoutMs });
				const thinkingMs = Date.now() - askStartedAt;
				if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] reply from ${player.role}: "${res.reply.content.text.slice(0, 40)}" rtt=${res.rttMs}\n`);
				metrics.askRttMs.push(res.rttMs);
				metrics.record({
					t: Date.now(),
					kind: "reply",
					askId: res.askId,
					from: player.sessionId ?? "",
					fromName: player.name,
					rttMs: res.rttMs,
					msg: res.reply,
				});
				// lastRttMs on the TUI shows the wall-clock move latency (including
				// the worker's model thinking), not just the delivery hop.
				ctx.live[player.role] = { ...(ctx.live[player.role] ?? {}), lastRttMs: thinkingMs };

				const san = extractSan(res.reply.content.text);
				const reply = tryApplyMove(game, san);
				if (reply.illegal) {
					outcome.illegalMoves++;
					lastTry = reply.text;
					lastReason = reply.reason ?? "illegal move";
					metrics.record({
						t: Date.now(),
						kind: "move",
						moveNo: totalPlies + 1,
						side,
						san: reply.text,
						fen: game.fen(),
						legal: false,
						rttMs: res.rttMs,
						thinkingMs,
					});
					ctx.log(`illegal move from ${player.role}: "${reply.text}" (${lastReason})`);
					continue;
				}

				applied = true;
				moveCountForSide[side] = (moveCountForSide[side] ?? 0) + 1;
				totalPlies++;
				outcome.moves.push(`${totalPlies}${side === "w" ? "." : "..."} ${reply.san}`);
				ctx.lastMove = reply.san;
				metrics.record({
					t: Date.now(),
					kind: "move",
					moveNo: totalPlies,
					side,
					san: reply.san,
					fen: game.fen(),
					legal: true,
					rttMs: res.rttMs,
					thinkingMs,
				});
				ctx.log(`[${totalPlies}] ${player.role}: ${reply.san} (${fmtMs(res.rttMs)})`);
				renderGame(ctx, game);
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (text.includes("timeout")) {
					outcome.timeouts++;
					metrics.record({ t: Date.now(), kind: "note", text: `ask timeout (${player.role}, ply ${totalPlies + 1})` });
				} else {
					outcome.deliveryFailures++;
				}
				ctx.log(`ask to ${player.role} failed: ${text}`);
				if (options.respawn && player.worker) {
					const respawned = await respawnPlayer(ctx, player);
					if (!respawned) {
						forfeit(side, `${player.role} unresponsive (${text}) and respawn failed`);
						break;
					}
					attempts = 0; // retry with the fresh worker
				} else {
					forfeit(side, `${player.role} unresponsive (${text})`);
					break;
				}
			}
		}

		if (!applied && outcome.result === "aborted") {
			forfeit(game.turn(), `${game.sideName()} failed to produce a legal move (${maxAttempts} attempts)`);
		}
		if (outcome.result !== "aborted") {
			break;
		}
	}

	outcome.plies = game.history.length;
	outcome.durationMs = Date.now() - started;
	metrics.record({ t: Date.now(), kind: "game_end", result: outcome.result, reason: outcome.reason });
	return outcome;
}

async function respawnPlayer(ctx: RunContext, player: Player): Promise<boolean> {
	ctx.log(`respawn ${player.role} worker…`);
	try {
		const worker = await spawnWorker({
			role: player.role,
			baseDir: join(ctx.baseDir, "workers", `${player.role}-respawn-${Date.now()}`),
			piBin: await resolvePiBin(),
		});
		const session = await discoverWorker(ctx.broker, worker, { timeoutMs: 120_000 });
		player.worker = worker;
		player.sessionId = session.id;
		ctx.names.set(session.id, player.name);
		ctx.log(`respawned as ${session.id.slice(0, 8)}`);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.log(`respawn failed: ${message}`);
		return false;
	}
}

function renderGame(ctx: RunContext, game: ChessGame): void {
	const { state } = ctx;
	state.phase = `game · ply ${game.history.length}`;
	state.boardAscii = game.ascii();
	state.moveNo = game.history.length;
	state.turn = game.turn();
	state.lastMove = ctx.lastMove ?? undefined;
	state.workers = (["w", "b"] as const).map(side => {
		const player = ctx.players[side];
		const liveState = ctx.live[player.role] ?? {};
		return {
			name: player.name,
			sessionId: player.sessionId ?? undefined,
			status: liveState.status ?? "idle",
			contextPct: liveState.contextPct,
			lastRttMs: liveState.lastRttMs,
		};
	});
	state.sendCount = game.history.length;
	state.replyCount = game.history.length;
	ctx.render();
}

// ---------------------------------------------------------------------------
// Dummy player (self-check mode: no LLM, no pi processes)

async function spawnDummyPlayer(ctx: RunContext, side: "w" | "b"): Promise<string> {
	const created = Date.now();
	const session = new BrokerSession(
		{
			cwd: process.cwd(),
			model: "intercom-stress/dummy",
			pid: process.pid,
			startedAt: created,
			lastActivity: created,
			name: `intercom-stress-dummy-${side}`,
			status: "idle",
		},
		() => {},
	);
	await session.connect();
	inProcessSessions.push(session);
		session.client.on("message", (from, message) => {
			if (!message.expectsReply || message.replyTo) return;
			if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] dummy ${side} got ask ${message.id.slice(0, 8)}\n`);
			let san = "e4";
		try {
			const fen = /FEN:\s*([^\n]+)/.exec(message.content.text)?.[1];
			const board = new ChessGame(fen);
			san = board.randomLegalMove();
		} catch {
			// fall back to e4; the referee rejects it if illegal
		}
		setTimeout(() => {
			session.client.send(from.id, { text: san, replyTo: message.id, expectsReply: false }).catch(() => {});
		}, 20);
	});
	return session.sessionId ?? "";
}

// ---------------------------------------------------------------------------
// Load mode

async function runLoad(ctx: RunContext): Promise<LoadOutcome> {
	const { options, metrics } = ctx;
	metrics.record({ t: Date.now(), kind: "phase", phase: "load:start" });

	const cfg: LoadConfig = {
		sessions: options.sessions,
		rampTo: options.rampTo,
		rampS: options.rampS,
		soakS: options.soakS,
		aggressive: options.aggressive,
		jitterMs: options.jitterMs,
		maxInflightPerVhost: options.maxInflight,
		askTimeoutMs: options.loadTimeoutMs,
		name: options.name,
		stop: () => ctx.stoppedRef.value,
	};

	ctx.state.workers = [{ name: `${options.sessions} vhosts`, status: "spawning", sessionId: undefined }];

	const loader = new Loadgen(cfg, metrics, tick => {
		ctx.state.phase = `load · ramp/soak`;
		ctx.state.sendCount = tick.sentTotal;
		ctx.state.replyCount = tick.replyTotal;
		ctx.state.perSec = tick.perSec;
		ctx.state.targetPerSec = tick.targetPerSec;
		ctx.state.throttleCount = tick.throttleCount;
		ctx.state.elapsedMs = Date.now() - ctx.gameDurationStarted;
		ctx.state.rttHistory = [...metrics.askRttMs];
		ctx.render();
	});

	const outcome = await loader.run();
	ctx.broker.updatePresence("done");
	return outcome;
}

await main();