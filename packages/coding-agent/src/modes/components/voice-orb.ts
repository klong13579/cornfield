/**
 * VoiceOrb — realtime procedural renderer for the voice-mode light orb.
 *
 * TypeScript port of the voice_tui/render_frames.py prototype math, rebuilt
 * for live rendering: one orb whose states are expressed through color
 * semantics and motion parameters only (blue = input side, orange =
 * processing/output side). Differences from the offline baker:
 *
 * - No nebula background (solid dark + static starfield, precomputed once).
 * - Geometry scales to the target box (the baker hardcoded 100x40).
 * - Breath depth / ring alpha / wave amplitude are driven by real mic and
 *   speaker RMS levels, not a canned loop.
 * - Buffers are reused across frames; heavy math is bounding-box bounded.
 *
 * Output is a full opaque cell rectangle (every cell carries bg) so the
 * caller can stamp it into any layout without bleed-through.
 */

type RGB = readonly [number, number, number];

interface Palette {
	readonly core: RGB;
	readonly edge: RGB;
	readonly glow: RGB;
}

export type OrbPhase = "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "muted" | "error";

/** Explicit motion-attachment selection. When provided, ONLY the enabled
 * effects render (unlisted = off); omitted entirely = phase defaults. */
export interface OrbEffects {
	/** Radius pulsation. */
	breath?: boolean;
	/** Expanding pulse ring. */
	ring?: boolean;
	/** Internal dot swirl + orbiting light. */
	swirl?: boolean;
	/** Radiating circular waveform. */
	wave?: boolean;
}

export interface OrbRenderOptions {
	/** Box width in terminal cells. */
	width: number;
	/** Box height in terminal cells. */
	height: number;
	phase: OrbPhase;
	/** Monotonic animation frame counter; the loop period is LOOP_FRAMES. */
	frame: number;
	/** Mic RMS 0..1 — deepens breath, strengthens the pulse ring. */
	inputLevel?: number;
	/** Speaker RMS 0..1 — drives the speaking waveform amplitude. */
	outputLevel?: number;
	/** Radius multiplier (large immersive orb uses > 1). Default 1. */
	boost?: number;
	/** Override which motion attachments render (omitted = phase defaults). */
	effects?: OrbEffects;
	/** Emit the orb over a transparent background (panel embedding). Default: opaque dark canvas. */
	transparent?: boolean;
	/** Plain-text fallback (no ANSI colors). */
	plain?: boolean;
}

export const LOOP_FRAMES = 90;

const TAU = Math.PI * 2;
const RAMP = " .·:~+=*%#@$";
const SOLID_CHAR = "~";
const LIGHT = [-0.408, -0.612, 0.679] as const;
const BG: RGB = [10, 13, 20];

const BLUE: Palette = { core: [185, 243, 255], edge: [30, 95, 155], glow: [65, 145, 225] };

/** Hidden "M" watermark inside the orb (prototype-final: span 0.8, depth 0.55). */
const M_BITS = ["X.....X", "XX...XX", "X.X.X.X", "X..X..X", "X.....X", "X.....X"];
const M_W = 7;
const M_H = 6;
const M_STRENGTH = 0.55;
const M_SPAN = 0.8;

/** Precomputed exp falloff for bloom (index = quantized (d-rad)/fall). */
const EXP_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) EXP_TABLE[i] = Math.exp(-i / 64);

/** Fibonacci-sphere points for the thinking swirl (80 = perf/quality balance). */
const GLOBE: readonly (readonly [number, number, number])[] = (() => {
	const pts: [number, number, number][] = [];
	const golden = Math.PI * (3 - Math.sqrt(5));
	const n = 80;
	for (let i = 0; i < n; i++) {
		const y = 1 - (i / (n - 1)) * 2;
		const r = Math.sqrt(1 - y * y);
		const th = golden * i;
		pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
	}
	return pts;
})();

function scalePal(p: Palette, f: number): Palette {
	const sc = (c: RGB): RGB => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
	return { core: sc(p.core), edge: sc(p.edge), glow: sc(p.glow) };
}

function mixPal(p: Palette, target: RGB, t: number): Palette {
	const mix = (c: RGB): RGB => [
		c[0] + (target[0] - c[0]) * t,
		c[1] + (target[1] - c[1]) * t,
		c[2] + (target[2] - c[2]) * t,
	];
	return { core: mix(p.core), edge: mix(p.edge), glow: mix(p.glow) };
}

