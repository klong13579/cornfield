# Custom Tool Authoring

> 状态：已实施
> 合并自：`custom-tools.md`（工厂 API / CustomToolAPI / 工具管线）+ `mcp-server-tool-authoring.md`（MCP server 与 tool 编写）

Custom tools are model-callable functions that plug into the same tool execution pipeline as built-in tools.

A custom tool is a TypeScript/JavaScript module that exports a factory. The factory receives a host API (`CustomToolAPI`) and returns one tool or an array of tools.

## What this is (and is not)

- **Custom tool**: callable by the model during a turn (`execute` + TypeBox schema).
- **Extension**: lifecycle/event framework that can register tools and intercept/modify events.
- **Hook**: external pre/post command scripts.
- **Skill**: static guidance/context package, not executable tool code.

If you need the model to call code directly, use a custom tool.

## Integration paths in current code

There are two active integration styles:

1. **SDK-provided custom tools** (`options.customTools`)
   - Wrapped into agent tools via `CustomToolAdapter` or extension wrappers.
   - Always included in the initial active tool set in SDK bootstrap.

2. **Filesystem-discovered modules via loader API** (`discoverAndLoadCustomTools` / `loadCustomTools`)
   - Exposed as library APIs in `src/extensibility/custom-tools/loader.ts`.
   - Host code can call these to discover and load tool modules from config/provider/plugin paths.

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + custom tool adapters)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## Discovery locations (loader API)

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` merges:

1. Capability providers (`toolCapability`), including:
   - Native CornField config (`~/.cornfield/agent/tools`, `.cornfield/tools`)
   - Claude config (`~/.claude/tools`, `.claude/tools`)
   - Codex config (`~/.codex/tools`, `.codex/tools`)
   - Claude marketplace plugin cache provider
2. Installed plugin manifests (`~/.cornfield/plugins/node_modules/*` via plugin loader)
3. Explicit configured paths passed to the loader

### Important behavior

- Duplicate resolved paths are deduplicated.
- Tool name conflicts are rejected against built-ins and already-loaded custom tools.
- `.md` and `.json` files are discovered as tool metadata by some providers, but the executable module loader rejects them as runnable tools.
- Relative configured paths are resolved from `cwd`; `~` is expanded.

## Module contract

A custom tool module must export a function (default export preferred):

```ts
import type { CustomToolFactory } from "@cornfield/coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.typebox.Type.Object({
    glob: pi.typebox.Type.Optional(
      pi.typebox.Type.String({ default: "**/*.ts" }),
    ),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

Factory return type:

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## API surface passed to factories (`CustomToolAPI`)

From `types.ts` and `loader.ts`:

- `cwd`: host working directory
- `exec(command, args, options?)`: process execution helper
- `ui`: UI context (can be no-op in headless modes)
- `hasUI`: `false` in non-interactive flows
- `logger`: shared file logger
- `typebox`: injected `@sinclair/typebox`
- `pi`: injected `@cornfield/coding-agent` exports
- `pushPendingAction(action)`: register a preview action for hidden `resolve` tool (see docs/tools/resolve-tool-runtime.md)

Loader starts with a no-op UI context and requires host code to call `setUIContext(...)` when real UI is ready.

## Execution contract and typing

`CustomTool.execute` signature:

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` is statically typed from your TypeBox schema via `Static<TParams>`.
- Runtime argument validation happens before execution in the agent loop.
- `onUpdate` emits partial results for UI streaming.
- `ctx` includes session/model state and an `abort()` helper.
- `signal` carries cancellation.

`CustomToolAdapter` bridges this to the agent tool interface and forwards calls in the correct argument order.

## How tools are exposed to the model

- Tools are wrapped into `AgentTool` instances (`CustomToolAdapter` or extension wrappers).
- They are inserted into the session tool registry by name.
- In SDK bootstrap, custom and extension-registered tools are force-included in the initial active set.
- CLI `--tools` currently validates only built-in tool names; custom tool inclusion is handled through discovery/registration paths and SDK options.

## Rendering hooks

Optional rendering hooks:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

Runtime behavior in TUI:

- If hooks exist, tool output is rendered inside a `Box` container.
- `renderResult` receives `{ expanded, isPartial, spinnerFrame? }`.
- Renderer errors are caught and logged; UI falls back to default text rendering.

## Session/state handling

Optional `onSession(event, ctx)` receives session lifecycle events, including:

- `start`, `switch`, `branch`, `tree`, `shutdown`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`, `todo_reminder`

Use `ctx.sessionManager` to reconstruct state from history when branch/session context changes.

