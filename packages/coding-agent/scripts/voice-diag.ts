#!/usr/bin/env bun
/**
 * voice-diag — Voice Jarvis session debugger.
 *
 * Merges the two evidence sources of a voice session into one annotated
 * timeline and reconstructs every response's stage timings, so freezes and
 * latency regressions are readable in seconds instead of hand-grepping logs.
 *
 * Sources:
 *   1. ~/.cornfield/logs/cornfield.YYYY-MM-DD.log{,.1..4} — controller lifecycle events
 *      (live phase / response.created / response.done / errors / stalls),
 *      grouped by pid. Rotation segments are all scanned.
 *   2. ~/.cornfield/agent/sessions/<cwd>/by-date/<date>/<id>.jsonl — the session
 *      tree: voice transcripts (customType "voice") + main-session messages.
 *
 * What it reports:
 *   - Per-response stage table:
 *       endpoint(listening→thinking) → response.created → speaking(TTFB)
 *       → response.done(status) → listening(drain+room-decay)
 *     with deltas; slow stages flagged.
 *   - Anomalies, each encoding a failure mode proven in acceptance:
 *       [SILENT-GAP]  listening with zero events for ≥ --gap seconds AND no
 *                     main-session activity inside the gap → capture stall
 *                     (VPIO post-playback quirk). Gap WITH JSONL activity is
 *                     reported as [TASK-RUNNING] instead (normal busy wait).
 *       [FN-CALL]     response.done < 400ms after created, no speaking in
 *                     between, next created within 600ms → the response was a
 *                     bare function call. Right after a confirmation exchange
 *                     this is the self-confirmation fingerprint (triple
 *                     「已确认执行」 2026-08-06).
 *       [ERROR]       live server error (with errorCount).
 *       [QUEUED]      commit queued behind an in-flight response.
 *       [STALE]       response-in-flight flag self-healed (lost done).
 *       [STALL]       capture stalled / resumed (watchdog).
 *       [SLOW]        created latency > 1.5s or TTFB > 1.5s.
 *   - Active voice settings (endpointing / aec / vadSilenceMs) from config.
 *
 * Usage:
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts              # latest voice session today
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts --list       # candidate sessions today
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts --session <path> [--pid N]
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts --date 2026-08-06 --last 30
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts --verbose    # + full merged timeline
 *   bun run .cornfield/skills/voice-diag/voice-diag.ts --gap 10     # silent-gap threshold (s)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ------------------------------------------------------------------ args ---

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const has = (name: string): boolean => args.includes(name);
const DATE = flag("--date") ?? new Date().toISOString().slice(0, 10);
const GAP_S = Number(flag("--gap") ?? 15);
const LAST_MIN = flag("--last") ? Number(flag("--last")) : undefined;
const VERBOSE = has("--verbose");
const LIST = has("--list");
const SESSION_ARG = flag("--session");
const PID_ARG = flag("--pid") ? Number(flag("--pid")) : undefined;

const HOME = os.homedir();
const SESSIONS_ROOT = path.join(HOME, ".cornfield", "agent", "sessions");

// ------------------------------------------------------------- utilities ---

function fmt(ms: number): string {
	const d = new Date(ms);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function dur(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

interface LogEvent {
	ts: number;
	level: string;
	pid: number;
	message: string;
	from?: string;
	to?: string;
	responseId?: string;
	status?: string;
	errorCount?: number;
	silenceMs?: number;
	ageMs?: number;
}

function parseLogFiles(date: string): LogEvent[] {
	// Rotation segments: cornfield.DATE.log, cornfield.DATE.log.1 … .4 (maxFiles 5).
	const base = path.join(HOME, ".cornfield", "logs", `cornfield.${date}.log`);
	const files = [base, `${base}.1`, `${base}.2`, `${base}.3`, `${base}.4`];
	const out: LogEvent[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"live ') && !line.includes('"voice')) continue;
			try {
				const raw = JSON.parse(line) as Record<string, unknown>;
				const message = typeof raw.message === "string" ? raw.message : "";
				if (!message.startsWith("live ") && !message.startsWith("voice")) continue;
				const ts = Date.parse(String(raw.timestamp ?? ""));
				if (Number.isNaN(ts)) continue;
				out.push({
					ts,
					level: String(raw.level ?? ""),
					pid: Number(raw.pid ?? 0),
					message,
					from: raw.from as string | undefined,
					to: raw.to as string | undefined,
					responseId: raw.responseId as string | undefined,
					status: raw.status as string | undefined,
					errorCount: raw.errorCount as number | undefined,
					silenceMs: raw.silenceMs as number | undefined,
					ageMs: raw.ageMs as number | undefined,
				});
			} catch {
				// truncated/corrupt line — skip
			}
		}
	}
	return out.sort((a, b) => a.ts - b.ts);
}

interface JsonlEntry {
	ts: number;
	kind: "voice" | "message";
	role?: string;
	text: string;
}

function parseSessionFile(file: string): JsonlEntry[] {
	const out: JsonlEntry[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line) as Record<string, unknown>;
			const ts = Date.parse(String(e.timestamp ?? ""));
			if (Number.isNaN(ts)) continue;
			if (e.type === "custom_message" && e.customType === "voice") {
				const details = (e.details ?? {}) as Record<string, unknown>;
				out.push({ ts, kind: "voice", role: String(details.role ?? ""), text: String(e.content ?? "") });
			} else if (e.type === "message") {
				const msg = (e.message ?? e) as Record<string, unknown>;
				const role = String(msg.role ?? "");
				if (role !== "user" && role !== "assistant") continue;
				const content = msg.content;
				let text = "";
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) {
					text = content
						.map(c => {
							if (!c || typeof c !== "object") return "";
							const cc = c as Record<string, unknown>;
							if (cc.type === "text") return String(cc.text ?? "");
							if (cc.type === "toolCall" || cc.type === "tool_call")
								return `[tool:${String(cc.name ?? cc.toolName ?? "")}]`;
							return "";
						})
						.filter(Boolean)
						.join(" ");
				}
				if (text) out.push({ ts, kind: "message", role, text });
			}
		} catch {
			// skip
		}
	}
	return out.sort((a, b) => a.ts - b.ts);
}

function findVoiceSessions(date: string): Array<{ file: string; mtime: number; voiceCount: number; firstTs?: number }> {
	const results: Array<{ file: string; mtime: number; voiceCount: number; firstTs?: number }> = [];
	let cwds: string[] = [];
	try {
		cwds = fs.readdirSync(SESSIONS_ROOT);
	} catch {
		return results;
	}
	for (const cwd of cwds) {
		const dir = path.join(SESSIONS_ROOT, cwd, "by-date", date);
		let files: string[] = [];
		try {
			files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(dir, f);
			const text = fs.readFileSync(file, "utf8");
			const voiceCount = text.split('"customType":"voice"').length - 1;
			if (voiceCount === 0) continue;
			const entries = parseSessionFile(file);
			results.push({ file, mtime: fs.statSync(file).mtimeMs, voiceCount, firstTs: entries[0]?.ts });
		}
	}
	return results.sort((a, b) => b.mtime - a.mtime);
}

function readVoiceSettings(): string {
	try {
		const text = fs.readFileSync(path.join(HOME, ".cornfield", "agent", "config.yml"), "utf8");
		const get = (key: string): string => {
			const m = text.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, "m"));
			return m ? m[1]!.trim() : "–";
		};
		return `endpointing=${get("endpointing")} (default client)  aec=${get("aec")}  vadSilenceMs=${get("vadSilenceMs")} (default 1200)`;
	} catch {
		return "(config unreadable)";
	}
}

// ------------------------------------------------------- response records ---

interface ResponseRec {
	id: string;
	createdTs: number;
	endpointTs?: number;
	speakingTs?: number;
	doneTs?: number;
	status?: string;
	listeningTs?: number;
	fnCallSuspect?: boolean;
}

interface Anomaly {
	ts: number;
	tag: string;
	text: string;
}

function analyze(
	events: LogEvent[],
	jsonl: JsonlEntry[],
	gapMs: number,
): { recs: ResponseRec[]; anomalies: Anomaly[] } {
	const recs: ResponseRec[] = [];
	const anomalies: Anomaly[] = [];
	let current: ResponseRec | undefined;
	let lastEndpointTs: number | undefined;
	let gapStart: number | undefined;
	let lastEventTs: number | undefined;

	const closeGap = (ts: number): void => {
		if (gapStart === undefined) return;
		const start = gapStart;
		gapStart = undefined;
		const size = ts - start;
		if (size < gapMs) return;
		const busy = jsonl.some(e => e.kind === "message" && e.ts > start && e.ts < ts);
		anomalies.push({
			ts: start,
			tag: busy ? "TASK-RUNNING" : "SILENT-GAP",
			text: busy
				? `${dur(size)} listening 空档，主会话有活动（任务在跑，正常等待）`
				: `${dur(size)} listening 零事件且主会话无活动 — 疑似麦克风采集停摆（VPIO 播放后怪癖）`,
		});
	};

	for (const ev of events) {
		lastEventTs = ev.ts;
		if (ev.message === "live phase") {
			if (ev.to === "thinking" && ev.from === "listening") {
				lastEndpointTs = ev.ts; // client endpoint committed a turn
			}
			if (ev.to === "listening") {
				if (current?.doneTs && !current.listeningTs) current.listeningTs = ev.ts;
				if (gapStart === undefined) gapStart = ev.ts;
			} else if (ev.to === "speaking") {
				closeGap(ev.ts);
				if (current && !current.speakingTs && !current.doneTs) current.speakingTs = ev.ts;
			} else {
				closeGap(ev.ts);
			}
		} else if (ev.message === "live response.created") {
			closeGap(ev.ts);
			// FN-CALL fingerprint on the PREVIOUS record: created→done fast, no
			// speaking, and this create lands right after it.
			if (current?.doneTs && !current.speakingTs) {
				const gen = current.doneTs - current.createdTs;
				if (gen < 400 && ev.ts - current.doneTs < 600) current.fnCallSuspect = true;
			}
			current = { id: ev.responseId ?? "?", createdTs: ev.ts, endpointTs: lastEndpointTs };
			recs.push(current);
		} else if (ev.message === "live response.done") {
			closeGap(ev.ts);
			const rec = recs.find(r => r.id === ev.responseId) ?? current;
			if (rec) {
				rec.doneTs = ev.ts;
				rec.status = ev.status;
			}
		} else if (ev.message.startsWith("live server error")) {
			closeGap(ev.ts);
			anomalies.push({
				ts: ev.ts,
				tag: "ERROR",
				text: `${ev.message.slice("live server error ".length)} (errorCount=${ev.errorCount ?? "?"})`,
			});
		} else if (ev.message === "live commit queued behind in-flight response") {
			anomalies.push({ ts: ev.ts, tag: "QUEUED", text: "commit 排队等待在飞 response（端点落在响应期间）" });
		} else if (ev.message === "live response flag went stale, resetting") {
			anomalies.push({ ts: ev.ts, tag: "STALE", text: `response 标志位丢失自愈 (age=${dur(ev.ageMs ?? 0)})` });
		} else if (ev.message.startsWith("live capture stalled")) {
			anomalies.push({ ts: ev.ts, tag: "STALL", text: `麦克风采集停摆 (silence=${dur(ev.silenceMs ?? 0)})` });
		} else if (ev.message === "live capture resumed") {
			anomalies.push({ ts: ev.ts, tag: "RESUME", text: "采集恢复" });
		} else if (ev.message.startsWith("voice") && ev.message.includes("failed")) {
			anomalies.push({ ts: ev.ts, tag: "ERROR", text: ev.message });
		}
	}
	// Trailing gap (session went silent and never came back).
	if (gapStart !== undefined && lastEventTs !== undefined && lastEventTs - gapStart >= gapMs) {
		anomalies.push({
			ts: gapStart,
			tag: "SILENT-GAP",
			text: `${dur(lastEventTs - gapStart)} listening 空档直到日志结束 — 疑似采集停摆或用户离开`,
		});
	}
	return { recs, anomalies: anomalies.sort((a, b) => a.ts - b.ts) };
}

// ------------------------------------------------------------------- main ---

const sessions = findVoiceSessions(DATE);
if (LIST) {
	if (sessions.length === 0) {
		console.log(`${DATE} 没有 voice 会话`);
	} else {
		console.log(`${DATE} 的 voice 会话（按修改时间倒序）：`);
		for (const s of sessions) {
			console.log(`  ${s.file}`);
			console.log(`    voice 条目 ${s.voiceCount}，首条 ${s.firstTs ? fmt(s.firstTs) : "?"}，mtime ${fmt(s.mtime)}`);
		}
	}
	process.exit(0);
}

const target = SESSION_ARG ?? sessions[0]?.file;
if (!target) {
	console.error(`${DATE} 没有 voice 会话。--list 查看候选，--date 换日期。`);
	process.exit(1);
}
const jsonl = parseSessionFile(target);
if (jsonl.length === 0) {
	console.error(`会话无可解析条目：${target}`);
	process.exit(1);
}

const allEvents = parseLogFiles(DATE);
// Pick the pid whose live events overlap this session's lifetime.
const t0 = jsonl[0]!.ts;
const tEnd = jsonl[jsonl.length - 1]!.ts;
const byPid = new Map<number, LogEvent[]>();
for (const ev of allEvents) {
	if (!byPid.has(ev.pid)) byPid.set(ev.pid, []);
	byPid.get(ev.pid)!.push(ev);
}
let pid = PID_ARG;
if (pid === undefined) {
	let best = 0;
	for (const [p, evs] of byPid) {
		const overlap = evs.filter(e => e.ts >= t0 - 5 * 60_000 && e.ts <= tEnd + 5 * 60_000).length;
		if (overlap > best) {
			best = overlap;
			pid = p;
		}
	}
}
const events = pid === undefined ? [] : (byPid.get(pid) ?? []);
let filtered = events;
if (LAST_MIN !== undefined) {
	const cutoff = Date.now() - LAST_MIN * 60_000;
	filtered = events.filter(e => e.ts >= cutoff);
}

const { recs, anomalies } = analyze(filtered, jsonl, GAP_S * 1000);

console.log(`Voice session : ${target}`);
console.log(`Pid           : ${pid ?? "(未找到匹配日志的 pid)"}   日志: ~/.cornfield/logs/cornfield.${DATE}.log{,.1..4}`);
console.log(`窗口          : ${fmt(t0)} – ${fmt(tEnd)} (${dur(tEnd - t0)})`);
console.log(`Voice 设置    : ${readVoiceSettings()}`);
console.log("");

// Stage table
console.log(`── 响应阶段计时 (${recs.length} 个 response) ─────────────────────────`);
if (recs.length === 0) console.log("  (无 response.created 事件 — 日志缺失或 pid 不匹配)");
for (const [i, r] of recs.entries()) {
	const lines: string[] = [];
	lines.push(`#${i + 1} ${r.id.slice(-8)}  ${fmt(r.createdTs)}`);
	if (r.endpointTs) {
		const createLat = r.createdTs - r.endpointTs;
		lines.push(`   endpoint→created ${dur(createLat)}${createLat > 1500 ? "  ⚠ SLOW" : ""}`);
	}
	if (r.speakingTs) {
		const ttfb = r.speakingTs - r.createdTs;
		lines.push(`   created→speaking ${dur(ttfb)} (TTFB)${ttfb > 1500 ? "  ⚠ SLOW" : ""}`);
	} else if (r.fnCallSuspect) {
		lines.push("   (无 speaking — 纯函数调用响应)");
	}
	if (r.doneTs) {
		const gen = r.doneTs - (r.speakingTs ?? r.createdTs);
		lines.push(
			`   →done[${r.status ?? "?"}] ${dur(gen)}${r.listeningTs ? `   →listening +${dur(r.listeningTs - r.doneTs)} (drain)` : ""}`,
		);
	}
	if (r.fnCallSuspect)
		lines.push("   ⚠ FN-CALL 指纹：created→done<400ms 无音频，紧随新 create — 模型自调用了工具（自确认嫌疑）");
	console.log(lines.join("\n"));
}
console.log("");

// Voice transcripts
console.log("── 语音转写 ─────────────────────────────────────────────");
for (const e of jsonl.filter(x => x.kind === "voice")) {
	console.log(`  ${fmt(e.ts)} [${e.role}] ${e.text.slice(0, 80)}`);
}
console.log("");

// Anomalies
console.log(`── 异常 (${anomalies.length}) ─────────────────────────────────────────`);
if (anomalies.length === 0) console.log("  无");
for (const a of anomalies) {
	console.log(`  ${fmt(a.ts)} [${a.tag}] ${a.text}`);
}

// Verbose merged timeline
if (VERBOSE) {
	console.log("");
	console.log("── 合并时间线 ───────────────────────────────────────────");
	type Item = { ts: number; line: string };
	const items: Item[] = [];
	for (const ev of filtered) {
		let line = ev.message;
		if (ev.message === "live phase") line = `phase ${ev.from}→${ev.to}`;
		if (ev.responseId) line += ` ${ev.responseId.slice(-8)}`;
		if (ev.status) line += ` [${ev.status}]`;
		items.push({ ts: ev.ts, line });
	}
	for (const e of jsonl) {
		items.push({ ts: e.ts, line: `JSONL ${e.kind}(${e.role ?? ""}) ${e.text.slice(0, 60)}` });
	}
	items.sort((a, b) => a.ts - b.ts);
	for (const it of items) console.log(`  ${fmt(it.ts)} ${it.line}`);
}
