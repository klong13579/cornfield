# Extensions

> 状态：已实施
> 合并自：`extensions.md` + `extension-loading.md`

Primary guide for authoring runtime extensions in `packages/coding-agent`.

This document covers the current extension runtime:

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/loader.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`
- `src/discovery/builtin.ts` (native auto-discovery provider)
- `src/config/settings.ts` (merged `extensions` / `disabledExtensions` settings)

This document covers both halves of the extension system: the runtime model and authoring surface (below), and the startup discovery/loading of `.ts`/`.js` extension modules ([Module discovery and loading](#module-discovery-and-loading)). `gemini-extension.json` manifest extensions are documented separately in [docs/extend/gemini-manifest.md](./gemini-manifest.md).

## What an extension is

An extension is a TS/JS module exporting a default factory:

```ts
import type { ExtensionAPI } from "@cornfield/coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

Extensions can combine all of the following in one module:

- event handlers (`pi.on(...)`)
- LLM-callable tools (`pi.registerTool(...)`)
- slash commands (`pi.registerCommand(...)`)
- keyboard shortcuts and flags
- custom message rendering
- session/message injection APIs (`sendMessage`, `sendUserMessage`, `appendEntry`)

## Runtime model

1. Extensions are imported and their factory functions run.
2. During that load phase, registration methods are valid; runtime action methods are not yet initialized.
3. `ExtensionRunner.initialize(...)` wires live actions/contexts for the active mode.
4. Session/agent/tool lifecycle events are emitted to handlers.
5. Every tool execution is wrapped with extension interception (`tool_call` / `tool_result`).

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import module + run factory (registration only)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

Important constraint from `loader.ts`:

- calling action methods like `pi.sendMessage()` during extension load throws `ExtensionRuntimeNotInitializedError`
- register first; perform runtime behavior from events/commands/tools

## Quick start

```ts
import type { ExtensionAPI } from "@cornfield/coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## Extension API surfaces

### 1) Registration and actions (`ExtensionAPI`)

Core methods:

- `on(event, handler)`
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`
- `registerMessageRenderer`
- `sendMessage`, `sendUserMessage`, `appendEntry`
- `getActiveTools`, `getAllTools`, `setActiveTools`
- `getSessionName`, `setSessionName`
- `setModel`, `getThinkingLevel`, `setThinkingLevel`
- `registerProvider`
- `events` (shared event bus)

In interactive mode, `input` handlers run before the built-in first-message auto-title check. Extensions that call `await pi.setSessionName(...)` from `input` can set the persisted session name and prevent the default auto-generated title from running for that session.

Also exposed:

- `pi.logger`
- `pi.typebox`
- `pi.pi` (package exports)

#### Message delivery semantics

`pi.sendMessage(message, options)` supports:

- `deliverAs: "steer"` (default) — interrupts current run
- `deliverAs: "followUp"` — queued to run after current run
- `deliverAs: "nextTurn"` — stored and injected on the next user prompt
- `triggerTurn: true` — starts a turn when idle (`nextTurn` ignores this)

`pi.sendUserMessage(content, { deliverAs })` always goes through prompt flow; while streaming it queues as steer/follow-up.

### 2) Handler context (`ExtensionContext`)

Handlers and tool `execute` receive `ctx` with:

- `ui`
- `hasUI`
- `cwd`
- `sessionManager` (read-only)
- `modelRegistry`, `model`
- `getContextUsage()`
- `compact(...)`
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `getSystemPrompt()`

### 3) Command context (`ExtensionCommandContext`)

Command handlers additionally get:

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

Use command context for session-control flows; these methods are intentionally separated from general event handlers.

## Event surface (current names and behavior)

Canonical event unions and payload types are in `types.ts`.

### Session lifecycle

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

Cancelable pre-events:

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

### Prompt and turn lifecycle

- `input`
- `before_agent_start`
- `context`
- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`

### Tool lifecycle

- `tool_call` (pre-exec, may block)
- `tool_result` (post-exec, may patch content/details/isError)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end` (observability)

`tool_result` is middleware-style: handlers run in extension order and each sees prior modifications.

### Reliability/runtime signals

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### User command interception

- `user_bash` (override with `{ result }`)
- `user_python` (override with `{ result }`)

### `resources_discover`

`resources_discover` exists in extension types and `ExtensionRunner`.
Current runtime note: `ExtensionRunner.emitResourcesDiscover(...)` is implemented, but there are no `AgentSession` callsites invoking it in the current codebase.