## Failures and cancellation semantics

### Synchronous/async failures

- Throwing (or rejected promises) in `execute` is treated as tool failure.
- Agent runtime converts failures into tool result messages with `isError: true` and error text content.
- With extension wrappers, `tool_result` handlers can further rewrite content/details and even override error status.

### Cancellation

- Agent abort propagates through `AbortSignal` to `execute`.
- Forward `signal` to subprocess work (`pi.exec(..., { signal })`) for cooperative cancellation.
- `ctx.abort()` lets a tool request abort of the current agent operation.

### onSession errors

- `onSession` errors are caught and logged as warnings; they do not crash the session.

## Real constraints to design for

- Tool names must be globally unique in the active registry.
- Prefer deterministic, schema-shaped outputs in `details` for renderer/state reconstruction.
- Guard UI usage with `pi.hasUI`.
- Treat `.md`/`.json` in tool directories as metadata, not executable modules.

## MCP server and tool authoring

How MCP server definitions become callable `mcp__*` tools in coding-agent, and what operators should expect when configs are invalid, duplicated, disabled, or auth-gated.

## Architecture at a glance

```text
Config sources (.cornfield/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> capability loader dedupes by server name (higher provider priority wins)
  -> loadAllMCPConfigs converts to MCPServerConfig + skips enabled:false
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) Server config model and validation

`src/mcp/types.ts` defines the authoring shape used by MCP config writers and runtime:

- `stdio` (default when `type` missing): requires `command`, optional `args`, `env`, `cwd`
- `http`: requires `url`, optional `headers`
- `sse`: requires `url`, optional `headers` (kept for compatibility)
- shared fields: `enabled`, `timeout`, `auth`, `oauth`

`validateServerConfig()` (`src/mcp/config.ts`) enforces transport basics:

- rejects configs that set both `command` and `url`
- requires `command` for stdio
- requires `url` for http/sse
- rejects unknown `type`

`config-writer.ts` applies this validation for add/update operations and also validates server names:

- non-empty
- max 100 chars
- only `[a-zA-Z0-9_.-]`

### Transport pitfalls

- `type` omitted means stdio. If you intended HTTP/SSE but omitted `type`, `command` becomes mandatory.
- `sse` is still accepted but treated as HTTP transport internally (`createHttpTransport`).
- Validation is structural, not reachability: a syntactically valid URL can still fail at connect time.

## 2) Discovery, normalization, and precedence

### Capability-based discovery

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical `MCPServer` items via `loadCapability(mcpCapability.id)`.

The capability layer (`src/capability/index.ts`) then:

1. loads providers in priority order
2. dedupes by `server.name` (first win = highest priority)
3. validates deduped items

Result: duplicate server names across sources are not merged. One definition wins; lower-priority duplicates are shadowed.

### `.mcp.json` and related files

The dedicated fallback provider in `src/discovery/mcp-json.ts` reads project-root `mcp.json` and `.mcp.json` (low priority).

In practice MCP servers also come from higher-priority providers (for example native `.cornfield/...` and tool-specific config dirs). Authoring guidance:

- Prefer `.cornfield/mcp.json` (project) or `~/.cornfield/agent/mcp.json` (user) for explicit control.
- Use root `mcp.json` / `.mcp.json` when you need fallback compatibility.
- Reusing the same server name in multiple sources causes precedence shadowing, not merge.

### Normalization behavior

`convertToLegacyConfig()` (`src/mcp/config.ts`) maps canonical `MCPServer` to runtime `MCPServerConfig`.

Key behavior:

- transport inferred as `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`
- disabled servers (`enabled === false`) are dropped before connection
- optional fields are preserved when present

### Environment expansion during discovery

`mcp-json.ts` expands env placeholders in string fields with `expandEnvVarsDeep()`:

- supports `${VAR}` and `${VAR:-default}`
- unresolved values remain literal `${VAR}` strings

`mcp-json.ts` also performs runtime type checks for user JSON and logs warnings for invalid `enabled`/`timeout` values instead of hard-failing the whole file.

## 3) Auth and runtime value resolution

`MCPManager.prepareConfig()`/`#resolveAuthConfig()` (`src/mcp/manager.ts`) is the final pre-connect pass.

### OAuth credential injection

If config has:

```ts
auth: { type: "oauth", credentialId: "..." }
```

and credential exists in auth storage:

- `http`/`sse`: injects `Authorization: Bearer <access_token>` header
- `stdio`: injects `OAUTH_ACCESS_TOKEN` env var

If credential lookup fails, manager logs a warning and continues with unresolved auth.

