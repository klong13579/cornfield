/**
 * VoiceOrb — procedural renderer contracts: determinism, animation,
 * phase color semantics, level-driven modulation, geometry invariants.
 */
import { describe, expect, it } from "bun:test";
import { LOOP_FRAMES, VoiceOrb } from "@cornfield/coding-agent/modes/components/voice-orb";
import { visibleWidth } from "@cornfield/tui";

const W = 60;
const H = 20;

function colorsOf(lines: string[]): { blue: number; orange: number } {
	let blue = 0;
	let orange = 0;
	const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;
	for (const line of lines) {
		for (const m of line.matchAll(re)) {
			const r = Number(m[1]);
			const g = Number(m[2]);
			const b = Number(m[3]);
			// Blue semantics: b dominates. Orange semantics: r dominates, g mid, b low.
			if (b > r + 30 && b > g) blue += 1;
			else if (r > b + 40 && r > g) orange += 1;
		}
	}
	return { blue, orange };
}

describe("VoiceOrb", () => {
	it("renders exactly height lines, each exactly width visible cells", () => {
		const orb = new VoiceOrb();
		const lines = orb.render({ width: W, height: H, phase: "listening", frame: 0 });
		expect(lines.length).toBe(H);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(W);
		}
	});

	it("is deterministic for identical inputs", () => {
		const a = new VoiceOrb();
		const b = new VoiceOrb();
		const la = a.render({ width: W, height: H, phase: "thinking", frame: 7, inputLevel: 0.3 });
		const lb = b.render({ width: W, height: H, phase: "thinking", frame: 7, inputLevel: 0.3 });
		expect(la).toEqual(lb);
	});

	it("breathes continuously across frames (always-on loop, no audio needed)", () => {
		const orb = new VoiceOrb();
		for (const phase of ["listening", "thinking", "speaking"] as const) {
			const f0 = orb.render({ width: W, height: H, phase, frame: 0 });
			const f20 = orb.render({ width: W, height: H, phase, frame: 20 });
			expect(f0).not.toEqual(f20);
		}
	});

	it("motion is voice-independent (same frame identical across levels)", () => {
		const orb = new VoiceOrb();
		const quiet = orb.render({ width: W, height: H, phase: "listening", frame: 12, inputLevel: 0 });
		const loud = orb.render({ width: W, height: H, phase: "listening", frame: 12, inputLevel: 1 });
		expect(quiet).toEqual(loud);
	});

	it("loops seamlessly with LOOP_FRAMES period", () => {
		const orb = new VoiceOrb();
		const f0 = orb.render({ width: W, height: H, phase: "speaking", frame: 0, outputLevel: 0.5 });
		const fLoop = orb.render({ width: W, height: H, phase: "speaking", frame: LOOP_FRAMES, outputLevel: 0.5 });
		expect(f0).toEqual(fLoop);
	});

	it("static phases produce identical frames (zero motion)", () => {
		const orb = new VoiceOrb();
		const f0 = orb.render({ width: W, height: H, phase: "error", frame: 0 });
		const f30 = orb.render({ width: W, height: H, phase: "error", frame: 30 });
		expect(f0).toEqual(f30);
	});

	it("keeps one ball color across all active states (blue identity)", () => {
		const orb = new VoiceOrb();
		const listening = colorsOf(orb.render({ width: W, height: H, phase: "listening", frame: 10, inputLevel: 0.5 }));
		const thinking = colorsOf(orb.render({ width: W, height: H, phase: "thinking", frame: 10, inputLevel: 0.4 }));
		const speaking = colorsOf(orb.render({ width: W, height: H, phase: "speaking", frame: 10, outputLevel: 0.7 }));
		expect(listening.blue).toBeGreaterThan(listening.orange);
		expect(thinking.blue).toBeGreaterThan(thinking.orange);
		expect(speaking.blue).toBeGreaterThan(speaking.orange);
	});

	it("adapts to arbitrary box sizes", () => {
		const orb = new VoiceOrb();
		for (const [w, h] of [
			[24, 12],
			[76, 28],
			[40, 16],
		] as const) {
			const lines = orb.render({ width: w, height: h, phase: "thinking", frame: 5 });
			expect(lines.length).toBe(h);
			for (const line of lines) expect(visibleWidth(line)).toBe(w);
		}
	});

	it("transparent mode leaves untouched cells as bare spaces (panel embedding)", () => {
		const orb = new VoiceOrb();
		const lines = orb.render({ width: W, height: H, phase: "listening", frame: 0, transparent: true });
		expect(lines.length).toBe(H);
		// corners are far from the orb: bare spaces, no bg color codes
		expect(lines[0]!.startsWith(" ")).toBe(true);
		expect(lines[0]).not.toContain("48;2;");
		// the orb body still carries truecolor
		expect(lines.join("")).toContain("38;2;");
	});

	it("plain mode emits no ANSI sequences", () => {
		const orb = new VoiceOrb();
		const lines = orb.render({ width: W, height: H, phase: "listening", frame: 3, plain: true });
		for (const line of lines) {
			expect(line).not.toContain("\x1b[");
			expect(line.length).toBe(W);
		}
	});

	it("renders breath as the only default motion (chosen signature effect)", () => {
		const orb = new VoiceOrb();
		for (const phase of ["listening", "thinking", "speaking"] as const) {
			const def = orb.render({ width: W, height: H, phase, frame: 12, inputLevel: 0.5, outputLevel: 0.5 });
			const breathOnly = orb.render({
				width: W,
				height: H,
				phase,
				frame: 12,
				inputLevel: 0.5,
				outputLevel: 0.5,
				effects: { breath: true },
			});
			expect(def).toEqual(breathOnly);
		}
	});

	it("renders a large immersive frame within a generous time budget", () => {
		const orb = new VoiceOrb();
		// Warm the size cache (production reuses buffers across frames).
		orb.render({ width: 76, height: 28, phase: "listening", frame: 0 });
		const t0 = performance.now();
		const frames = 20;
		for (let i = 1; i <= frames; i++) {
			orb.render({ width: 76, height: 28, phase: "listening", frame: i, inputLevel: 0.4 });
		}
		const perFrame = (performance.now() - t0) / frames;
		// Budget: 20fps = 50ms/frame; assert a loose 25ms to survive slow CI.
		expect(perFrame).toBeLessThan(25);
	});
});
