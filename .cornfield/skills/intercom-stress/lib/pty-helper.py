#!/usr/bin/env python3
"""PTY wrapper for spawning headless pi worker sessions.

Spawns <cmd...> under a sized pseudo-terminal (so TUIs boot correctly),
prints the child's PID as the first stdout line, then drains the pty master
forever (output is discarded — workers talk to the stress program exclusively
through the intercom broker).

Set ICS_PTY_DUMP=<path> to tee the child's pty output to a file for debugging.

Usage: python3 pty-helper.py <cmd...>
"""

import fcntl
import os
import select
import struct
import sys
import termios


DUMP = os.environ.get("ICS_PTY_DUMP")


def drain(fd):
    try:
        data = os.read(fd, 65536)
    except OSError:
        return b""
    return data


def main() -> None:
    cmd = sys.argv[1:]
    if not cmd:
        print("usage: pty-helper.py <cmd...>", file=sys.stderr)
        sys.exit(2)

    pid, fd = os.forkpty()
    if pid == 0:
        os.execvp(cmd[0], cmd)
        os._exit(127)

    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    except OSError:
        pass

    print(f"CHILD_PID {pid}")
    sys.stdout.flush()

    while True:
        try:
            readable, _, _ = select.select([fd], [], [], 1.0)
        except (OSError, ValueError):
            break
        if fd in readable:
            data = drain(fd)
            if not data:
                break
            if DUMP:
                try:
                    with open(DUMP, "ab") as fh:
                        fh.write(data)
                except OSError:
                    pass
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except OSError:
            break
        if done == pid:
            break

    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()