### Header/env value resolution

Before connect, manager resolves stdio `env` values and HTTP/SSE `headers` values via `resolveConfigValue()` (`src/config/resolve-config-value.ts`):

- value starting with `!` => execute shell command, use trimmed stdout (cached)
- failed, timed-out, or whitespace-only commands produce `undefined`, so that entry is omitted
- otherwise, treat value as environment variable name first (`process.env[name]`), fallback to literal value

Operational caveat: a mistyped `!` secret command can silently remove that header/env entry, producing downstream 401/403 or server startup failures. A mistyped environment variable name is sent literally unless that literal happens to be meaningful to the server.

## 4) Tool bridge: MCP -> agent-callable tools

`src/mcp/tool-bridge.ts` converts MCP tool definitions into `CustomTool`s.

### Naming and collision domain

Tool names are generated as:

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

Rules:

- lowercases
- non-`[a-z_]` chars become `_`
- repeated underscores collapse
- redundant `<server>_` prefix in tool name is stripped once

This avoids many collisions, but not all. Different raw names can still sanitize to the same identifier (for example `my-server` and `my.server` both sanitize similarly), and registry insertion is last-write-wins.

### Schema mapping

`tool-bridge.ts` passes each MCP `inputSchema` through `sanitizeSchemaForMCP()` before registering it as a `CustomTool` schema.

### Execution mapping

`MCPTool.execute()` / `DeferredMCPTool.execute()`:

- calls MCP `tools/call`
- flattens MCP content into displayable text
- returns structured details (`serverName`, `mcpToolName`, provider metadata)
- maps server-reported `isError` to `Error: ...` text result
- attempts reconnect + one retry for retriable connection errors
- maps remaining thrown transport/runtime failures to `MCP error: ...`
- preserves abort semantics by translating AbortError into `ToolAbortError`

## 5) Operator lifecycle: add/edit/remove and live updates

Interactive mode exposes `/mcp` in `src/modes/controllers/mcp-command-controller.ts`.

Supported operations:

- `add` (wizard or quick-add)
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`, `prompts`, `notifications`
- Smithery search/login/logout flows

Config writes are atomic (`writeMCPConfigFile`: temp file + rename).

After changes, controller calls `#reloadMCP()`:

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` replaces all `mcp__` registry entries and immediately re-activates the latest MCP tool set, so changes take effect without restarting the session.

### Mode differences

- **Interactive/TUI mode**: `/mcp` gives in-app UX (wizard, OAuth flow, connection status text, immediate runtime rebinding).
- **SDK/headless integration**: `discoverAndLoadMCPTools()` (`src/mcp/loader.ts`) returns loaded tools + per-server errors; no `/mcp` command UX.

## 6) User-visible error surfaces

Common error strings users/operators see:

- add/update validation failures:
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- quick-add argument issues:
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- connect/test failures:
  - `Failed to connect to "<name>": <message>`
  - timeout help text suggests increasing timeout
  - auth help text for `401/403`
- auth/OAuth flows:
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- disabled server usage:
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

Bad source JSON in discovery is generally handled as warnings/logs; config-writer paths throw explicit errors.

## 7) Practical authoring guidance

For robust MCP authoring in this codebase:

1. Keep server names globally unique across all MCP-capable config sources.
2. Prefer names that remain distinct after MCP tool-name sanitization to avoid generated `mcp__` collisions.
3. Use explicit `type` to avoid accidental stdio defaults.
4. Treat `enabled: false` as hard-off: server is omitted from runtime connect set.
5. For OAuth configs, store a valid `credentialId`; otherwise auth injection is skipped.
6. If using command-based secret resolution (`!cmd`), verify command output is stable and non-empty.

## Implementation files

- `src/mcp/types.ts` — MCP server authoring shape and JSON-RPC message types
- `src/mcp/config.ts` — validation, discovery normalization
- `src/mcp/config-writer.ts` — atomic config writes
- `src/mcp/tool-bridge.ts` — MCP -> CustomTool bridge
- `src/discovery/mcp-json.ts` — standalone `mcp.json` / `.mcp.json` provider
- `src/modes/controllers/mcp-command-controller.ts` — `/mcp` operator UX
- `src/mcp/manager.ts` — connect/list with auth/header/env resolution
- `src/capability/index.ts` — capability dedupe/precedence
- `src/config/resolve-config-value.ts` — `!cmd` / env-var / literal resolution
- `src/mcp/loader.ts` — `discoverAndLoadMCPTools` SDK facade
- `src/extensibility/custom-tools/loader.ts` — custom tool discovery/loading entry points