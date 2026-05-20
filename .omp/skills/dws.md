---
name: "dws"
version: "1"
source: "builtin"
status: "active"
confidence_score: 0.9
description: "Use when the user asks to access DingTalk product capabilities via the dws CLI — search contacts, manage calendar, send/read messages, query docs, operate AI tables, manage todos, or handle OA approvals."
---

# DingTalk Workspace CLI (dws)

## Prerequisites

Before any dws invocation:

```bash
which dws          # is dws installed?
dws auth status    # is the user logged in?
```

- Not installed → guide: `curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh`
- Not logged in → guide: `dws auth login` (browser) or `dws auth login --device` (headless/SSH)
- Org not enabled → tell user to contact DingTalk admin to enable CLI access in Developer Platform

## Invocation Rules

Every dws call through bash MUST follow these rules:

1. **Always** pass `--format json` for structured machine-readable output
2. **Always** pass `-y` (--yes) to skip confirmation prompts in agent context
3. **Always** use `--dry-run` first for write operations (create/update/delete/send). Verify preview, then re-run without `--dry-run` to execute.
4. Use `--jq` to extract specific fields and reduce token usage
5. Cache resolved identifiers (userId, conversationId, baseId, tableId, eventId) across calls
6. When unsure about parameters, run `dws schema <command>` first

## Command Index

### Contact (通讯录)

| Intent | Command |
|--------|---------|
| Search user by name | `dws contact user search --query <name> --format json -y` |
| Get current user profile | `dws contact user get-self --format json -y` |
| Search department | `dws contact dept search --query <name> --format json -y` |
| List dept members | `dws contact dept list-members --dept-id <id> --format json -y` |

### Calendar (日历)

| Intent | Command |
|--------|---------|
| List today's events | `dws calendar event list --format json -y` |
| List events in range | `dws calendar event list --time-min <ISO> --time-max <ISO> --format json -y` |
| Create event | `dws calendar event create --dry-run --summary "..." --start ... --end ... --format json -y` → verify → re-run |
| Delete event | `dws calendar event delete --dry-run --event-id <id> --format json -y` → verify → re-run |
| Check busy/free | `dws calendar busy search --user-ids <ids> --time-min <ISO> --time-max <ISO> --format json -y` |
| Search meeting rooms | `dws calendar room search --query <keyword> --format json -y` |

### Chat / IM (群聊)

| Intent | Command |
|--------|---------|
| Send message as bot | `dws chat message send-by-bot --dry-run --robot-code <code> --group <id> --title "..." --text "..." --format json -y` |
| Send via webhook | `dws chat message send-by-webhook --dry-run --webhook-url <url> --title "..." --text "..." --format json -y` |
| Search groups | `dws chat search --query <name> --format json -y` |
| List group members | `dws chat group members --group-id <id> --format json -y` |
| Search bots | `dws chat bot search --query <name> --format json -y` |
| Read message history | `dws chat message list --conversation-id <id> --format json -y` |
| Search messages | `dws chat message search --query <keyword> --format json -y` |

### Todo (待办)

| Intent | Command |
|--------|---------|
| Create todo | `dws todo task create --dry-run --title "..." --format json -y` → verify → re-run |
| List todos | `dws todo task list --format json -y` |
| Mark done | `dws todo task done --task-id <id> --format json -y` |

### Doc (钉钉文档)

| Intent | Command |
|--------|---------|
| Search docs | `dws doc search --query <keyword> --format json -y` |
| Read doc | `dws doc read --doc-id <id> --format json -y` |
| List folder | `dws doc list --folder-id <id> --format json -y` |

### AI Table (多维表)

| Intent | Command |
|--------|---------|
| List bases | `dws aitable base list --format json -y` |
| Search bases | `dws aitable base search --query <name> --format json -y` |
| Query records | `dws aitable record query --base-id <id> --table-id <id> --format json -y` |
| Create record | `dws aitable record create --dry-run --base-id <id> --table-id <id> --fields '...' --format json -y` |
| Update record | `dws aitable record update --dry-run --base-id <id> --table-id <id> --record-id <id> --fields '...' --format json -y` |

### OA Approval (审批)

| Intent | Command |
|--------|---------|
| List pending | `dws oa approval list-pending --format json -y` |
| Get detail | `dws oa approval detail --instance-id <id> --format json -y` |
| Approve | `dws oa approval approve --dry-run --task-id <id> --format json -y` → verify → re-run |

### DING Messages

| Intent | Command |
|--------|---------|
| Send DING | `dws ding message send --dry-run --user-ids <ids> --text "..." --format json -y` → MUST get user confirmation before executing |

### Other

| Product | Intent | Command |
|---------|--------|---------|
| Attendance | My records | `dws attendance record get --format json -y` |
| Drive | List files | `dws drive list --format json -y` |
| Minutes | List mine | `dws minutes list mine --format json -y` |
| Report | List reports | `dws report list --format json -y` |

## Schema Discovery

```bash
# List all products
dws schema --jq '.products[] | {id, tool_count: (.tools | length)}'

# Inspect specific tool parameters
dws schema contact.search_users --jq '.tool.parameters'
```

## File Injection

```bash
# Write content to temp file, reference via @file
write path="/tmp/dws-msg.md" content="..."
bash: dws chat message send-by-bot --robot-code CODE --group ID --title "Title" --text @/tmp/dws-msg.md --format json -y
```

## Safety Rules

1. **Write operations require `--dry-run` first** — create, update, delete, send. Only re-run without `--dry-run` after verifying the preview.
2. **DING and approval actions require explicit user confirmation** — these are high-stakes, do not execute without asking.
3. **Never fabricate DingTalk identifiers** — always resolve userId, conversationId, baseId, etc. from dws query output.
4. **Send messages require user confirmation of content and recipients** — do not send without review.

## Pitfalls

- Forgetting `--format json` → output is unparseable for the agent
- Forgetting `-y` → dws will hang waiting for confirmation prompt
- Using `--dry-run` on read-only commands → unnecessary
- Assuming identifiers are correct without verifying via dws query
- Not caching resolved identifiers across multiple calls
- Sending DING or approval without user confirmation

## Anti-patterns

- Do not use curl or REST API directly when dws is available
- Do not fabricate DingTalk IDs — always look them up
- Do not skip `--dry-run` for write operations
- Do not execute DING/approval without user confirmation