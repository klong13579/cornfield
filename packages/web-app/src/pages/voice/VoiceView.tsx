import { CircleStop, Mic, Send, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Orb, type OrbState } from "../../components/Orb";
import { inQuietHours, loadVoicePrefs, saveVoicePrefs, type VoicePreferences } from "../../lib/voice-preferences";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 语音页（FR-4 / FR-13）—— 基础语音 + Jarvis 双模式。
 * - STT：浏览器 Web Speech API（webkitSpeechRecognition，本地免 key）实时转写；
 *   不支持时降级为手动输入 + 提示。
 * - 发送：转写文本 → prompt 命令（pi-client）→ 会话工作台同一会话。
 * - Jarvis：64px orb 状态机（breathing→listening→shaping→composing）+
 *   自动 TTS 播报条（speechSynthesis，系统声线）+ 多轮对话记录。
 * - 偏好：播报/速度/角色/静默时段/唤醒词，localStorage 持久化。
 */

// ── Web Speech 类型（标准 DOM lib 无 SpeechRecognition 声明）──
interface RecognitionResultLike {
	isFinal: boolean;
	0: { transcript: string };
}
interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResultLike> }) => void) | null;
	onerror: ((e: { error?: string }) => void) | null;
	onend: (() => void) | null;
	start: () => void;
	stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── TTS 工具 ──
function speak(text: string, prefs: VoicePreferences): void {
	if (!("speechSynthesis" in window) || !text.trim()) return;
	if (inQuietHours(prefs)) return;
	const utterance = new SpeechSynthesisUtterance(text.trim());
	utterance.lang = "zh-CN";
	utterance.rate = prefs.rate;
	if (prefs.voiceName) {
		const voice = window.speechSynthesis.getVoices().find(v => v.name === prefs.voiceName);
		if (voice) utterance.voice = voice;
	}
	window.speechSynthesis.speak(utterance);
}

