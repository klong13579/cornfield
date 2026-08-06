#!/usr/bin/env python3
"""
Voice Interface — Flipbook Player (Ghostty-homepage style)

Plays pre-rendered ANSI frames baked by render_frames.py.
The player does zero rendering — it just pages frames at a fixed
rate, exactly like the Ghostty homepage terminal video.

Frames:  voice_frames/<state>_NNN.ansi  (idle / listen / think / speak)
Keys:    1-4 switch state · Space pause · Q quit
"""

import json
import os
import re
import select
import shutil
import sys
import termios
import time
import tty

FRAME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_frames")
STATE_KEYS = {"1": "idle", "2": "listen", "3": "think", "4": "speak"}
TOKEN = re.compile(r"(\033\[[0-9;]+m|\033\[\d+;\d+H)")


def load_frames():
    with open(os.path.join(FRAME_DIR, "meta.json")) as fp:
        meta = json.load(fp)
    frames = {}
    for st in meta["states"]:
        seq = []
        for i in range(meta["frames"]):
            path = os.path.join(FRAME_DIR, f"{st}_{i:03d}.ansi")
            with open(path) as fp:
                seq.append(fp.read())
        frames[st] = seq
    return meta, frames


def crop_frame(data, max_w, max_h):
    """Crop a baked ANSI frame to (max_w, max_h) visible cells."""
    out = ["\033[H"]
    skip_row = False
    col = 0
    for p in TOKEN.split(data):
        if not p:
            continue
        m = re.match(r"\033\[(\d+);(\d+)H", p)
        if m:
            y = int(m.group(1))
            skip_row = y > max_h
            col = 0
            if not skip_row:
                out.append(p)
            continue
        if p.startswith("\033["):
            if not skip_row:
                out.append(p)  # color codes pass through harmlessly
            continue
        if skip_row:
            continue
        for ch in p:
            if col >= max_w:
                break
            out.append(ch)
            col += 1
    out.append("\033[0m")
    return "".join(out)


def fit_frames(frames, fw, fh, tw, th):
    """Return frames unchanged if terminal fits, else cropped copies."""
    if tw >= fw and th >= fh:
        return frames
    return {st: [crop_frame(f, tw, th) for f in seq]
            for st, seq in frames.items()}


def main():
    if not os.path.isdir(FRAME_DIR):
        sys.exit(f"frames not found: {FRAME_DIR}\nrun render_frames.py first")

    meta, frames = load_frames()
    n = meta["frames"]
    fps = meta.get("fps", 30)
    fw, fh = meta["w"], meta["h"]

    w, h = shutil.get_terminal_size()
    if w < 20 or h < 8:
        sys.exit(f"terminal way too small: {w}x{h}")
    view = fit_frames(frames, fw, fh, w, h)

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    state = "idle"
    idx = 0
    paused = False

    tty.setcbreak(fd)
    try:
        sys.stdout.write("\033[?25l\033[?7l\033[2J")
        tick = 0
        while True:
            if not paused:
                sys.stdout.write(view[state][idx])
                sys.stdout.flush()
                idx = (idx + 1) % n
                tick += 1
                if tick % 20 == 0:  # periodic resize check
                    nw, nh = shutil.get_terminal_size()
                    if (nw, nh) != (w, h):
                        w, h = nw, nh
                        view = fit_frames(frames, fw, fh, w, h)
                        sys.stdout.write("\033[2J")

            t0 = time.time()
            while time.time() - t0 < 1 / fps:
                if select.select([sys.stdin], [], [], 0.005)[0]:
                    k = sys.stdin.read(1)
                    if k in ("q", "Q"):
                        return
                    if k == " ":
                        paused = not paused
                    elif k in STATE_KEYS:
                        state = STATE_KEYS[k]  # keep idx → seamless switch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\033[?7h\033[?25h\033[0m\033[2J\033[H")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
