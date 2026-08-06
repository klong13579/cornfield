#!/usr/bin/env python3
"""
omp 交互动效候选 — 三合一演示（球体旋转 / thinking 波浪 / solving 条带）

按 omp 实际尺寸：每段 100×10 字符（welcome maxWidth=100 参考），三段竖排，
左侧状态标签，60fps 差分播放。

用法：
  python3 three_orbs.py render [--out DIR]
  python3 three_orbs.py play   [--out DIR]
调参：SEG_W / SEG_H（每段宽高）、SPEED 等
"""

import math
import os
import re
import shutil
import sys
import time

# ── 段尺寸（omp 内容区宽度 ~100）──
SEG_W, SEG_H = 100, 12
GAP = 1                      # 段间空行
LABEL_W = 18                 # 左侧标签列宽
SS = 2
FPS = 60
TAU = math.tau

PW, PH = SEG_W * SS, SEG_H * SS * 2
PCX, PCY = PW // 2, PH // 2
DIM = "\x1b[38;5;240m"
RESET = "\x1b[0m"

# 各动效周期（各自无缝循环）
T_SPHERE = TAU / 0.9        # 球 7s 一圈
T_THINK = 15.0              # 双波共同周期
T_SOLVE = 2 * 8 * 0.42 + 1.2   # solving 7.9s 周期
T_SEARCH = TAU / 0.5            # searching 12.6s（自转一圈，扫描 16 圈无缝）


def angle_delta(a, b):
    d = a - b
    while d > math.pi:
        d -= TAU
    while d < -math.pi:
        d += TAU
    return d


def hash01(a, b):
    h = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - math.floor(h)


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

    def emit_line(self, cy):
        """输出一行字符（含灰阶色），返回字符串"""
        out = []
        run_lum = None
        run = []

        def flush():
            nonlocal run_lum, run
            if run:
                v = 232 + int(round(min(1.0, run_lum) * 23))
                out.append(f"\x1b[38;5;{v}m{''.join(run)}")
                run_lum, run = None, []

        for cx in range(SEG_W):
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
            ch = "•" if L > 0.16 else "·"
            lum = min(1.0, L * 1.9)
            if run_lum is None:
                run_lum = lum
            else:
                run_lum = min(1.0, max(run_lum, lum))
            run.append(ch)
        flush()
        return "".join(out)


# ── 三个动效绘制（段画布内）──
def draw_sphere(t, f, R):
    yaw = t * 0.9
    tilt = 0.32
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    ct, st = math.cos(tilt), math.sin(tilt)
    for gx, gy, gz in make_globe(110):
        x1 = gx * cy_ + gz * sy_
        z1 = -gx * sy_ + gz * cy_
        y2 = gy * ct - z1 * st
        z2 = gy * st + z1 * ct
        depth = (z2 + 1) / 2
        if z2 < -0.15:
            continue
        lum = 0.20 + 0.65 * depth
        f.splat(PCX + x1 * R, PCY + y2 * R, lum, sigma=0.4 + 0.5 * depth)


def draw_thinking(t, f, R):
    tilt = 0.38
    ct, st = math.cos(tilt), math.sin(tilt)
    w1 = TAU / 3
    w2 = TAU / 5
    rings, lon_den = 8, 18
    for ri in range(rings + 1):
        lat = -math.pi / 2 + (ri / rings) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        w = 0.62 * math.sin(w1 * t - ri * 0.52) + 0.38 * math.sin(w2 * t + ri * 0.83)
        rr = 0.88 + 0.105 * w
        crest = max(0.0, w)
        lon_n = max(10, int(abs(cl) * lon_den))
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
            lum = 0.22 + 0.42 * depth + 0.32 * crest
            sig = 0.45 + 0.5 * depth + 0.5 * crest
            f.splat(PCX + gx * R, PCY + y2 * R, min(1.0, lum), sigma=sig)


