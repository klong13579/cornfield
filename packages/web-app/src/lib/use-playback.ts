import { useEffect, useState } from "react";

/**
 * 回放引擎 —— 纯前端驱动消息时间线逐步 reveal。
 * 能力：播放/暂停（发/停计时器）、速度 1x/2x/4x（同比例缩短步间隔）、
 * 快进/快退（±1 step）、进度条（step/总条数）、Step 计数、seek 跳转。
 * 与后端解耦：只消费 entries 数组（get_messages 真数据）。
 */

export type PlaybackSpeed = 1 | 2 | 4;

/** 1x 时每条消息的揭示间隔（ms）。 */
const STEP_BASE_MS = 750;

export interface Playback {
	playing: boolean;
	speed: PlaybackSpeed;
	/** 已揭示的 entry 数（0..entryCount）。 */
	step: number;
	entryCount: number;
	/** 0..1 进度。 */
	progress: number;
	togglePlay: () => void;
	setSpeed: (speed: PlaybackSpeed) => void;
	/** 快进（+1）。 */
	next: () => void;
	/** 快退（-1）。 */
	prev: () => void;
	seek: (index: number) => void;
}

export function usePlayback(entryCount: number): Playback {
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState<PlaybackSpeed>(1);
	const [step, setStep] = useState(0);

	// 播放计时：step 变化驱动下一拍（避免 interval 与 seek 竞态）
	useEffect(() => {
		if (!playing || step >= entryCount) return;
		const timer = setTimeout(() => setStep(s => Math.min(s + 1, entryCount)), STEP_BASE_MS / speed);
		return () => clearTimeout(timer);
	}, [playing, speed, step, entryCount]);

	// 播到末尾自动停
	useEffect(() => {
		if (playing && step >= entryCount) setPlaying(false);
	}, [playing, step, entryCount]);

	return {
		playing,
		speed,
		step,
		entryCount,
		progress: entryCount === 0 ? 0 : step / entryCount,
		togglePlay: () => setPlaying(p => !p),
		setSpeed: s => setSpeed(s),
		next: () => setStep(s => Math.min(s + 1, entryCount)),
		prev: () => setStep(s => Math.max(s - 1, 0)),
		seek: index => setStep(Math.min(Math.max(0, index), entryCount)),
	};
}
