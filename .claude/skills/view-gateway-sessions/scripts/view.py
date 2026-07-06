#!/usr/bin/env python3
"""
view.py — gateway agent session/log viewer (self-contained, stdlib only).

Coverage
--------
  im    IM conversation JSONL
         <agentDir>/sessions/<convId>.jsonl           (gateway-managed, flat)
         <agentDir>/sessions/<encoded-cwd>/by-date/<YYYY-MM-DD>/<HHMMSS>__<8hex>.jsonl
                                                         (OMP-managed, by-date)
  cron  gateway cron task session JSONL
         <agentDir>/sessions/cron_<ts>.jsonl
  exec  scheduler execution diagnostics
         <dataDir>/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl

Discovery (for a given <accountId>)
------------------------------------
  agentDir — looked up in two places, in order:
    1. ~/.omp/gateway.json → channels.<ch>.accounts.<id>.agentDir
       (the canonical DM agentDir for a gateway account)
    2. ~/.omp/agent/registry.json → agents.<id>.path
       (the omp-CLI-registered path; broader fallback for non-DM agents)
  No implicit fallback to ~/.omp/agents/<id>/ — that path does not exist
  for gateway accounts (their agentDir is project-relative, not user-relative).

  cron task slugs — read from:
    ~/.omp/gateway-data/scheduler/jobs.json
    filter tasks[*].accountId == <id>, collect tasks[*].name
  The scheduler.db is vestigial: schema is present but the tasks table is
  empty. jobs.json is the live source.

  cron exec logs — on disk at:
    <dataDir>/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl
  where <slug> is one of the names collected above.

  --agent-dir, --gateway-config, --registry, --data-dir override defaults.

Examples
--------
  python3 view.py hr                              # latest IM conversation, last 30
  python3 view.py hr --type all                   # one newest file from each kind
  python3 view.py hr --type exec                  # exec log of one of hr's tasks
  python3 view.py hr --type cron --last 50        # last 50 of latest cron run
  python3 view.py hr --list                       # list all discoverable files
  python3 view.py hr --grep "puppeteer"           # filter
  python3 view.py hr --from "ack test"            # start at first match
  python3 view.py hr --file <path>                # specific file
  python3 view.py hr --role user --json           # structured output
  python3 view.py hr --tz Asia/Shanghai
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HOME = Path(os.environ.get("HOME") or os.path.expanduser("~"))
DEFAULT_DATA_DIR = HOME / ".omp" / "gateway-data"
DEFAULT_GATEWAY_CONFIG = HOME / ".omp" / "gateway.json"
DEFAULT_REGISTRY = HOME / ".omp" / "agent" / "registry.json"
DEFAULT_JOBS_PATH = DEFAULT_DATA_DIR / "scheduler" / "jobs.json"
DEFAULT_TAIL = 30

# Filename grammars — keep in lockstep with packages/pi-gateway/src/session-paths.ts
RE_CRON_SESSION = re.compile(r"^cron_\d+\.jsonl$")
RE_INTERACTIVE_SESSION = re.compile(r"^\d{6}(?:-[a-z0-9-]+)?__[0-9a-f]{8}\.jsonl$")
RE_CRON_LOG = re.compile(r"^\d{4}-\d{2}-\d{2}\.jsonl$")

ROLE_ICONS = {
    "user": "👤",
    "assistant": "🤖",
    "toolResult": "🔧",
    "exec": "🛠",
    "model_change": "🔄",
    "session": "📌",
    "compaction": "🗜",
    "developer": "🧑‍💻",
    "system": "⚙️",
}

# ---------------------------------------------------------------------------
# Path discovery
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> object | None:
    """Read and parse a JSON file. Return None on missing/invalid."""
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as e:
        print(f"warn: failed to read {path}: {e}", file=sys.stderr)
        return None


def _resolve_agent_dir(account_id: str, args: argparse.Namespace) -> tuple[Path | None, str | None]:
    """Look up the agentDir for a gateway account.

    Order:
      1. --agent-dir  (explicit override)
      2. ~/.omp/gateway.json   → channels.<ch>.accounts.<id>.agentDir
      3. ~/.omp/agent/registry.json → agents.<id>.path

    Returns (path, source-label) or (None, None) if nothing matched.
    """
    if args.agent_dir:
        p = Path(args.agent_dir).expanduser()
        return p, "agent-dir"

    # 1. gateway.json — iterate every channel's accounts
    gw = _read_json(Path(args.gateway_config).expanduser())
    if isinstance(gw, dict):
        for ch_name, ch_cfg in (gw.get("channels") or {}).items():
            if not isinstance(ch_cfg, dict):
                continue
            accounts = ch_cfg.get("accounts") or {}
            if not isinstance(accounts, dict):
                continue
            entry = accounts.get(account_id)
            if isinstance(entry, dict) and entry.get("agentDir"):
                return Path(entry["agentDir"]).expanduser(), f"gateway.json:{ch_name}"

    # 2. registry.json — omp-CLI-registered path
    reg = _read_json(Path(args.registry).expanduser())
    if isinstance(reg, dict):
        entry = (reg.get("agents") or {}).get(account_id)
        if isinstance(entry, dict) and entry.get("path"):
            return Path(entry["path"]).expanduser(), "registry.json"

    return None, None


def _resolve_task_slugs(account_id: str, args: argparse.Namespace) -> list[str]:
    """Read jobs.json and return the names of cron tasks bound to accountId."""
    jobs_path = Path(args.jobs).expanduser()
    jobs = _read_json(jobs_path)
    if not isinstance(jobs, dict):
        return []
    out: list[str] = []
    for task in jobs.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        if task.get("accountId") != account_id:
            continue
        name = task.get("name")
        if isinstance(name, str) and name:
            out.append(name)
    return out


def discover(account_id: str, args: argparse.Namespace) -> dict:
    """Resolve an accountId into (agent_dir, task_slugs, sources)."""
    agent_dir, agent_dir_source = _resolve_agent_dir(account_id, args)
    return {
        "account_id": account_id,
        "agent_dir": agent_dir,
        "agent_dir_source": agent_dir_source,
        "task_slugs": _resolve_task_slugs(account_id, args),
    }


# ---------------------------------------------------------------------------
# File enumeration
# ---------------------------------------------------------------------------


def list_session_files(agent_dir: Path | None) -> list[dict]:
    if not agent_dir:
        return []
    sessions_root = agent_dir / "sessions"
    if not sessions_root.is_dir():
        return []
    out: list[dict] = []
    for path, kind, label in _walk_jsonl(sessions_root):
        stat = path.stat()
        out.append(
            {
                "kind": kind,
                "path": path,
                "mtime_ms": stat.st_mtime * 1000,
                "size": stat.st_size,
                "label": f"{kind} session: {label}",
            }
        )
    return out


def list_exec_log_files(task_slugs: list[str], data_dir: Path) -> list[dict]:
    out: list[dict] = []
    for slug in task_slugs:
        d = data_dir / "scheduler" / "logs" / "by-task" / slug
        if not d.is_dir():
            continue
        for entry in sorted(d.iterdir()):
            if not entry.is_file() or not RE_CRON_LOG.match(entry.name):
                continue
            stat = entry.stat()
            out.append(
                {
                    "kind": "exec",
                    "path": entry,
                    "mtime_ms": stat.st_mtime * 1000,
                    "size": stat.st_size,
                    "label": f"exec log: {slug}/{entry.name}",
                }
            )
    return out


def _walk_jsonl(root: Path) -> Iterator[tuple[Path, str, str]]:
    """Yield (path, kind, label) for every recognized session JSONL under root.

    `root` is always an agent's `sessions/` directory. We classify each
    file via `_classify_session` against this root.
    """
    sessions_root = root
    for entry in root.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            sub = entry / "sessions"
            if sub.is_dir():
                yield from _walk_jsonl(sub)
            # Also recurse for OMP-style by-date trees (encoded cwd dirs).
            for sub2 in entry.rglob("*.jsonl"):
                if sub2.is_file():
                    yield from _classify_session(sub2, sessions_root)
            continue
        if entry.is_file():
            yield from _classify_session(entry, sessions_root)


def _classify_session(path: Path, sessions_root: Path) -> Iterator[tuple[Path, str, str]]:
    """Classify a JSONL inside an agent's `sessions/` root.

    Two source conventions are recognized:
      1. OMP interactive grammar — `HHMMSS__<8hex>.jsonl` under
         `<encoded-cwd>/by-date/<YYYY-MM-DD>/`.
      2. Gateway-managed IM (e.g. DingTalk conversation ID) — flat
         `*.jsonl` at the top of `sessions/`. Filename is opaque to us
         but distinguishable from cron by absence of the `cron_` prefix.
    """
    if RE_CRON_SESSION.match(path.name):
        yield path, "cron", path.name
        return
    if RE_INTERACTIVE_SESSION.match(path.name):
        yield path, "im", str(path.relative_to(sessions_root))
        return
    # Gateway-managed IM: any non-cron .jsonl sitting directly under sessions/.
    if path.parent == sessions_root:
        yield path, "im", path.name


# ---------------------------------------------------------------------------
# Time formatting
# ---------------------------------------------------------------------------


def fmt_time(iso: str, tz_name: str) -> str:
    if not iso:
        return "?"
    try:
        if iso.endswith("Z"):
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        try:
            tz = ZoneInfo(tz_name)
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("UTC")
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return iso


# ---------------------------------------------------------------------------
# JSONL streaming
# ---------------------------------------------------------------------------


def iter_jsonl(path: Path) -> Iterator[dict]:
    """Yield each non-empty, parseable JSON line. Malformed lines are skipped."""
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def matches_keyword(obj: object, kw: str | None) -> bool:
    if not kw:
        return True
    return kw.lower() in json.dumps(obj, ensure_ascii=False).lower()


# ---------------------------------------------------------------------------
# Message extraction & formatting
# ---------------------------------------------------------------------------


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content) if content is not None else ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t == "text":
            parts.append(str(item.get("text", "")))
        elif t == "thinking":
            tk = item.get("thinking")
            if tk:
                parts.append(f"[思考] {str(tk)[:200]}")
        elif t == "toolCall":
            name = item.get("name", "?")
            args = item.get("arguments") or {}
            intent = args.get("_i", "") if isinstance(args, dict) else ""
            parts.append(f"[工具调用] {name}({intent})")
        elif t == "toolResult":
            text = item.get("text", "")
            is_err = bool(item.get("isError"))
            status = "❌" if is_err else "✅"
            parts.append(f"[{status}] 工具结果: {str(text)[:200]}")
    return "\n".join(parts)


def parse_im_or_cron(obj: dict, tz: str) -> dict:
    obj_type = obj.get("type", "")

    # System events have their own schema; surface the payload instead of dumping a bare role label.
    if obj_type == "model_change":
        return {
            "type": obj_type,
            "role": obj_type,
            "time": fmt_time(obj.get("timestamp", ""), tz),
            "text": f"→ {obj.get('model', '?')} (role: {obj.get('role', '?')})",
            "model": "",
            "raw": obj,
        }
    if obj_type == "session":
        lines = [
            f"id:      {obj.get('id', '?')}",
            f"version: {obj.get('version', '?')}",
            f"cwd:     {obj.get('cwd', '?')}",
        ]
        return {
            "type": obj_type,
            "role": obj_type,
            "time": fmt_time(obj.get("timestamp", ""), tz),
            "text": "\n".join(lines),
            "model": "",
            "raw": obj,
        }
    if obj_type == "compaction":
        summary = obj.get("shortSummary") or obj.get("summary", "") or "(no summary)"
        if len(summary) > 500:
            summary = summary[:500] + "..."
        return {
            "type": obj_type,
            "role": obj_type,
            "time": fmt_time(obj.get("timestamp", ""), tz),
            "text": summary,
            "model": "",
            "raw": obj,
        }

    # Default: standard message event
    msg = obj.get("message") or {}
    stop_reason = msg.get("stopReason") or ""
    err_msg = msg.get("errorMessage") or ""
    return {
        "type": obj_type,
        "role": msg.get("role") or obj_type,
        "time": fmt_time(obj.get("timestamp", ""), tz),
        "text": extract_text(msg.get("content")),
        "model": msg.get("api", ""),
        "status": stop_reason or ("error" if err_msg else "ok"),
        "errorMessage": err_msg,
        "raw": obj,
    }


def parse_exec(obj: dict, tz: str) -> dict:
    ts_ms = obj.get("ts")
    ts_iso = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat() if ts_ms else ""
    diag = obj.get("diagnostics") or {}
    lines: list[str] = []
    lines.append(
        f"status={obj.get('status', '?')} exit={obj.get('exitCode', '?')} "
        f"durationMs={obj.get('durationMs', '?')}"
    )
    summary = diag.get("summary")
    if summary:
        lines.append(f"summary: {summary}")
    entries = diag.get("entries") or []
    if entries:
        lines.append("entries:")
        for e in entries:
            e_ts = e.get("ts")
            e_iso = (
                datetime.fromtimestamp(e_ts / 1000, tz=timezone.utc).isoformat()
                if e_ts
                else "?"
            )
            lines.append(
                f"  - [{e_iso}] {e.get('severity', '?')} {e.get('source', '?')}: {e.get('message', '')}"
            )
    output = obj.get("output")
    if output:
        lines.append(f"output: {str(output)[:500]}")
    stderr = obj.get("stderr")
    if stderr:
        lines.append(f"stderr: {str(stderr)[:500]}")
    return {
        "type": "exec",
        "role": "exec",
        "time": fmt_time(ts_iso, tz),
        "text": "\n".join(lines),
        "model": "",
        "raw": obj,
    }


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------


def apply_filters(
    msgs: list[dict],
    *,
    grep: str | None,
    from_kw: str | None,
    role: str | None,
    last: int,
    errors_only: bool = False,
) -> list[dict]:
    out = msgs
    if from_kw:
        idx = next(
            (i for i, m in enumerate(out) if matches_keyword(m.get("raw", m), from_kw)),
            -1,
        )
        if idx >= 0:
            out = out[idx:]
        else:
            out = []
    if grep:
        out = [m for m in out if matches_keyword(m.get("raw", m), grep)]
    if role:
        out = [m for m in out if m.get("role") == role]
    if errors_only:
        out = [m for m in out if m.get("status") in ("aborted", "error") or m.get("errorMessage")]
    if last and len(out) > last:
        out = out[-last:]
    return out


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_text(
    file: dict,
    msgs: list[dict],
    args: argparse.Namespace,
    total_parsed: int,
) -> str:
    sep = "-" * 70
    out: list[str] = []
    out.append(f"File:     {file['path']}")
    out.append(f"Kind:     {file['kind']}")
    out.append(f"Size:     {file['size'] / 1024:.0f} KB")
    out.append(f"Timezone: {args.tz}")
    if args.from_keyword:
        out.append(f"[from keyword: {args.from_keyword!r}]")
    if args.grep:
        out.append(f"[grep: {args.grep!r}]")
    if args.role:
        out.append(f"[role: {args.role}]")
    if args.errors:
        out.append("[errors only: aborted | error]")
    out.append(sep)
    if not msgs:
        out.append("(no matching messages)")
        return "\n".join(out)
    for m in msgs:
        role = m.get("role", "")
        status = m.get("status", "ok")
        is_err = status in ("aborted", "error") or m.get("errorMessage")
        icon = "⚠️ " if is_err else ROLE_ICONS.get(role, "•")
        model_tag = f" [{m['model']}]" if m.get("model") else ""
        status_tag = f" [{status}]" if is_err else ""
        out.append("")
        out.append(f"[{m['time']}] {icon} {role}{model_tag}{status_tag}")
        text = (m.get("text") or "").strip()
        err_msg = (m.get("errorMessage") or "").strip()
        if err_msg:
            # Place the error message on the line immediately under the header
            # so it's not lost inside the (often empty) content body.
            out.append(f"  ⚠ {err_msg}")
        if text:
            if len(text) > 500:
                text = text[:500] + "..."
            for line in text.splitlines():
                out.append(f"  {line}")
    out.append("=" * 70)
    out.append(f"Total parsed: {total_parsed} | Shown: {len(msgs)} messages")
    return "\n".join(out)


def render_list(entries: list[dict], discovered: dict, account_id: str | None) -> str:
    sep = "=" * 78
    out: list[str] = []
    out.append(sep)
    title = "Gateway Agent Files"
    if account_id:
        title += f" — account: {account_id}"
    out.append(title)
    out.append(sep)
    ad = discovered.get("agent_dir")
    out.append(f"agentDir: {ad or '(not found)'}")
    if discovered.get("agent_dir_source"):
        out.append(f"  source:  {discovered['agent_dir_source']}")
    if discovered.get("task_slugs"):
        out.append(f"task slugs ({len(discovered['task_slugs'])}): {', '.join(discovered['task_slugs'])}")
    else:
        out.append("task slugs: (none for this accountId)")
    out.append("-" * 78)
    if not entries:
        out.append("(no files found)")
        return "\n".join(out)
    # sort: kind then mtime desc
    by_kind: dict[str, list[dict]] = {"im": [], "cron": [], "exec": []}
    for e in entries:
        by_kind.setdefault(e["kind"], []).append(e)
    for kind in ("im", "cron", "exec"):
        items = sorted(by_kind.get(kind, []), key=lambda x: x["mtime_ms"], reverse=True)
        if not items:
            continue
        out.append(f"[{kind}] ({len(items)})")
        for e in items:
            ts = datetime.fromtimestamp(e["mtime_ms"] / 1000).strftime("%Y-%m-%d %H:%M")
            size_kb = e["size"] / 1024
            rel = e["label"]
            out.append(f"  {ts}  {size_kb:>6.0f}KB  {rel}")
        out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="view.py",
        description="View a gateway agent's session JSONL (IM / cron / exec).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("account_id", nargs="?", help="Gateway account id (e.g. hr, algorithm).")
    p.add_argument("--type", choices=["im", "cron", "exec", "all"], default="im")
    p.add_argument("-a", "--list", action="store_true", help="List all discoverable files.")
    p.add_argument("-f", "--file", help="View a specific file path (skip discovery).")
    p.add_argument("-n", "-t", "--last", "--tail", dest="last", type=int, default=DEFAULT_TAIL,
                   help="Number of recent messages to show (default: 30).")
    p.add_argument("-r", "--role", help="Role filter (im/cron only): user | assistant | toolResult")
    p.add_argument("-g", "--grep", help="Filter messages containing keyword (case-insensitive).")
    p.add_argument("--from", dest="from_keyword", help="Start output from first message containing this keyword.")
    p.add_argument("--errors", action="store_true", help="Only show assistant turns that aborted or errored (stopReason in {aborted, error} or errorMessage present).")
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.add_argument("--tz", default=None, help="IANA timezone name (default: system).")
    p.add_argument("--agent-dir", help="Skip discovery; use this agentDir directly.")
    p.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR),
                   help=f"Gateway data dir (jobs.json + exec logs live here; default: {DEFAULT_DATA_DIR}).")
    p.add_argument("--gateway-config", default=str(DEFAULT_GATEWAY_CONFIG),
                   help=f"Gateway config file (default: {DEFAULT_GATEWAY_CONFIG}).")
    p.add_argument("--registry", default=str(DEFAULT_REGISTRY),
                   help=f"omp agent registry file (default: {DEFAULT_REGISTRY}).")
    p.add_argument("--jobs", default=str(DEFAULT_JOBS_PATH),
                   help=f"jobs.json path (default: {DEFAULT_JOBS_PATH}).")
    return p


def resolve_tz(args: argparse.Namespace) -> str:
    if args.tz:
        return args.tz
    try:
        return str(ZoneInfo("localtime").key)  # type: ignore[attr-defined]
    except Exception:
        return "UTC"


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.account_id and not args.file:
        parser.error("account_id is required (or pass --file to skip discovery)")
    args.tz = resolve_tz(args)

    # --file short-circuits discovery
    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"file not found: {path}", file=sys.stderr)
            return 1
        # Guess kind from filename
        if RE_CRON_LOG.match(path.name) and "by-task" in str(path):
            kind = "exec"
        elif RE_CRON_SESSION.match(path.name):
            kind = "cron"
        elif RE_INTERACTIVE_SESSION.match(path.name):
            kind = "im"
        else:
            kind = "im"
        file_entry = {
            "kind": kind,
            "path": path,
            "mtime_ms": path.stat().st_mtime * 1000,
            "size": path.stat().st_size,
            "label": path.name,
        }
        return view_file(file_entry, args, total_known=None)

    # Discovery
    info = discover(args.account_id, args)
    session_files = list_session_files(info["agent_dir"])
    exec_files = list_exec_log_files(info["task_slugs"], Path(args.data_dir))
    all_files = session_files + exec_files

    # --list
    if args.list:
        print(render_list(all_files, info, args.account_id))
        return 0

    # Pick file(s) by --type
    wanted_kinds = {
        "im": {"im"},
        "cron": {"cron"},
        "exec": {"exec"},
        "all": {"im", "cron", "exec"},
    }[args.type]

    matching = [f for f in all_files if f["kind"] in wanted_kinds]
    if not matching:
        print(
            f"no {args.type} files found for account '{args.account_id}'.\n"
            f"  agentDir: {info['agent_dir']}  (source: {info['agent_dir_source']})\n"
            f"  taskSlugs: {info['task_slugs']}",
            file=sys.stderr,
        )
        return 2

    if args.type == "all":
        # Show one newest file per kind
        for kind in ("im", "cron", "exec"):
            picked = pick_newest(matching, kind)
            if not picked:
                continue
            print()
            view_file(picked, args, total_known=None)
        return 0

    picked = pick_newest(matching, args.type)
    if not picked:
        print(f"no {args.type} file matched.", file=sys.stderr)
        return 2
    return view_file(picked, args, total_known=None)


def pick_newest(entries: list[dict], kind: str) -> dict | None:
    subset = [e for e in entries if e["kind"] == kind]
    if not subset:
        return None
    return max(subset, key=lambda e: e["mtime_ms"])


def view_file(file: dict, args: argparse.Namespace, total_known: int | None) -> int:
    """Parse + filter + render a single file. Returns shell exit code."""
    total_parsed = 0
    parsed: list[dict] = []
    tz = args.tz
    kind = file["kind"]
    for obj in iter_jsonl(file["path"]):
        total_parsed += 1
        if kind == "exec":
            parsed.append(parse_exec(obj, tz))
        else:
            parsed.append(parse_im_or_cron(obj, tz))

    msgs = apply_filters(
        parsed,
        grep=args.grep,
        from_kw=args.from_keyword,
        role=args.role,
        last=args.last,
        errors_only=args.errors,
    )

    if args.json:
        payload = {
            "file": str(file["path"]),
            "kind": kind,
            "size": file["size"],
            "tz": tz,
            "total_parsed": total_parsed,
            "shown": len(msgs),
            "messages": [
                {
                    "type": m["type"],
                    "role": m["role"],
                    "time": m["time"],
                    "text": m["text"],
                    "model": m["model"],
                    "status": m.get("status", "ok"),
                    "errorMessage": m.get("errorMessage", ""),
                }
                for m in msgs
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(render_text(file, msgs, args, total_parsed))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
