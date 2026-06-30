# Repository Guidelines

Oh My Pi (`omp`) is a Bun-based monorepo that builds a terminal coding agent (`omp` CLI). The agent is a multi-provider LLM harness with a differential TUI, 25+ built-in tools, slash commands, session/memory management, a self-evolution learning system, and a gateway for IM channel integration (DingTalk). It compiles to a standalone binary that ships with native Rust addons.

## Runtime & Tooling Preferences

|Concern|Tooling|
|---|---|
|Runtime|**Bun 1.3.12** (min 1.3.7). Never use Node for dev commands.|
|Package manager|Bun workspaces (`bun install`). Lockfile: `bun.lock`.|
|TypeScript type-check|**tsgo** (`@typescript/native-preview`), NOT `tsc`/`npx tsc`.|
|TS lint/format|**Biome 2.4.13** (`biome.json`). Tab indent, width 120, double quotes, semicolons, trailing commas all.|
|Rust toolchain|**nightly-2026-04-29** (`rust-toolchain.toml`), with rustfmt + clippy.|
|Rust lint|clippy: `pedantic` + `nursery` at warn, `correctness` at deny.|
|Rust test runner|`cargo nextest` (installed in CI via taiki-e/install-action).|
|Editor configs|`.vscode/`, `.zed/` present.|

Two `bunfig.toml` exist: root (`linker=hoisted`) and `packages/coding-agent` (`linker=isolated`). Root config loads `.md`/`.py`/`.lark` as text modules.

## Development Commands

All commands run from repo root unless noted.

```bash
# Run the agent locally (interactive TUI)
bun dev                          # = bun --cwd=packages/coding-agent src/cli.ts

# Checks (TS + Rust)
bun check                        # parallel: check:ts + check:rs
bun check:ts                     # biome check . + tsgo per-workspace
bun check:rs                     # cargo fmt --check + clippy (skips if no .rs changed locally)

# Lint / Format / Auto-fix
bun lint                         # parallel: lint:ts + lint:rs
bun fmt                          # parallel: fmt:ts + fmt:rs
bun fix                          # parallel: fix:ts + fix:rs (biome --unsafe + clippy --fix)

# Tests
bun test                         # parallel: test:ts + test:rs
bun test:ts                      # per-workspace bun test --only-failures
bun test:rs                      # cargo nextest (skips if no .rs changed locally)
bun test path/to/file.test.ts    # single file — only run tests you added/changed

# Build
bun build                        # per-workspace build (if present)
bun build:native                 # build Rust native addons (packages/natives)

# Generate models (never edit models.json by hand)
bun generate-models              # = bun --cwd=packages/ai run generate-models

# Release (see scripts/release.ts)
bun run release                  # bumps versions, finalizes CHANGELOGs, tags, pushes, watches CI
```

**Do not run** `bun run dev`, `bun test`, or `bun run check` unless the user instructs. Run only targeted tests for code you changed.

## Architecture & Data Flow

### Boot sequence (coding-agent)

```
packages/coding-agent/src/cli.ts        # Bun runtime guard + command table; routes unknown argv → "launch"
  └─ main.ts (runRootCommand)           # arg parsing, settings init, plugin/marketplace preload, version check
       ├─ commands/<subcommand>.ts      # commit, config, grep, jupyter, plugin, setup, shell, ssh, stats, update, gateway, ...
       └─ modes/                         # interactive | print | rpc | acp
            └─ sdk.ts (createAgentSession)  # wires AgentSession, builds tools, registers extensions, configures auth
                 └─ @oh-my-pi/pi-agent-core  # agent runtime: message/tool loop, state
```

### Package dependency graph