interface PhaseConfig {
	pal: Palette;
	base: number;
	amp: number;
	cyc: number;
	ring?: boolean;
	orbitLight?: boolean;
	swirl?: boolean;
	wave?: boolean;
	/** Skip all motion (static phases). */
	still?: boolean;
}

/**
 * One orb, one color. The signature breath plays continuously (user final
 * 2026-08-06: always-on loop, NOT voice-driven). Only muted/error are still.
 */
function phaseConfig(phase: OrbPhase): PhaseConfig {
	switch (phase) {
		case "connecting":
			return { pal: scalePal(BLUE, 0.7), base: 24, amp: 5, cyc: 1 };
		case "listening":
			return { pal: BLUE, base: 26, amp: 7, cyc: 1 };
		case "thinking":
			return { pal: BLUE, base: 27, amp: 5, cyc: 1 };
		case "speaking":
			return { pal: scalePal(BLUE, 1.1), base: 27, amp: 6, cyc: 1 };
		case "interrupted":
			return { pal: scalePal(BLUE, 1.4), base: 26, amp: 0, cyc: 1, still: true };
		case "muted":
			return { pal: mixPal(BLUE, [96, 102, 116], 0.6), base: 24, amp: 0, cyc: 1, still: true };
		case "error":
			return { pal: scalePal(BLUE, 0.5), base: 24, amp: 0, cyc: 1, still: true };
	}
}

interface SizeBuffers {
	pw: number;
	ph: number;
	lum: Float32Array;
	cr: Float32Array;
	cg: Float32Array;
	cb: Float32Array;
	solid: Float32Array;
	/** Static starfield background, copied into the color buffers each frame. */
	bgCr: Float32Array;
	bgCg: Float32Array;
	bgCb: Float32Array;
}

function clamp255(v: number): number {
	return v > 255 ? 255 : v < 0 ? 0 : v;
}

export class VoiceOrb {
	#sizes = new Map<string, SizeBuffers>();

