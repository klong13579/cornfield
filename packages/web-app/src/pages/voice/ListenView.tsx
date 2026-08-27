import { Clipboard, Download, FileText, ListTodo, Mic, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Orb } from "../../components/Orb";
import { encodeWavPcm16, WAV_TARGET_SAMPLE_RATE } from "../../lib/audio-encode";
import type { ListenRecordingDto } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";

/**
 * 听记（VOICE-D）—— TUI /record 的 web 前端：浏览器录音 → 16kHz PCM WAV →
 * serve record_transcribe（TUI /record 同源转写管线：本地 whisper / record.model API，
 * 自动分块）→ 落 ~/.omp/listen/（与 /record 同目录同格式）。历史 = listen_list 全量加载。
 *
 * 四态：idle（orb breathing 静止帧）→ recording（orb listening 动效 + 7 格电平 + 计时）
 * → transcribing（orb working）→ done（文本卡 + 操作组：整理纪要/提取待办/发 Agent/
 * 复制/导出 .md）。错误/权限拒绝落 error 态提示。
 */

type ListenPhase = "idle" | "recording" | "transcribing" | "done";

const LEVEL_BAR_CELLS = 7;
const LEVEL_EMIT_MS = 90;
/** 录音上限（serve 端 stt.maxRecordingSec 默认 60；前端同值提示）。 */
const MAX_RECORDING_MS = 60_000;

function formatClock(totalSec: number): string {
	const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
	const s = String(totalSec % 60).padStart(2, "0");
	return `${m}:${s}`;
}

/** 导出 .md：Blob 下载（转写文本 + 头部元信息）。 */
function downloadMarkdown(rec: { name: string; text: string; recordedAt: string }): void {
	const body = `# ${rec.name.replace(/\.json$/, "")}\n\n> ${new Date(rec.recordedAt).toLocaleString()}\n\n${rec.text}\n`;
	const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = rec.name.replace(/\.json$/, ".md");
	a.click();
	URL.revokeObjectURL(url);
}

