/**
 * Voice Stage orb — motion design preview.
 *
 * Standalone demo of the P0.5 "breathing orb" concept: a large central
 * graphic whose shape, color and motion track the voice state machine
 * (connecting → listening → thinking → speaking → barge-in → idle).
 *
 * Run live:        bun orb-demo.tmp.ts            (full screen, loops)
 * Static preview:  bun orb-demo.tmp.ts --frames   (one frame per state)
 *
 * Rendering: half-block (▀) truecolor for the orb body — each character
 * cell is 2 vertical pixels, so the pixel grid is roughly square. Pure
 * ANSI, no deps, works in any truecolor terminal.
 */

type RGB = [number, number, number];
type Phase = "connecting" | "listening" | "thinking" | "speaking" | "bargein" | "idle";

const PHASE_ORDER: Phase[] = ["connecting", "listening", "thinking", "speaking", "bargein", "listening", "idle"];
const PHASE_DUR: Record<Phase, number> = {
	connecting: 1.6,
	listening: 4.0,
	thinking: 4.0,
	speaking: 4.5,
	bargein: 0.7,
	idle: 3.0,
};
const PHASE_LABEL: Record<Phase, string> = {
	connecting: "连接中",
	listening: "聆听",
	thinking: "思考",
	speaking: "播报",
	bargein: "被打断",
	idle: "环境待机",
};
const PHASE_HUE: Record<Phase, [number, number, number]> = {
	// [hue, saturation, lightness]
	connecting: [222, 0.55, 0.62],
	listening: [187, 0.9, 0.66],
	thinking: [40, 0.95, 0.64],
	speaking: [276, 0.85, 0.68],
	bargein: [0, 0.0, 0.92],
	idle: [46, 0.6, 0.4],
};