```
utils (pi-utils)          ← shared helpers (logger, dirs, env, stream, isEnoent, ...)
  ↑
ai (pi-ai)                ← multi-provider LLM client, streaming, OAuth, models.json (generated)
  ↑
agent (pi-agent-core)     ← agent runtime: tool-calling loop, session state
  ↑
coding-agent              ← main CLI: TUI, 25+ tools, slash commands, modes, sessions, memory, SDK
  ├─ tui (pi-tui)         ← differential terminal UI, layout, components
  ├─ natives (pi-natives) ← N-API bindings → crates/pi-natives (Rust cdylib)
  └─ self-evolution       ← SQLite evolution DB, skill mining, episodic memory, regression replay

Extension products:
  pi-gateway              ← IM channels (DingTalk), scheduler (cron/interval/one-shot), agent bridge
  cognitive-coordination  ← L4 Synapse coordination layer (WIP)
  swarm-extension         ← multi-agent orchestration
  stats (omp-stats)       ← local observability dashboard
```

### Key data flow

1. **User input** → `modes/interactive-mode.ts` (TUI) or `modes/print-mode.ts` (non-interactive `-p`).
2. **Agent loop** (`pi-agent-core`): user message → LLM provider (`pi-ai`) → tool calls → tool execution (`coding-agent/src/tools/`) → results back to LLM → repeat until done.
3. **Tools** are built via `createTools()` (`packages/coding-agent/src/tools/index.ts`) which assembles `BUILTIN_TOOLS` + `HIDDEN_TOOLS` registries, gated by `Settings.isToolAllowed`.
4. **Sessions** persist as JSONL under `~/.omp/agent/sessions/<cwd-encoded>/by-date/<YYYY-MM-DD>/<HHMMSS>[-<slug>]__<8hex>.jsonl`. This is the CLI agent's session log location.
   - **Gateway agent sessions live elsewhere**: each gateway agent runs with its own `agentDir` (default `~/.omp/agents/<accountId>/`), and its session files are written under `<agentDir>/sessions/` — IM conversations as `<convId>.jsonl`, cron tasks as `cron_<taskId>.jsonl`. Do not look for gateway agent session logs under `~/.omp/agent/sessions/`.
   - **Cron execution logs** (separate from agent sessions) are under `~/.omp/gateway-data/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl`.
5. **Self-evolution** hooks into the agent lifecycle via an extension (`sdk.ts` registers it): extracts learnings from session traces, mines skills/conventions, stores in `~/.omp/self-evolution/evolution.db` (SQLite), injects context into future sessions.

### Native bindings

`crates/pi-natives` is a single `cdylib` (~7,500 LOC Rust) exposing N-API functions: grep, shell (embedded `brush` shell), text ops, key handling, syntax highlighting, glob, task management, process listing, profiling, image, clipboard, HTML. Built via `@napi-rs/cli`. Runtime picks `modern` (x86-64-v3, AVX2) or `baseline` (x86-64-v2) addon on x64 via `scripts/host-detect.ts` AVX2 probe. CI enforces no AVX-512 in either x64 variant (`scripts/ci-release-verify-natives.ts`).

## Key Directories