export function ListenView(): React.JSX.Element {
	const store = useSessionStore();
	const [phase, setPhase] = useState<ListenPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [elapsed, setElapsed] = useState(0);
	const [levels, setLevels] = useState<number[]>(new Array(LEVEL_BAR_CELLS).fill(0));
	const [result, setResult] = useState<{ text: string; path: string; model: string } | null>(null);
	const [recordings, setRecordings] = useState<ListenRecordingDto[]>([]);
	const [search, setSearch] = useState("");
	const [openName, setOpenName] = useState<string | null>(null);

	const audioRef = useRef<{ ctx: AudioContext; stream: MediaStream; stop: () => void } | null>(null);
	const levelTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const samplesRef = useRef<Float32Array[]>([]);
	/** AudioContext 实际采样率（stopCapture 后 ctx 关闭，仍可取）。 */
	const sampleRateRef = useRef(48_000);

	// 历史：挂载时拉取一次（TUI /listen 同数据）
	useEffect(() => {
		let cancelled = false;
		void store
			.listenList()
			.then(res => {
				if (!cancelled && res.ok) setRecordings(res.recordings);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [store]);

	useEffect(() => {
		return () => {
			stopCapture();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载清理
	}, []);

	const stopCapture = useCallback(() => {
		if (levelTimer.current) clearInterval(levelTimer.current);
		if (clockTimer.current) clearInterval(clockTimer.current);
		levelTimer.current = null;
		clockTimer.current = null;
		audioRef.current?.stop();
		audioRef.current = null;
	}, []);

	const startRecording = async () => {
		setError(null);
		setResult(null);
		setLevels(new Array(LEVEL_BAR_CELLS).fill(0));
		samplesRef.current = [];
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			setError("无法访问麦克风：浏览器权限被拒绝或未授权。请检查地址栏麦克风权限后重试。");
			return;
		}
		const ctx = new AudioContext();
		sampleRateRef.current = ctx.sampleRate;
		const source = ctx.createMediaStreamSource(stream);
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 512;
		source.connect(analyser);

		// 采集 Float32 音频（ScriptProcessor 兼容性好；短录音场景够用）
		const processor = ctx.createScriptProcessor(4096, 1, 1);
		processor.onaudioprocess = e => {
			const ch = e.inputBuffer.getChannelData(0);
			samplesRef.current.push(new Float32Array(ch));
		};
		analyser.connect(processor);
		processor.connect(ctx.destination); // 保持图活跃（不发声，输出接 destination 保活）

		audioRef.current = {
			ctx,
			stream,
			stop: () => {
				try {
					processor.disconnect();
					analyser.disconnect();
					source.disconnect();
					void ctx.close();
				} catch {
					/* 已关闭 */
				}
				for (const t of stream.getTracks()) t.stop();
			},
		};

		setPhase("recording");
		const t0 = Date.now();
		clockTimer.current = setInterval(() => {
			const e = Math.floor((Date.now() - t0) / 1000);
			setElapsed(e);
			if (Date.now() - t0 >= MAX_RECORDING_MS) {
				void stopRecording();
			}
		}, 1000);

		// 电平：10Hz 从 analyser 取 RMS → 7 格 sqrt 缩放（与 TUI renderBarFromRms 同视觉）
		const timeData = new Uint8Array(analyser.fftSize);
		levelTimer.current = setInterval(() => {
			analyser.getByteTimeDomainData(timeData);
			let sum = 0;
			for (let i = 0; i < timeData.length; i++) {
				const v = (timeData[i]! - 128) / 128;
				sum += v * v;
			}
			const rms = Math.sqrt(sum / timeData.length);
			const norm = Math.min(1, rms * 4);
			setLevels(prev => {
				const next = [...prev];
				for (let i = 0; i < LEVEL_BAR_CELLS; i++) {
					const h = Math.min(1, Math.sqrt(norm) * 1);
					next[i] = i === LEVEL_BAR_CELLS - 1 ? Math.max(0.12, h * 0.5) : Math.max(0.06, h);
				}
				return next;
			});
		}, LEVEL_EMIT_MS);
	};

	const stopRecording = async () => {
		stopCapture();
		const chunks = samplesRef.current;
		samplesRef.current = [];
		const total = chunks.reduce((n, c) => n + c.length, 0);
		if (total === 0) {
			setPhase("idle");
			setError("没有采集到音频，已取消。");
			return;
		}
		const merged = new Float32Array(total);
		let off = 0;
		for (const c of chunks) {
			merged.set(c, off);
			off += c.length;
		}
		const wav = encodeWavPcm16(merged, sampleRateRef.current, WAV_TARGET_SAMPLE_RATE);
		const b64 = bytesToBase64(wav);

		setPhase("transcribing");
		try {
			const res = await store.recordTranscribe(b64);
			if (!res.ok || !res.text) {
				setPhase("idle");
				setError(res.error ?? "转写失败：未返回文本。");
				return;
			}
			setResult({ text: res.text, path: res.path, model: res.model });
			setPhase("done");
			// 刷新历史（新录音入列表）
			const list = await store.listenList();
			if (list.ok) setRecordings(list.recordings);
		} catch (err) {
			setPhase("idle");
			setError(`转写失败：${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const cancelRecording = () => {
		stopCapture();
		samplesRef.current = [];
		setElapsed(0);
		setPhase("idle");
	};

	// ── done 操作组 ──
	const agentPrompt = (prefix: string) => {
		if (!result?.text.trim()) return;
		store.prompt(`${prefix}\n\n${result.text}`);
		setNotice(`已发送给 Agent 处理（${prefix.slice(0, 12)}…）`);
	};

	const copyText = async () => {
		if (!result?.text) return;
		try {
			await navigator.clipboard.writeText(result.text);
			setNotice("已复制");
		} catch {
			setError("复制失败：浏览器剪贴板不可用");
		}
	};

	const filtered = search.trim()
		? recordings.filter(r => r.name.includes(search.trim()) || r.text.includes(search.trim()))
		: recordings;

	return (
		<div className="flex flex-col items-center gap-6">
			{/* 错误提示 */}
			{error && (
				<div className="w-full page-narrow rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-[12.5px] leading-relaxed text-ink">
					{error}
					<button type="button" className="link ml-2" onClick={() => setError(null)}>
						清除
					</button>
				</div>
			)}
			{notice && <div className="w-full page-narrow text-center text-[12px] text-ink-subtle">{notice}</div>}

			{/* orb 槽位：idle/done 静止帧（paused），录音/转写才动 */}
			<button
				type="button"
				className="relative flex cursor-pointer items-center justify-center rounded-full focus-visible:outline-2"
				title={phase === "recording" ? "点击停止并转写" : "点击开始录音"}
				onClick={() => {
					if (phase === "recording") void stopRecording();
					else if (phase === "idle") void startRecording();
				}}
				aria-label={phase === "recording" ? "停止并转写" : "开始录音"}
			>
				<Orb
					state={phase === "recording" ? "listening" : phase === "transcribing" ? "working" : "breathing"}
					size={64}
					paused={phase !== "recording" && phase !== "transcribing"}
				/>
			</button>

			{/* idle / done 提示 */}
			{phase === "idle" && (
				<div className="text-[13px] text-ink-faint">点击圆球开始录音（上限 60s），或从下方历史选择已有录音整理</div>
			)}

			{/* recording：电平条 + 计时 + 停止/取消 */}
			{phase === "recording" && (
				<>
					<div className="flex h-[30px] items-end gap-1">
						{levels.map((h, i) => (
							<i
								key={i}
								className="block w-[7px] rounded-[3px] bg-success opacity-80 transition-[height] duration-100"
								style={{ height: `${Math.round(h * 28)}px` }}
							/>
						))}
					</div>
					<div className="flex items-center gap-3.5">
						<span className="font-mono text-2xl font-medium tabular-nums tracking-[0.5px] text-ink">
							{formatClock(elapsed)}
						</span>
						<button
							type="button"
							className="btn flex items-center gap-2 bg-danger text-white hover:bg-danger/85"
							onClick={() => void stopRecording()}
						>
							<Square size={13} strokeWidth={1.5} fill="currentColor" /> 停止并转写
						</button>
						<button type="button" className="btn ghost" onClick={cancelRecording}>
							取消
						</button>
					</div>
				</>
			)}

			{/* transcribing */}
			{phase === "transcribing" && (
				<>
					<div className="text-[13px] text-ink-muted">转写中…（本地 whisper / record.model，长录音自动分块）</div>
					<div className="h-[5px] w-[200px] overflow-hidden rounded-[3px] bg-surface-3">
						<i className="block h-full w-full animate-pulse rounded-[3px] bg-success" />
					</div>
					<div className="font-mono text-[11px] text-ink-faint">请勿关闭页面</div>
				</>
			)}

			{/* done：文本卡 + 操作组 */}
			{phase === "done" && result && (
				<div className="w-full page-narrow">
					<div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
						<span className="mono">{formatClock(elapsed)}</span>
						<span>·</span>
						<span className="badge neutral">{result.model || "whisper"}</span>
						<span className="rounded bg-surface-2 px-1.5 py-px font-mono">
							{result.path.replace(/^\/Users\/[^/]+/, "~")}
						</span>
						<span style={{ flex: 1 }} />
						<span className="text-success">✓ 已保存</span>
					</div>
					<pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-hairline-strong bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink">
						{result.text}
					</pre>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="btn"
							onClick={() => agentPrompt("请把以下录音转写整理成会议纪要，列出要点和结论：")}
						>
							<FileText size={13} strokeWidth={1.5} className="inline" /> 整理为纪要
						</button>
						<button
							type="button"
							className="btn"
							onClick={() => agentPrompt("请从以下录音转写中提取待办事项（负责人/截止/内容）：")}
						>
							<ListTodo size={13} strokeWidth={1.5} className="inline" /> 提取待办
						</button>
						<button
							type="button"
							className="btn ghost"
							onClick={() => agentPrompt("以下是一段录音转写，请处理：")}
						>
							<Send size={13} strokeWidth={1.5} className="inline" /> 发给 Agent 处理
						</button>
						<button type="button" className="btn ghost" onClick={() => void copyText()}>
							<Clipboard size={13} strokeWidth={1.5} className="inline" /> 复制文本
						</button>
						<button
							type="button"
							className="btn ghost"
							onClick={() =>
								downloadMarkdown({
									name: result.path.split("/").pop() ?? "recording.json",
									text: result.text,
									recordedAt: new Date().toISOString(),
								})
							}
						>
							<Download size={13} strokeWidth={1.5} className="inline" /> 导出 .md
						</button>
						<span style={{ flex: 1 }} />
						<button
							type="button"
							className="btn ghost"
							onClick={() => {
								setPhase("idle");
								setResult(null);
								setElapsed(0);
							}}
						>
							重新录音
						</button>
					</div>
				</div>
			)}

			{/* ── 历史记录（listen_list） ── */}
			<div className="mt-4 w-full page-narrow">
				<div className="mb-2 flex items-center gap-3">
					<h3 className="text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">历史记录</h3>
					<span className="text-[11px] text-ink-faint">~/.omp/listen/ · 与 TUI /listen 同数据</span>
					<input
						value={search}
						onChange={e => setSearch(e.target.value)}
						placeholder="搜索关键词…"
						className="ml-auto max-w-[220px] rounded border border-hairline bg-surface px-2.5 py-1.5 text-[12px] text-ink"
					/>
				</div>
				<div className="overflow-hidden rounded-xl border border-hairline bg-surface">
					{recordings.length === 0 && !search && (
						<div className="px-4 py-6 text-center text-[12px] text-ink-faint">
							暂无录音记录 —— 点击上方圆球录一段，或去 TUI 用 <span className="mono">/record</span>{" "}
							录（同一列表）
						</div>
					)}
					{filtered.length === 0 && search && (
						<div className="px-4 py-6 text-center text-[12px] text-ink-faint">
							没有匹配「{search}」的记录，换个关键词试试
						</div>
					)}
					{filtered.map(rec => (
						<div key={rec.path}>
							<div className="flex items-center gap-3 border-b border-hairline px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-2">
								<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-dim text-ink-muted">
									<Mic size={16} strokeWidth={1.5} />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] text-ink">{rec.name}</span>
									<span className="mt-0.5 flex gap-2.5 font-mono text-[11px] text-ink-faint">
										<span>{new Date(rec.recordedAt).toLocaleString()}</span>
										<span>{Math.max(1, Math.round(rec.size / 1024))} KB</span>
										<span className="badge neutral">whisper</span>
									</span>
								</span>
								<button
									type="button"
									className="rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:text-ink"
									onClick={() => setOpenName(prev => (prev === rec.name ? null : rec.name))}
								>
									{openName === rec.name ? "收起" : "查看"}
								</button>
								<button
									type="button"
									className="rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:text-ink"
									onClick={e => {
										e.stopPropagation();
										downloadMarkdown({ name: rec.name, text: rec.text, recordedAt: rec.recordedAt });
									}}
								>
									导出 .md
								</button>
							</div>
							{openName === rec.name && (
								<div className="border-b border-hairline bg-surface-2 px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-muted last:border-b-0">
									{rec.text || "（空转写）"}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/** Uint8Array → base64（浏览器端，无 Buffer 依赖）。 */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}
