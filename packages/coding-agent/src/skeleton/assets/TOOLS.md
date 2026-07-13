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
- MUST use `read` for office documents (PPT, PPTX, DOC, DOCX, XLS, XLSX, RTF, EPUB) instead of `bash` + Python scripts — `read` converts them to markdown text via markit-ai, preserving structured content.
- MUST NOT use `bash` `python3 -c "zipfile"` or similar to manually extract text from Office XML — let `read` handle the conversion.
- **PDF 例外**：OMP `read` 工具缺 mupdf 运行时依赖，无法解析 PDF。使用 `python3` + `fitz` 代替：
  `python3 -c "import fitz; doc = fitz.open('/tmp/f.pdf'); [print(page.get_text()) for page in doc]"`

### `search`
Search text across files.

- MUST narrow by `path` before running on a large repo.
- MUST prefer `search` over manual `cat` / `head` / `tail` / `rg` pipelines.

### `find`
Find files by glob pattern.

- MUST use `find` instead of shell globbing (`ls **/*.ts` etc.).
- MUST narrow results with a specific `pattern` to avoid excessive output.

### `lsp`
Language Server Protocol: symbol definitions, references, rename, code actions.

- MUST use `lsp` for symbol-aware operations (rename, go-to-definition, find references) instead of text-based search.
- MUST NOT perform cross-file renames with `sed` or `ast_edit` when `lsp` rename is available.

### `bash`
Execute shell commands.

- MUST use `read` / `search` instead of `cat` / `head` / `tail` for inspection.
- MUST NOT run interactive commands (`vim`, `less`, `ssh` without batch flags).
- MUST NOT pipe untrusted input to `sh` / `bash`.
- MUST redirect large output to a file and read it back with `read`.
- MUST use full, non-truncated `python3 -c 'import json,sys; print(json.load(sys.stdin))'` (or `jq .`) when parsing JSON from stdin. Never rely on the AI Card's preview of a truncated `python3 -c "import sy…"` — the gateway-side rendering clips long arguments and `{}` is what an empty result *and* a parse failure both render to. If you cannot read the full command back, switch to the `read` tool on the JSON file directly.
- MUST NOT use a `python3 -c` one-liner to look up a known field in a config file when a `read` + `search` would do.

### `write`
Create or overwrite a file.

- MUST NOT overwrite an existing file without reading the current content first.
- MUST verify the parent directory is correct before writing.

### `edit`
Edit an existing file via `atom` / `hashline` / `patch` mode.

- MUST read the file first to obtain current anchors.
- MUST NOT use `sed` / `awk` for structural edits; use `edit` instead.

### `identity`
Persist stable user facts (name, role, timezone) to `~/.omp/user.md`.

- MUST only persist facts durable across sessions; ephemeral task context belongs in conversation, not user.md.
- MUST NOT persist one-off requests or guesses.

### `write_memory`
Persist runtime-learned behavioral preferences (target: "user" or "agent").

- MUST NOT write temporary task progress or session results to memory.
- MUST distinguish stable facts (use `identity`) from learned preferences (use `write_memory`).

## Project-specific tools

> Append project-specific tools here (DingTalk MCP, GitLab MCP, internal APIs, etc.).
> For each tool, list its purpose and any co-located `MUST` / `MUST NOT` rules.

### `cron` (gateway host tool — NOT a CLI)

`cron` is an OMP **host tool** registered by the gateway on the `set_host_tools` RPC. The agent calls it as a regular LLM tool, NOT by shelling out to `omp gateway cron ...`.

**Scope = agent (this account).** "My" in a cron context refers to the current agent (= this OMP subprocess / this account), not the user asking. All users in the same agent see the same task list; the agent owns its tasks. There is no per-user or per-conversation scope — `cron.list` returns ALL tasks in this agent, regardless of who created them or which chat is active. Each task records its creator in `createdByUserId` (audit field); if the user asks "which tasks did I create", call `cron.list` then filter the result client-side by `createdByUserId === <current sender staffId>`. See `docs/pi-gateway-cron-host-tool.md` §6.5 for the design rationale.

Actions: `add` / `list` / `show` / `update` / `remove` / `enable` / `disable` / `runs` / `test-run`.

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

**`test-run` (verification path)**: triggers a task through the REAL scheduler and reports the delivery verdict. Use after `add` / `update` to confirm the task actually works end-to-end (warm bridge → agent run → DingTalk delivery). Default duration: 90s `inMs` (1.5x the 60s gateway tick) + 30s `testTimeoutMs` = 120s total. The original schedule is ALWAYS restored after the run (in `finally`), even on timeout / abort / failure. `result.kind` is one of `success` / `trigger_timeout` / `task_failed` / `delivery_failed` / `aborted`. `isError: true` on the host tool result for non-`success` kinds. Pass `noRestore: true` only for debug — it leaves the schedule on `+<delay>s once`. Do NOT call test-run speculatively; it's a long tool call.

### `bridge.status` (gateway host tool — read-only diagnostic)

`bridge.status` is an OMP **host tool** registered by the gateway on the `set_host_tools` RPC. It returns the AgentBridge's current snapshot (lifecycle state, circuit breaker, crash recovery, queue depth) plus a derived `summary` field. No parameters.

**Scope = this agent's bridge** (the OMP subprocess serving this account). The LLM should call this when:
- The user reports a message wasn't delivered and the LLM suspects the bridge is the cause
- The LLM's own tool call returned a "system busy" / "circuit open" error and it needs to know when to retry
- The LLM needs to confirm the bridge is healthy before promising the user a follow-up

**MUST NOT** call this speculatively — the bridge is healthy most of the time, and polling costs an extra tool round-trip. Only call it when the LLM has a concrete reason to suspect a bridge problem.

**State field is the primary signal**:
- `idle` — healthy, ready. No action needed.
- `busy` — processing a prompt (see `activePromptId`). Wait for it to finish.
- `starting` — bridge spawning OMP; first prompt may take a few seconds.
- `stopped` — OMP subprocess is down. Tell the user the agent is unavailable.
- `restarting` — OMP crashed, gateway is restarting with backoff. Brief window of unavailability.
- `degraded` — circuit breaker open after consecutive failures. New prompts fast-fail until cooldown (default 30s) expires. Read `circuitFailures` and `circuitOpenedAt` to estimate when retries will be accepted.
- `error` — too many crashes; bridge is suppressed and NOT auto-restarting. Operator (human) must intervene. Tell the user the agent is down and the gateway operator needs to restart it.