def draw_solving(t, f, R):
    move_count, slot_dur, rest = 8, 0.42, 1.2
    cyc = 2 * move_count * slot_dur + rest
    tc = t % cyc
    amount = [0.0] * move_count
    active = -1
    active_amount = 0.0
    if tc < 2 * move_count * slot_dur:
        slot = int(tc // slot_dur)
        p = (tc - slot * slot_dur) / slot_dur
        ep = 1 - (1 - min(1.0, p / 0.7)) ** 3
        if slot < move_count:
            for i in range(slot):
                amount[i] = 1.0
            amount[slot] = ep
            active = slot
            active_amount = ep
        else:
            u = 2 * move_count - 1 - slot
            for i in range(u):
                amount[i] = 1.0
            amount[u] = 1 - ep
            active = u
            active_amount = 1 - ep
    moves = []
    for i in range(move_count):
        axis = min(2, int(hash01(i, 2.3) * 3))
        lo = -1.0 + 0.5 * min(3, int(hash01(i, 5.9) * 4))
        dir_ = 1 if hash01(i, 7.7) < 0.5 else -1
        moves.append((axis, lo, lo + 0.5, dir_ * math.pi / 2))

    yaw = t * 0.55
    tilt = 0.35
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    ct, st = math.cos(tilt), math.sin(tilt)
    lat_rings, lon_den = 8, 20
    for li in range(lat_rings + 1):
        lat = -math.pi / 2 + (li / lat_rings) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        lon_n = max(10, int(abs(cl) * lon_den))
        for lj in range(lon_n):
            lon = (lj / lon_n) * TAU
            gx = cl * math.cos(lon)
            gy = sl
            gz = cl * math.sin(lon)
            x, y, z = gx, gy, gz
            in_active = False
            for i, (axis, lo, hi, ang) in enumerate(moves):
                amt = amount[i]
                if amt <= 0:
                    continue
                coord = x if axis == 0 else (y if axis == 1 else z)
                if coord < lo or coord >= hi:
                    continue
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
            x1 = x * cy_ + z * sy_
            z1 = -x * sy_ + z * cy_
            y2 = y * ct - z1 * st
            z2 = y * st + z1 * ct
            depth = (z2 + 1) / 2
            if z2 < -0.12:
                continue
            # 打乱中：active 带拉满亮，其余压暗 → 亮带在暗球上移动
            if in_active:
                lum = 0.6 + 0.4 * active_amount
                sig = 0.7 + 0.6 * active_amount
            else:
                lum = (0.18 + 0.36 * depth) * 0.75
                sig = 0.45 + 0.5 * depth
            f.splat(PCX + x1 * R, PCY + y2 * R, min(1.0, lum), sigma=sig)


def draw_searching(t, f, R):
    """经纬点阵球 + 扫描子午线（globe 移植，段尺寸适配）"""
    spin, scan = 0.5, 8.0
    tilt = -(0.4 + 0.06 * math.sin(t * 0.35))
    ct, st = math.cos(tilt), math.sin(tilt)
    rings, lon_den = 8, 16
    for li in range(rings + 1):
        lat = -math.pi / 2 + (li / rings) * math.pi
        cl, sl = math.cos(lat), math.sin(lat)
        lon_n = max(10, int(abs(cl) * lon_den))
        for lj in range(lon_n):
            lon = (lj / lon_n) * TAU
            gx = cl * math.cos(lon)
            gy = sl
            gz = cl * math.sin(lon)
            yaw = t * spin
            x1 = gx * math.cos(yaw) + gz * math.sin(yaw)
            z1 = -gx * math.sin(yaw) + gz * math.cos(yaw)
            y2 = gy * ct - z1 * st
            z2 = gy * st + z1 * ct
            depth = (z2 + 1) / 2
            if z2 < -0.45:
                continue
            d = angle_delta(lon + yaw, t * scan)
            if d < 0:
                boost = math.exp(-(d * d) / 0.05) * max(0.0, z2) * 0.45
            else:
                boost = math.exp(-(d * d) / 0.10) * max(0.0, z2)
            # 极区可见性：亮度/点径下限（depth 低导致暗小）
            lum = max(0.32, 0.24 + 0.38 * depth) + 1.2 * boost
            sig = max(0.9, 0.6 + 0.6 * depth) + 0.8 * boost
            f.splat(PCX + x1 * R, PCY - y2 * R, min(1.0, lum), sigma=sig)


# ── 渲染：三段拼一帧 ──
SEGMENTS = [
    ("① sphere 球体旋转", draw_sphere),
    ("② thinking 波浪", draw_thinking),
    ("③ solving 条带", draw_solving),
]

TOTAL_ROWS = len(SEGMENTS) * (SEG_H + GAP)


def render_frame(i, t, R):
    rows = []
    for label, draw_fn in SEGMENTS:
        f = Frame()
        draw_fn(t, f, R)
        rows.append(f"{DIM}{label:<{LABEL_W}}{RESET}")
        for cy in range(SEG_H):
            rows.append(" " * LABEL_W + f.emit_line(cy))
        rows.append("")
    return rows


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    R = 0.48 * min(PW, PH)
    periods = [T_SPHERE, T_THINK, T_SOLVE]
    total = 0
    for name, period in [("sphere", T_SPHERE), ("think", T_THINK), ("solve", T_SOLVE), ("search", T_SEARCH)]:
        n = int(round(period * FPS))
        total += n
        for i in range(n):
            f = Frame()
            if name == "sphere":
                draw_sphere(i / FPS, f, R)
            elif name == "think":
                draw_thinking(i / FPS, f, R)
            elif name == "solve":
                draw_solving(i / FPS, f, R)
            else:
                draw_searching(i / FPS, f, R)
            out = []
            for cy in range(SEG_H):
                out.append(f"\x1b[{cy + 1};1H{f.emit_line(cy)}")
            with open(f"{outdir}/{name}_{i:03d}.ansi", "w") as fp:
                fp.write("".join(out))
    print(f"rendered {total} frames -> {outdir}/ ({FPS}fps, 各段独立周期)")


def play(outdir):
    import glob
    names = [("sphere", "① sphere 球体旋转"), ("think", "② thinking 波浪"), ("solve", "③ solving 条带"), ("search", "④ searching 扫描")]
    seqs = []
    for name, label in names:
        files = sorted(glob.glob(f"{outdir}/{name}_*.ansi"))
        if not files:
            sys.exit(f"frames not found for {name} — run render first")
        seqs.append((label, [open(p).read() for p in files]))

    def parse(raw):
        parts = re.split(r"\x1b\[(\d+);1H", raw)
        d = {}
        for j in range(1, len(parts) - 1, 2):
            d[int(parts[j])] = parts[j + 1]
        return d

    # 预解析所有段帧为行数组（内存 ~几 MB）
    seg_rows = []
    for label, frames in seqs:
        parsed = [parse(fr) for fr in frames]
        rows = []
        for pr in parsed:
            rows.append([pr.get(y, "") for y in range(1, SEG_H + 1)])
        seg_rows.append((label, rows))

    total_rows = len(seqs) * (SEG_H + GAP) + 1  # 标签行 + 段行 + 空行

    print("\x1b[2J\x1b[?25l", end="", flush=True)
    prev = None
    i = 0
    try:
        while True:
            if i % 90 == 0:
                try:
                    term_rows = shutil.get_terminal_size().lines
                except Exception:
                    term_rows = total_rows
                max_rows = min(total_rows, max(20, term_rows))
            # 组合三行区域（各段独立循环）
            cur_lines = []
            for label, rows in seg_rows:
                frame_rows = rows[i % len(rows)]
                cur_lines.append(f"{DIM}{label:<{LABEL_W}}{RESET}")
                cur_lines.extend(" " * LABEL_W + r for r in frame_rows)
                cur_lines.append("")
            if i % 30 == 0:
                sys.stdout.write("\x1b[2J\x1b[H")
                for y, line in enumerate(cur_lines[:max_rows]):
                    sys.stdout.write(f"\x1b[{y + 1};1H{line}")
                sys.stdout.flush()
            else:
                out = []
                for y in range(max_rows):
                    cv = cur_lines[y] if y < len(cur_lines) else ""
                    pv = prev[y] if prev and y < len(prev) else ""
                    if cv != pv:
                        if cv == "":
                            out.append(f"\x1b[{y + 1};1H\x1b[2K")
                        else:
                            out.append(f"\x1b[{y + 1};1H{cv}")
                if out:
                    sys.stdout.write("".join(out))
                    sys.stdout.flush()
            prev = cur_lines
            i += 1
            time.sleep(1 / FPS)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "demo"
    outdir = "three_frames"
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
