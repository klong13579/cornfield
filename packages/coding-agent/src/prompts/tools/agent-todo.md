Reads and writes **this Agent's own long-lived task board** (`<agentDir>/.cornfield/agent-todos.json`) — the same board the Todo page shows and the user edits by hand.

Two different task surfaces exist; do not mix them:

| Surface | Scope | Tool |
|---|---|---|
| Session checklist | this run only; dies with the session | `todo` |
| Agent task board | outlives every session; this Agent's standing work | `agent_todo` (this one) |

Use this tool when the task outlives the conversation — something the user asked to track, a standing follow-up, work the next session must pick up. Use `todo` for the steps of the work you are doing right now. Long-lived tasks go on the board; *nobody* moves them to the board for you.

## Actions

|`action`|Required|Effect|
|---|---|---|
|`list`|—|Read the board. Always do this before `update`/`delete` — ids come from here.|
|`add`|`title`|Create a task. Status starts `open`.|
|`update`|`id`|Change `title` / `status` / `priority` / `dueAt` / `notes` / `projectId`. Unnamed fields stay as they are.|
|`delete`|`id`|Remove the task.|

## Fields

- `title` — the task, one line. Required for `add`, and it must stay non-empty.
- `status` — `open` · `in_progress` · `completed` · `cancelled`.
- `priority` — `low` · `medium` · `high`. Defaults to `medium`.
- `dueAt` — local wall clock. `YYYY-MM-DD` (that day's end) or `YYYY-MM-DD HH:mm`. An empty string clears it. A date that does not exist (`2026-02-30`) is an error, not silently rolled forward.
- `notes` — free text. An empty string clears it.
- `projectId` — bind the task to a Project. Only Projects this Agent declares are allowed.

## Rules

- **Ids are opaque.** Take one from a `list` and pass it back verbatim. Never invent one.
- **`completed` and `cancelled` are terminal.** The board does not reopen them; a transition back to `open` is rejected by design. If work must restart, `add` a new task and say why.
- **`sessionRefs` is not yours to write.** The board records which sessions advanced a task; a value that disagrees with what is stored is rejected. Read the board, change the fields above, write it back.
- **Never edit `agent-todos.json` by hand.** Timestamps, lifecycle and provenance are owned by the store.
- **Report what the board says, not what you meant.** Every write returns the stored record; when it disagrees with what you sent, the stored record is the truth.

## Examples

Read the board:
`{"action":"list"}`

Add a task:
`{"action":"add","title":"把转正答辩排期定了","priority":"high","dueAt":"2026-09-30"}`

Move a task to in progress and add a note:
`{"action":"update","id":"6f1c…","status":"in_progress","notes":"等王总回复时间"}`

Complete a task:
`{"action":"update","id":"6f1c…","status":"completed"}`

Clear a due date and a note:
`{"action":"update","id":"6f1c…","dueAt":"","notes":""}`

Delete a task:
`{"action":"delete","id":"6f1c…"}`