## Tool authoring details

`registerTool` uses `ToolDefinition` from `types.ts`.

Current `execute` signature:

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

Template:

```ts
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: Type.Object({}),
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

`tool_call`/`tool_result` intercept all tools once the registry is wrapped in `sdk.ts`, including built-ins and extension/custom tools.

## UI integration points

`ctx.ui` implements the `ExtensionUIContext` interface. Support differs by mode.

### Interactive mode (`extension-ui-controller.ts`)

Supported:

- dialogs: `select`, `confirm`, `input`, `editor`
- notifications/status/editor text/terminal input/custom overlays
- theme listing/loading by name (`setTheme` supports string names)
- tools expanded toggle

Current no-op methods in this controller:

- `setFooter`
- `setHeader`
- `setEditorComponent`

Also note: `setWidget` currently routes to status-line text via `setHookWidget(...)`.

### RPC mode (`rpc-mode.ts`)

`ctx.ui` is backed by RPC `extension_ui_request` events:

- dialog methods (`select`, `confirm`, `input`, `editor`) round-trip to client responses
- fire-and-forget methods emit requests (`notify`, `setStatus`, `setWidget` for string arrays, `setTitle`, `setEditorText`)

Unsupported/no-op in RPC implementation:

- `onTerminalInput`
- `custom`
- `setFooter`, `setHeader`, `setEditorComponent`
- `setWorkingMessage`
- theme switching/loading (`setTheme` returns failure)
- tool expansion controls are inert

### Print/headless/subagent paths

When no UI context is supplied to runner init, `ctx.hasUI` is `false` and methods are no-op/default-returning.

### Background interactive mode

Background mode installs a non-interactive UI context object. In current implementation, `ctx.hasUI` may still be `true` while interactive dialogs return defaults/no-op behavior.

## Session and state patterns

For durable extension state:

1. Persist with `pi.appendEntry(customType, data)`.
2. Rebuild state from `ctx.sessionManager.getBranch()` on `session_start`, `session_branch`, `session_tree`.
3. Keep tool result `details` structured when state should be visible/reconstructible from tool result history.

Example reconstruction pattern:

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

## Rendering extension points

### Custom message renderer

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return tui Component
});
```

Used by interactive rendering when custom messages are displayed.

### Tool call/result renderer

Provide `renderCall` / `renderResult` on `registerTool` definitions for custom tool visualization in TUI.

## Constraints and pitfalls

- Runtime actions are unavailable during extension load.
- `tool_call` errors block execution (fail-closed).
- Command name conflicts with built-ins are skipped with diagnostics.
- Reserved shortcuts are ignored (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).
- Treat `ctx.reload()` as terminal for the current command handler frame.

## Extensions vs hooks vs custom-tools

Use the right surface:

- **Extensions** (`src/extensibility/extensions/*`): unified system (events + tools + commands + renderers + provider registration).
- **Hooks** (`src/extensibility/hooks/*`): separate legacy event API.
- **Custom-tools** (`src/extensibility/custom-tools/*`): tool-focused modules; when loaded alongside extensions they are adapted and still pass through extension interception wrappers.

If you need one package that owns policy, tools, command UX, and rendering together, use extensions.

## Module discovery and loading

How the coding agent discovers and loads **extension modules** (`.ts`/`.js`) at startup. (`gemini-extension.json` manifest extensions are covered in [docs/extend/gemini-manifest.md](./gemini-manifest.md).)

The loading subsystem builds a list of module entry files, imports each module with Bun, executes its factory, and returns:

- loaded extension definitions
- per-path load errors (without aborting the whole load)
- a shared extension runtime object used later by `ExtensionRunner`

### Inputs to extension loading

#### 1) Auto-discovered native extension modules

`discoverAndLoadExtensions()` first asks discovery providers for `extension-module` capability items, then keeps only provider `native` items.

Effective native locations:

- Project: `<cwd>/.cornfield/extensions`
- User: `~/.cornfield/agent/extensions`

Path roots come from the native provider (`SOURCE_PATHS.native`).

Notes:

- Native auto-discovery is currently `.cornfield` based.
- Legacy `.pi` is still accepted in `package.json` manifest keys (`pi.extensions`), but not as a native root here.

#### 2) Installed plugin extension entries

After native auto-discovery, `discoverAndLoadExtensions()` appends extension entry points from enabled installed plugins via `getAllPluginExtensionPaths(cwd)`.