	/** Render one frame. Returns `height` ANSI lines, each `width` visible cells. */
	render(opts: OrbRenderOptions): string[] {
		const w = Math.max(8, Math.floor(opts.width));
		const h = Math.max(6, Math.floor(opts.height));
		const buf = this.#buffers(w, h);
		const cfg = phaseConfig(opts.phase);
		const ph = cfg.still ? 0 : (((opts.frame % LOOP_FRAMES) + LOOP_FRAMES) % LOOP_FRAMES) / LOOP_FRAMES;
		this.#drawFrame(
			buf,
			cfg,
			ph,
			clamp01(opts.inputLevel ?? 0),
			clamp01(opts.outputLevel ?? 0),
			opts.boost ?? 1,
			opts.effects,
			opts.transparent ?? false,
		);
		return this.#toAnsi(buf, w, h, opts.plain ?? false, opts.transparent ?? false);
	}

	#buffers(w: number, h: number): SizeBuffers {
		const key = `${w}x${h}`;
		const cached = this.#sizes.get(key);
		if (cached) return cached;
		const pw = w * 2;
		const phh = h * 4;
		const n = pw * phh;
		const buf: SizeBuffers = {
			pw,
			ph: phh,
			lum: new Float32Array(n),
			cr: new Float32Array(n),
			cg: new Float32Array(n),
			cb: new Float32Array(n),
			solid: new Float32Array(n),
			bgCr: new Float32Array(n),
			bgCg: new Float32Array(n),
			bgCb: new Float32Array(n),
		};
		// Static starfield: deterministic faint dots over the solid dark bg.
		let seed = (w * 73856093) ^ (h * 19349663);
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let i = 0; i < n; i++) {
			buf.bgCr[i] = BG[0];
			buf.bgCg[i] = BG[1];
			buf.bgCb[i] = BG[2];
		}
		const stars = Math.floor((w * h) / 26);
		for (let s = 0; s < stars; s++) {
			const i = Math.floor(rand() * n);
			const b = 22 + rand() * 36;
			buf.bgCr[i] += b * 0.75;
			buf.bgCg[i] += b * 0.85;
			buf.bgCb[i] += b;
		}
		this.#sizes.set(key, buf);
		return buf;
	}

	#drawFrame(
		buf: SizeBuffers,
		cfg: PhaseConfig,
		ph: number,
		inputLevel: number,
		outputLevel: number,
		boost: number,
		effects: OrbEffects | undefined,
		transparent: boolean,
	): void {
		const { pw, ph: phh, lum, cr, cg, cb, solid } = buf;
		// Reset to starfield background.
		lum.fill(0);
		solid.fill(0);
		cr.set(buf.bgCr);
		cg.set(buf.bgCg);
		cb.set(buf.bgCb);

		const pcx = pw / 2;
		const pcy = phh / 2;
		// Prototype radii were designed for a 200x160 pixel canvas; scale to fit.
		const scale = Math.min(pw / 200, phh / 160) * boost;
		const breath = 0.5 * (1 - Math.cos(TAU * ph * cfg.cyc));
		const amp = effects && !effects.breath ? 0 : cfg.amp;
		const rad = (cfg.base + amp * breath) * scale;
		const pal = cfg.pal;

		// ── bloom glow (behind sphere) ──
		const gs = (0.26 + 0.14 * breath) * (cfg.wave ? 1.5 : 1.0) * (transparent ? 1.7 : 1.0);
		const fall = rad * 0.3;
		const outer = rad * 2.4;
		const ri = Math.floor(outer) + 2;
		const y0 = Math.max(0, Math.floor(pcy - ri));
		const y1 = Math.min(phh - 1, Math.ceil(pcy + ri));
		const x0 = Math.max(0, Math.floor(pcx - ri));
		const x1 = Math.min(pw - 1, Math.ceil(pcx + ri));
		for (let yy = y0; yy <= y1; yy++) {
			const dy = yy - pcy;
			for (let xx = x0; xx <= x1; xx++) {
				const dx = xx - pcx;
				const d = Math.sqrt(dx * dx + dy * dy);
				if (d < rad || d > outer) continue;
				const ti = Math.min(255, Math.floor(((d - rad) / fall) * 64));
				const a = EXP_TABLE[ti] * gs;
				const i = yy * pw + xx;
				const ia = 1 - a;
				cr[i] = cr[i] * ia + pal.glow[0] * a;
				cg[i] = cg[i] * ia + pal.glow[1] * a;
				cb[i] = cb[i] * ia + pal.glow[2] * a;
				lum[i] = 1 - (1 - lum[i]) * ia;
			}
		}

		// ── 3D-shaded sphere ──
		const r2 = rad * rad;
		const sr = Math.floor(rad) + 1;
		const sy0 = Math.max(0, Math.floor(pcy - sr));
		const sy1 = Math.min(phh - 1, Math.ceil(pcy + sr));
		const sx0 = Math.max(0, Math.floor(pcx - sr));
		const sx1 = Math.min(pw - 1, Math.ceil(pcx + sr));
		// Light direction (orbits during thinking → internal movement).
		let lx = LIGHT[0];
		let ly = LIGHT[1];
		const lz = cfg.orbitLight ? 0.62 : LIGHT[2];
		const showSwirl = effects ? effects.swirl === true : cfg.swirl === true;
		if (cfg.orbitLight || showSwirl) {
			const la = TAU * ph;
			lx = Math.cos(la) * -0.55;
			ly = Math.sin(la) * -0.55;
		}
		const mw = rad * M_SPAN;
		const cw = mw / M_W;
		for (let yy = sy0; yy <= sy1; yy++) {
			const dy = yy - pcy;
			for (let xx = sx0; xx <= sx1; xx++) {
				const dx = xx - pcx;
				const d2 = dx * dx + dy * dy;
				if (d2 >= r2) continue;
				const q = Math.sqrt(d2) / rad;
				const nz = Math.sqrt(1 - d2 / r2);
				let diff = (dx / rad) * lx + (dy / rad) * ly + nz * lz;
				if (diff < 0) diff = 0;
				const base = (1 - q * q) ** 0.65;
				let a = base * (0.42 + 0.58 * diff);
				const sp = diff ** 18 * 0.85;
				let rim = 0;
				if (q > 0.82) rim = ((q - 0.82) / 0.18) * 0.35;
				a = Math.min(1, a + sp + rim);
				let rr = pal.edge[0] + (pal.core[0] - pal.edge[0]) * base + 200 * sp + pal.glow[0] * rim;
				let gg = pal.edge[1] + (pal.core[1] - pal.edge[1]) * base + 200 * sp + pal.glow[1] * rim;
				let bb = pal.edge[2] + (pal.core[2] - pal.edge[2]) * base + 200 * sp + pal.glow[2] * rim;
				// Hidden M watermark (breathes with the orb, clipped to the body).
				const gx = (dx + mw * 0.5) / cw;
				const gy = (dy + cw * M_H * 0.5) / cw;
				if (gx >= 0 && gx < M_W && gy >= 0 && gy < M_H && M_BITS[Math.floor(gy)]?.charAt(Math.floor(gx)) === "X") {
					const shade = 1 - M_STRENGTH;
					rr *= shade;
					gg *= shade;
					bb *= shade;
				}
				const i = yy * pw + xx;
				const ia = 1 - a;
				cr[i] = cr[i] * ia + clamp255(rr) * a;
				cg[i] = cg[i] * ia + clamp255(gg) * a;
				cb[i] = cb[i] * ia + clamp255(bb) * a;
				lum[i] = 1 - (1 - lum[i]) * ia;
				solid[i] = 1;
			}
		}

		// ── gaussian splat helper ──
		const splat = (x: number, y: number, a: number, c: RGB): void => {
			for (let oy = -1; oy <= 1; oy++) {
				const yy = Math.floor(y) + oy;
				if (yy < 0 || yy >= phh) continue;
				for (let ox = -1; ox <= 1; ox++) {
					const xx = Math.floor(x) + ox;
					if (xx < 0 || xx >= pw) continue;
					const wgt = ox === 0 && oy === 0 ? 1 : 0.45;
					const aa = a * wgt;
					const i = yy * pw + xx;
					const ia = 1 - aa;
					cr[i] = cr[i] * ia + c[0] * aa;
					cg[i] = cg[i] * ia + c[1] * aa;
					cb[i] = cb[i] * ia + c[2] * aa;
					lum[i] = 1 - (1 - lum[i]) * ia;
				}
			}
		};

		// ── state attachments ──
		const showRing = effects ? effects.ring === true : cfg.ring === true;
		if (showRing) {
			// LISTENING: pulse ring; alpha follows the mic level.
			const frac = ph % 1.0;
			const rr = rad + (8 + frac * 30) * scale;
			const alpha = (1 - frac) * (0.2 + 0.35 * inputLevel);
			const band = Math.floor(rr) + 3;
			const ry0 = Math.max(0, Math.floor(pcy - band));
			const ry1 = Math.min(phh - 1, Math.ceil(pcy + band));
			const rx0 = Math.max(0, Math.floor(pcx - band));
			const rx1 = Math.min(pw - 1, Math.ceil(pcx + band));
			for (let yy = ry0; yy <= ry1; yy++) {
				const dy = yy - pcy;
				for (let xx = rx0; xx <= rx1; xx++) {
					const dx = xx - pcx;
					const d = Math.sqrt(dx * dx + dy * dy);
					const g2 = Math.exp(-((d - rr) ** 2) / 6.0) * alpha;
					if (g2 < 0.01) continue;
					const i = yy * pw + xx;
					const ia = 1 - g2;
					cr[i] = cr[i] * ia + pal.core[0] * g2;
					cg[i] = cg[i] * ia + pal.core[1] * g2;
					cb[i] = cb[i] * ia + pal.core[2] * g2;
					lum[i] = 1 - (1 - lum[i]) * ia;
				}
			}
		}

		if (showSwirl) {
			// THINKING: dot swirl inside the orb (energy churning within).
			const rIn = rad * 0.72;
			const ct = Math.cos(TAU * ph);
			const st = Math.sin(TAU * ph);
			for (const [gx, gy, gz] of GLOBE) {
				const xr = gx * ct + gz * st;
				const zr = -gx * st + gz * ct;
				const depth = (zr + 1) * 0.5;
				const c: RGB = [
					pal.edge[0] + (pal.core[0] - pal.edge[0]) * depth,
					pal.edge[1] + (pal.core[1] - pal.edge[1]) * depth,
					pal.edge[2] + (pal.core[2] - pal.edge[2]) * depth,
				];
				splat(pcx + xr * rIn, pcy + gy * rIn * 0.95, (0.15 + 0.55 * depth) * (0.4 + 0.6 * breath), c);
			}
		}

		const showWave = effects ? effects.wave === true : cfg.wave === true;
		if (showWave) {
			// SPEAKING: circular waveform; amplitude follows the speaker level.
			const nb = 48;
			const maxlen = 30 * scale * (0.3 + 0.7 * outputLevel);
			const baseR = rad + 10 * scale;
			for (let bi = 0; bi < nb; bi++) {
				const ang = (TAU * bi) / nb;
				const v = 0.45 + 0.3 * Math.sin(4 * ang + TAU * ph) + 0.25 * Math.sin(7 * ang - TAU * ph);
				const ln = v * maxlen;
				const ca = Math.cos(ang);
				const sa = Math.sin(ang);
				const steps = Math.floor(ln);
				for (let s = 0; s < steps; s++) {
					const rr = baseR + s;
					const fade = 1 - s / Math.max(1, steps);
					const c: RGB = [
						pal.edge[0] + (pal.core[0] - pal.edge[0]) * fade,
						pal.edge[1] + (pal.core[1] - pal.edge[1]) * fade,
						pal.edge[2] + (pal.core[2] - pal.edge[2]) * fade,
					];
					splat(pcx + rr * ca, pcy + rr * sa, 0.85 * fade + 0.1, c);
				}
			}
		}
	}

	/** Downsample pixel buffers to cells, then emit RLE true-color ANSI lines. */
	#toAnsi(buf: SizeBuffers, w: number, h: number, plain: boolean, transparent: boolean): string[] {
		const { pw, lum, cr, cg, cb, solid } = buf;
		const lines: string[] = [];
		for (let cy = 0; cy < h; cy++) {
			let line = "";
			let pf: string | undefined;
			let pb: string | undefined;
			for (let cx = 0; cx < w; cx++) {
				let sl = 0;
				let sr = 0;
				let sg = 0;
				let sb = 0;
				let ss = 0;
				for (let oy = 0; oy < 4; oy++) {
					const o = (cy * 4 + oy) * pw + cx * 2;
					for (let ox = 0; ox < 2; ox++) {
						const i = o + ox;
						sl += lum[i];
						sr += cr[i];
						sg += cg[i];
						sb += cb[i];
						ss += solid[i];
					}
				}
				const cnt = 8;
				const l = sl / cnt;
				const coverage = ss / cnt;
				const rampOf = (v: number): string => RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))] ?? " ";
				if (plain) {
					line += coverage > 0.5 ? SOLID_CHAR : rampOf(l);
					continue;
				}
				if (transparent && coverage < 0.85) {
					// Soft silhouette: edge fringe, glow and empty cells carry a foreground
					// tint only — the terminal background shows through, so the outline
					// fades out instead of stair-stepping.
					if (pb !== undefined) {
						line += "\x1b[0m";
						pf = undefined;
						pb = undefined;
					}
					if (coverage === 0 && sl === 0) {
						line += " ";
						continue;
					}
					const fringe = coverage > 0 ? rampOf(l + coverage * 0.7) : rampOf(l);
					const fgKey = `${clamp255(Math.floor((sr / cnt) * 1.35 + 22))};${clamp255(Math.floor((sg / cnt) * 1.35 + 22))};${clamp255(Math.floor((sb / cnt) * 1.35 + 22))}`;
					if (fgKey !== pf) {
						line += `\x1b[38;2;${fgKey}m`;
						pf = fgKey;
					}
					line += fringe;
					continue;
				}
				const ch = transparent ? SOLID_CHAR : coverage > 0.5 ? SOLID_CHAR : rampOf(l);
				if (transparent && ss === 0) {
					// Non-solid cell (glow / untouched): the terminal background
					// must show through. Glow keeps a foreground tint only — no bg fill.
					if (sl === 0) {
						if (pf !== undefined || pb !== undefined) {
							line += "\x1b[0m";
							pf = undefined;
							pb = undefined;
						}
						line += " ";
						continue;
					}
					if (pb !== undefined) {
						line += "\x1b[0m";
						pf = undefined;
						pb = undefined;
					}
					const fgKey = `${clamp255(Math.floor((sr / cnt) * 1.35 + 22))};${clamp255(Math.floor((sg / cnt) * 1.35 + 22))};${clamp255(Math.floor((sb / cnt) * 1.35 + 22))}`;
					if (fgKey !== pf) {
						line += `\x1b[38;2;${fgKey}m`;
						pf = fgKey;
					}
					line += ch;
					continue;
				}
				const fr = clamp255(Math.floor((sr / cnt) * 1.35 + 22));
				const fg = clamp255(Math.floor((sg / cnt) * 1.35 + 22));
				const fb = clamp255(Math.floor((sb / cnt) * 1.35 + 22));
				const br = Math.floor((sr / cnt) * 0.42);
				const bg = Math.floor((sg / cnt) * 0.42);
				const bb = Math.floor((sb / cnt) * 0.42);
				const bgKey = `${br};${bg};${bb}`;
				const fgKey = `${fr};${fg};${fb}`;
				if (bgKey !== pb) {
					line += `\x1b[48;2;${bgKey.replaceAll(";", ";")}m`;
					pb = bgKey;
				}
				if (fgKey !== pf) {
					line += `\x1b[38;2;${fgKey}m`;
					pf = fgKey;
				}
				line += ch;
			}
			lines.push(plain ? line : `${line}\x1b[0m`);
		}
		return lines;
	}
}

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
