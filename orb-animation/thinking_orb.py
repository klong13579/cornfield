#!/usr/bin/env python3
"""
omp 交互动效候选 — thinking（wave：球面波浪起伏）

基于 sphere_orb.py 的管线（深度明暗圆点 + 60fps 离线烘焙 + 差分播放）。
移植 thinking-orbs lattice.ts drawWave（MIT）：
  - 经纬点阵球，球体基本不转
  - 两股不同频率的波叠加驱动球面半径起伏（波幅区域大小不同）
  - 波峰点更亮更大（crest boost）

用法：
  python3 thinking_orb.py render [--out DIR]   # 烘焙帧
  python3 thinking_orb.py play   [--out DIR]   # 播放（需真实 TTY）
调参：ORBITS / GHOST_PER_ORBIT / PARTICLES_PER_ORBIT / SPIN
"""

import math
import os
import re
import shutil
import sys
import time

# ── 参数 ──
RINGS = 15            # 纬度环数（原版）
LON_DEN = 40          # 赤道经度密度（原版）
W1 = math.tau / 3     # 主波频率（3s 一圈，原版 2.1 近似）
W2 = math.tau / 5     # 次波频率（5s 一圈，原版 1.27 近似）
SPIN = 0.0            # 球体不转
W, H = 216, 64        # 画布（字符）
SS = 2
FPS = 60
TAU = math.tau

PW, PH = W * SS, H * SS * 2
PCX, PCY = PW // 2, PH // 2
FRAME_ROWS = H


def hash01(a, b):
    h = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - math.floor(h)


class Frame:
    def __init__(self):
        self.lum = [0.0] * (PW * PH)

    def splat(self, x, y, a, sigma=1.0):
        xi, yi = int(x), int(y)
        r2 = int(3 * sigma) + 1
        for oy in range(-r2, r2 + 1):
            yy = yi + oy
            if yy < 0 or yy >= PH:
                continue
            for ox in range(-r2, r2 + 1):
                xx = xi + ox
                if xx < 0 or xx >= PW:
                    continue
                d2 = ox * ox + oy * oy
                w = math.exp(-d2 / (2 * sigma * sigma))
                aa = a * w
                if aa < 0.02:
                    continue
                i = yy * PW + xx
                if aa > self.lum[i]:
                    self.lum[i] = aa

    def emit(self):
        out = []
        for cy in range(H):
            out.append(f"\033[{cy + 1};1H")
            run_lum = None
            run = []

            def flush():
                nonlocal run_lum, run
                if run:
                    v = 232 + int(round(min(1.0, run_lum) * 23))
                    out.append(f"\033[38;5;{v}m")
                    out.append("".join(run))
                    run_lum, run = None, []

            for cx in range(W):
                sl = 0.0
                for oy in range(SS * 2):
                    base = (cy * SS * 2 + oy) * PW + cx * SS
                    for ox in range(SS):
                        sl += self.lum[base + ox]
                L = sl / (SS * SS * 2)
                if L < 0.07:
                    flush()
                    out.append(" ")
                    continue
                ch = "●" if L > 0.38 else ("•" if L > 0.20 else "·")
                lum = min(1.0, L * 2.0)
                if run_lum is None:
                    run_lum = lum
                else:
                    run_lum = min(1.0, max(run_lum, lum))
                run.append(ch)
            flush()
            out.append("\033[0m")
        out.append("")
        return "".join(out)


def make_globe(n):
    pts = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (2 * (i + 0.5)) / n
        r = math.sqrt(1 - y * y)
        th = golden * i
        pts.append((math.cos(th) * r, y, math.sin(th) * r))
    return pts


def draw(t, f, R):
    """经纬点阵球 + 双频波驱动半径起伏（wave 移植）"""
    tilt = 0.38
    ct, st = math.cos(tilt), math.sin(tilt)
    # 两股不同频率的波叠加 → 波浪区域大小不同
    for ri in range(RINGS + 1):
        lat = -math.pi / 2 + (ri / RINGS) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        w = 0.62 * math.sin(W1 * t - ri * 0.52) + 0.38 * math.sin(W2 * t + ri * 0.83)
        rr = 0.88 + 0.105 * w  # 半径起伏因子
        crest = max(0.0, w)    # 波峰
        lon_n = max(1, int(abs(cl) * LON_DEN))
        for lj in range(lon_n):
            lon = (lj / lon_n) * TAU
            gx = cl * math.cos(lon) * rr
            gy = sl * rr
            gz = cl * math.sin(lon) * rr
            y2 = gy * ct - gz * st
            z2 = gy * st + gz * ct
            depth = (z2 + 1) / 2
            if z2 < -0.12:
                continue
            lum = 0.24 + 0.36 * depth + 0.25 * crest
            sig = 0.6 + 0.6 * depth + 0.45 * crest
            f.splat(PCX + gx * R, PCY + y2 * R, min(1.0, lum), sigma=sig)


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    N = int(round(15 * FPS))  # 双波共同周期 15s 无缝循环
    R = 0.34 * min(PW, PH)
    for i in range(N):
        f = Frame()
        draw(i / FPS, f, R)
        with open(f"{outdir}/thinking_{i:03d}.ansi", "w") as fp:
            fp.write(f.emit())
    print(f"rendered {N} frames -> {outdir}/ ({FPS}fps)")


def play(outdir):
    import glob
    files = sorted(glob.glob(f"{outdir}/thinking_*.ansi"))
    if not files:
        sys.exit(f"frames not found in {outdir}/ — run render first")
    N = len(files)
    seq = [open(p).read() for p in files]

    def parse(raw):
        parts = re.split(r"\x1b\[(\d+);1H", raw)
        d = {}
        for j in range(1, len(parts) - 1, 2):
            d[int(parts[j])] = parts[j + 1]
        return d

    print("\x1b[2J\x1b[?25l", end="", flush=True)
    prev = None
    i = 0
    try:
        while True:
            if i % 90 == 0:
                try:
                    term_rows = shutil.get_terminal_size().lines
                except Exception:
                    term_rows = FRAME_ROWS
                max_rows = min(FRAME_ROWS, max(20, term_rows))
            if i % 30 == 0:
                sys.stdout.write("\x1b[2J\x1b[H")
                cur = parse(seq[i % N])
                for y in range(1, max_rows + 1):
                    sys.stdout.write(f"\x1b[{y};1H{cur.get(y, '')}")
                sys.stdout.flush()
                prev = cur
            else:
                cur = parse(seq[i % N])
                out = []
                for y in range(1, max_rows + 1):
                    cv = cur.get(y, "")
                    pv = prev.get(y, "")
                    if cv != pv:
                        if cv == "" or cv.strip(" \x1b[0m") == "":
                            out.append(f"\x1b[{y};1H\x1b[2K")
                        else:
                            out.append(f"\x1b[{y};1H{cv}")
                if out:
                    sys.stdout.write("".join(out))
                    sys.stdout.flush()
                prev = cur
            i += 1
            time.sleep(1 / FPS)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "demo"
    outdir = "thinking_frames"
    if "--out" in args:
        outdir = args[args.index("--out") + 1]
    if cmd == "render":
        render(outdir)
    elif cmd == "play":
        play(outdir)
    else:
        render(outdir)
        play(outdir)


if __name__ == "__main__":
    main()