Plugin extension entries come from package `cornfield.extensions` / `pi.extensions` manifests, including enabled feature entries.

#### 3) Explicitly configured paths

After plugin extension entries, configured paths are appended and resolved.

Configured path sources in the main session startup path (`sdk.ts`):

1. CLI-provided paths (`--extension/-e`, and `--hook` is also treated as an extension path)
2. Settings `extensions` array (merged global + project settings)

Global settings file:

- `~/.cornfield/agent/config.yml` (or custom agent dir via `CORNFIELD_CODING_AGENT_DIR`)

Project settings file:

- `<cwd>/.cornfield/settings.json`

Examples:

```yaml
# ~/.cornfield/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.cornfield/extensions/my-extra"]
}
```

### Enable/disable controls

Disable discovery:

- CLI: `--no-extensions`
- SDK option: `disableExtensionDiscovery`

Behavior split:

- SDK: when `disableExtensionDiscovery=true`, it still loads `additionalExtensionPaths` via `loadExtensions()`.
- CLI path building (`main.ts`) currently clears CLI extension paths when `--no-extensions` is set, so explicit `-e/--hook` are not forwarded in that mode.

Disable specific extension modules:

`disabledExtensions` setting filters by extension id format:

- `extension-module:<derivedName>`

`derivedName` is based on entry path (`getExtensionNameFromPath`), for example:

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

Example:

```yaml
disabledExtensions:
  - extension-module:foo
```

### Path and entry resolution

Path normalization (for configured paths):

1. Normalize unicode spaces
2. Expand `~`
3. If relative, resolve against current `cwd`

If configured path is a file, it is used directly as a module entry candidate.

If configured path is a directory, resolution order:

1. `package.json` in that directory with `cornfield.extensions` (or legacy `pi.extensions`) -> use declared entries
2. `index.ts`
3. `index.js`
4. Otherwise scan one level for extension entries:
   - direct `*.ts` / `*.js`
   - subdir `index.ts` / `index.js`
   - subdir `package.json` with `cornfield.extensions` / `pi.extensions`

Rules and constraints:

- no recursive discovery beyond one subdirectory level
- declared `extensions` manifest entries are resolved relative to that package directory
- declared entries are included only if file exists/access is allowed
- in `*/index.{ts,js}` pairs, TypeScript is preferred over JavaScript
- symlinks are treated as eligible files/directories

Ignore behavior differs by source:

- Native auto-discovery (`discoverExtensionModulePaths` in discovery helpers) uses native glob with `gitignore: true` and `hidden: false`.
- Explicit configured directory scanning in `loader.ts` uses `readdir` rules and does **not** apply gitignore filtering.

### Load order and precedence

`discoverAndLoadExtensions()` builds one ordered list and then calls `loadExtensions()`.

Order:

1. Native auto-discovered modules
2. Installed plugin extension entries
3. Explicit configured paths (in provided order)

In `sdk.ts`, configured order is:

1. CLI additional paths
2. Settings `extensions`

De-duplication:

- absolute path based
- first seen path wins
- later duplicates are ignored

Implication: if the same module path is both auto-discovered and explicitly configured, it is loaded once at the first position (auto-discovered stage).

### Module import and factory contract

Each candidate path is loaded with dynamic import:

- `await import(resolvedPath)`
- factory is `module.default ?? module`
- factory must be a function (`ExtensionFactory`)

If export is not a function, that path fails with a structured error and loading continues.

### Failure handling and isolation

During loading:

- per extension path, failures are captured as `{ path, error }` and do not stop other paths from loading
- common cases: import failure / missing file; invalid factory export (non-function); exception thrown while executing factory

Runtime isolation model:

- Extensions are **not sandboxed** (same process/runtime).
- They share one `EventBus` and one `ExtensionRuntime` instance.
- During load, runtime action methods intentionally throw `ExtensionRuntimeNotInitializedError`; action wiring happens later in `ExtensionRunner.initialize()`.

After loading:

- when events run through `ExtensionRunner`, handler exceptions are caught and emitted as extension errors instead of crashing the runner loop.

### Minimal user/project layout examples

User-level:

```text
~/.cornfield/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

Project-level:

```text
<repo>/
  .cornfield/
    settings.json
    extensions/
      checks/
        package.json
      lint-gates.ts
```

`checks/package.json`:

```json
{
  "cornfield": {
    "extensions": ["./src/check-a.ts", "./src/check-b.js"]
  }
}
```

Legacy manifest key still accepted:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```