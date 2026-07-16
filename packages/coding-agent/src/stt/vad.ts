/**
 * Voice Activity Detection (VAD) state machine — pure function for testability.
 *
 * Mirrors Hermes Agent's RMS-based VAD (tools/voice_mode.py:546-625): compute
 * RMS (root mean square) of recent audio frames, threshold against
 * `silenceThreshold`. After speech is confirmed, sustained silence for
 * `silenceDurationMs` triggers auto-stop.
 *
 * Two-stage algorithm:
 *   1. Speech confirmation: requires speech above threshold for at least
 *      `minSpeechDurationMs` (tolerates brief dips between syllables).
 *   2. End detection: once confirmed, sustained silence for
 *      `silenceDurationMs` fires the auto-stop callback once.
 *
 * If no speech is detected at all for `maxWaitMs` (e.g. user hits record and
 * walks away), auto-stop fires as a safety net.
 */
export interface VadOptions {
	/** RMS amplitude above which audio counts as speech. 0-32767. Default 200. */
	silenceThreshold: number;
	/** Continuous silence duration to auto-stop after speech is confirmed. Default 3000ms. */
	silenceDurationMs: number;
	/** Brief dip tolerance to prevent resetting during natural speech pauses. Default 300ms. */
	minSpeechDurationMs: number;
	/** Max wait for any speech before auto-stop. Default 15000ms. */
	maxWaitMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
	silenceThreshold: 200,
	silenceDurationMs: 3000,
	minSpeechDurationMs: 300,
	maxWaitMs: 15000,
};

export interface VadStreamState {
	hasSpoken: boolean;
	peakRms: number;
	/** When the current silence episode started (0 = not currently in silence). */
	silenceStartMs: number;
}

export interface VadStreamResult {
	state: VadStreamState;
	shouldStop: boolean;
}

export function initialVadStreamState(): VadStreamState {
	return { hasSpoken: false, peakRms: 0, silenceStartMs: 0 };
}

/**
 * Timer-aware VAD wrapper. Caller passes a clock (typically `Date.now()`) and
 * receives back when to auto-stop. This is the form ListenController should
 * call from its recording loop.
 *
 * The stop signal is "one-shot" — callers must not act on a `shouldStop=true`
 * result that is stale (i.e. caller already stopped on a previous tick).
 */
export function feedVadStream(
	state: VadStreamState,
	rms: number,
	nowMs: number,
	startedAtMs: number,
	options: VadOptions,
): VadStreamResult {
	const elapsed = nowMs - startedAtMs;
	const updated: VadStreamState = {
		...state,
		peakRms: Math.max(state.peakRms, rms),
	};

	if (rms > options.silenceThreshold) {
		// Above threshold: speech. Reset silence tracker.
		updated.silenceStartMs = 0;
		if (!updated.hasSpoken && elapsed >= options.minSpeechDurationMs) {
			updated.hasSpoken = true;
		}
		return { state: updated, shouldStop: false };
	}

	// Below threshold.
	if (!updated.hasSpoken) {
		// No speech yet — just keep tracking peak. MaxWait handled below.
	} else {
		// Speech confirmed, now silent. Arm silence timer once.
		if (updated.silenceStartMs === 0) {
			updated.silenceStartMs = nowMs;
		} else if (nowMs - updated.silenceStartMs >= options.silenceDurationMs) {
			return { state: updated, shouldStop: true };
		}
	}

	// MaxWait safety net: even if user never speaks, auto-stop after maxWait.
	if (!updated.hasSpoken && elapsed >= options.maxWaitMs) {
		return { state: updated, shouldStop: true };
	}

	return { state: updated, shouldStop: false };
}

/**
 * Map a raw RMS value (0-32767) to a 0-7 level index for the on-screen
 * meter bar. Matches Hermes' `▁▂▃▅▇▇▅▂` style visual scale.
 */
export function rmsToLevel(rms: number, maxRms = 16000): number {
	if (rms <= 0) return 0;
	const normalized = Math.min(1, rms / maxRms);
	// Non-linear scaling: 0 -> 0, 0.5 -> ~4, 1.0 -> 7
	return Math.min(7, Math.round(Math.sqrt(normalized) * 7));
}

const LEVEL_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Render a 7-cell level meter bar (e.g. `▃▅▆▇▇▅▂`) for a sequence of recent
 * RMS values, oldest first. Used for the live recording UI.
 */
export function renderLevelBar(recentRms: readonly number[]): string {
	const cells = [...recentRms.slice(-7)];
	while (cells.length < 7) cells.unshift(0);
	return cells.map(rms => LEVEL_GLYPHS[rmsToLevel(rms)]).join("");
}
