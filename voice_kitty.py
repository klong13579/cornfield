#!/usr/bin/env python3
"""
Voice Interface — Kitty Edition (24-bit RGB true color)

Holographic voice-interaction animation for any true-color terminal
(Kitty, WezTerm, iTerm2, Alacritty, Ghostty...).

Enhanced FX:
  grid backdrop, twinkling particles, rotating halo orbits,
  radar ticks, rainbow spectrum equalizer,
  data-stream influx, breathing title bar.

States:
  IDLE      — breathing sphere + halo orbits + drifting particles
  LISTENING — pulsing sphere + pulse rings + radar ticks
  THINKING  — morphing core + orbital ring + data streams
  SPEAKING  — vibrating core + rainbow spectrum equalizer

Controls:
  1-4 switch state · Space pause · Q quit
"""

import math
import random
import select
import shutil
import sys
import termios
import time
import tty

IDLE, LISTEN, THINK, SPEAK = 0, 1, 2, 3
LABELS = ["IDLE", "LISTENING", "THINKING", "SPEAKING"]

# (core RGB, edge RGB) gradient per state
PALETTES = [
    ((140, 230, 255), (8, 45, 80)),    # IDLE      ice cyan
    ((90, 255, 175), (5, 55, 40)),     # LISTENING neon green
    ((255, 205, 100), (75, 45, 8)),    # THINKING  amber
    ((225, 125, 255), (55, 18, 75)),   # SPEAKING  violet
]
BG = (5, 7, 12)
DIM = (58, 68, 88)
LABEL = (150, 160, 180)
MIN_RAD, MAX_RAD = 2.0, 10.0
FPS = 1 / 30


def lerp(a, b, t):
    return a + (b - a) * t


def rgb(c1, c2, t):
    t = max(0.0, min(1.0, t))
    return (int(lerp(c1[0], c2[0], t)),
            int(lerp(c1[1], c2[1], t)),
            int(lerp(c1[2], c2[2], t)))


def hsv(h, s, v):
    """HSV (h in [0,1)) -> RGB tuple, for rainbow effects."""
    h = h % 1.0
    i = int(h * 6)
    f = h * 6 - i
    p = v * (1 - s)
    q = v * (1 - f * s)
    tt = v * (1 - (1 - f) * s)
    if i == 0:
        r, g, b = v, tt, p
    elif i == 1:
        r, g, b = q, v, p
    elif i == 2:
        r, g, b = p, v, tt
    elif i == 3:
        r, g, b = p, q, v
    elif i == 4:
        r, g, b = tt, p, v
    else:
        r, g, b = v, p, q
    return (int(r * 255), int(g * 255), int(b * 255))


def fg(c):
    return f"\033[38;2;{c[0]};{c[1]};{c[2]}m"


def ball_char(r):
    if r < 0.10:
        return "█"
    if r < 0.28:
        return "▓"
    if r < 0.48:
        return "▒"
    if r < 0.70:
        return "░"
    if r < 0.90:
        return "·"
    return None


# ─── Grid buffer ─────────────────────────────────────────

def new_grid(w, h):
    return [[[" ", None] for _ in range(w)] for _ in range(h)]


def put(g, x, y, ch, col):
    if 0 <= y < len(g) and 0 <= x < len(g[0]):
        g[y][x][0] = ch
        g[y][x][1] = col


# ─── Drawing primitives ──────────────────────────────────

def draw_ball(g, cx, cy, rad, core, edge):
    """Gradient sphere with halo glow beyond the edge."""
    r = int(math.ceil(rad * 1.4)) + 1
    for dy in range(-r, r + 1):
        for dx in range(-r * 2, r * 2 + 1):
            d = math.sqrt((dx * 0.5) ** 2 + dy ** 2)
            ratio = d / rad if rad > 0 else 9
            ch = ball_char(ratio)
            if ch:
                put(g, cx + dx, cy + dy, ch, rgb(core, edge, ratio))
            elif ratio < 1.35:
                put(g, cx + dx, cy + dy, "·",
                    rgb(edge, BG, (ratio - 1.0) / 0.35))


