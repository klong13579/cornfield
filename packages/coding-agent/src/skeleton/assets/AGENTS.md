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
| `.omp/SYSTEM.md`                     | RUNTIME (gateway system prompt)  | overrides OMP built-in prompt — gateway agent baseline               |
| `.omp/skills/<name>/SKILL.md`        | BEHAVIOR (on-demand)             | via `skill://<name>` URI                                             |
|| `knowledge/handbook/*`               | CONTEXT (on-demand)              | read by agent (user-created)                                         |
|| `raw/`                               | CONTEXT (data ingress)           | raw/unstructured data (user-created)                                 |
|| `wiki/`                              | CONTEXT (structured knowledge)   | curated wiki pages (user-created)                                    |
|| `cron/tasks/*.json5`                 | RUNTIME (schedule + prompt)      | cron trigger (prompt in `command` field; no .prompt.md pair)         |
|| `sessions/*.jsonl`                   | RUNTIME (gitignored)             | session history                                                      |

> Optional files (not in skeleton): `scripts/`, `external/`, `weekly-reports/`, `examples/`, `docs/`.
> `raw/` and `wiki/` are skeleton directories — created by init. Remove from gitignore if you don't need them.
> Per design §6.3 principle 5, missing optional files **must not** raise errors or warnings.

## 文件职责边界（MECE 规则）

> 每个关注点只在一个文件里定义。其他文件如需提及，写引用而非复制内容。

| 关注点 | 唯一定义位置 | 其他文件写法 |
|--------|-------------|-------------|
| 身份/角色/职责 | `mission.md` | SYSTEM.md 不重复定义身份 |
| 工具使用规则（per-tool MUST） | `TOOLS.md` | SYSTEM.md 不列具体工具规则 |
| 安全硬约束（MUST NOT） | `AGENTS.md` hard-constraints | SYSTEM.md 不重复同等约束 |
| 工作纪律/风格原则（建议语气） | `.omp/SYSTEM.md` | MUST/NOT 级别的硬约束放 AGENTS.md |
| 领域知识/研发文档 | `knowledge/handbook/*` | mission.md 只放索引不放内容 |
| 外部数据源登记 | `knowledge/external-workspaces.md` | mission.md 只引用不重列 |
| 一次性 procedure / SOP | `.omp/skills/<name>/SKILL.md` | TOOLS.md 只放约束不放命令 |
| 定时任务 | `cron/tasks/*.json5` | 通过 `cron` host tool 注册 |

修改任何 prompt 文件前 **MUST** 检查：要加的内容是否已在另一个文件里定义。如是，改为引用而非复制内容。
判定归属时区分：MUST/NOT 级别的硬约束 → AGENTS.md hard-constraints；风格/原则建议 → SYSTEM.md。

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