```
packages/
  coding-agent/src/
    cli.ts                    # entry point (bin "omp")
    main.ts                   # root command dispatch
    sdk.ts                    # createAgentSession — wires everything
    commands/                 # subcommand implementations (commit, config, grep, ...)
    cli/                      # CLI helpers (arg parsing, session picker, file processor)
    tools/                    # 25+ tool implementations + createTools() registry
      index.ts                # BUILTIN_TOOLS / HIDDEN_TOOLS registries
      bash.ts, read.ts, write.ts, edit.ts, find.ts, search.ts
      ast-grep.ts, ast-edit.ts, lsp/, debug.ts, python.ts, task.ts, ...
      render-utils.ts         # TUI sanitization helpers (replaceTabs, truncateToWidth)
    modes/                    # interactive, print, rpc, acp
      interactive-mode.ts, print-mode.ts, rpc/, acp/, components/, theme/
    config/                   # settings.ts, model-registry.ts
    prompts/                  # agent system prompts (static .md files, Handlebars for dynamic)
    session/                  # session management, persistence
    memories/                 # memory protocol
  ai/src/
    providers/                # openai-completions, openai-responses, azure, codex, google-gemini-cli, ...
    provider-models/          # descriptors.ts, resolvers (openai-compat.ts) — source of truth for models.json
    models.json               # GENERATED — never hand-edit
    model-thinking.ts         # thinking/reasoning metadata policies
  agent/src/                  # agent loop, tool-calling, state
  tui/src/                    # differential terminal UI components, layout
  natives/                    # N-API package wrapping crates/pi-natives
  utils/src/                  # logger, isEnoent, stream helpers, dirs, env
  self-evolution/src/         # evolution DB, skill extraction, episodic storage, learning admission
  pi-gateway/src/             # DingTalk channel, scheduler, agent bridge, service installer
  cognitive-coordination/src/ # coordination registry, conflict resolver (WIP)

crates/
  pi-natives/                 # Rust cdylib: grep, shell, text, keys, highlight, glob, ...
  brush-core-vendored/        # vendored brush shell (excluded from workspace)
  brush-builtins-vendored/    # vendored brush builtins (excluded from workspace)
  session-stats/              # standalone Rust binary for session analysis (own workspace)

scripts/                      # build/CI/release automation (see Important Files)
docs/                         # 50+ design/runtime docs (see Documentation)
```

## Code Conventions & Common Patterns

### TypeScript

- **No `any`** unless absolutely necessary.
- **No `private`/`protected`/`public` keywords** on class fields/methods — use ES native `#` private fields. Exception: constructor parameter properties (`constructor(private readonly x: T)`) keep the keyword.
- **No `ReturnType<>`** — use the actual named type. If a return type has no exported name, define a type alias at the call site.
- **No inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions. Always top-level imports.
- **No inline prompt strings** — prompts live in static `.md` files under `packages/coding-agent/src/prompts/`. Use Handlebars for dynamic content. Never build prompts with template literals or string concatenation in TS.
- **Namespace imports** for `node:` modules: `import * as fs from "node:fs/promises"`, not `import { readdir } from "node:fs/promises"`.
- **Barrel exports**: prefer `export * from "./module"` over named re-export blocks in `index.ts` files.
- **`Promise.withResolvers()`** instead of `new Promise((resolve, reject) => ...)`.
- **Static text imports**: `import content from "./prompt.md" with { type: "text" }` instead of `readFileSync`.
- **TypeScript config**: `tsconfig.base.json` — ES2024 target, Bundler module resolution, strict, `verbatimModuleSyntax`, `allowArbitraryExtensions`, `noEmit` (type-check only).

### Bun APIs (prefer over Node)

|Use this|Not this|
|---|---|
|`Bun.file(path).text()` / `.json()`|`readFileSync` / `readFile`|
|`Bun.write(path, data)`|`writeFileSync` (Bun.write auto-creates parent dirs)|
|`$`cmd`...` (Bun Shell)|`Bun.spawnSync([...])` for simple commands|
|`Bun.sleep(ms)`|`new Promise(r => setTimeout(r, ms))`|
|`Bun.JSON5.parse()`|`json5` package|
|`Bun.JSONL.parse()`|manual `split("\n").map(JSON.parse)`|
|`Bun.stringWidth()`|custom width / `get-east-asian-width`|
|`Bun.wrapAnsi()`|custom ANSI-aware wrappers|

### Error handling (file I/O)

```typescript
// Single syscall, atomic, no race condition
import { isEnoent } from "@oh-my-pi/pi-utils";
try {
  return await Bun.file(path).json();
} catch (err) {
  if (isEnoent(err)) return null;
  throw err;
}
```

Never check `.exists()` before reading — use try-catch with `isEnoent`. Never create multiple handles to the same path.

### Logging

