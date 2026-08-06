#!/usr/bin/env python3
"""
Offline frame renderer — FINAL unified design.

One orb, four breathing behaviors. The sphere is always the protagonist;
states are expressed through color semantics and motion parameters only:
  IDLE      ice blue (dim)    slow breath, nearly still
  LISTENING ice blue (full)   faster breath + pulse ring attachment
  THINKING  amber orange      light orbits inside the sphere + inner dot swirl
  SPEAKING  amber orange      vibration + circular waveform attachment

Blue = input side. Orange = processing/output side.

Offline quality: fake-3D sphere (normal diffuse + specular + rim),
exponential bloom, 2x supersampling, gaussian splats, luminance ramp,
seamless loop (integer cycle counts). Frames baked to true-color ANSI;
play with voice_player.py.

Usage:
  python3 render_frames.py [--w 100] [--h 40] [--frames 90] [--out voice_frames]
"""

import argparse
import json
import math
import os
import time

TAU = math.tau
RAMP = " .·:~+=*%#@$"
NL = len(RAMP)
SOLID_CHAR = "~"  # uniform sphere body char; color carries the shading

# ── Color semantics: blue = input, orange = processing/output ──────
BLUE = {"core": (150, 235, 255), "edge": (10, 50, 90), "glow": (30, 90, 160)}
ORANGE = {"core": (255, 215, 120), "edge": (80, 50, 10), "glow": (140, 85, 25)}


def scale_pal(p, f):
    return {k: tuple(min(255, int(c * f)) for c in v) for k, v in p.items()}


# One orb; states are just parameter sets.
# All states share the same slow rhythm (cyc=1, matching idle).
STATES = {
    "idle":   {"pal": BLUE,
               "base": 24, "amp": 8, "cyc": 1},
    "listen": {"pal": BLUE,
               "base": 26, "amp": 6, "cyc": 1, "ring": True},
    "think":  {"pal": ORANGE,
               "base": 28, "amp": 2, "cyc": 1, "orbit_light": True, "swirl": True},
    "speak":  {"pal": scale_pal(ORANGE, 1.12),
               "base": 28, "amp": 1.5, "cyc": 1, "wave": True},
}
LABELS = {"idle": "IDLE", "listen": "LISTENING", "think": "THINKING", "speak": "SPEAKING"}
DIM = (58, 68, 88)
LIGHT = (-0.408, -0.612, 0.679)  # normalized

# ── Hidden "M" watermark inside the orb ──────────────────
# Visible as a soft brightness lift; the silhouette stays a sphere.
# Scales with the orb radius (breathes with it), clipped to the body.
M_BITS = (
    "X.....X",
    "XX...XX",
    "X.X.X.X",
    "X..X..X",
    "X.....X",
    "X.....X",
)
M_W, M_H = 7, 6
M_STRENGTH = 0.55   # shadow depth: 0 = invisible · 1 = black
M_SPAN = 0.8        # M width as fraction of the orb radius


def make_globe(n=160):
    pts = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (i / (n - 1)) * 2
        r = math.sqrt(1 - y * y)
        th = golden * i
        pts.append((math.cos(th) * r, y, math.sin(th) * r))
    return pts


GLOBE = make_globe()