function stopSpeak(): void {
	if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

type VoiceMode = "basic" | "jarvis";

export function VoiceView(): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [mode, setMode] = useState<VoiceMode>("basic");
	const [prefs, setPrefs] = useState<VoicePreferences>(() => loadVoicePrefs());
	const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
	const [recording, setRecording] = useState(false);
	const [finalText, setFinalText] = useState("");
	const [interimText, setInterimText] = useState("");
	const [sttStatus, setSttStatus] = useState<"idle" | "listening">("idle");
	const [sendLog, setSendLog] = useState<string | null>(null);
	const [speaking, setSpeaking] = useState(false);
	const lastSpokenId = useRef<string | null>(null);
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
	const sttSupported = useMemo(() => getRecognitionCtor() !== null, []);

	// 声线列表（异步加载，保存后二次进入生效）
	useEffect(() => {
		if (!("speechSynthesis" in window)) return;
		const load = () => setVoices(window.speechSynthesis.getVoices());
		load();
		window.speechSynthesis.addEventListener("voiceschanged", load);
		return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
	}, []);

	const speakNow = (text: string, prefsToUse = prefs) => {
		speak(text, prefsToUse);
		setSpeaking(true);
		setTimeout(() => setSpeaking(false), Math.min(30_000, Math.max(1200, text.length * 180)));
	};

	// TTS 自动播报：监听会话新 assistant 消息（语音页面内保持播放）
	useEffect(() => {
		if (!prefs.autoSpeak) return;
		const last = [...view.messages].reverse().find(m => m.role === "assistant" && m.text && m.text.length > 0);
		if (!last || last.id === lastSpokenId.current) return;
		lastSpokenId.current = last.id;
		if (!inQuietHours(prefs) && last.text) speakNow(last.text);
		// eslint 无 (biome)：view 依赖由 subscribe 驱动；仅新消息触发
	}, [view.messages, prefs.autoSpeak, prefs.quietStart, prefs.quietEnd]);

	const updatePrefs = (patch: Partial<VoicePreferences>) => {
		const next = { ...prefs, ...patch };
		setPrefs(next);
		saveVoicePrefs(next);
	};

	const startListening = () => {
		const Ctor = getRecognitionCtor();
		if (!Ctor) return;
		const rec = new Ctor();
		rec.lang = "zh-CN";
		rec.continuous = true;
		rec.interimResults = true;
		rec.onresult = e => {
			let final = "";
			let interim = "";
			for (let i = 0; i < e.results.length; i++) {
				const r = e.results[i];
				if (r.isFinal) final += r[0].transcript;
				else interim += r[0].transcript;
			}
			if (final) setFinalText(prev => (prev ? `${prev}${final}` : final));
			setInterimText(interim);
		};
		rec.onerror = e => {
			if (e.error === "not-allowed" || e.error === "service-not-allowed") {
				setSttStatus("idle");
				setRecording(false);
				setSendLog("麦克风权限被拒绝：浏览器无法访问麦克风，可选手动输入。");
			}
		};
		rec.onend = () => {
			// 用户手动停止时停止；否则自动续听（浏览器偶发断流）
			if (recordingRef.current) {
				try {
					rec.start();
				} catch {
					// 续听失败（如页面隐藏）——恢复 idle
					recordingRef.current = false;
					setRecording(false);
					setSttStatus("idle");
				}
			}
		};
		recognitionRef.current = rec;
		recordingRef.current = true;
		setSttStatus("listening");
		try {
			rec.start();
		} catch {
			setSttStatus("idle");
			setSendLog("语音识别启动失败（浏览器不支持/权限被拒），可选手动输入。");
		}
	};

	// 录音态 ref（供 onend 判断是否用户主动停止）
	const recordingRef = useRef(false);

	const stopListening = () => {
		recordingRef.current = false;
		recognitionRef.current?.stop();
		recognitionRef.current = null;
		setSttStatus("idle");
	};

	const toggleRecording = () => {
		if (sttStatus === "listening") {
			stopListening();
			setRecording(false);
			return;
		}
		if (!sttSupported) {
			setSendLog("当前浏览器不支持 Web Speech API（建议 Chrome/Edge/Safari）。可选手动输入发送。");
			return;
		}
		setRecording(true);
		startListening();
	};

	const sendTranscript = () => {
		const text = `${finalText}${interimText}`.trim();
		if (!text) return;
		store.prompt(text);
		setFinalText("");
		setInterimText("");
		setSendLog(`已发送语音指令：${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`);
	};

	const manualText = `${finalText}${interimText}`;

	// Jarvis orb 状态：录制 listening → 有转写未发送 shaping → agent 流式 composing → 待命 breathing
	const jarvisOrb: OrbState =
		sttStatus === "listening"
			? "listening"
			: manualText.trim()
				? "shaping"
				: view.isStreaming
					? "composing"
					: "breathing";
	const recentTurns = useMemo(() => [...view.messages].slice(-6), [view.messages]);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[760px]">
				<div className="mb-6 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Voice</h1>
					<span className="text-[13px] text-ink-faint">
						{sttSupported ? "Web Speech API · 本地转写" : "降级模式：手动输入"}
					</span>
				</div>

				{/* 模式切换 */}
				<div className="mb-6 flex w-fit gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
					{(
						[
							["basic", "基础语音"],
							["jarvis", "Jarvis 免提"],
						] as [VoiceMode, string][]
					).map(([m, label]) => (
						<button
							key={m}
							type="button"
							className={`rounded px-3.5 py-1.5 text-[12px] font-medium transition-colors ${mode === m ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
							onClick={() => setMode(m)}
						>
							{label}
						</button>
					))}
				</div>

				{/* 不支持 Web Speech 时的醒目降级提示（D 增强） */}
				{!sttSupported && (
					<div className="mb-6 w-full max-w-[560px] rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-[12.5px] leading-relaxed text-ink">
						<b>语音识别不可用</b> —— 当前浏览器不支持 Web Speech API（建议 Chrome / Edge /
						Safari）。已切换为手动输入模式：直接在下框输入指令，或改用麦克风录音后自行转写。
					</div>
				)}
				{/* 模式主体 */}
				{mode === "basic" ? (
					<div className="flex flex-col items-center gap-6">
						{/* 录音球（120px 触控，录制时 pulse + 波纹） */}
						<button
							type="button"
							onClick={toggleRecording}
							disabled={!sttSupported}
							className="relative flex h-30 w-30 items-center justify-center rounded-full border border-hairline-strong bg-surface transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
							aria-label={recording ? "停止录音" : "开始录音"}
						>
							{recording && (
								<span className="absolute inset-0 animate-ping rounded-full border border-warning/50" />
							)}
							{recording ? (
								<CircleStop size={44} strokeWidth={1.25} className="text-danger" />
							) : (
								<Mic
									size={44}
									strokeWidth={1.25}
									className={sttStatus === "listening" ? "text-ink" : "text-ink-subtle"}
								/>
							)}
						</button>

						{/* 实时转写（active 态变亮） */}
						<div
							className={`w-full max-w-[560px] rounded-xl border px-4 py-3 text-[14px] leading-relaxed transition-colors ${sttStatus === "listening" || manualText ? "border-hairline-strong bg-surface text-ink" : "border-hairline bg-surface-2 text-ink-faint"}`}
						>
							{finalText}
							{interimText && <span className="opacity-60">{interimText}</span>}
							{!manualText && (
								<span className="text-ink-faint">
									{recording ? "正在聆听…（点击球停止）" : "点击录音球开始说话，或直接手动输入"}
								</span>
							)}
						</div>

						{/* 发送为指令 / 手动输入 */}
						<div className="flex w-full max-w-[560px] items-center gap-2.5">
							<input
								value={sttSupported ? manualText : finalText}
								onChange={e => setFinalText(e.target.value)}
								placeholder={sttSupported ? "也可直接输入作为指令" : "浏览器不支持语音识别，请手动输入指令"}
								className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								onKeyDown={e => e.key === "Enter" && sendTranscript()}
							/>
							<button
								type="button"
								className="btn shrink-0"
								onClick={sendTranscript}
								disabled={!manualText.trim()}
							>
								<Send size={14} strokeWidth={1.5} className="inline" /> 发送
							</button>
						</div>
						{sendLog && <div className="max-w-[560px] text-[12px] text-ink-subtle">{sendLog}</div>}
					</div>
				) : (
					<div className="flex flex-col items-center gap-6">
						{/* Jarvis：64px orb 状态机 */}
						<div className="flex flex-col items-center gap-2.5">
							<Orb state={jarvisOrb} size={64} className="shrink-0" />
							<span className="font-mono text-[11px] text-ink-faint">{jarvisOrb}</span>
						</div>

						{/* 唤醒/免持说明 + 录音控制 */}
						<div className="flex items-center gap-3">
							<button
								type="button"
								className={
									sttStatus === "listening"
										? "btn flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white"
										: "btn flex h-14 w-14 items-center justify-center rounded-full"
								}
								onClick={toggleRecording}
								disabled={!sttSupported}
								aria-label={recording ? "停止" : "按住说话"}
							>
								{recording ? <CircleStop size={22} strokeWidth={1.5} /> : <Mic size={22} strokeWidth={1.5} />}
							</button>
							<div className="text-[12px] leading-snug text-ink-faint">
								唤醒词「{prefs.wakeWord}」占位（常驻唤醒需独立语音引擎，P4 后置）
								<br />
								点击麦克风开始 / 停止
							</div>
						</div>

						{/* 转写区 */}
						<div
							className={`w-full max-w-[560px] rounded-xl border px-4 py-3 text-[14px] leading-relaxed ${sttStatus === "listening" ? "border-hairline-strong bg-surface text-ink" : "border-hairline bg-surface-2 text-ink-faint"}`}
						>
							{finalText}
							{interimText && <span className="opacity-60">{interimText}</span>}
							{!manualText && (
								<span className="text-ink-faint">{recording ? "聆听中…" : "（转写内容将作为指令发送）"}</span>
							)}
						</div>

						<button type="button" className="btn" onClick={sendTranscript} disabled={!manualText.trim()}>
							发送为指令
						</button>
						{sendLog && <div className="text-[12px] text-ink-subtle">{sendLog}</div>}

						{/* TTS 播报条 */}
						<div className="flex w-full max-w-[560px] items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-3">
							<button
								type="button"
								className={`flex h-9 w-9 items-center justify-center rounded-full ${prefs.autoSpeak ? "bg-accent text-on-accent" : "bg-surface-2 text-ink-subtle"}`}
								onClick={() => updatePrefs({ autoSpeak: !prefs.autoSpeak })}
								aria-label={prefs.autoSpeak ? "关闭自动播报" : "开启自动播报"}
							>
								{prefs.autoSpeak ? (
									<Volume2 size={16} strokeWidth={1.5} />
								) : (
									<VolumeX size={16} strokeWidth={1.5} />
								)}
							</button>
							<div className="min-w-0 flex-1">
								<div className="text-[12px] text-ink-subtle">自动播报 Agent 回复</div>
								<div className="text-[11px] text-ink-faint">
									{inQuietHours(prefs)
										? `静默时段 ${prefs.quietStart}–${prefs.quietEnd} 内不播报`
										: `系统 TTS · ${prefs.rate}x${prefs.voiceName ? ` · ${prefs.voiceName}` : ""}`}
								</div>
							</div>
							{view.isStreaming && <Orb state="composing" size={20} />}
							<button
								type="button"
								className="link"
								onClick={() => {
									if (speaking) {
										stopSpeak();
										setSpeaking(false);
									} else {
										speakNow(lastAssistantText(recentTurns));
									}
								}}
							>
								{speaking ? "停止" : "重读"}
							</button>
						</div>

						{/* 多轮对话记录 */}
						{recentTurns.length > 0 && (
							<div className="w-full max-w-[560px]">
								<h3 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									本轮对话
								</h3>
								<div className="flex flex-col gap-2">
									{recentTurns.map(turn =>
										turn.role === "user" ? (
											<div
												key={turn.id}
												className="self-end max-w-[80%] rounded-xl border border-hairline bg-user-bg px-3 py-2 text-[13px] text-ink"
											>
												{turn.text}
											</div>
										) : turn.text ? (
											<div
												key={turn.id}
												className="self-start max-w-[80%] rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] text-ink-muted"
											>
												{turn.text}
											</div>
										) : null,
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{/* 语音偏好 */}
				<div className="mt-10">
					<h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">语音偏好</h2>
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						<div className="flex items-center justify-between px-4 py-2.5">
							<span className="text-[13px] text-ink-subtle">朗读速度</span>
							<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
								{[0.8, 1, 1.2].map(r => (
									<button
										key={r}
										type="button"
										className={`rounded px-2.5 py-0.5 font-mono text-[11px] ${prefs.rate === r ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
										onClick={() => updatePrefs({ rate: r })}
									>
										{r}x
									</button>
								))}
							</div>
						</div>
						<div className="flex items-center justify-between px-4 py-2.5">
							<span className="text-[13px] text-ink-subtle">朗读角色</span>
							<select
								value={prefs.voiceName}
								onChange={e => updatePrefs({ voiceName: e.target.value })}
								className="max-w-[240px] rounded border border-hairline bg-surface-2 px-2 py-1.5 text-[12px] text-ink outline-none"
							>
								<option value="">系统默认</option>
								{voices
									.filter(v => v.lang.startsWith("zh"))
									.map(v => (
										<option key={v.name} value={v.name}>
											{v.name}
										</option>
									))}
							</select>
						</div>
						<div className="flex items-center justify-between px-4 py-2.5">
							<span className="text-[13px] text-ink-subtle">静默时段（不播报）</span>
							<span className="flex items-center gap-2 font-mono text-[12px] text-ink">
								<input
									type="time"
									value={prefs.quietStart}
									onChange={e => updatePrefs({ quietStart: e.target.value })}
									className="rounded border border-hairline bg-surface-2 px-2 py-1 outline-none"
								/>
								–
								<input
									type="time"
									value={prefs.quietEnd}
									onChange={e => updatePrefs({ quietEnd: e.target.value })}
									className="rounded border border-hairline bg-surface-2 px-2 py-1 outline-none"
								/>
							</span>
						</div>
						<div className="flex items-center justify-between px-4 py-2.5">
							<span className="text-[13px] text-ink-subtle">唤醒词</span>
							<input
								value={prefs.wakeWord}
								onChange={e => updatePrefs({ wakeWord: e.target.value })}
								className="w-[200px] rounded border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none"
							/>
						</div>
					</div>
					<div className="mt-2 text-[11px] text-ink-faint">
						偏好本地存储（localStorage），不落日志。云端 TTS/STT 选型待定（requirements 第 8 节）。
					</div>
				</div>
			</div>
		</div>
	);
}

function lastAssistantText(messages: { role: "user" | "assistant"; text?: string }[]): string {
	const last = [...messages].reverse().find(m => m.role === "assistant" && m.text);
	return last?.text ?? "";
}