def draw_halo(g, cx, cy, rad, t, core, edge):
    """Two counter-rotating tilted dot-orbits around the core."""
    rings = ((0.0, 1.0, 0.30, 1.30, 12), (0.5, -1.0, -0.22, 1.65, 16))
    for phase, dirn, tilt, rfac, n in rings:
        a0 = t * 0.9 * dirn + phase * math.pi
        for i in range(n):
            a = a0 + 2 * math.pi * i / n
            x = cx + int(rad * rfac * math.cos(a) * 2.0)
            y = cy + int(rad * rfac * math.sin(a) * tilt)
            col = rgb(core, BG, 0.45 + 0.4 * math.sin(a * 3 + t * 2))
            put(g, x, y, "·" if i % 2 else "∙", col)


def draw_grid(g, w, h, t):
    """Faint pulsing backdrop grid."""
    for y in range(2, h - 1, 4):
        for x in range(2, w - 1, 6):
            pulse = 0.5 + 0.5 * math.sin(t * 1.2 + x * 0.35 + y * 0.5)
            put(g, x, y, ".", rgb(BG, DIM, 0.22 + 0.3 * pulse))


def draw_frame(g, label, col, w, h, t):
    for x in range(1, w - 1):
        put(g, x, 0, "═", DIM)
        put(g, x, h - 1, "═", DIM)
    for y in range(1, h - 1):
        put(g, 0, y, "║", DIM)
        put(g, w - 1, y, "║", DIM)
    put(g, 0, 0, "╔", DIM)
    put(g, w - 1, 0, "╗", DIM)
    put(g, 0, h - 1, "╚", DIM)
    put(g, w - 1, h - 1, "╝", DIM)
    title = f" VOICE.SYS [{label}] "
    tx = max(1, (w - len(title)) // 2)
    for i, ch in enumerate(title):
        c = rgb(col, (255, 255, 255), 0.30 + 0.30 * math.sin(t * 2.0 + i * 0.25))
        put(g, tx + i, 0, ch, c)


def draw_particles(g, parts, core, t):
    for p in parts:
        tw = 0.7 + 0.3 * math.sin(t * 6.0 + p[0] * 0.7 + p[1] * 1.1)
        col = rgb(core, BG, (1.0 - p[3]) * tw)
        put(g, int(p[0]), int(p[1]), p[2], col)


def draw_rings(g, cx, cy, rings, core, t):
    for ring in rings:
        if not ring[1]:
            continue
        rad = MAX_RAD + ring[0] * 8
        alpha = max(0.0, 1.0 - ring[0] / 1.5)
        if alpha < 0.05:
            continue
        col = rgb(core, BG, 1.0 - alpha)
        ch = "○" if alpha > 0.5 else "·"
        ri = int(rad) + 1
        for dy in range(-ri, ri + 1):
            for dx in range(-ri * 2, ri * 2 + 1):
                d = math.sqrt((dx * 0.5) ** 2 + dy ** 2)
                if abs(d - rad) < 0.7:
                    put(g, cx + dx, cy + dy, ch, col)
    # radar tick marks rotating outside the pulse rings
    a0 = t * 0.8
    for i in range(12):
        a = a0 + 2 * math.pi * i / 12
        d = MAX_RAD + 3
        x = cx + int(d * math.cos(a) * 2.0)
        y = cy + int(d * math.sin(a) * 0.5)
        col = rgb(core, BG, 0.35 + 0.6 * abs(math.sin(a)))
        put(g, x, y, "●" if i % 3 == 0 else "·", col)


def draw_think(g, cx, cy, t, core, edge):
    m = 0.5 * (1 - math.cos(t * 3.0))
    draw_ball(g, cx, cy, 1.5 + m * 2.5, core, edge)
    # orbital data ring
    for i in range(8):
        a = 2 * math.pi * i / 8 + t * 1.5
        d = 4 + 1.5 * math.sin(t * 2.0 + i * 0.8)
        col = rgb(core, edge, 0.3 + 0.4 * math.sin(t + i))
        put(g, cx + int(d * math.cos(a) * 2.0),
            cy + int(d * math.sin(a) * 0.5),
            "●" if i % 2 == 0 else "○", col)
    for i in range(6):
        a = math.pi / 3 * i + t * 0.5
        put(g, cx + int(10 * math.cos(a) * 2.0),
            cy + int(10 * math.sin(a) * 0.5), "◇", rgb(edge, BG, 0.4))
    # data streams converging on the core
    for i in range(12):
        a = 2 * math.pi * i / 12 + t * 0.8
        prog = (t * 0.22 + i * 0.083) % 1.0
        d = 2 + prog * 11
        lv = 1.0 - prog
        col = rgb(edge, core, lv)
        ch = "∙" if lv > 0.5 else "·"
        put(g, cx + int(d * math.cos(a) * 2.0),
            cy + int(d * math.sin(a) * 0.5), ch, col)


def draw_speak(g, cx, cy, t, core, edge):
    vib = 0.3 * math.sin(t * 8.0)
    draw_ball(g, cx, cy, 3.0 + vib, core, edge)
    # frequency glow ring
    gl = 0.5 + 0.5 * math.sin(t * 6.0)
    if gl > 0.55:
        d = 4.6
        for a in range(24):
            ang = 2 * math.pi * a / 24
            x = cx + int(d * math.cos(ang) * 2.0)
            y = cy + int(d * math.sin(ang) * 0.5)
            put(g, x, y, "·", rgb(core, BG, (gl - 0.55) * 2.2))
    # rainbow spectrum radiating bars
    for i in range(12):
        a = 2 * math.pi * i / 12
        amp = 0.5 + 0.5 * math.sin(t * 5.0 + i)
        bl = int(amp * 4) + 2
        hue = t * 0.06 + i / 12
        for b in range(bl):
            d = 5 + b
            lv = b / max(1, bl - 1)
            ch = "█" if lv < 0.3 else "▓" if lv < 0.6 else "░"
            col = hsv(hue, 0.85, 0.35 + 0.65 * (1 - lv))
            put(g, cx + int(d * math.cos(a) * 2.0),
                cy + int(d * math.sin(a) * 0.5), ch, col)


def draw_status(g, t, core, edge, w, h):
    y = max(1, h - 3)
    label_col = rgb(core, (255, 255, 255), 0.45)
    amp = 50 + 30 * math.sin(t * 2.0)
    freq = int(220 + 220 * math.sin(t * 1.5))
    pwr = 70 + 20 * math.sin(t * 2.5)

    def text(x, s, col):
        for i, ch in enumerate(s):
            put(g, x + i, y, ch, col)

    def bar(x, frac, hue):
        for i in range(10):
            on = i < int(frac * 10)
            if on:
                put(g, x + i, y, "▓", hsv(hue + i * 0.02, 0.8, 0.5 + 0.5 * frac))
            else:
                put(g, x + i, y, "░", DIM)

    text(3, "AMP:", label_col)
    bar(7, amp / 100, 0.0)
    text(18, f"{int(amp)}%", label_col)
    mid = f"FREQ:{freq}Hz"
    text((w - len(mid)) // 2, mid, label_col)
    text(w - 20, "PWR:", label_col)
    bar(w - 16, pwr / 100, 0.55)


# ─── Frame output ────────────────────────────────────────

def flush(g):
    h, w = len(g), len(g[0])
    out = ["\033[H"]
    prev = None
    for y, row in enumerate(g):
        out.append(f"\033[{y + 1};1H")
        for x, cell in enumerate(row):
            if cell[1] != prev:
                out.append(fg(cell[1]) if cell[1] else "\033[39m")
                prev = cell[1]
            out.append(cell[0])
    out.append("\033[0m")
    sys.stdout.write("".join(out))
    sys.stdout.flush()


def init_particles(w, h, n=24):
    return [[random.uniform(0, w), random.uniform(0, h),
             random.choice("·∙◦"), random.uniform(0.3, 1.0),
             random.uniform(-0.3, 0.3), random.uniform(-0.15, 0.15)]
            for _ in range(n)]


# ─── Main loop ───────────────────────────────────────────

def main():
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    w, h = shutil.get_terminal_size()
    parts = init_particles(w, h)
    rings = [[i * 0.5, False, i * 0.5] for i in range(3)]
    state = IDLE
    paused = False
    t0 = time.time()
    t = 0.0

    tty.setcbreak(fd)
    try:
        sys.stdout.write("\033[?25l\033[?7l\033[2J")  # hide cursor, no autowrap
        while True:
            if not paused:
                t = time.time() - t0

            # input
            while select.select([sys.stdin], [], [], 0)[0]:
                k = sys.stdin.read(1)
                if k in ("q", "Q"):
                    return
                if k == " ":
                    paused = not paused
                elif k == "1":
                    state = IDLE
                elif k == "2":
                    state = LISTEN
                elif k == "3":
                    state = THINK
                elif k == "4":
                    state = SPEAK

            # resize
            nw, nh = shutil.get_terminal_size()
            if (nw, nh) != (w, h):
                w, h = nw, nh
                parts = init_particles(w, h)
                sys.stdout.write("\033[2J")

            # update
            if not paused:
                for p in parts:
                    p[0] += p[4]
                    p[1] += p[5]
                    p[3] -= 0.003
                    if p[3] <= 0 or not (0 <= p[0] < w and 0 <= p[1] < h):
                        p[0] = random.uniform(0, w)
                        p[1] = random.uniform(0, h)
                        p[2] = random.choice("·∙◦")
                        p[3] = random.uniform(0.5, 1.0)
                        p[4] = random.uniform(-0.3, 0.3)
                        p[5] = random.uniform(-0.15, 0.15)
                for r in rings:
                    if not r[1]:
                        r[0] += FPS
                        if r[0] >= r[2]:
                            r[1] = True
                            r[0] = 0.0
                    else:
                        r[0] += FPS
                        if r[0] > 1.5:
                            r[1] = False
                            r[0] = 0.0

            # render
            core, edge = PALETTES[state]
            g = new_grid(w, h)
            cx, cy = w // 2, h // 2
            draw_frame(g, LABELS[state], rgb(core, (255, 255, 255), 0.2), w, h, t)
            draw_grid(g, w, h, t)
            draw_particles(g, parts, core, t)

            if state == IDLE:
                br = 0.5 * (1 - math.cos(2 * math.pi * (t % 4) / 4))
                rad = MIN_RAD + (MAX_RAD - MIN_RAD) * br * 0.5
                draw_ball(g, cx, cy, rad, core, edge)
                draw_halo(g, cx, cy, rad + 2.5, t, core, edge)
            elif state == LISTEN:
                br = 0.5 * (1 - math.cos(2 * math.pi * (t % 2) / 2))
                rad = MIN_RAD + (MAX_RAD - MIN_RAD) * br * 0.4
                draw_ball(g, cx, cy, rad, core, edge)
                draw_rings(g, cx, cy, rings, core, t)
                draw_halo(g, cx, cy, rad + 2.5, t, core, edge)
            elif state == THINK:
                draw_think(g, cx, cy, t, core, edge)
            else:
                draw_speak(g, cx, cy, t, core, edge)

            draw_status(g, t, core, edge, w, h)

            ctl = " [1-4] State  [Space] Pause  [Q] Quit "
            for i, ch in enumerate(ctl):
                put(g, max(1, (w - len(ctl)) // 2) + i, h - 2, ch, LABEL)

            flush(g)
            time.sleep(FPS)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\033[?7h\033[?25h\033[0m\033[2J\033[H")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