def render_state(state, W, H, N, outdir, quiet=False):
    SS = 2
    PW, PH = W * SS, H * SS * 2
    pcx, pcy = PW // 2, PH // 2
    np_ = PW * PH
    cfg = STATES[state]
    pal = cfg["pal"]
    core, edge, glow = pal["core"], pal["edge"], pal["glow"]

    # ── static nebula background ─────────────────────────
    bg_l = [0.0] * np_
    bg_r = [0.0] * np_
    bg_g = [0.0] * np_
    bg_b = [0.0] * np_
    for y in range(PH):
        for x in range(PW):
            i = y * PW + x
            s = 0.5 + 0.5 * math.sin(x * 0.045 + math.sin(y * 0.06) * 1.7)
            t2 = 0.5 + 0.5 * math.sin(y * 0.05 - x * 0.021)
            v = 0.030 + 0.045 * s * t2
            bg_l[i] = v
            bg_r[i] = 10 + 22 * s
            bg_g[i] = 12 + 10 * t2
            bg_b[i] = 30 + 20 * s

    # ── orbiting dust (deterministic, loops seamlessly) ──
    dust = []
    for i in range(34):
        dust.append((
            (i * 2.399963) % TAU,
            30 + (i * 37 % 46),
            (i % 3) - 1,
            1 + (i % 3),
            0.20 + 0.13 * ((i * 7) % 5) / 4.0,
        ))

    t_start = time.time()

    for f in range(N):
        ph = f / N
        lum = bg_l.copy()
        cr = bg_r.copy()
        cg = bg_g.copy()
        cb = bg_b.copy()

        # ── the orb: one breathing behavior per state ────
        breath = 0.5 * (1 - math.cos(TAU * ph * cfg["cyc"]))
        rad = cfg["base"] + cfg["amp"] * breath
        solid = [0.0] * np_

        # light direction (orbits for think → internal movement)
        if cfg.get("orbit_light"):
            la = TAU * ph
            lx = math.cos(la) * -0.55
            ly = math.sin(la) * -0.55
            lz = 0.62
        else:
            lx, ly, lz = LIGHT

        # ── bloom glow (behind sphere) ───────────────────
        gs = (0.16 + 0.10 * breath) * (1.5 if state == "speak" else 1.0)
        ri = int(rad * 2.4) + 2
        fall = rad * 0.30
        for yy in range(max(0, pcy - ri), min(PH, pcy + ri + 1)):
            dy = yy - pcy
            for xx in range(max(0, pcx - ri), min(PW, pcx + ri + 1)):
                dx = xx - pcx
                d = math.sqrt(dx * dx + dy * dy)
                if d < rad or d > rad * 2.4:
                    continue
                a = math.exp(-(d - rad) / fall) * gs
                i = yy * PW + xx
                ia = 1.0 - a
                cr[i] = cr[i] * ia + glow[0] * a
                cg[i] = cg[i] * ia + glow[1] * a
                cb[i] = cb[i] * ia + glow[2] * a
                lum[i] = 1 - (1 - lum[i]) * ia

        # ── 3D-shaded sphere ─────────────────────────────
        r2 = rad * rad
        ri = int(rad) + 1
        for yy in range(max(0, pcy - ri), min(PH, pcy + ri + 1)):
            dy = yy - pcy
            for xx in range(max(0, pcx - ri), min(PW, pcx + ri + 1)):
                dx = xx - pcx
                d2 = dx * dx + dy * dy
                if d2 >= r2:
                    continue
                q = math.sqrt(d2) / rad
                nz = math.sqrt(1 - d2 / r2)
                diff = dx / rad * lx + dy / rad * ly + nz * lz
                if diff < 0:
                    diff = 0.0
                base = (1 - q * q) ** 0.65
                a = base * (0.42 + 0.58 * diff)
                sp = diff ** 18 * 0.85
                rim = 0.0
                if q > 0.82:
                    rim = (q - 0.82) / 0.18 * 0.35
                a = min(1.0, a + sp + rim)
                rr = edge[0] + (core[0] - edge[0]) * base + 200 * sp + glow[0] * rim
                gg = edge[1] + (core[1] - edge[1]) * base + 200 * sp + glow[1] * rim
                bb = edge[2] + (core[2] - edge[2]) * base + 200 * sp + glow[2] * rim
                # hidden M watermark (normalized to rad → breathes with the orb)
                mw = rad * M_SPAN
                cw_ = mw / M_W
                gx = (dx + mw * 0.5) / cw_
                gy = (dy + cw_ * M_H * 0.5) / cw_
                if 0 <= gx < M_W and 0 <= gy < M_H \
                        and M_BITS[int(gy)][int(gx)] == "X":
                    shade = 1.0 - M_STRENGTH
                    rr *= shade
                    gg *= shade
                    bb *= shade
                i = yy * PW + xx
                ia = 1.0 - a
                cr[i] = cr[i] * ia + min(255, rr) * a
                cg[i] = cg[i] * ia + min(255, gg) * a
                cb[i] = cb[i] * ia + min(255, bb) * a
                lum[i] = 1 - (1 - lum[i]) * ia
                solid[i] = 1.0

        # ── gaussian splat helper ────────────────────────
        def splat(x, y, a, c):
            for oy in (-1, 0, 1):
                yy = int(y) + oy
                if yy < 0 or yy >= PH:
                    continue
                for ox in (-1, 0, 1):
                    xx = int(x) + ox
                    if xx < 0 or xx >= PW:
                        continue
                    w = 1.0 if (ox == 0 and oy == 0) else 0.45
                    aa = a * w
                    i = yy * PW + xx
                    ia = 1.0 - aa
                    cr[i] = cr[i] * ia + c[0] * aa
                    cg[i] = cg[i] * ia + c[1] * aa
                    cb[i] = cb[i] * ia + c[2] * aa
                    lum[i] = 1 - (1 - lum[i]) * ia

        # ── state attachments (orb accessories) ──────────
        if cfg.get("ring"):
            # LISTENING: gentle pulse ring around the orb (slow, 1 per loop)
            frac = ph % 1.0
            rr = rad + 8 + frac * 30
            alpha = (1 - frac) * 0.45
            ring_r = int(rr) + 3
            for yy in range(max(0, pcy - ring_r), min(PH, pcy + ring_r + 1)):
                dy = yy - pcy
                for xx in range(max(0, pcx - ring_r), min(PW, pcx + ring_r + 1)):
                    dx = xx - pcx
                    d = math.sqrt(dx * dx + dy * dy)
                    g2 = math.exp(-((d - rr) ** 2) / 6.0) * alpha
                    if g2 < 0.01:
                        continue
                    i = yy * PW + xx
                    ia = 1.0 - g2
                    cr[i] = cr[i] * ia + core[0] * g2
                    cg[i] = cg[i] * ia + core[1] * g2
                    cb[i] = cb[i] * ia + core[2] * g2
                    lum[i] = 1 - (1 - lum[i]) * ia

        if cfg.get("swirl"):
            # THINKING: dot swirl INSIDE the orb (energy churning within)
            R_in = rad * 0.72
            ct, st = math.cos(TAU * ph), math.sin(TAU * ph)
            for gx, gy, gz in GLOBE:
                xr = gx * ct + gz * st
                zr = -gx * st + gz * ct
                depth = (zr + 1) * 0.5
                c = (edge[0] + (core[0] - edge[0]) * depth,
                     edge[1] + (core[1] - edge[1]) * depth,
                     edge[2] + (core[2] - edge[2]) * depth)
                splat(pcx + xr * R_in, pcy + gy * R_in * 0.95,
                      (0.15 + 0.55 * depth) * (0.4 + 0.6 * breath), c)

        if cfg.get("wave"):
            # SPEAKING: circular waveform radiating from the orb
            NB = 72
            maxlen = 30
            base_r = rad + 10
            for bi in range(NB):
                ang = TAU * bi / NB
                v = (0.45 + 0.30 * math.sin(4 * ang + TAU * ph) +
                     0.25 * math.sin(7 * ang - TAU * ph))
                ln = v * maxlen
                ca, sa = math.cos(ang), math.sin(ang)
                steps = int(ln)
                for s in range(steps):
                    rr = base_r + s
                    fade = 1 - s / max(1, steps)
                    c = (edge[0] + (core[0] - edge[0]) * fade,
                         edge[1] + (core[1] - edge[1]) * fade,
                         edge[2] + (core[2] - edge[2]) * fade)
                    splat(pcx + rr * ca, pcy + rr * sa, 0.85 * fade + 0.1, c)

        # ── orbiting dust (same slow drift in all states) ──
        spd_mul = 1
        for p0, orb, sd, k, bright in dust:
            ang = p0 + TAU * ph * sd * spd_mul
            rr = orb + 6 * math.sin(TAU * ph * k + p0)
            x = pcx + rr * math.cos(ang)
            y = pcy + rr * math.sin(ang) * 0.92
            splat(x, y, bright, core)

        # ── downsample to cells ──────────────────────────
        cells = []
        B = SS * 2
        for cyi in range(H):
            row = []
            for cxi in range(W):
                sl = sr = sg = sb = ss_ = 0.0
                for oy in range(B):
                    o = (cyi * B + oy) * PW + cxi * SS
                    for ox in range(SS):
                        i = o + ox
                        sl += lum[i]
                        sr += cr[i]
                        sg += cg[i]
                        sb += cb[i]
                        ss_ += solid[i]
                n = B * SS
                L = sl / n
                ch = SOLID_CHAR if ss_ / n > 0.5 else RAMP[min(NL - 1, int(L * NL))]
                row.append((ch,
                            (min(255, int(sr / n * 1.25 + 14)),
                             min(255, int(sg / n * 1.25 + 14)),
                             min(255, int(sb / n * 1.25 + 14))),
                            (int(sr / n * 0.30), int(sg / n * 0.30), int(sb / n * 0.30))))
            cells.append(row)

        # ── HUD overlay ──────────────────────────────────
        def put(x, y, ch, fg):
            if 0 <= x < W and 0 <= y < H:
                cells[y][x] = (ch, fg, cells[y][x][2])

        for x in range(W):
            put(x, 0, "═", DIM)
            put(x, H - 1, "═", DIM)
        for y in range(H):
            put(0, y, "║", DIM)
            put(W - 1, y, "║", DIM)
        put(0, 0, "╔", DIM)
        put(W - 1, 0, "╗", DIM)
        put(0, H - 1, "╚", DIM)
        put(W - 1, H - 1, "╝", DIM)

        title = f" VOICE.SYS [{LABELS[state]}] "
        tc = tuple(min(255, c + 40) for c in core)
        for i, ch in enumerate(title):
            put(max(1, (W - len(title)) // 2) + i, 0, ch, tc)

        amp = 0.5 + 0.5 * math.sin(TAU * ph * 2)
        freq = int(220 + 220 * math.sin(TAU * ph))
        lc = tuple(min(255, int(c * 0.55 + 110)) for c in core)
        bar = "▓" * int(amp * 10) + "░" * (10 - int(amp * 10))
        s1 = f"AMP:{bar} {int(amp * 100)}%"
        for i, ch in enumerate(s1):
            put(3 + i, H - 2, ch, lc)
        mid = f"FREQ:{freq}Hz"
        for i, ch in enumerate(mid):
            put((W - len(mid)) // 2 + i, H - 2, ch, lc)
        for i, ch in enumerate("● LIVE"):
            put(W - 12 + i, H - 2, ch, core)

        ctl = " [1-4] State  [Space] Pause  [Q] Quit "
        for i, ch in enumerate(ctl):
            put(max(1, (W - len(ctl)) // 2) + i, H - 1, ch, DIM)

        # ── emit ANSI ────────────────────────────────────
        out = []
        for y, row in enumerate(cells):
            out.append(f"\033[{y + 1};1H")
            pf = pb = None
            for ch, fg, bg in row:
                if bg != pb:
                    out.append(f"\033[48;2;{bg[0]};{bg[1]};{bg[2]}m")
                    pb = bg
                if fg != pf:
                    out.append(f"\033[38;2;{fg[0]};{fg[1]};{fg[2]}m")
                    pf = fg
                out.append(ch)
        out.append("\033[0m")
        path = os.path.join(outdir, f"{state}_{f:03d}.ansi")
        with open(path, "w") as fp:
            fp.write("".join(out))

        if not quiet and (f + 1) % 30 == 0:
            el = time.time() - t_start
            print(f"  {state}: {f + 1}/{N}  ({el:.1f}s)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--w", type=int, default=100)
    ap.add_argument("--h", type=int, default=40)
    ap.add_argument("--frames", type=int, default=90)
    ap.add_argument("--out", default="voice_frames")
    ap.add_argument("--states", default="idle,listen,think,speak")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for st in args.states.split(","):
        print(f"rendering {st} ...", flush=True)
        render_state(st, args.w, args.h, args.frames, args.out)

    meta = {"w": args.w, "h": args.h, "frames": args.frames,
            "fps": 30, "states": args.states.split(",")}
    with open(os.path.join(args.out, "meta.json"), "w") as fp:
        json.dump(meta, fp)
    print(f"done -> {args.out}/ ({args.frames * len(args.states.split(','))} frames)")


if __name__ == "__main__":
    main()
