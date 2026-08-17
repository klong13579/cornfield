/**
 * 语音偏好 —— 本地设置持久化（播报/速度/角色/静默时段/唤醒词）。
 * localStorage key: omp.voice.prefs；缺失字段回默认。
 */

export interface VoicePreferences {
	/** Agent 完成时自动朗读（TTS 播报）。 */
	autoSpeak: boolean;
	/** 朗读速度倍率（speechSynthesis rate）。 */
	rate: number;
	/** 朗读角色（SpeechSynthesisVoice.name，空 = 系统默认）。 */
	voiceName: string;
	/** 静默时段（24h "HH:mm"），此区间内抑制播报。 */
	quietStart: string;
	quietEnd: string;
	/** Jarvis 唤醒词（占位：真实唤醒需要常驻语音引擎，当前为偏好存储）。 */
	wakeWord: string;
}

const PREFS_KEY = "omp.voice.prefs";

export const DEFAULT_VOICE_PREFS: VoicePreferences = {
	autoSpeak: true,
	rate: 1,
	voiceName: "",
	quietStart: "23:00",
	quietEnd: "07:00",
	wakeWord: "Hey Jarvis",
};

export function loadVoicePrefs(): VoicePreferences {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<VoicePreferences>;
			return { ...DEFAULT_VOICE_PREFS, ...parsed };
		}
	} catch {
		// 配置损坏回默认
	}
	return { ...DEFAULT_VOICE_PREFS };
}

export function saveVoicePrefs(prefs: VoicePreferences): void {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// localStorage 不可用时仅内存态
	}
}

/** 当前时间是否处于静默时段（支持跨夜：quietStart > quietEnd）。 */
export function inQuietHours(prefs: VoicePreferences, now = new Date()): boolean {
	const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	if (prefs.quietStart === prefs.quietEnd) return false;
	const start1 = prefs.quietStart < prefs.quietEnd ? prefs.quietStart : prefs.quietStart;
	const end1 = prefs.quietEnd;
	const crossing = prefs.quietStart > prefs.quietEnd;
	if (!crossing) return hm >= start1 && hm < end1;
	return hm >= prefs.quietStart || hm < prefs.quietEnd;
}
