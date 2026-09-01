#!/usr/bin/env python3
"""
cornfield 交互动效候选 — breathing（球体呼吸）

基于 sphere_orb.py 的管线（fib 深度明暗圆点 + 60fps 离线烘焙 + 差分播放）。
移植 thinking-orbs ribbon faceOn（breathing）：
  - 球体不转，半径双频慢速起伏（两股正弦叠加，缓慢有机）
  - 呼吸时点沿径向移动（球变大散开、变小聚拢），深度明暗保持

用法：
  python3 breathing_orb.py render [--out DIR]
  python3 breathing_orb.py play   [--out DIR]
调参：BREATH_1 / BREATH_2（双频振幅）、POINTS
"""

import math
import os
import re
import shutil
import sys
import time

# ── 参数 ──
POINTS = 600          # 球面 fib 点数（加密）
BREATH_1 = 0.12       # 主呼吸振幅（半径 ±12%，翻倍）
BREATH_2 = 0.06       # 次呼吸振幅（±6%，与主波叠加，翻倍）
W1 = math.tau / 3     # 主呼吸频率（3s 一圈，快一倍）
W2 = math.tau / 1.5   # 次呼吸频率（1.5s，共同周期 3s）
W, H = 216, 64
SS = 6
FPS = 60
TAU = math.tau

PW, PH = W * SS, H * SS * 2
PCX, PCY = PW // 2, PH // 2
FRAME_ROWS = H


def make_globe(n):
    pts = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (2 * (i + 0.5)) / n
        r = math.sqrt(1 - y * y)
        th = golden * i
        pts.append((math.cos(th) * r, y, math.sin(th) * r))
    return pts


class Frame:
    def __init__(self, color=250):
        self.lum = [0.0] * (PW * PH)
        self.color = color  # 256 色前景色

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
                    out.append(f"\033[38;5;{self.color}m")
                    out.append("".join(run))
                    run_lum, run = None, []

            for cx in range(W):
                sl = 0.0
                for oy in range(SS * 2):
                    base = (cy * SS * 2 + oy) * PW + cx * SS
                    for ox in range(SS):
                        sl += self.lum[base + ox]
                L = sl / (SS * SS * 2)
                if L < 0.05:
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


# 双色：收缩 = 蓝(39)，膨胀 = 红(196)；转向渐变插值
COLOR_SHRINK, COLOR_EXPAND = 39, 196


def lerp_color(a, b, t):
    return int(round(a + (b - a) * t))


def draw(phase, f, R):
    """球体呼吸：半径三角波 + 收缩蓝/膨胀红双色"""
    tri = 4 * abs(phase - 0.5) - 1          # [-1, 1] 线性升→降
    breath = 0.156 * tri                    # ±15.6% 等幅
    rr = R * (1 + breath)
    # 颜色：收缩段(phase<0.5)蓝 → 膨胀段(phase>0.5)红，转向 8 帧渐变
    if phase < 0.5:
        t = min(1.0, phase / 0.045)          # 收缩起点由红转蓝
        f.color = lerp_color(COLOR_EXPAND, COLOR_SHRINK, t)
    else:
        t = min(1.0, (phase - 0.5) / 0.045)  # 膨胀起点由蓝转红
        f.color = lerp_color(COLOR_SHRINK, COLOR_EXPAND, t)
    tilt = 0.32
    ct, st = math.cos(tilt), math.sin(tilt)

    for gx, gy, gz in make_globe(POINTS):
        y2 = gy * ct - gz * st
        z2 = gy * st + gz * ct
        depth = (z2 + 1) / 2
        if z2 < -0.15:
            continue
        lum = 0.25 + 0.55 * depth
        # 点径恒定（只保留球半径呼吸，无叠加）
        sig = 3 * (0.7 + 0.7 * depth)
        f.splat(PCX + gx * rr, PCY - y2 * rr, lum, sigma=sig)


# 色板（256 色）：冰蓝色系 8 档（深→浅）
PALETTE = [30, 33, 39, 45, 51, 81, 117, 159]


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    N = int(round(3 * FPS))  # 双波共同周期 3s = N 帧
    R = 0.48 * min(PW, PH)
    # 每帧几何渲染一次，8 色各 emit 一次（颜色是唯一变量，快）
    for i in range(N):
        f = Frame()
        draw(i / N, f, R)
        for ci, c in enumerate(PALETTE):
            f.color = c
            with open(f"{outdir}/breathing_{ci}_{i:03d}.ansi", "w") as fp:
                fp.write(f.emit())
    print(f"rendered {N * len(PALETTE)} frames ({len(PALETTE)}色×{N}) -> {outdir}/")


