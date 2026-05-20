Bash execution of the DingTalk Workspace CLI (dws) for operating DingTalk products: contact, calendar, chat, docs, tables, todos, approvals, etc.

<conditions>
- User asks to access or operate DingTalk capabilities (search contacts, manage calendar, send messages, query docs, create todos, etc.)
- User mentions "钉钉", "DingTalk", or any dws product (calendar, contact, aitable, chat, todo, doc, oa, minutes, drive, attendance, report)
- The task requires reading or writing DingTalk data that dws commands can access
</conditions>

<instruction>
- **MUST** always pass `--format json` to every dws command for structured machine-readable output
- **MUST** always pass `-y` (or `--yes`) to skip confirmation prompts in agent mode
- **MUST** use `--dry-run` first for any write operation (create, update, delete, send); verify the preview, then re-run without `--dry-run` to execute
- **MUST** confirm with the user before sending messages, creating calendar events on behalf of real participants, or performing destructive operations (delete, DING)
- Use `--jq` to extract specific fields from JSON output and reduce token usage
- Cache resolved identifiers (userId, conversationId, baseId, tableId, eventId) across multiple dws calls in the same conversation
- When unsure about a command's parameters, use `dws schema <command>` to discover the parameter structure before calling
</instruction>

<prerequisites>
Before any dws invocation, check availability:

```bash
which dws          # is dws installed?
dws auth status    # is the user logged in?
```
- If dws is not installed, guide the user: `curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh`
- If not logged in, guide the user: `dws auth login` (browser) or `dws auth login --device` (headless/SSH)
- If the organization has not enabled CLI access, tell the user to contact their DingTalk admin to enable it in the Developer Platform
</prerequisites>

<command-mappings>
## Contact (通讯录)

|Intent|Command|
|---|---|
|Search user by name|`dws contact user search --query <name> --format json -y`|
|Get current user profile|`dws contact user get-self --format json -y`|
|Search department|`dws contact dept search --query <name> --format json -y`|
|List department members|`dws contact dept list-members --dept-id <id> --format json -y`|

## Calendar (日历)

|Intent|Command|
|---|---|
|List today's events|`dws calendar event list --format json -y`|
|List events in range|`dws calendar event list --time-min <ISO> --time-max <ISO> --format json -y`|
|Create event|`dws calendar event create --dry-run --summary "…" --start … --end … --format json -y` → verify → re-run without `--dry-run`|
|Delete event|`dws calendar event delete --dry-run --event-id <id> --format json -y` → verify → re-run|
|Check busy/free|`dws calendar busy search --user-ids <id1,id2> --time-min <ISO> --time-max <ISO> --format json -y`|
|Search meeting rooms|`dws calendar room search --query <keyword> --format json -y`|

## Chat / IM (群聊)

|Intent|Command|
|---|---|
|Send message as user|`dws chat message send --dry-run --group <id> --text "…" --format json -y` → verify → re-run|
|Send message as bot|`dws chat message send-by-bot --dry-run --robot-code <code> --group <id> --title "…" --text "…" --format json -y` → verify → re-run|
|Send via webhook|`dws chat message send-by-webhook --dry-run --webhook-url <url> --title "…" --text "…" --format json -y`|
|List group members|`dws chat group members --group-id <id> --format json -y`|
|Search groups|`dws chat search --query <name> --format json -y`|
|Search bots|`dws chat bot search --query <name> --format json -y`|
|Read message history|`dws chat message list --conversation-id <id> --format json -y`|
|Search messages|`dws chat message search --query <keyword> --format json -y`|

## Todo (待办)

|Intent|Command|
|---|---|
|Create todo|`dws todo task create --dry-run --title "…" --format json -y` → verify → re-run|
|List todos|`dws todo task list --format json -y`|
|Mark done|`dws todo task done --task-id <id> --format json -y`|
|Delete todo|`dws todo task delete --dry-run --task-id <id> --format json -y` → verify → re-run|

## Doc (钉钉文档)

|Intent|Command|
|---|---|
|Search docs|`dws doc search --query <keyword> --format json -y`|
|Read doc content|`dws doc read --doc-id <id> --format json -y`|
|Create doc|`dws doc create --dry-run --title "…" --folder-id <id> --format json -y`|
|List folder contents|`dws doc list --folder-id <id> --format json -y`|

## AI Table (多维表)

|Intent|Command|
|---|---|
|List bases|`dws aitable base list --format json -y`|
|Search bases|`dws aitable base search --query <name> --format json -y`|
|Query records|`dws aitable record query --base-id <id> --table-id <id> --format json -y`|
|Create record|`dws aitable record create --dry-run --base-id <id> --table-id <id> --fields '…' --format json -y`|
|Update record|`dws aitable record update --dry-run --base-id <id> --table-id <id> --record-id <id> --fields '…' --format json -y`|

## OA Approval (审批)

|Intent|Command|
|---|---|
|List pending|`dws oa approval list-pending --format json -y`|
|Get detail|`dws oa approval detail --instance-id <id> --format json -y`|
|Approve|`dws oa approval approve --dry-run --task-id <id> --format json -y` → verify → re-run|

## DING Messages

|Intent|Command|
|---|---|
|Send DING|`dws ding message send --dry-run --user-ids <id1,id2> --text "…" --format json -y` → **MUST** get user confirmation before executing|

## Other Common Commands

|Product|Intent|Command|
|---|---|---|
|Attendance|My records|`dws attendance record get --format json -y`|
|Drive|List files|`dws drive list --format json -y`|
|Minutes|List mine|`dws minutes list mine --format json -y`|
|Report|List reports|`dws report list --format json -y`|
</command-mappings>

<schema-discovery>
When you are unsure about a command's parameters:

```bash
# List all products and their tools
dws schema --jq '.products[] | {id, tool_count: (.tools | length)}'

# Inspect a specific tool's parameters
dws schema contact.search_users --jq '.tool.parameters'

# Inspect required fields
dws schema contact.search_users --jq '.tool.required'
```
</schema-discovery>

<file-injection>
To send long text content to dws, write to a temp file and use `@` file injection:

```bash
# Write content to a temp file
write path="/tmp/dws-msg.md" content="..."
# Reference it in dws
bash: dws chat message send-by-bot --robot-code CODE --group ID --title "Title" --text @/tmp/dws-msg.md --format json -y
```
</file-injection>

<caution>
- Never fabricate DingTalk identifiers (user IDs, conversation IDs, base IDs, etc.). Always resolve them from dws query output.
- Write operations (create, update, delete, send) require `--dry-run` first. Only re-run without `--dry-run` after verifying the preview.
- DING messages and approval operations require explicit user confirmation before execution — these are high-stakes actions.
- Do not call `dws` for non-DingTalk tasks. Use `bash` directly for general shell commands.
</caution>

<critical>
- **MUST** pass `--format json` to every dws invocation — without it, output is human-readable and unparseable
- **MUST** pass `-y` to skip confirmation prompts when called from agent context
- **MUST** use `--dry-run` for all write operations before actual execution
- **MUST NOT** execute DING sends or approval actions without explicit user confirmation
- **MUST** check dws availability (`which dws`) before first use and guide installation if missing
</critical>
