#!/usr/bin/env python3
"""
omp 交互动效候选 — searching（扫描子午线）

基于 sphere_orb.py 的管线（深度明暗圆点 + 60fps 离线烘焙 + 差分播放）。
移植 thinking-orbs lattice.ts drawGlobe（MIT）：
  - 经纬点阵球 + 深度明暗
  - 一条扫描子午线沿球面扫过（scan 快于自转），扫过的点更亮更大
  - 未被扫描的点压暗，扫描线清晰可辨

用法：
  python3 searching_orb.py render [--out DIR]
  python3 searching_orb.py play   [--out DIR]
调参：RINGS / LON_DEN / SPIN / SCAN
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
SPIN = 0.5            # 球自转 rad/s（原版）
SCAN = 8.0            # 扫描速度 rad/s（= 16× 自转 → 无缝循环 + 很快）
TILT_BOB = 0.06       # tilt 轻微摆动幅度
W, H = 216, 64
SS = 6
FPS = 60
TAU = math.tau

PW, PH = W * SS, H * SS * 2
PCX, PCY = PW // 2, PH // 2
FRAME_ROWS = H


def angle_delta(a, b):
    d = a - b
    while d > math.pi:
        d -= TAU
    while d < -math.pi:
        d += TAU
    return d


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

    def put_aa(self, x, y, a):
        """中心格满亮 + 邻格渐变：点主体保持亮度，移动平滑（丝滑）"""
        xi, yi = int(x), int(y)
        fx, fy = x - xi, y - yi
        if 0 <= xi < PW and 0 <= yi < PH:
            i = yi * PW + xi
            if a > self.lum[i]:
                self.lum[i] = a
        # 邻格按 frac 渐变（过渡格，弱）
        for ox, oy, f in ((1, 0, fx), (-1, 0, 1 - fx), (0, 1, fy), (0, -1, 1 - fy)):
            v = a * f * 0.55
            if v < 0.03:
                continue
            xx, yy = xi + ox, yi + oy
            if 0 <= xx < PW and 0 <= yy < PH:
                i = yy * PW + xx
                if v > self.lum[i]:
                    self.lum[i] = v

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
                if L < 0.035:
                    flush()
                    out.append(" ")
                    continue
                ch = "●" if L > 0.30 else ("•" if L > 0.14 else "·")
                lum = min(1.0, L * 2.6)
                if run_lum is None:
                    run_lum = lum
                else:
                    run_lum = min(1.0, max(run_lum, lum))
                run.append(ch)
            flush()
            out.append("\033[0m")
        out.append("")
        return "".join(out)


def draw(t, f, R):
    """经纬点阵球 + 扫描子午线（globe 移植）"""
    spin = SPIN
    tilt = -(0.4 + TILT_BOB * math.sin(t * 0.35))
    scan = t * SCAN
    ct, st = math.cos(tilt), math.sin(tilt)

    for li in range(RINGS + 1):
        lat = -math.pi / 2 + (li / RINGS) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        lon_n = max(1, int(abs(cl) * LON_DEN))
        for lj in range(lon_n):
            lon = (lj / lon_n) * TAU
            gx = cl * math.cos(lon)
            gy = sl
            gz = cl * math.sin(lon)
            # 自转（yaw = t*spin）
            yaw = t * spin
            x1 = gx * math.cos(yaw) + gz * math.sin(yaw)
            z1 = -gx * math.sin(yaw) + gz * math.cos(yaw)
            y2 = gy * ct - z1 * st
            z2 = gy * st + z1 * ct
            depth = (z2 + 1) / 2
            if z2 < -0.45:
                continue
            # 扫描 boost（非对称）：前沿锐利、尾部快速衰减 → 方向感
            d = angle_delta(lon + yaw, scan)
            if d < 0:
                boost = math.exp(-(d * d) / 0.135) * max(0.0, z2) * 0.45
            else:
                boost = math.exp(-(d * d) / 0.27) * max(0.0, z2)
            lum = (0.18 + 0.34 * depth) * 0.85 + 1.2 * boost
            # 高分辨率 splat（SS=6 取整粒度 0.67px → 移动丝滑；高斯点清晰）
            sig = 3 * (0.9 + 0.9 * depth + 1.2 * boost)
            f.splat(PCX + x1 * R, PCY + y2 * R, min(1.0, lum + 0.15 * boost), sigma=sig)


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    # 共同周期：自转一圈 + 扫描整数圈
    # spin=0.5 → 12.6s 一圈；scan=1.7 → 3.7s。共同周期 = 12.6s（扫描 3.4 圈，非整数）
    # 用自转周期：N = 2π/spin*FPS，接缝处扫描相位跳变轻微（scan 相对自转连续）
    N = int(round(TAU / SPIN * FPS))
    R = 0.32 * min(PW, PH)
    for i in range(N):
        f = Frame()
        draw(i / FPS, f, R)
        with open(f"{outdir}/searching_{i:03d}.ansi", "w") as fp:
            fp.write(f.emit())
    print(f"rendered {N} frames -> {outdir}/ ({N / FPS:.1f}s, {FPS}fps)")


def play(outdir):
    import glob
    files = sorted(glob.glob(f"{outdir}/searching_*.ansi"))
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
    outdir = "searching_frames"
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