def play(outdir):
    import select
    import glob
    # 加载 8 色帧序列
    files = sorted(glob.glob(f"{outdir}/breathing_*_000.ansi"))
    if not files:
        sys.exit(f"frames not found in {outdir}/ — run render first")
    N = len(glob.glob(f"{outdir}/breathing_0_*.ansi"))
    seqs = []
    for ci in range(len(PALETTE)):
        seqs.append([open(f"{outdir}/breathing_{ci}_{i:03d}.ansi").read() for i in range(N)])

    def parse(raw):
        parts = re.split(r"\x1b\[(\d+);1H", raw)
        d = {}
        for j in range(1, len(parts) - 1, 2):
            d[int(parts[j])] = parts[j + 1]
        return d

    parsed = [[parse(fr) for fr in s] for s in seqs]

    # 色板 UI（右上角第 1 行）：8 冰蓝块 × 3 列（2 字符块 + 1 空格）
    SW = 8 * 3
    SX = W - SW + 1  # 色板起始列（1-based）
    def palette_ansi():
        return "".join(f"\x1b[48;5;{c}m  \x1b[0m " for c in PALETTE)

    def click_color(mx, my):
        if my == 1 and SX <= mx < SX + SW:
            ci = (mx - SX) // 3
            if 0 <= ci < len(PALETTE):
                return ci
        return None

    # 启用鼠标追踪（X10 + SGR 双协议）
    sys.stdout.write("\x1b[2J\x1b[?25l\x1b[?1000h\x1b[?1006h")
    sys.stdout.flush()
    prev = None
    i = 0
    cur_color = 0
    try:
        while True:
            # 鼠标事件（X10: \x1b[M b'x'y' 字节编码；SGR: \x1b[<b;x;yM）
            while select.select([sys.stdin], [], [], 0)[0]:
                ch = sys.stdin.read(1)
                if ch == "\x1b":
                    rest = sys.stdin.read(1)
                    if rest == "[":
                        c2 = sys.stdin.read(1)
                        if c2 == "M":
                            b1, b2, b3 = sys.stdin.read(1), sys.stdin.read(1), sys.stdin.read(1)
                            if b1 and b2 and b3:
                                btn = ord(b1) - 32
                                mx, my = ord(b2) - 32, ord(b3) - 32
                                if btn == 0:  # 左键按下
                                    ci = click_color(mx, my)
                                    if ci is not None:
                                        cur_color = ci
                                        sys.stdout.write("\x1b[2J")
                                        sys.stdout.flush()
                                        prev = None
                        elif c2 == "<":
                            s = ""
                            while True:
                                c3 = sys.stdin.read(1)
                                if not c3:
                                    break
                                if c3 in "Mm":
                                    break
                                s += c3
                            nums = s.split(";")
                            if len(nums) == 3 and nums[0] == "0":
                                mx, my = int(nums[1]), int(nums[2])
                                ci = click_color(mx, my)
                                if ci is not None:
                                    cur_color = ci
                                    sys.stdout.write("\x1b[2J")
                                    sys.stdout.flush()
                                    prev = None
                elif ch == "q":
                    return
            if i % 90 == 0:
                try:
                    term_rows = shutil.get_terminal_size().lines
                except Exception:
                    term_rows = FRAME_ROWS
                max_rows = min(FRAME_ROWS, max(20, term_rows))
            cur = parsed[cur_color][i % N]
            def line1(cv):
                # 动画第 1 行保留左侧，右侧替换为色板
                base = cv[:SX - 1] if cv else ""
                return base + palette_ansi()
            if i % 30 == 0:
                sys.stdout.write("\x1b[2J\x1b[H")
                for y in range(1, max_rows + 1):
                    line = line1(cur.get(y, "")) if y == 1 else cur.get(y, "")
                    sys.stdout.write(f"\x1b[{y};1H{line}")
                sys.stdout.flush()
                prev = cur
            else:
                out = []
                for y in range(1, max_rows + 1):
                    if y == 1:
                        cv = line1(cur.get(y, ""))
                        pv = line1(prev.get(y, "")) if prev else ""
                    else:
                        cv = cur.get(y, "")
                        pv = prev.get(y, "") if prev else ""
                    if cv != pv:
                        if cv == "":
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
        sys.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H\x1b[?1000l\x1b[?1006l")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "demo"
    outdir = "breathing_frames"
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
