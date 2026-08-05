/**
 * Voice Stage orb — motion design preview (dual pipeline).
 *
 * Standalone demo of the P0.5 "breathing orb" concept: a large central
 * graphic whose shape, color and motion track the voice state machine
 * (connecting → listening → thinking → speaking → barge-in → idle).
 *
 * Run live:        bun scripts/orb-demo.ts            (auto-detects pipeline)
 * Static preview:  bun scripts/orb-demo.ts --frames   (one ANSI frame per state)
 * Force pipeline:  --kitty | --ansi
 *
 * Pipelines:
 *  1. kitty graphics protocol (ghostty/kitty/wezterm): the orb is rasterized
 *     into a real RGBA image — true anti-aliasing, bloom, particle trails,
 *     HUD tick ring and arc gauges. Transmitted as raw RGBA (f=32) with
 *     animation updates (a=f); tmux sessions wrap it in passthrough DCS.
 *  2. ANSI half-block fallback for every other truecolor terminal.
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

// ── kitty graphics protocol pipeline (ghostty/kitty/wezterm) ───────────────
//
// Real image rendering: RGBA raster + raw-pixel transmission (f=32) with
// in-place animation updates (a=f). The ANSI path above is the fallback.

const IMG_ID = 42;
let IW = 256;
let IH = 256;

let pixD = new Float32Array(0);
let pixT = new Float32Array(0);

function initGeometry(w: number, h: number): void {
	IW = w;
	IH = h;
	pixD = new Float32Array(IW * IH);
	pixT = new Float32Array(IW * IH);
	for (let y = 0; y < IH; y++) {
		for (let x = 0; x < IW; x++) {
			const dx = x - IW / 2;
			const dy = y - IH / 2;
			pixD[y * IW + x] = Math.hypot(dx, dy);
			pixT[y * IW + x] = Math.atan2(dy, dx);
		}
	}
	imgBuf = new Uint8ClampedArray(IW * IH * 4);
}

// Cell pixel size via CSI 16t (xterm cell-size report). tmux answers for
// the outer terminal; the response may arrive wrapped in DCS tmux with
// doubled escapes, so parse the numeric core loosely. Rendering at exact
// pixel dimensions (no c=/r= scaling) is what keeps the layout honest.
async function queryCellSize(): Promise<[number, number]> {
	const FALLBACK: [number, number] = [10, 20];
	try {
		// raw mode: the CSI response carries no newline, canonical mode would buffer it
		const stdin = process.stdin as typeof process.stdin & { setRawMode?: (on: boolean) => void };
		stdin.setRawMode?.(true);
		const query = process.env.TMUX ? `\x1bPtmux;\x1b\x1b[16t\x1b\\` : `\x1b[16t`;
		process.stdout.write(query);
		const { promise, resolve } = Promise.withResolvers<[number, number]>();
		const timer = setTimeout(() => resolve(FALLBACK), 800);
		const reader = Bun.stdin.stream().getReader();
		let buf = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += typeof value === "string" ? value : new TextDecoder().decode(value);
			const m = buf.match(/\[6;(\d+);(\d+)t/);
			if (m) {
				clearTimeout(timer);
				resolve([Number(m[2]), Number(m[1])]); // report is height;width
				break;
			}
			if (buf.length > 512) break;
		}
		const result = await promise;
		stdin.setRawMode?.(false);
		return result;
	} catch {
		return FALLBACK;
	}
}

const WOB_BUCKETS = 512;
const wobTable = new Float32Array(WOB_BUCKETS);
let imgBuf = new Uint8ClampedArray(IW * IH * 4);
const trails: Array<Array<[number, number]>> = [[], [], [], [], []];

function kittyGraphicsSupported(): boolean {
	if (Bun.argv.includes("--ansi")) return false;
	if (Bun.argv.includes("--kitty")) return true;
	const prog = (process.env.TERM_PROGRAM ?? "").toLowerCase();
	if (prog === "ghostty" || prog === "kitty" || prog === "wezterm") return true;
	return (process.env.TERM ?? "").includes("kitty");
}

function blendPx(pidx: number, r: number, g: number, b: number, a: number): void {
	if (a <= 0) return;
	if (a > 1) a = 1;
	const ia = 1 - a;
	imgBuf[pidx] = imgBuf[pidx] * ia + r * a;
	imgBuf[pidx + 1] = imgBuf[pidx + 1] * ia + g * a;
	imgBuf[pidx + 2] = imgBuf[pidx + 2] * ia + b * a;
	const na = a * 255;
	if (na > imgBuf[pidx + 3]) imgBuf[pidx + 3] = na;
}

function renderKittyImage(s: AnimState): void {
	imgBuf.fill(0);
	const [hue, sat, lit] = PHASE_HUE[s.phase];
	const level = Math.max(s.envIn, s.envOut);
	const core = hslToRgb(hue, sat * 0.7, Math.min(0.92, lit + 0.26));
	const midc = hslToRgb(hue, sat, lit);
	const edgec = hslToRgb(hue, sat, Math.max(0.18, lit - 0.28));
	const gaugeIn = hslToRgb(187, 0.9, 0.62);
	const gaugeOut = hslToRgb(276, 0.85, 0.66);

	// radius choreography (image pixels)
	let radius = IW * 0.3;
	let scale = 1 + 0.02 * Math.sin(s.t * 0.8) + level * 0.16;
	if (s.phase === "connecting") scale *= easeOutCubic(s.bloom);
	if (s.phase === "thinking") scale *= 0.92;
	if (s.phase === "idle") scale *= 1 - 0.55 * easeOutCubic(s.shrink);
	if (s.phase === "bargein") scale *= 1 - 0.25 * s.flash;
	radius *= scale;

	const wobbleAmp = 0.012 + level * 0.055 + (s.phase === "speaking" ? 0.02 : 0);
	for (let b = 0; b < WOB_BUCKETS; b++) {
		const theta = (b / WOB_BUCKETS) * Math.PI * 2;
		wobTable[b] =
			wobbleAmp *
			(0.5 * Math.sin(3 * theta + s.t * 1.5) +
				0.3 * Math.sin(5 * theta - s.t * 2.1) +
				0.2 * Math.sin(7 * theta + s.t * 2.8));
	}

	const glowW = 10 + level * 22 + (s.phase === "speaking" ? 8 : 0);
	const cx = IW / 2;
	const cy = IH / 2;
	const tickR = IW * 0.465;
	const gaugeR = IW * 0.415;
	const scanActive = s.phaseT < 0.45;
	const scanY = scanActive ? (s.phaseT / 0.45) * IH : -10;

	for (let y = 0; y < IH; y++) {
		const rowOff = y * IW;
		for (let x = 0; x < IW; x++) {
			const idx = rowOff + x;
			const d = pixD[idx];
			const theta = pixT[idx];
			const pidx = idx * 4;

			const bucket = (((theta + Math.PI) / (Math.PI * 2)) * WOB_BUCKETS) | 0;
			const R = radius * (1 + wobTable[bucket]);

			// orb body with anti-aliased edge + hot center
			if (d <= R + 1.5) {
				const k = Math.min(1, d / R);
				let c: RGB = k < 0.5 ? mix(core, midc, k * 2) : mix(midc, edgec, (k - 0.5) * 2);
				c = mix(c, [255, 255, 255], Math.pow(1 - k, 2.5) * 0.5);
				if (s.flash > 0) c = mix(c, [255, 255, 255], s.flash * 0.6);
				const a = d <= R ? 1 : Math.max(0, (R + 1.5 - d) / 1.5);
				blendPx(pidx, c[0], c[1], c[2], a);
			} else if (d <= R + glowW) {
				// bloom
				const gk = (d - R) / glowW;
				const a = Math.pow(1 - gk, 2.4) * (0.3 + level * 0.5);
				blendPx(pidx, midc[0], midc[1], midc[2], a);
			}

			// listening ripples
			if (s.phase === "listening" || s.phase === "bargein") {
				for (const rr of s.ripples) {
					const band = Math.abs(d - (R + 8 + rr * 3.2));
					if (band < 2.2) {
						blendPx(pidx, midc[0], midc[1], midc[2], (1 - band / 2.2) * Math.max(0, 1 - rr / 26) * 0.5);
					}
				}
			}

			// speaking sonic ring
			if (s.phase === "speaking") {
				const band = Math.abs(d - (R + 12 + s.envOut * 10));
				if (band < 2.5) {
					blendPx(pidx, midc[0], midc[1], midc[2], (1 - band / 2.5) * (0.35 + s.envOut * 0.5));
				}
			}

			// HUD: rotating tick bezel + arc gauges
			if (s.phase !== "idle" && s.phase !== "connecting") {
				if (Math.abs(d - tickR) < 2) {
					const ang = theta + s.t * 0.15;
					const tickPhase = ((((ang * 24) / Math.PI) % 1) + 1) % 1;
					if (tickPhase < 0.3) {
						blendPx(pidx, midc[0], midc[1], midc[2], 0.22 + level * 0.35);
					}
				}
				if (Math.abs(d - gaugeR) < 2.5) {
					const ath = Math.abs(theta);
					// input gauge (left arc, cyan): fills outward from horizontal
					if (ath > Math.PI * 0.55 && (Math.PI - ath) / (Math.PI * 0.45) < s.envIn) {
						blendPx(pidx, gaugeIn[0], gaugeIn[1], gaugeIn[2], 0.65);
					}
					// output gauge (right arc, violet)
					if (ath < Math.PI * 0.45 && (Math.PI * 0.45 - ath) / (Math.PI * 0.45) < s.envOut) {
						blendPx(pidx, gaugeOut[0], gaugeOut[1], gaugeOut[2], 0.65);
					}
				}
			}

			// state-entry scanline
			if (scanActive && Math.abs(y - scanY) < 2.5) {
				blendPx(pidx, midc[0], midc[1], midc[2], 0.16 * (1 - s.phaseT / 0.45));
			}
		}
	}

	// thinking particles with decaying trails
	if (s.phase === "thinking") {
		for (let i = 0; i < s.particles.length; i++) {
			const ang = s.particles[i];
			const pr = radius * 1.3 + Math.sin(s.t * 2 + i) * radius * 0.1;
			trails[i].push([cx + Math.cos(ang) * pr, cy + Math.sin(ang) * pr]);
			if (trails[i].length > 22) trails[i].shift();
		}
	} else {
		for (const tr of trails) tr.length = 0;
	}
	for (const tr of trails) {
		const n = tr.length;
		for (let j = 0; j < n; j++) {
			const [px, py] = tr[j];
			const age = (n - 1 - j) / 22;
			const dotR = 3.5 * (1 - age * 0.75);
			const alpha = (1 - age) * 0.8;
			const x0 = Math.max(0, Math.floor(px - dotR));
			const x1 = Math.min(IW - 1, Math.ceil(px + dotR));
			const y0 = Math.max(0, Math.floor(py - dotR));
			const y1 = Math.min(IH - 1, Math.ceil(py + dotR));
			for (let yy = y0; yy <= y1; yy++) {
				for (let xx = x0; xx <= x1; xx++) {
					const dd = Math.hypot(xx - px, yy - py);
					if (dd < dotR) blendPx((yy * IW + xx) * 4, 255, 220, 140, alpha * (1 - dd / dotR));
				}
			}
		}
	}

	// barge-in glitch: shifted horizontal bands
	if (s.phase === "bargein" && s.flash > 0.25) {
		for (let b = 0; b < 4; b++) {
			const y0 = Math.floor(Math.random() * IH);
			const h = 3 + Math.floor(Math.random() * 9);
			const dx = Math.floor((Math.random() - 0.5) * 36);
			if (dx === 0) continue;
			for (let y = y0; y < Math.min(IH, y0 + h); y++) {
				const row = imgBuf.subarray(y * IW * 4, (y + 1) * IW * 4);
				const copy = new Uint8ClampedArray(row);
				for (let x = 0; x < IW; x++) {
					const src = (((x - dx) % IW) + IW) % IW;
					row[x * 4] = copy[src * 4];
					row[x * 4 + 1] = copy[src * 4 + 1];
					row[x * 4 + 2] = copy[src * 4 + 2];
					row[x * 4 + 3] = copy[src * 4 + 3];
				}
			}
		}
	}
}

function emitKittyImage(): string[] {
	const b64 = Buffer.from(imgBuf).toString("base64");
	const CHUNK = 4096;
	const seqs: string[] = [];
	for (let i = 0; i < b64.length; i += CHUNK) {
		const chunk = b64.slice(i, i + CHUNK);
		const more = i + CHUNK < b64.length ? 1 : 0;
		// every frame re-transmits with placement (a=T) so the render self-heals
		// after tmux pane redraws. Each chunk is a separate write and the caller
		// paces them: bursting a whole frame in one write overwhelms ghostty's
		// parser and the image is silently dropped.
		const ctrl =
			i === 0 ? `a=T,f=32,s=${IW},v=${IH},i=${IMG_ID},q=2,m=${more}` : `a=T,i=${IMG_ID},m=${more}`;
		let seq = `\x1b_G${ctrl};${chunk}\x1b\\`;
		if (process.env.TMUX) seq = `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
		seqs.push(seq);
	}
	return seqs;
}

function renderKittyFrame(s: AnimState, cols: number, rows: number, imgTop: number, imgLeft: number): { text: string; images: string[] } {
	renderKittyImage(s);
	const [hue, sat] = PHASE_HUE[s.phase];
	const bright = hslToRgb(hue, sat, 0.8);
	const blank = " ".repeat(cols);
	let out = "\x1b[H\x1b[0m";
	for (let r = 0; r < rows; r++) out += blank + (r < rows - 1 ? "\r\n" : "");

	const status = `● mic   ◉ aec   qwen-realtime   ${PHASE_LABEL[s.phase]}`;
	out += `\x1b[1;${Math.floor((cols - status.length) / 2) + 1}H\x1b[38;2;90;100;125m${status}`;

	const waveRow = rows - 4;
	const waveW = Math.min(cols - 8, 64);
	const wStart = Math.floor((cols - waveW) / 2);
	const blocks = "▁▂▃▄▅▆▇█";
	out += `\x1b[${waveRow + 1};${wStart + 1}H`;
	const hist = s.levelHist;
	for (let i = 0; i < waveW; i++) {
		const v = hist[hist.length - waveW + i] ?? 0;
		const wc = mix(BG, bright, 0.3 + v * 0.7);
		out += `\x1b[38;2;${wc[0]};${wc[1]};${wc[2]}m${blocks[Math.min(7, Math.floor(v * 8))]}`;
	}

	const transcript: Record<Phase, [string, string]> = {
		connecting: ["", ""],
		listening: ["你: 帮我看下 TODO 里还有几条待办", ""],
		thinking: ["你: 帮我看下 TODO 里还有几条待办", "⣿ read: TODO.md"],
		speaking: ["你: 帮我看下 TODO 里还有几条待办", "助手: 还有三条，分别是…"],
		bargein: ["你: 等等，先看另一个——", ""],
		idle: ["", ""],
	};
	const [t1, t2] = transcript[s.phase];
	if (t1) out += `\x1b[${rows - 2};${Math.floor((cols - t1.length) / 2) + 1}H\x1b[38;2;150;160;185m${t1}`;
	if (t2) out += `\x1b[${rows - 1};${Math.floor((cols - t2.length) / 2) + 1}H\x1b[38;2;${bright[0]};${bright[1]};${bright[2]}m${t2}`;

	out += `\x1b[${imgTop + 1};${imgLeft + 1}H`;
	let del = `\x1b_Ga=d,i=${IMG_ID}\x1b\\`;
	if (process.env.TMUX) del = `\x1bPtmux;${del.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
	out += del;
	return { text: out, images: emitKittyImage() };
}


// ── drivers ─────────────────────────────────────────────────────────────────

async function live(): Promise<void> {
	const termCols = process.stdout.columns ?? 80;
	const termRows = process.stdout.rows ?? 26;
	const useKitty = kittyGraphicsSupported() && termCols >= 40 && termRows >= 16;
	process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
	const restore = () => {
		if (useKitty) {
			let del = `\x1b_Ga=d,i=${IMG_ID}\x1b\\`;
			if (process.env.TMUX) del = `\x1bPtmux;${del.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
			process.stdout.write(del);
		}
		process.stdout.write("\x1b[0m\x1b[?1049l\x1b[?25h");
	};
	process.on("SIGINT", () => {
		restore();
		process.exit(0);
	});

	const s = newState();
	const FPS = 15;
	const dt = 1 / FPS;
	if (useKitty) {
		const [cellW, cellH] = await queryCellSize();
		// Layout contract: rows 0-1 status, rows 2..(rows-8) image region,
		// bottom 6 rows waveform + transcript. The image is rasterized at exact
		// pixel size (capped for frame budget) and placed at natural size, so
		// what is rendered is what appears — no terminal-side scaling guesses.
		const layout = { cols: 0, rows: 0, imgLeft: 0, imgTop: 0 };
		const relayout = (): void => {
			layout.cols = process.stdout.columns ?? 80;
			layout.rows = process.stdout.rows ?? 26;
			const regionRows = Math.max(6, layout.rows - 9);
			const regionCols = Math.max(12, layout.cols - 2);
			const MAX_PIX = 320 * 320;
			const footPixW = regionCols * cellW;
			const footPixH = regionRows * cellH;
			const shrink = Math.min(1, Math.sqrt(MAX_PIX / (footPixW * footPixH)));
			const pixW = Math.max(64, Math.round(footPixW * shrink));
			const pixH = Math.max(64, Math.round(footPixH * shrink));
			initGeometry(pixW, pixH);
			const renderedCols = Math.ceil(pixW / cellW);
			const renderedRows = Math.ceil(pixH / cellH);
			layout.imgLeft = Math.max(0, Math.floor((layout.cols - renderedCols) / 2));
			layout.imgTop = 2 + Math.max(0, Math.floor((regionRows - renderedRows) / 2));
		};
		relayout();
		// window resize re-runs the layout; the per-frame delete+place heals the image
		process.stdout.on("resize", relayout);
		for (;;) {
			advance(s, dt);
			const frame = renderKittyFrame(s, layout.cols, layout.rows, layout.imgTop, layout.imgLeft);
			process.stdout.write(frame.text);
			for (const seq of frame.images) {
				process.stdout.write(seq);
				await Bun.sleep(0); // pace: separate syscalls so the terminal parser keeps up
			}
			await Bun.sleep(dt * 1000);
		}
	}
	const cols = Math.max(56, Math.min(110, termCols - 2));
	const rows = Math.max(20, Math.min(34, termRows - 2));
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
