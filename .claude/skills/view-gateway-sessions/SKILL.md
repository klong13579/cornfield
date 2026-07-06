---
name: view-gateway-sessions
description: >-
  Tail a gateway agent's session JSONL — IM conversation, cron task run,
  or scheduler exec diagnostic. Use when the user asks to view, debug,
  trace, or read a session, conversation, cron run, or exec failure
  of a gateway account. Skip for direct `cat <file>`, for `omp agent show`
  identity queries, or for tasks already known by cron slug
  (`omp gateway cron logs <slug>` handles those).
---

> tail — chronological, recent, filterable view of an agent's activity.

A gateway account produces three log sources, in two distinct on-disk trees. One tool reads all of them, scoped to one account at a time.

| `--type` | Source | On-disk path |
|---|---|---|
| `im` (default) | IM conversation | `<agentDir>/sessions/<convId>.jsonl` (DingTalk-managed) or `<agentDir>/sessions/<encoded-cwd>/by-date/<YYYY-MM-DD>/<HHMMSS>__<8hex>.jsonl` (OMP-managed) |
| `cron` | cron task run | `<agentDir>/sessions/cron_<ts>.jsonl` |
| `exec` | scheduler exec diagnostic | `<dataDir>/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl` |

`--type all` tails one newest file from each.

## Procedure

### Step 1 — Pick the account and the source

The user names an accountId (e.g. `hr`, `algorithm`) and may name a source. Default source: `im`. If the user says "what just happened in hr's cron" you have `accountId=hr`, `type=cron` — both bounded, no further questions.

Completion criterion: you have `(accountId, type)`.

### Step 2 — Run view.py

Script: `~/.omp/agent/skills/view-gateway-sessions/scripts/view.py`

Common invocations (output goes to your context — keep tail small):

```bash
SCRIPT=~/.omp/agent/skills/view-gateway-sessions/scripts/view.py

# Latest IM conversation
python3 "$SCRIPT" hr

# All three sources, one newest file each
python3 "$SCRIPT" hr --type all

# Tail the last cron run for the account
python3 "$SCRIPT" hr --type cron --last 50

# Exec diagnostic for one of the account's cron tasks
python3 "$SCRIPT" hr --type exec

# Search the latest file for a keyword
python3 "$SCRIPT" hr --grep "puppeteer"

# Start output at the first match
python3 "$SCRIPT" hr --from "ack test"

# List everything we can find
python3 "$SCRIPT" hr --list

# JSON for piping
python3 "$SCRIPT" hr --json | jq '.messages[-1]'
```

Completion criterion: the script ran, returned exit 0 or 2, and you read the output.

### Step 3 — Interpret

The output is a header (`File` / `Kind` / `Size` / `Timezone`) followed by timestamped role-tagged lines. `im` and `cron` lines look like:

```
[2026-07-05 12:00:05] 🤖 assistant [anthropic/claude-opus-4-5]
  Reading inbox...
  [工具调用] bash(ls mail)
```

`exec` lines look like:

```
[2026-07-05 12:00:03] 🛠 exec
  status=success exit=0 durationMs=3360
  summary: Running task via subprocess (no agent bridge)
  entries:
    - [2026-07-05T12:00:00.026000+00:00] info cron-setup: Running task via subprocess (no agent bridge)
```

Assistant turns whose upstream LLM request failed render with `⚠️` + a `[status]` tag + the `errorMessage` on the line below the header:

```
[2026-07-06 17:40:03] ⚠️  assistant [openai-completions] [aborted]
  ⚠ Request was aborted
```

Status values seen in the wild: `toolUse`, `stop`, `aborted`, `error`. `aborted` and `error` are treated as failures; use `--errors` to see only those.

Exit code 2 means "discovered nothing for this `(accountId, type)`". The stderr message reports what the script did find — usually enough to ask the user the right next question (wrong account, custom config path, account that never ran a cron task).

Completion criterion: you can summarise file path, key message content, and any error state in your reply.

## Discovery

Two on-disk lookups, no DB:

- **agentDir** — gateway.json first, registry.json fallback. The script reads `~/.omp/gateway.json` and walks `channels.<ch>.accounts.<id>.agentDir`; if absent, reads `~/.omp/agent/registry.json` for `agents.<id>.path`. Override with `--agent-dir`, `--gateway-config`, or `--registry`.
  The agentDir for a DM gateway account is the project-relative path declared in `gateway.json` (e.g. `OMP-workspace-test/hr3/`), not `~/.omp/agents/<id>/` — that path does not exist for gateway accounts.
- **cron task slugs** — read `~/.omp/gateway-data/scheduler/jobs.json`, filter `tasks[*].accountId == <id>`, collect `tasks[*].name`. The scheduler.db is vestigial: schema is present but the `tasks` table is empty in current installs. jobs.json is the live source. Override with `--jobs` or `--data-dir`.

If the account exists in `gateway.json` but jobs.json has no rows for it, that's correct: an IM-only account has no cron tasks. Don't fail.

## Filter reference

| Flag | Effect |
|---|---|
| `--type {im\|cron\|exec\|all}` | Source. Default: `im`. |
| `--list` | List discoverable files, newest first. No filtering. |
| `--file PATH` | Skip discovery; read this exact JSONL. |
| `--last N` | Keep last N messages after filter. Default 30. |
| `--role R` | Role filter (im/cron only). |
| `--grep KW` | Case-insensitive keyword filter on the raw record. |
| `--from KW` | Drop everything before first match. |
| `--errors` | Keep only assistant turns that `aborted` or `errored` (upstream LLM failure). |
| `--json` | Structured JSON output. |
| `--tz Region/City` | IANA timezone (default: system). |
| `--agent-dir PATH` | Skip discovery; use this agentDir. |
| `--gateway-config PATH` | Override `~/.omp/gateway.json`. |
| `--registry PATH` | Override `~/.omp/agent/registry.json`. |
| `--jobs PATH` | Override `jobs.json` path. |
| `--data-dir PATH` | Override `~/.omp/gateway-data`. |

## Pitfalls

- **Cron exec log empty for a slug** → the task hasn't run since the gateway started, or `--data-dir` points to a different machine. Verify with `ls <dataDir>/scheduler/logs/by-task/<slug>/`.
- **Custom `gateway.json` path in production** → pass `--gateway-config`. Don't assume the default.
- **Local OMP CLI session tree** — `~/.omp/agent/sessions/<encoded-cwd>/...` is the LOCAL OMP CLI's session log, not a gateway account. The script scopes by accountId via `gateway.json` / `registry.json` and will not recurse into that tree.
- **AccountId with no cron tasks in jobs.json** → `--type cron` and `--type exec` will return nothing. Confirm the account actually has scheduled tasks; if it does and jobs.json disagrees, jobs.json may be stale — point `--data-dir` at the live gateway host.

## When NOT to use

- User has a specific file path and just wants `cat` / `tail -f` — use the bash tool directly. Don't shell out through this skill.
- User is asking about agent identity, tools, skills, or cron task config — that's `omp agent show <name>` or `omp gateway cron list`.
- User already knows the cron task slug (e.g. "check `daily-2000-calendar-push`") — that's `omp gateway cron logs <name>`. This skill is the account-fan-out view; `cron logs` is the slug-deep view.
- User is debugging `view-sessions.py` inside `omp-atomix/` — keep using that script; this skill is the generalisation for everywhere else.
