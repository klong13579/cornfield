# AGENTS.md

> Manifest + global hard constraints for this agentDir.
>
> OMP native discovery reads this file at agent startup (design §3 step 3):
>
> - Lines containing `MUST NOT` or `NEVER` are extracted to `<hard-constraints>`.
> - All other content (after MUST NOT extraction) is injected to `<context>`.
>
> This file is **always-on** (loaded unconditionally as the manifest trigger).

## File Map

| Path                                 | Layer                            | Loaded as                                                            |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------- |
| `AGENTS.md` (this)                   | MANIFEST + CONSTRAINTS           | always-on (manifest trigger)                                         |
| `mission.md`                         | IDENTITY                         | always-on (via `prompt-includes.json`)                               |
| `TOOLS.md`                           | CONTEXT + tool-level CONSTRAINTS | always-on                                                            |
| `TODO.md`                            | CONTEXT (current task)           | always-on                                                            |
| `knowledge/external-workspaces.md`   | CONTEXT (data sources)           | always-on                                                            |
| `prompt-includes.json`               | RUNTIME (injection manifest)     | read at startup                                                      |
| `.omp/config.yml`                    | RUNTIME (model/role/theme)       | read at startup (hard dependency)                                    |
| `.omp/SYSTEM.md`                    | RUNTIME (gateway system prompt)  | overrides OMP built-in prompt — gateway agent baseline                |
| `.omp/skills/<name>/SKILL.md`       | BEHAVIOR (on-demand)             | via `skill://<name>` URI                                             |
| `knowledge/handbook/*`               | CONTEXT (on-demand)              | read by agent (user-created)                                         |
| `cron/tasks/*.prompt.md`             | BEHAVIOR (scheduled)             | cron trigger                                                         |
| `sessions/*.jsonl`                   | RUNTIME (gitignored)             | session history                                                      |

> Optional files (not in skeleton): `scripts/`, `external/`, `weekly-reports/`, `examples/`, `docs/`.
> Per design §6.3 principle 5, missing optional files **must not** raise errors or warnings.

## Update guide

- `mission.md` — redefine this bot's identity, capabilities, and language.
- `TOOLS.md` — add tool-level `MUST` / `MUST NOT` rules co-located with each tool (design §4 principle 2).
- `TODO.md` — track the current task; updated by the agent as work progresses.
- `prompt-includes.json` — change which files are injected as always-on.
- `.omp/config.yml` — change `modelRoles.default` to switch the active model.
- `.omp/SYSTEM.md` — gateway agent system prompt baseline; edit to customize behavior. Leave empty to fall back to OMP's built-in prompt.

## Global hard constraints

> Rules below are extracted by OMP and enforced as system-prompt hard constraints.
> Add new rules under this heading; use `MUST` / `MUST NOT` / `NEVER` so the extractor picks them up.

- MUST read `mission.md` first to understand identity before any user response.
- MUST verify a tool exists in `TOOLS.md` before invoking it; never guess tool names.
- MUST NOT execute destructive operations (delete, force-push, drop, format) without explicit user confirmation in the same conversation.
- MUST NOT exfiltrate data outside `agentDir` unless the user names a specific destination.
- MUST log every external write (IM message, webhook, git push) to `cron/logs/` or `sessions/`.