// ── color helpers ────────────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): RGB {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g] = [c, x];
	else if (hp < 2) [r, g] = [x, c];
	else if (hp < 3) [g, b] = [c, x];
	else if (hp < 4) [g, b] = [x, c];
	else if (hp < 5) [r, b] = [x, c];
	else [r, b] = [c, x];
	const m = l - c / 2;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function mix(a: RGB, b: RGB, t: number): RGB {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

const BG: RGB = [7, 9, 17];

// ── simulated audio levels (organic, state-driven) ──────────────────────────

function micLevel(t: number): number {
	// intermittent user speech: syllable bursts with word gaps
	const active = Math.sin(t * 0.55) > -0.35 ? 1 : 0.12;
	const syl = Math.pow(Math.max(0, Math.sin(t * 7.3 + 0.5)), 1.3);
	const drift = 0.75 + 0.25 * Math.sin(t * 0.9);
	return Math.min(1, active * syl * drift * 0.85 + 0.04);
}

function speechLevel(t: number): number {
	// assistant playback: rhythmic syllables with phrase pauses
	const syl = Math.pow(Math.max(0, Math.sin(t * 8.2)), 1.6);
	const phrase = (Math.sin(t * 1.6) + 1) / 2 > 0.18 ? 1 : 0.15;
	return Math.min(1, syl * phrase * (0.65 + 0.35 * Math.sin(t * 0.7)) + 0.03);
}

// ── animation state ─────────────────────────────────────────────────────────

interface AnimState {
	phase: Phase;
	phaseT: number; // seconds inside current phase
	t: number; // global time
	envIn: number; // mic envelope (fast attack / slow release)
	envOut: number; // playback envelope
	ripples: number[]; // expanding ring radii (listening)
	particles: number[]; // orbit angles (thinking)
	levelHist: number[]; // waveform history
	bloom: number; // connecting bloom 0→1
	shrink: number; // idle shrink 0→1
	flash: number; // barge-in flash
}

function newState(): AnimState {
	return {
		phase: "connecting",
		phaseT: 0,
		t: 0,
		envIn: 0,
		envOut: 0,
		ripples: [],
		particles: [0, 1.2, 2.5, 3.9, 5.1],
		levelHist: [],
		bloom: 0,
		shrink: 0,
		flash: 0,
	};
}

function envelope(cur: number, target: number): number {
	const rate = target > cur ? 0.45 : 0.1; // fast attack, slow release
	return cur + (target - cur) * rate;
}

function advance(s: AnimState, dt: number): void {
	s.t += dt;
	s.phaseT += dt;
	if (s.phaseT >= PHASE_DUR[s.phase]) {
		const idx = PHASE_ORDER.indexOf(s.phase);
		s.phase = PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
		s.phaseT = 0;
		if (s.phase === "connecting") s.bloom = 0;
		if (s.phase === "idle") s.shrink = 0;
		if (s.phase === "bargein") s.flash = 1;
		if (s.phase === "listening") s.ripples = [];
	}

	const mic = s.phase === "listening" || s.phase === "bargein" ? micLevel(s.t) : 0;
	const out = s.phase === "speaking" ? speechLevel(s.t) : 0;
	s.envIn = envelope(s.envIn, mic);
	s.envOut = envelope(s.envOut, out);
	s.flash = Math.max(0, s.flash - dt * 2.2);

	if (s.phase === "connecting") s.bloom = Math.min(1, s.bloom + dt / 0.9);
	if (s.phase === "idle") s.shrink = Math.min(1, s.shrink + dt / 1.2);

	if (s.phase === "listening") {
		// spawn a ripple on speech energy peaks
		if (s.envIn > 0.25 && (s.ripples.length === 0 || s.ripples[s.ripples.length - 1] > 3)) {
			s.ripples.push(0);
		}
		for (let i = s.ripples.length - 1; i >= 0; i--) {
			s.ripples[i] += dt * 9;
			if (s.ripples[i] > 26) s.ripples.splice(i, 1);
		}
	}
	if (s.phase === "thinking") {
		for (let i = 0; i < s.particles.length; i++) {
			s.particles[i] += dt * (1.4 + i * 0.22);
		}
	}

	const histLevel = Math.max(s.envIn, s.envOut);
	s.levelHist.push(histLevel);
	if (s.levelHist.length > 200) s.levelHist.shift();
}

// ── frame rendering ─────────────────────────────────────────────────────────

interface Cell {
	ch: string;
	fg: RGB;
	bg: RGB;
}

function easeOutCubic(x: number): number {
	return 1 - Math.pow(1 - x, 3);
}

function renderFrame(s: AnimState, cols: number, rows: number): string {
	const pw = cols;
	const ph = rows * 2;
	const cx = pw / 2;
	const cy = ph / 2 - rows * 0.12; // leave room for transcript at bottom

	const [hue, sat, lit] = PHASE_HUE[s.phase];
	const level = Math.max(s.envIn, s.envOut);

	// radius choreography
	let radius = Math.min(pw, ph) * 0.34;
	const breathe = 0.02 * Math.sin(s.t * 0.8);
	let scale = 1 + breathe + level * 0.16;
	if (s.phase === "connecting") scale *= easeOutCubic(s.bloom);
	if (s.phase === "thinking") scale *= 0.92; // focus contraction
	if (s.phase === "idle") scale *= 1 - 0.55 * easeOutCubic(s.shrink);
	if (s.phase === "bargein") scale *= 1 - 0.25 * s.flash;
	radius *= scale;

	const wobbleAmp = 0.012 + level * 0.055 + (s.phase === "speaking" ? 0.02 : 0);
	const grid: Cell[][] = [];

	for (let ry = 0; ry < rows; ry++) {
		const row: Cell[] = [];
		for (let colx = 0; colx < cols; colx++) {
			// two vertical pixels per cell
			const top = pixelColor(colx, ry * 2);
			const bot = pixelColor(colx, ry * 2 + 1);
			row.push({ ch: "▀", fg: top, bg: bot });
		}
		grid.push(row);
	}

	function pixelColor(px: number, py: number): RGB {
		const x = px - cx;
		const y = py - cy;
		const d = Math.hypot(x, y);
		const theta = Math.atan2(y, x);

		const wob =
			wobbleAmp *
			(0.5 * Math.sin(3 * theta + s.t * 1.5) +
				0.3 * Math.sin(5 * theta - s.t * 2.1) +
				0.2 * Math.sin(7 * theta + s.t * 2.8));
		const R = radius * (1 + wob);

		if (d <= R) {
			const k = d / R;
			const bright = Math.pow(1 - k, 0.45) * 0.9 + 0.28;
			const rim = k > 0.8 ? ((k - 0.8) / 0.2) * 0.3 : 0;
			let l = lit * bright + rim;
			if (s.flash > 0) l = Math.min(1, l + s.flash * 0.5);
			return hslToRgb(hue, sat, Math.min(0.95, l));
		}

		// outer glow
		const glowW = 2.5 + level * 5 + (s.phase === "speaking" ? 2 : 0);
		if (d <= R + glowW) {
			const gk = (d - R) / glowW;
			const a = Math.pow(1 - gk, 2.2) * (0.28 + level * 0.45);
			const glow = hslToRgb(hue, sat, lit);
			return mix(BG, glow, Math.min(1, a));
		}

		// listening ripples
		if (s.phase === "listening" || s.phase === "bargein") {
			for (const rr of s.ripples) {
				const band = Math.abs(d - (R + 2 + rr));
				if (band < 0.9) {
					const ra = (1 - band / 0.9) * Math.max(0, 1 - rr / 24) * 0.55;
					const rc = hslToRgb(hue, sat, lit + 0.1);
					return mix(BG, rc, ra);
				}
			}
		}

		// speaking sonic ring
		if (s.phase === "speaking") {
			const ringR = R + 3.5 + s.envOut * 3;
			const band = Math.abs(d - ringR);
			if (band < 0.8) {
				const ra = (1 - band / 0.8) * (0.3 + s.envOut * 0.5);
				return mix(BG, hslToRgb(hue, sat, lit + 0.15), ra);
			}
		}

		return BG;
	}

	// thinking particles overlay
	if (s.phase === "thinking") {
		for (let i = 0; i < s.particles.length; i++) {
			const ang = s.particles[i];
			const pr = radius * (1.3 + 0.12 * Math.sin(s.t * 2 + i));
			const px = Math.round(cx + Math.cos(ang) * pr);
			const py = Math.round(cy + Math.sin(ang) * pr);
			const cellRow = Math.floor(py / 2);
			if (px >= 0 && px < cols && cellRow >= 0 && cellRow < rows) {
				const c = hslToRgb(hue, sat, 0.85);
				const cell = grid[cellRow][px];
				if (py % 2 === 0) cell.fg = c;
				else cell.bg = c;
				cell.ch = "▀";
			}
		}
	}

	// ── text overlays ──
	const lines = grid.map(row => row.map(c => ({ ...c })));

	function drawText(row: number, text: string, fg: RGB, center = true) {
		if (row < 0 || row >= rows) return;
		const start = center ? Math.max(0, Math.floor((cols - text.length) / 2)) : 2;
		for (let i = 0; i < text.length && start + i < cols; i++) {
			lines[row][start + i] = { ch: text[i], fg, bg: BG };
		}
	}

	const dim: RGB = [90, 100, 125];
	const bright = hslToRgb(hue, sat, 0.8);

	// status bar
	const status = `● mic   ◉ aec   qwen-realtime   ${PHASE_LABEL[s.phase]}`;
	drawText(0, status, dim);

	// waveform bar (rolling level history)
	const waveRow = rows - 5;
	const waveW = Math.min(cols - 8, 56);
	const wStart = Math.floor((cols - waveW) / 2);
	const blocks = "▁▂▃▄▅▆▇█";
	const hist = s.levelHist;
	for (let i = 0; i < waveW; i++) {
		const v = hist[hist.length - waveW + i] ?? 0;
		const bi = Math.min(7, Math.floor(v * 8));
		const wc = mix(BG, bright, 0.25 + v * 0.7);
		lines[waveRow][wStart + i] = { ch: blocks[bi], fg: wc, bg: BG };
	}

	// transcript sample per state
	const transcript: Record<Phase, [string, string]> = {
		connecting: ["", ""],
		listening: ["你: 帮我看下 TODO 里还有几条待办", ""],
		thinking: ["你: 帮我看下 TODO 里还有几条待办", "⣿ read: TODO.md"],
		speaking: ["你: 帮我看下 TODO 里还有几条待办", "助手: 还有三条，分别是…"],
		bargein: ["你: 等等，先看另一个——", ""],
		idle: ["", ""],
	};
	const [t1, t2] = transcript[s.phase];
	if (t1) drawText(rows - 3, t1, [150, 160, 185]);
	if (t2) drawText(rows - 2, t2, bright);

	// ── serialize to ANSI ──
	let out = "\x1b[H";
	let lastFg = "";
	let lastBg = "";
	for (let ry = 0; ry < rows; ry++) {
		for (let colx = 0; colx < cols; colx++) {
			const c = lines[ry][colx];
			const fg = `38;2;${c.fg[0]};${c.fg[1]};${c.fg[2]}`;
			const bg = `48;2;${c.bg[0]};${c.bg[1]};${c.bg[2]}`;
			if (fg !== lastFg) {
				out += `\x1b[${fg}m`;
				lastFg = fg;
			}
			if (bg !== lastBg) {
				out += `\x1b[${bg}m`;
				lastBg = bg;
			}
			out += c.ch;
		}
		out += "\r\n";
	}
	return out;
}

// ── drivers ─────────────────────────────────────────────────────────────────

async function live(): Promise<void> {
	const cols = Math.max(56, Math.min(110, (process.stdout.columns ?? 80) - 2));
	const rows = Math.max(20, Math.min(34, (process.stdout.rows ?? 26) - 2));
	process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
	const restore = () => process.stdout.write("\x1b[?25l\x1b[0m\x1b[?1049l\x1b[?25h");
	process.on("SIGINT", () => {
		restore();
		process.exit(0);
	});

	const s = newState();
	const FPS = 20;
	const dt = 1 / FPS;
	for (;;) {
		advance(s, dt);
		process.stdout.write(renderFrame(s, cols, rows));
		await Bun.sleep(dt * 1000);
	}
}

async function frames(): Promise<void> {
	// one representative frame per state, mid-phase
	const cols = 66;
	const rows = 24;
	for (const phase of ["connecting", "listening", "thinking", "speaking", "bargein", "idle"] as Phase[]) {
		const s = newState();
		// fast-forward to mid-phase of the target state
		const idx = PHASE_ORDER.indexOf(phase);
		for (let i = 0; i <= idx; i++) {
			const p = PHASE_ORDER[i];
			const dur = i === idx ? PHASE_DUR[p] * 0.6 : PHASE_DUR[p];
			for (let t = 0; t < dur; t += 1 / 20) advance(s, 1 / 20);
		}
		process.stdout.write(`\n── ${phase} (${PHASE_LABEL[phase]}) ──\n`);
		process.stdout.write(renderFrame(s, cols, rows));
	}
	process.stdout.write("\x1b[0m\n");
}

if (Bun.argv.includes("--frames")) {
	await frames();
} else {
	await live();
}
