#!/usr/bin/env python3
"""
omp 交互动效候选 — solving（rubik：条带打乱 → 复原）

基于 sphere_orb.py 的管线（深度明暗圆点 + 60fps 离线烘焙 + 差分播放）。
移植 thinking-orbs lattice.ts drawRubik（MIT）：
  - 经纬点阵球 + 深度明暗
  - 球面切条带，逐条整体转动 90° 打乱，再逐条回放复原（palindrome）
  - 转动中的带更亮更大（the hand）

用法：
  python3 solving_orb.py render [--out DIR]   # 烘焙帧
  python3 solving_orb.py play   [--out DIR]   # 播放（需真实 TTY）
调参：MOVE_COUNT / SLOT_DUR / REST / LAT_RINGS / LON_DEN
"""

import math
import os
import re
import shutil
import sys
import time

# ── 参数 ──
MOVE_COUNT = 14       # 条带数（原版）
SLOT_DUR = 0.42       # 每条转动时长 s（原版）
REST = 1.2            # 复原后静止 s（原版）
LAT_RINGS = 17        # 纬度圈数
LON_DEN = 56          # 赤道经度密度（加密：球体感）
SPIN = 0.55           # 球整体旋转 rad/s（原版 yaw）
W, H = 216, 64
SS = 2
FPS = 60
TAU = math.tau

PW, PH = W * SS, H * SS * 2
PCX, PCY = PW // 2, PH // 2
FRAME_ROWS = H
CYC = 2 * MOVE_COUNT * SLOT_DUR + REST


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


# ── solveCycle（lattice.ts 移植）──
MOVES = []
for i in range(MOVE_COUNT):
    axis = min(2, int(hash01(i, 2.3) * 3))
    lo = -1.0 + 0.5 * min(3, int(hash01(i, 5.9) * 4))
    dir_ = 1 if hash01(i, 7.7) < 0.5 else -1
    MOVES.append((axis, lo, lo + 0.5, dir_ * math.pi / 2))


def solve_cycle(time):
    tc = time % CYC
    amount = [0.0] * MOVE_COUNT
    active = -1
    active_amount = 0.0
    if tc < 2 * MOVE_COUNT * SLOT_DUR:
        slot = int(tc // SLOT_DUR)
        p = (tc - slot * SLOT_DUR) / SLOT_DUR
        cl = min(1.0, p / 0.7)
        ep = 1 - (1 - cl) ** 3
        if slot < MOVE_COUNT:
            for i in range(slot):
                amount[i] = 1.0
            amount[slot] = ep
            active = slot
            active_amount = ep
        else:
            u = 2 * MOVE_COUNT - 1 - slot
            for i in range(u):
                amount[i] = 1.0
            amount[u] = 1 - ep
            active = u
            active_amount = 1 - ep
    return amount, active, active_amount


def apply_moves(p3, amount, active):
    x, y, z = p3
    applied = 0.0
    in_active = False
    for i, (axis, lo, hi, ang) in enumerate(MOVES):
        amt = amount[i]
        if amt <= 0:
            continue
        coord = x if axis == 0 else (y if axis == 1 else z)
        if coord < lo or coord >= hi:
            continue
        applied = max(applied, amt)
        if i == active:
            in_active = True
        a = ang * amt
        ca, sa = math.cos(a), math.sin(a)
        if axis == 0:
            y, z = y * ca - z * sa, y * sa + z * ca
        elif axis == 1:
            x, z = x * ca + z * sa, -x * sa + z * ca
        else:
            x, y = x * ca - y * sa, x * sa + y * ca
    return x, y, z, applied, in_active


def draw(t, f, R):
    amount, active, active_amount = solve_cycle(t)
    yaw = t * SPIN
    tilt = 0.35 + 0.1 * math.sin(t * 0.9)
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    ct, st = math.cos(tilt), math.sin(tilt)

    for li in range(LAT_RINGS + 1):
        lat = -math.pi / 2 + (li / LAT_RINGS) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        lon_n = max(1, int(abs(cl) * LON_DEN))
        for lj in range(lon_n):
            lon = (lj / lon_n) * TAU
            gx = cl * math.cos(lon)
            gy = sl
            gz = cl * math.sin(lon)
            x, y, z, applied, in_active = apply_moves((gx, gy, gz), amount, active)
            x1 = x * cy_ + z * sy_
            z1 = -x * sy_ + z * cy_
            y2 = y * ct - z1 * st
            z2 = y * st + z1 * ct
            depth = (z2 + 1) / 2
            if z2 < -0.12:
                continue
            lum = 0.28 + 0.38 * depth
            sig = 0.7 + 0.7 * depth
            if in_active:
                lum += 0.30 * active_amount
                sig += 0.45 * active_amount
            f.splat(PCX + x1 * R, PCY + y2 * R, min(1.0, lum), sigma=sig)


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    N = int(round(CYC * FPS))  # 完整周期无缝循环
    R = 0.32 * min(PW, PH)
    for i in range(N):
        f = Frame()
        draw(i / FPS, f, R)
        with open(f"{outdir}/solving_{i:03d}.ansi", "w") as fp:
            fp.write(f.emit())
    print(f"rendered {N} frames -> {outdir}/ ({CYC:.1f}s 周期, {FPS}fps)")


def play(outdir):
    import glob
    files = sorted(glob.glob(f"{outdir}/solving_*.ansi"))
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
    outdir = "solving_frames"
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
