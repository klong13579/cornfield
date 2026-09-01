#!/usr/bin/env python3
"""
cornfield 交互动效候选 — 深度明暗圆点球体旋转

视觉语言参考 thinking-orbs（https://github.com/Jakubantalik/thinking-orbs）：
  - 稀疏圆点球（fib 分布），点大小随 3D 深度：近 `●` 大 / 中 `•` / 远 `·` 小
  - 深度明暗：灰阶颜色随深度渐变，明暗带随旋转流动 → 转感
  - 离线烘焙：2x 超采样 → 高斯 splat → 256 色灰阶 ANSI 帧
  - 播放器零渲染只翻页（差分 + 定期全量自愈）

用法：
  python3 sphere_orb.py render [--frames N] [--out DIR]   # 烘焙帧
  python3 sphere_orb.py play   [--out DIR]                 # 播放（需真实 TTY）
  python3 sphere_orb.py demo                               # render + play

调参（改下面的常量即可）：
  SPEED   旋转速度 rad/s（0.9 ≈ 7 秒一圈）
  POINTS  球面点数
  W / H   画布（字符）
"""

import math
import os
import re
import shutil
import sys
import time

# ── 参数（用户满意的默认值）──
SPEED = 0.9        # 旋转速度 rad/s（7s 一圈）
POINTS = 320       # 球面 fib 点数
W, H = 216, 64     # 画布（字符宽 × 高）
SS = 2             # 超采样（每字符 2×4 像素）
FPS = 60           # 烘焙/播放帧率
TAU = math.tau

PW, PH = W * SS, H * SS * 2
PCX, PCY = PW // 2, PH // 2
FRAME_ROWS = H


# ── 球面点 ──
def make_globe(n):
    pts = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (2 * (i + 0.5)) / n
        r = math.sqrt(1 - y * y)
        th = golden * i
        pts.append((math.cos(th) * r, y, math.sin(th) * r))
    return pts


# ── 帧缓冲 ──
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


# ── 绘制：绕 Y 轴旋转 + 深度明暗 ──
def draw_sphere(t, f, R):
    yaw = t * SPEED
    tilt = 0.32
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    ct, st = math.cos(tilt), math.sin(tilt)

    for gx, gy, gz in make_globe(POINTS):
        x1 = gx * cy_ + gz * sy_
        z1 = -gx * sy_ + gz * cy_
        y2 = gy * ct - z1 * st
        z2 = gy * st + z1 * ct
        depth = (z2 + 1) / 2
        if z2 < -0.15:
            continue
        lum = 0.25 + 0.55 * depth
        f.splat(PCX + x1 * R, PCY + y2 * R, lum, sigma=0.5 + 0.55 * depth)


# ── 烘焙 ──
def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    N = int(round(TAU / SPEED * FPS))  # 无缝循环帧数
    R = 0.32 * min(PW, PH)
    for i in range(N):
        f = Frame()
        draw_sphere(i / FPS, f, R)
        with open(f"{outdir}/sphere_{i:03d}.ansi", "w") as fp:
            fp.write(f.emit())
    print(f"rendered {N} frames -> {outdir}/ ({N / FPS:.1f}s 一圈, {FPS}fps)")


# ── 播放（差分 + 定期全量自愈）──
def play(outdir):
    N = int(round(TAU / SPEED * FPS))
    seq = [open(f"{outdir}/sphere_{i:03d}.ansi").read() for i in range(N)]

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
    outdir = "sphere_frames"
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
