# TOOLS.md

> Tool usage guide + tool-level `MUST` / `MUST NOT` rules.
>
> This file is **always-on** (injected via `prompt-includes.json`).
> Per design §4 principle 2: **tool-level rules are co-located with the tool description**.
> Use `MUST` / `MUST NOT` / `NEVER` in this file — OMP extracts them into `<hard-constraints>`.

## OMP 内置工具

### `read`
Read a file or URL.

- MUST verify the path is inside `agentDir` unless the user names an explicit external path.
- MUST NOT read files larger than the configured `read.defaultLimit` without paging.

### `grep`
Search text across files.

- MUST narrow by `path` before running on a large repo.
- MUST prefer `grep` over manual `cat` / `head` / `tail` / `rg` pipelines.

### `bash`
Execute shell commands.

- MUST use `read` / `grep` instead of `cat` / `head` / `tail` for inspection.
- MUST NOT run interactive commands (`vim`, `less`, `ssh` without batch flags).
- MUST NOT pipe untrusted input to `sh` / `bash`.
- MUST redirect large output to a file and read it back with `read`.

### `write`
Create or overwrite a file.

- MUST NOT overwrite an existing file without reading the current content first.
- MUST verify the parent directory is correct before writing.

### `edit`
Edit an existing file via `atom` / `hashline` / `patch` mode.

- MUST read the file first to obtain current anchors.
- MUST NOT use `sed` / `awk` for structural edits; use `edit` instead.

## Project-specific tools

> Append project-specific tools here (DingTalk MCP, GitLab MCP, internal APIs, etc.).
> For each tool, list its purpose and any co-located `MUST` / `MUST NOT` rules.

### `cron` (gateway host tool — NOT a CLI)

`cron` is an OMP **host tool** registered by the gateway on the `set_host_tools` RPC. The agent calls it as a regular LLM tool, NOT by shelling out to `omp gateway cron ...`.

Actions: `add` / `list` / `show` / `update` / `remove` / `enable` / `disable` / `runs`.

- MUST use the `cron` host tool for any scheduled-task operation. Do NOT run `omp gateway cron create` / `update` / `list` / etc. from `bash` — that's the operator CLI path.
- MUST omit the `delivery` field on `cron.add` when the user is in a chat. The gateway auto-infers `{channel, accountId, toUserId}` for DM and `{channel, accountId, toConversationId}` for group from the active conversation. Do NOT read `gateway.json` / `BOOT.md` / call `dws` to look up the sender.
- MUST set `agentDir` and `prompt` (not `command`) when `taskType: "agent"`. `agentDir` is the project root the agent should run in (the current agentDir — implicit from where the agent is running).
- MUST set `command` (not `prompt`) when `taskType: "shell"`.
- MUST pick a unique, descriptive `name` slug (e.g. `daily-1830-report`, `interview-prep-1h`). The tool returns the persisted task — surface `name` / schedule / delivery to the user verbatim from the response.
- MUST NOT use the v1 flag set: `--account`, `--deliver`, `--deliver-user`. Those flags were removed in the v2 schema (v2 uses `--channel` / `--to-user-id` / `--to-conversation-id` at the CLI surface; the host tool uses the same field names under `delivery`).
- MUST NOT shell out to `bash` to read `~/.omp/gateway.json` just to look up the agentDir or accountId — it's already in the active chat context (auto-inference handles it) and the project root is implicit from where the agent is running.

Example `cron.add` call (DM context, daily 18:30 report):

```json
{
  "action": "add",
  "name": "daily-1830-report",
  "schedule": "30 18 * * *",
  "taskType": "agent",
  "agentDir": "<this session's agentDir>",
  "prompt": "汇总今天的钉钉日程 + TODO.md 进展，发给当前用户",
  "timeoutMs": 300000
}
```

No `delivery` field — gateway infers `{channel, accountId, toUserId}` from the current DM via `getActiveChatContext()`.