Use the centralized logger — **never** `console.log`/`console.error`/`console.warn` in `packages/coding-agent` (corrupts TUI rendering):

```typescript
import { logger } from "@oh-my-pi/pi-utils";
logger.error("MCP request failed", { url, method });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation.

### TUI sanitization

All text rendered to the TUI must be sanitized:

- **Tabs → spaces**: `replaceTabs()` from `@oh-my-pi/pi-tui` or `../tools/render-utils`.
- **Line truncation**: `truncateToWidth()` / `ui.truncate()` with `TRUNCATE_LENGTHS` constants.
- **Path shortening**: `shortenPath()` (replaces `~` for home).
- **Preview limits**: use `PREVIEW_LIMITS` constants, not ad-hoc limits.

Applies to **every render path** including error messages, diff content, and streaming previews. Streaming bash previews can have multiple render paths — update all of them.

### Generated files

`packages/ai/src/models.json` is **generated** from upstream sources by `packages/ai/scripts/generate-models.ts` and the descriptors/resolvers in `packages/ai/src/provider-models/`. Never hand-edit it. To change a model entry, edit the source:

- Resolution rules / per-id overrides → `packages/ai/src/provider-models/openai-compat.ts`
- Provider descriptors → `packages/ai/src/provider-models/descriptors.ts` or provider-specific descriptor
- Generator-level fixups → `packages/ai/scripts/generate-models.ts`
- Thinking metadata → `packages/ai/src/model-thinking.ts`

Then regenerate: `bun --cwd=packages/ai run generate-models`.

## Important Files

|File|Role|
|---|---|
|`packages/coding-agent/src/cli.ts`|CLI entry point (bin `omp`). Bun runtime guard + command routing.|
|`packages/coding-agent/src/main.ts`|Root command: arg parsing, settings init, mode dispatch.|
|`packages/coding-agent/src/sdk.ts`|`createAgentSession` — wires AgentSession, tools, extensions, auth.|
|`packages/coding-agent/src/tools/index.ts`|Tool registry: `BUILTIN_TOOLS`, `HIDDEN_TOOLS`, `createTools()`.|
|`packages/coding-agent/src/config/settings.ts`|Settings model and defaults.|
|`packages/coding-agent/src/config/model-registry.ts`|Model resolution / registry.|
|`packages/ai/src/provider-models/descriptors.ts`|Provider descriptors (source of truth for models.json).|
|`packages/ai/src/models.json`|Generated model catalog — do not edit.|
|`packages/utils/src/logger.ts`|Centralized logger (winston + daily rotate).|
|`biome.json`|Lint/format config (tab, width 120, double quotes).|
|`tsconfig.base.json`|Base TS config (ES2024, strict, Bundler resolution).|
|`Cargo.toml`|Rust workspace (members: `crates/*`, excluding vendored brush).|
|`scripts/release.ts`|Release pipeline (version bump, CHANGELOG finalization, tag, CI watch).|
|`scripts/run-rs-task.ts`|Rust task runner (skips locally if no `.rs` changed).|
|`scripts/ci-build-native.ts`|Native addon build for CI (baseline/modern variant selection).|
|`scripts/ci-release-build-binaries.ts`|Cross-compile `omp` binary for 5 targets via `bun build --compile`.|
|`scripts/ci-release-publish.ts`|Publish 7 packages to npm in dep order.|
|`scripts/install.sh` / `install.ps1`|End-user installers (bun-source / binary modes).|

## Testing & QA

### Framework

- **TypeScript**: `bun:test` (`import { describe, test, expect, vi } from "bun:test"`). No Jest/Vitest.
- **Rust**: `cargo nextest`, tests inline as `#[cfg(test)] mod tests` in source files.

### Test file conventions

|Pattern|Meaning|
|---|---|
|`<feature>.test.ts`|Unit test|
|`<feature>.integration.test.ts`|Cross-component (real SQLite, real temp dirs, real on-disk JSONL)|
|`<feature>-e2e.test.ts`|Full-stack end-to-end (gateway/IM channels)|
|`issue-NNN-repro.test.ts`|One-shot regression repro (kept long-term as living regression)|
|`regression-<topic>.test.ts`|Replay-based regression suite|

Tests live in `packages/*/test/`, except `packages/cognitive-coordination` which colocates tests in `src/`. `packages/swarm-extension` has no tests.

### Mocking policy

- **Prefer real implementations** for integration tests: real SQLite, real temp dirs, real on-disk JSONL.
- Use `vi.spyOn(...)` for unit-level behavior swaps. Restore in `afterEach` via `vi.restoreAllMocks()`.
- **Never use `mock.module()`** — it mutates the global module registry and leaks across test files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead.
- **No hand-typed mock subsets** — if an API takes `{ description, handler, getArgumentCompletions, getInlineHint }`, the mock must capture all fields. Use `spyOn` on the real API object or type with the full interface.
- **E2E opt-in**: tests hitting real LLM/OAuth providers are gated by `E2E=1` env var (`packages/ai/test/oauth.ts`). Default `bun test` does no network.

### Test isolation patterns

```typescript
// HOME isolation (avoid polluting ~/.omp/agent/registry.json)
const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-"));
const savedHome = process.env.HOME;
process.env.HOME = isolatedHome;
afterEach(async () => {
  process.env.HOME = savedHome;          // restore BEFORE rm
  await fs.rm(isolatedHome, { recursive: true, force: true });
});
```

- Save + restore `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` in `afterEach` if touched.
- Use `Bun.sleep()` + `Promise.race` with timeout for hang detection in PTY/shell tests.
- Never use long-lived file-wide mutations of globals (`Bun.*`, `process.platform`, `process.env`). Use per-test `vi.spyOn(...)` with immediate restoration.

### Gateway pipeline testing

Gateway features (image pipeline, card rendering, streaming) MUST be tested with the fake RPC pattern — bypass the real LLM entirely. This is fast, deterministic, and doesn't depend on agent prompt compliance.

Pattern: write a fake `omp --mode rpc` script that emits synthetic agent events (text deltas, tool calls, agent_end), spawn a real `AgentBridge` with the fake script as `ompPath`, call `DingTalkChannel.streamCard` directly. The card is delivered to a real DingTalk user via real API.

Reference implementation: `packages/pi-gateway/src/test-longtask.ts` (long-task watcher test).

Steps:
1. Write a fake RPC script that emits the agent response you want to test (e.g. text containing `![](https://...)` for image pipeline)
2. Create `AgentBridge` with `ompPath` pointing to the fake script
3. Create `DingTalkChannel` with real config from `~/.omp/gateway.json`
4. Build synthetic `InboundMessage` + `SessionRecord`
5. Call `channel.streamCard(inbound, session, context, submit)`
6. Verify the card was delivered (check DingTalk, check logs, or assert on `streamCard` return)

This tests the full gateway pipeline (bridge → streamCard → card creation → API delivery) without LLM variance.
### Running tests

```bash
bun test path/to/file.test.ts          # single file (preferred for changes you made)
bun test:ts                            # all workspaces (--only-failures: only failing rerun)
bun test:rs                            # Rust (skips if no .rs changed locally)
bun run ci:test:smoke                  # CLI smoke (--version, --help, stats --help)
E2E=1 bun test path/to/file.test.ts    # opt into real-provider tests
```

Coverage is not enforced (no `bunfig.toml` coverage config).

### CI pipeline (`.github/workflows/ci.yml`)

Single workflow, triggered on push to `main`, `v*` tags, PRs, and manual dispatch:

1. **check** — biome + tsgo (ubuntu, no Rust).
2. **native** — matrix build of `pi-natives` for 5 OS/arch targets on tags (linux-x64 baseline+modern, linux-arm64, macOS x64/arm64, Windows); just linux-x64 on PRs.
3. **test** — full `ci:test:full` + `ci:test:smoke`, installs system deps (cairo, pango, fd, ripgrep, imagemagick).
4. **install_methods** — binary / source-link / tarball install smoke via `scripts/install-tests/run-ci.sh`.
5. **release_binary** (tags only) — cross-compile `omp` for 5 targets, smoke-run in isolated HOME.
6. **release** (tags only) — verify natives, build archives, GitHub Release, npm publish (7 packages in dep order).

## Documentation

`docs/` contains 50+ design and runtime docs. Key topics:

- **Runtime**: `session.md`, `memory.md`, `models.md`, `environment-variables.md`, `config-usage.md`, `compaction.md`, `secrets.md`
- **Tools**: `custom-tools.md`, `bash-tool-runtime.md`, `resolve-tool-runtime.md`, `notebook-tool-runtime.md`, `python-repl.md`
- **Extensibility**: `extensions.md`, `extension-loading.md`, `hooks.md`, `skills.md`, `marketplace.md`, `mcp-config.md`, `mcp-*.md`
- **Natives**: `natives-architecture.md`, `natives-binding-contract.md`, `natives-addon-loader-runtime.md`, `natives-build-release-debugging.md`
- **Architecture deep-dive**: `packages/coding-agent/DEVELOPMENT.md` (~1189 lines) — boot sequence, full `src/` tree, orchestration internals.
- **Self-evolution**: `omp-evolution-architecture-v{2,2.1,3}.md`, `docs/superpowers/`
- **Gateway**: `hermes-gateway-cron-architecture.md`, `cron-decoupling-design.md`, `packages/pi-gateway/docs/`
- **L4 Synapse**: `l4-evolution-architecture.md` (root, Chinese), `packages/cognitive-coordination/README.md`

## Changelog & Release

Each package has its own `packages/*/CHANGELOG.md`. Format under `## [Unreleased]`:

- `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Breaking Changes`
- Attribution: internal issues `([#123](https://github.com/can1357/oh-my-pi/issues/123))`, external PRs `([#456](.../pull/456) by [@user](...))`
- New entries always go under `## [Unreleased]`. Released version sections are immutable.

**Release flow** (`scripts/release.ts`):

1. Add entries to `## [Unreleased]` in affected `packages/*/CHANGELOG.md`.
2. Run `bun scripts/release.ts X.Y.Z` (must be on `main`, clean tree, version > latest tag).
3. Script: bumps all `package.json` + root catalog `@oh-my-pi/*` + `Cargo.toml`, finalizes CHANGELOGs (`## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`), runs `bun run check`, commits `chore: bump version to X.Y.Z`, tags `vX.Y.Z`, pushes.
4. CI builds natives + binaries, creates GitHub Release, publishes 7 packages to npm.
5. `bun scripts/release.ts watch` — polls CI status, tails failed job logs.

## User Data Directory

Default: `~/.omp/` (override with `PI_CODING_AGENT_DIR`).

```
~/.omp/
  agent/
    config.yml                 # user settings
    models.yml                 # model preferences
    sessions/                  # JSONL session logs (by-date/<YYYY-MM-DD>/ layout)
    memories/                  # memory protocol store
    agents/                    # agent registry
    auth.db                    # OAuth/API credentials
    skills/                    # unified skills dir
    extensions/                # installed extensions
    logs/omp.YYYY-MM-DD.log    # rotating logs
  self-evolution/
    evolution.db               # SQLite: episodes, skills, workflow patterns, nudges
```

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **oh-my-pi** (37937 symbols, 94845 relationships, 234 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/oh-my-pi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/oh-my-pi/clusters` | All functional areas |
| `gitnexus://repo/oh-my-pi/processes` | All execution flows |
| `gitnexus://repo/oh-my-pi/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
