# MOA Extension

Mixture-of-Agents planning extension for OMP.

Current state: v1 command-driven planning panel scaffold is live.

Implemented v1:
- `/moa run <task>` command surface
- Parallel divergent / grounded / critical workers via `runSubprocess(...)`
- Synthesis pass that chooses one recommendation
- Custom `moa-result` message renderer with collapsed and expanded views
- Heterogeneous worker model slots and trace details output
- **Two-tier persistence** (pi-fusion-style): every run emits a bounded `moa-result` handoff (≤ `resumeContextBytes`, default 8 KB) and a chunked `moa-archive` of the full transcript (`moa.archive.v1` schema, 48 KB chunks, keyed by a stable `runId`)
- `/moa transcript [runId]` to render the full archived transcript on demand
- `/moa runs` to list archived runs in the current session
- **5-stage pipeline (Discovery + Ask-user + Rewrite + Workers + Synthesis)**: closes the **Data Gap** (29.1% of multi-agent failures per AgentAsk 2026) by extracting a per-task Task Context Object (TCO), asking the user for missing inputs in TUI mode, and injecting the closed TCO into every worker / synthesis prompt. TUI mode shows up to 5 focused questions; gateway / cron falls back to `[assumed: non_interactive_fallback]` markers. See [`docs/moa-input-fulfillment.md`](../../docs/moa-input-fulfillment.md).

## Setup

`/moa` ships **inline** with `omp` (same pattern as swarm / autoresearch /
self-evolution). After `bun --cwd=packages/coding-agent run build`, the
compiled binary already registers `/moa` — no `extensions` path, no
`.omp/cache/extension-bundles` build step.

If your settings still list `../moa-extension` (or an absolute path to this
package), **remove that entry** so the factory is not loaded twice.

### Verifying

```bash
bun --cwd=packages/coding-agent run build
omp                                    # or: bun --cwd=packages/coding-agent src/cli.ts
# In the TUI:
/moa help                              # expect usage notification
/moa status                            # expect config dump
/moa run <task>                        # expect workers + synthesis + [moa] result
```

Automated (gated by API keys; skips otherwise):

```bash
bun test packages/moa-extension/test/moa-e2e.test.ts
bun test packages/moa-extension/test/moa-e2e-real-config.test.ts
# Multi-round interactive co-test (session archive / dispatchLog):
E2E=1 bun run packages/moa-extension/test-mr-e2e-cotest.ts
```

## Commands

| Command | Purpose |
| --- | --- |
| `/moa run <task>` | Run a 3-worker planning panel + synthesis. Emits a bounded `moa-result` handoff (with TCO summary) and a chunked `moa-archive` of the full transcript (including Discovery + Rewrite + TCO JSON). |
| `/moa status` | Show current settings (worker count, discovery/rewrite, ask-user enable/max, planner tools, execution mode, archive chunk bytes). |
| `/moa transcript [runId]` | Render the full archived transcript (default: most recent). Output is a `moa-transcript` custom message. |
| `/moa runs` | List every `moa-archive` run in the current session. |
| `/moa help` | Show the command summary. |

## Two-tier persistence (why `moa-result` content looks short)

`/moa run` produces two kinds of session entries:

1. **`moa-result` (display: true)** — the user-visible handoff. Content is bounded to `resumeContextBytes` (default 8 KB). The headline line is `∪ moa transcript: N/M workers completed.` followed by a pointer to the archive. Only the truncated worker conclusions and synthesis make it into the LLM context on subsequent turns.
2. **`moa-archive` (display: false, N+1 entries)** — the durable full transcript. One manifest entry plus 0..N chunk entries (`moa.archive.v1` schema, 48 KB per chunk). These are kept out of LLM context by the session manager but live in the session JSONL, so `/moa transcript <runId>` can rebuild them on demand. Chunks are byte-exact UTF-8 splits (`join(chunkUtf8(s, n)) === s`).

The `details` on the `moa-result` carries `runId`, `archiveChunks`, and `archiveBytes` so downstream code (renderers, other extensions) can locate the full transcript without re-parsing the content.

To inspect a run's full output:

```text
/moa runs                   # pick a runId from the list
/moa transcript moa-...     # render full markdown transcript
```

## Default model selection

The whole point of MOA is that different workers use different models so they cross-correct each other. Without explicit per-role models, every worker and the synthesis would collapse to whichever model happened to be first in the registry — no diversity, no MOA. So the extension ships with a hard-coded default layout and you can override it.

### Cost-lite defaults (shipped)

| Role | Model | Family |
| --- | --- | --- |
| `divergent` (广度) | `narwal-plan/qwen3.5-flash` | Qwen |
| `grounded` (实操) | `alibaba-coding-plan/deepseek-v4-pro` | DeepSeek |
| `critical` (锐利) | `alibaba-coding-plan/kimi-k2.6` | Kimi |
| `synthesis` (高阶) | `narwal-plan/deepseek-v4-pro-202606` | DeepSeek (V4 Pro 202606) |

