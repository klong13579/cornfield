# Hub

Inspect the live agent roster — every agent (the main session plus all
subagents) currently alive in this process, with what each one is doing.

## Operations
- `op: "list"` (default) — all peers visible to you, each with kind, status,
  current activity, and time since last activity. Use this to see who is
  around and what they are working on.
- `op: "show"` + `id` — one peer in detail: identity, parent, status,
  activity, last activity, session file, and any persisted history
  (model, metrics, artifacts).

## Relationship to other tools

|Need|Tool|
|---|---|
|Roster inspection / what is everyone doing|**hub** (`op: "list"` / `"show"`)|
|Message a live agent and read its reply|`irc` (`op: "send"`)|
|Wait for background jobs / cancel them|`job` (`poll` / `cancel`)|
|Spawn subagents|`task`|

The hub tool is read-only: it does not message, kill, or revive agents.
Killing a peer is a destructive action and belongs to a human operator.

Use `op: "show"` before acting on a specific agent id — the roster rows are
display-only and the identity details (session file, parent, history) live in
the show view.