Three different model families for the workers (diversity > strength, per the [Together MoA paper, 2024](https://arxiv.org/abs/2406.04692)) plus a fourth family member tuned for synthesis. Smoke-tested against the live `narwal-plan` and `alibaba-coding-plan` endpoints; all four return 200 OK with `stopReason=stop`.

### Overriding

There are three ways to override, in priority order (top wins):

1. **`PI_MOA_SETTINGS_JSON` env var** (one-off, JSON5 object; same shape as `MoaSettings`)
2. **Project config file** at `<git-root>/.omp/moa.{yml,yaml,json}` (committed, shared with the team)
3. **Global config file** at `~/.omp/agent/moa.{yml,yaml,json}` (per-user, all repos)
4. The bundled defaults in `DEFAULT_WORKER_SLOTS` / `DEFAULT_SETTINGS.synthesisModel`

#### Env var (one-off)

```bash
PI_MOA_SETTINGS_JSON='{
  workers: [
    { name: "divergent", model: "alibaba-coding-plan/glm-5.1" },
    { name: "grounded",  model: "alibaba-coding-plan/deepseek-v4-pro" },
    { name: "critical",  model: "narwal-plan/kimi-k2.5" },
  ],
  synthesisModel: "narwal-plan/gpt-5.4",
}' omp ...
```

#### Config file (persistent)

Project (committed; shared with the team):

```yaml
# <repo-root>/.omp/moa.yml
workers:
  - { name: divergent, model: alibaba-coding-plan/glm-5.1 }
  - { name: grounded,  model: alibaba-coding-plan/deepseek-v4-pro }
  - { name: critical,  model: narwal-plan/kimi-k2.5 }
synthesisModel: narwal-plan/gpt-5.4
```

Global (per-user, all repos):

```yaml
# ~/.omp/agent/moa.yml
synthesisThinking: medium
timeoutMs: 300000
```

The loader walks up from the active cwd to find the project root (the first ancestor with a `.git` entry), then looks for `<root>/.omp/moa.{yml,yaml,json}`. The global file lives at `~/.omp/agent/moa.{yml,yaml,json}`. Project wins on conflict (shallow merge — arrays are replaced, not deep-merged).

Malformed YAML, unknown fields, and unreadable files are tolerated: the loader logs a warning and returns empty overrides. A bad config file never blocks `/moa run`.

If a worker slot has no model binding (e.g. `workerCount: 5` and you only overrode 3 of them), the missing slots fall back to the highest-priority model from the user's `modelRegistry`. The four hard-coded defaults never need registry access.

## Execution mode

MOA supports two worker execution modes, controlled by `workerExecutionMode`:

| Mode | Default | Description |
| --- | --- | --- |
| `subprocess` | **yes** | Each worker runs as an `omp --mode json -p --no-session` subprocess. Full tool access, extension support, MCP, LSP. Backward compatible. |
| `in-process` | no | Workers run in the current process via `createAgentSession()`. No subprocess overhead — lower memory, shares the runtime. **Intentionally conservative**: no extension discovery, no MCP, no LSP, read-only tools only (`read`/`search`/`find`/`web_search`/`ast_grep`). |

### Config (any MOA config source)

```yaml
workerExecutionMode: in-process
```

### Differences between modes

- **Tool access**: `in-process` limits workers to `read`, `search`, `find`, and `web_search`. The `plannerToolMode: "all"` setting is ignored in `in-process` mode — workers never get write tools like `write`/`edit`/`bash`.
- **Extensions / MCP / LSP**: disabled in `in-process`. Workers do not discover or load project extensions, custom commands, or MCP servers.
- **Session**: `in-process` uses `SessionManager.inMemory()` — no session log is written to disk for worker sessions.
- **Python**: `in-process` skips Python kernel warmup.
- **Timeout**: `in-process` uses `AbortController` + `Promise.race`. Unlike subprocess, the worker's execution cannot be forcibly killed — timeout returns `timedOut: true` and signals the abort; resource reclamation is best-effort.
- **Recursion guard**: `in-process` workers do not set `PI_MOA_SUBAGENT`. The existing subprocess guard (`process.env.PI_MOA_SUBAGENT === "1"`) still applies to the subprocess path only.

Default remains `subprocess` for full backward compatibility. `in-process` is an opt-in experimental path for reduced memory footprint.

## Stage test harness (local / real LLM)

Diagnose a stuck stage without waiting for full `/moa run` session persistence:

```bash
# Full smoke (interactive Ask)
bun packages/moa-extension/scripts/stage-test.ts --stage all --task "你的任务…"

# Single stage (reuse prior artifacts)
bun packages/moa-extension/scripts/stage-test.ts --stage discovery --task "…"
bun packages/moa-extension/scripts/stage-test.ts --stage rewrite --from tmp/moa-stage/<id>

# Options: --out tmp/moa-stage --rounds N --continue-on-fail
```

Reads `~/.omp/agent/moa.yml` (and project `.omp/moa.yml`). Not part of default CI.
