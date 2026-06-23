# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool that uses Claude—questions about its behavior refer to the code in `packages/coding-agent/`, not your current session.

### Repository map

Use this when landing in an unfamiliar area: pick the package, then open the paths below.

- **Runnable entry**: `packages/coding-agent/src/cli.ts` (local dev is often `bun packages/coding-agent/src/cli.ts`; interactive verification in tmux — see Interactive Testing).
- **Bundled prompts and agent copy**: `packages/coding-agent/src/prompts/` — static `.md` (and Handlebars where already used). Never inline prompt strings in TypeScript (see Code Quality).
- **End-user behavior** (flags, subcommands, sessions, settings): [README.md](README.md) — sections Usage, Configuration, CLI Reference, Sessions.
- **Deep topics**: `docs/` (session format, memory, models, environment variables, custom tools, etc.).
- **Evolution / episodic / conventions pipeline**: `packages/self-evolution/`; high-level flow in root `ARCHITECTURE.md`.
- **Other workspace packages** (e.g. `packages/swarm-extension/`, `packages/pi-gateway/`, `packages/typescript-edit-benchmark/`): treat as their own surfaces; follow code and local docs in that folder.

### Packages (roles and typical edits)

| Package | Role | Typical edits |
| ------- | ---- | ------------- |
| `packages/coding-agent` | Main terminal CLI, TUI, tools, modes, session UX | Tools, slash commands, model selector, event/render paths, user-visible workflows |
| `packages/ai` | Multi-provider LLM client, streaming, OAuth helpers | Providers, transport, resolver/descriptor logic — not hand-editing `models.json` (see Generated Files) |
| `packages/agent` | Agent runtime, tool calling, state | Message/tool loop, session integration with `coding-agent` |
| `packages/tui` | Differential terminal UI, layout helpers | Components, truncation/sanitization helpers consumed by the CLI |
| `packages/natives` | JS bindings for native text/image/grep | Bridge to `crates/pi-natives` |
| `packages/stats` | Local observability (`omp stats`) | Stats UI and embedded client |
| `packages/utils` | Shared utilities (logger, streams, temp files) | Cross-package helpers (`logger`, `isEnoent`, etc.) |
| `packages/self-evolution` | Evolution DB, convention mining, episodic storage | SQLite layout, watchers, commands that sync evolution state |
| `packages/cognitive-coordination` | Coordination registry / shared orchestration types | Features that span sessions or agent coordination |
| `crates/pi-natives` | Rust performance-critical text and grep | Native performance or capability gaps |

## Code Quality

- No `any` types unless absolutely necessary
- Prefer `export * from "./module"` over named re-export-from blocks, including `export type { ... } from`. In pure `index.ts` barrel files (re-exports only), use star re-exports even for single-specifier cases. If star re-exports create symbol ambiguity, remove the redundant export path instead of keeping duplicate exports.
- **No `private`/`protected`/`public` keyword on class fields or methods** — use ES native `#` private fields for encapsulation; leave members that need external access as bare (no keyword). The only place `private`/`protected`/`public` is allowed is on **constructor parameter properties** (e.g., `constructor(private readonly session: ToolSession)`), where TypeScript requires the keyword for the implicit field declaration.

  ```typescript
  // BAD: TypeScript keyword privacy
  class Foo {
      private bar: string;
      private _baz = 0;
      protected qux(): void { ... }
      public greet(): void { ... }
  }

  // GOOD: ES native # for private, bare for accessible
  class Foo {
      #bar: string;
      #baz = 0;
      qux(): void { ... }
      greet(): void { ... }
  }

  // OK: constructor parameter properties keep the keyword
  class Service {
      constructor(private readonly session: ToolSession) {}
  }
  ```

- **NEVER use `ReturnType<>`** — it obscures types behind indirection. Use the actual type name instead. Look up return types in source or `node_modules` type definitions and reference them directly.

  ```typescript
  // BAD: Indirection through ReturnType
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stmt: ReturnType<Database["prepare"]>;
  let stat: Awaited<ReturnType<typeof fs.stat>>;

  // GOOD: Use the actual type
  let timer?: NodeJS.Timeout;
  let stmt: Statement;
  let stat: Stats;
  ```

  If a function's return type has no exported name, define a named type alias at the call site — don't use `ReturnType<>`.

- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- **NEVER build prompts in code** — no inline strings, no template literals, no string concatenation. Prompts live in static `.md` files; use Handlebars for any dynamic content.
- **Import static text files via Bun** — use `import content from "./prompt.md" with { type: "text" }` instead of `readFileSync`
- **Use `Promise.withResolvers()`** instead of `new Promise((resolve, reject) => ...)` — cleaner, avoids callback nesting, and the resolver functions are properly typed:

  ```typescript
  // BAD: Verbose, callback nesting
  const promise = new Promise<string>((resolve, reject) => { ... });

  // GOOD: Clean destructuring, typed resolvers
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  ```

## Bun Over Node

This project uses Bun. Use Bun APIs where they provide a cleaner alternative; use `node:fs` for operations Bun doesn't cover.

**NEVER spawn shell commands for operations that have proper APIs** (e.g., `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync` instead).

### Process Execution

**Prefer Bun Shell** (`$` template literals) for simple commands:

```typescript
import { $ } from "bun";

// Capture output
const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

// Fire and forget
$`do-stuff ${tmpFile}`.quiet().nothrow();
```

**Use `Bun.spawn`/`Bun.spawnSync`** only when:

- Long-running processes (LSP servers, Python kernels)
- Streaming stdin/stdout/stderr required (SSE, JSON-RPC)
- Process control needed (signals, kill, complex lifecycle)

**Bun Shell methods:**

- `.quiet()` - suppress output (stdout/stderr to null)
- `.nothrow()` - don't throw on non-zero exit
- `.text()` - get stdout as string
- `.cwd(path)` - set working directory

### Sleep

**Prefer** `await Bun.sleep(ms)`  
**Avoid** `new Promise((resolve) => setTimeout(resolve, ms))`

### Node Module Imports

**NEVER use named imports from `node:fs` or `node:path`** — always use namespace imports:

```typescript
// BAD: Named imports
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// GOOD: Namespace imports
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Then use: fs.readdir(), path.join(), etc.
```

**Choosing between `node:fs` and `node:fs/promises`:**

- **Async-only file** → `import * as fs from "node:fs/promises"`
- **Needs both sync and async** → `import * as fs from "node:fs"`, use `fs.promises.xxx` for async

### File I/O

**Prefer Bun file APIs:**

```typescript
// Read
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();

// Write
await Bun.write(path, data);
```

**`Bun.write()` is smart** — it auto-creates parent directories and uses optimal syscalls:

```typescript
// BAD: Redundant mkdir before write
await mkdir(dirname(path), { recursive: true });
await Bun.write(path, data);

// GOOD: Bun.write handles it
await Bun.write(path, data); // Creates parent dirs automatically
```

**Use `node:fs/promises`** for directories (Bun has no native directory APIs):

```typescript
import * as fs from "node:fs/promises";

await fs.mkdir(path, { recursive: true });
await fs.rm(path, { recursive: true, force: true });
const entries = await fs.readdir(path);
```

**Avoid sync APIs** in async flows:

- Don't use `existsSync`/`readFileSync`/`writeFileSync` when async is possible
- Use sync only when required by a synchronous interface

### File I/O Anti-Patterns

**NEVER check `.exists()` before reading** — use try-catch with error code:

```typescript
// BAD: Two syscalls, race condition
if (await Bun.file(path).exists()) {
	return await Bun.file(path).json();
}

// GOOD: One syscall, atomic, type-safe error handling
import { isEnoent } from "@oh-my-pi/pi-utils";

try {
	return await Bun.file(path).json();
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

**NEVER create multiple handles to the same path**:

```typescript
// BAD: Creates two file handles
if (await Bun.file(path).exists()) {
	const content = await Bun.file(path).text();
}

// BAD: Still wasteful even in separate functions
async function checkConfig() {
	return await Bun.file(configPath).exists();
}
async function loadConfig() {
	return await Bun.file(configPath).json(); // second handle
}
```

**NEVER use `Buffer.from(await Bun.file(x).arrayBuffer())`** — just use `readFile`:

```typescript
// BAD: Unnecessary conversion
const buffer = Buffer.from(await Bun.file(path).arrayBuffer());

// GOOD: Direct buffer read
import * as fs from "node:fs/promises";
const buffer = await fs.readFile(path);
```

**NEVER mix redundant existence checks with try-catch**:

```typescript
// BAD: Existence check is pointless when you have try-catch
if (await file.exists()) {
	try {
		return await file.json();
	} catch {
		return null;
	}
}

// GOOD: Let try-catch handle missing files
try {
	return await Bun.file(path).json();
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

### Streams

**Prefer centralized helpers:**

```typescript
import { readStream, readLines } from "./utils/stream";

// Read entire stream
const text = await readStream(child.stdout);

// Line-by-line iteration
for await (const line of readLines(stream)) {
	// process line
}
```

**Avoid manual reader loops** unless protocol requires it (SSE, streaming JSON-RPC).

### JSON5 Parsing

**Use `Bun.JSON5`** — never add `json5` as a dependency:

```typescript
// BAD: External dependency
import JSON5 from "json5";
const data = JSON5.parse(text);

// GOOD: Bun builtin
const data = Bun.JSON5.parse(text);
const output = Bun.JSON5.stringify(obj);
```

### JSONL Parsing

**Use `Bun.JSONL`** — never manually split and parse:

```typescript
// BAD: Manual split + JSON.parse
const lines = text.split("\n").filter(Boolean);
const entries = lines.map((line) => JSON.parse(line));

// GOOD: Full blob parsing
const entries = Bun.JSONL.parse(text);
```

**For streaming JSONL** (SSE, JSON-RPC, subprocess output), use `Bun.JSONL.parseChunk() | Bun.JSONL.parse()` without decoding to string:

### Terminal Width and Wrapping

**Use `Bun.stringWidth()`** for display width calculations:

```typescript
// BAD: External dependency or custom implementation
import { getWidth } from "get-east-asian-width";
function visibleWidth(str: string) {
	/* custom logic */
}

// GOOD: Bun builtin (handles ANSI, emoji, CJK)
const width = Bun.stringWidth(text);
const widthNoAnsi = Bun.stringWidth(text, { countAnsiEscapeCodes: false });
```

**Use `Bun.wrapAnsi()`** for ANSI-aware text wrapping:

```typescript
// BAD: Custom ANSI-aware wrapping
function wrapTextWithAnsi(text: string, width: number) {
	/* complex SGR tracking */
}

// GOOD: Bun builtin
const wrapped = Bun.wrapAnsi(text, width, {
	wordWrap: true,
	hard: false,
	trim: true,
});
```

### Where Bun Wins

| Operation       | Use                                   | Not                             |
| --------------- | ------------------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`           | `readFileSync`, `writeFileSync` |
| Spawn process   | `$\`cmd\``, `Bun.spawn()`             | `child_process`                 |
| Sleep           | `Bun.sleep(ms)`                       | `setTimeout` promise            |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`   |
| HTTP server     | `Bun.serve()`                         | `http.createServer()`           |
| SQLite          | `bun:sqlite`                          | `better-sqlite3`                |
| Hashing         | `Bun.hash()`, Web Crypto              | `node:crypto`                   |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` dance           |
| JSON5 parsing   | `Bun.JSON5.parse()`                   | `json5` package                 |
| JSONL parsing   | `Bun.JSONL.parse()`, `.parseChunk()`  | manual split + `JSON.parse`     |
| String width    | `Bun.stringWidth()`                   | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi()`                      | custom ANSI-aware wrappers      |

### Patterns

**Subprocess streams** — cast when using pipe mode:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

**Password hashing** — built-in bcrypt/argon2:

```typescript
const hash = await Bun.password.hash("password", "bcrypt");
const valid = await Bun.password.verify("password", hash);
```

### Anti-Patterns

- `Bun.spawnSync([...])` for simple commands → use `$\`...\``
- `new Promise((resolve) => setTimeout(resolve, ms))` → use `Bun.sleep(ms)`
- `existsSync/readFileSync/writeFileSync` in async code → use `Bun.file()` APIs
- Manual `child.stdout.getReader()` loops for non-streaming commands → use `readStream()` helper
- `import JSON5 from "json5"` → use `Bun.JSON5.parse()`
- `text.split("\n").map(JSON.parse)` for JSONL → use `Bun.JSONL.parse()`
- Custom `visibleWidth()` / `get-east-asian-width` → use `Bun.stringWidth()`
- Custom ANSI-aware text wrapping → use `Bun.wrapAnsi()`

## Generated Files

**NEVER edit `packages/ai/src/models.json` directly.** It is generated from upstream sources (models.dev, provider catalog discovery, OpenCode docs) by `packages/ai/scripts/generate-models.ts` and the descriptors/resolvers in `packages/ai/src/provider-models/`. Any hand-edit will be overwritten the next time the generator runs.

To change a model entry (api type, baseUrl, cost, context, reasoning metadata, etc.), fix the source instead:

- **Resolution rules / per-id overrides** (e.g. when models.dev mislabels a model's `provider.npm` for an OpenCode-style endpoint) → edit the relevant resolver in `packages/ai/src/provider-models/openai-compat.ts` (e.g. `createOpenCodeApiResolution`'s id-override map).
- **Provider descriptors** (filtering, transforms, defaults, headers, compat overrides, per-model api resolution) → edit `packages/ai/src/provider-models/descriptors.ts` or the provider-specific descriptor in `packages/ai/src/provider-models/`.
- **Generator-level fixups** (premium multipliers, codex pricing fallback, fallback models, post-processing) → edit `packages/ai/scripts/generate-models.ts`.
- **Thinking metadata / generated policies** → edit `packages/ai/src/model-thinking.ts` (`applyGeneratedModelPolicies`).

After fixing the source, regenerate with `bun --cwd=packages/ai run generate-models` and commit the resulting `models.json` alongside the source change. Add a regression test against the resolver / descriptor (not against the bundled JSON) so the fix survives the next regeneration even if upstream metadata shifts.

## Logging

**NEVER use `console.log`, `console.error`, or `console.warn`** in the coding-agent package. Console output corrupts the TUI rendering.

Use the centralized logger instead:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation.

## TUI Rendering Sanitization

All text displayed in tool renderers must be sanitized before output. Raw content (file contents, error messages, tool output) can contain characters that break terminal rendering — tabs cause visual holes, long lines overflow, and unsanitized paths leak home directories.

### Rules

- **Tabs → spaces**: Always pass displayed text through `replaceTabs()` before rendering. Tabs produce variable-width gaps in terminals and cause visual holes in the TUI. Import from `@oh-my-pi/pi-tui` or `../tools/render-utils`.
- **Line truncation**: Truncate displayed lines with `truncateToWidth()` or `ui.truncate()` to prevent horizontal overflow. Use constants from `TRUNCATE_LENGTHS` for consistency.
- **Path shortening**: Use `shortenPath()` for file paths shown to users — replaces home directory prefix with `~`.
- **Content preview limits**: Use `PREVIEW_LIMITS` constants for collapsed/expanded line counts. Don't invent ad-hoc limits.

### Where to apply

Sanitization applies to **every** code path that renders text to the TUI, including:

- Success output (file previews, command output, search results)
- **Error messages** — these often embed file content (e.g., patch failure messages include the lines that failed to match)
- Diff content (both added/removed lines)
- Streaming previews

A common mistake is sanitizing the happy path but forgetting error paths. If a message includes file content, it needs `replaceTabs()`.

### Streaming tool previews

Streaming tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed arguments, update every path — not just the final renderer.

For the bash tool specifically:
- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed tool-call args can lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve any preview-only fields (for example `__partialJson`) when tool-call args flow through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists. The bash renderer uses call args plus render context to show the command preview while streaming, not only after output arrives.
- When changing bash preview formatting, verify both live streaming and rebuilt transcript paths. A fix in one path does not automatically fix the other.

## Commands

### End-user `omp` (installed CLI)

Shipped command is **`omp`**. Authoritative reference: [README.md — CLI Reference](README.md#cli-reference) (invocation, flags, subcommands).

- **Common patterns**: `omp` (interactive), `omp -p "…"` (non-interactive), `omp -c` / `omp -r` (session resume), `omp @file.md "…"` (file args).
- **Dedicated subcommands** (see README): `commit`, `config`, `grep`, `jupyter`, `plugin`, `search` (`q`), `setup`, `shell`, `ssh`, `stats`, `update`.
- **User data dir** (default): `~/.omp/agent/` — `config.yml`, `sessions/`, `memories/`, credentials store, etc. Override with `PI_CODING_AGENT_DIR`.
- **Logs** (coding-agent): `~/.omp/logs/omp.YYYY-MM-DD.log` (see Logging).

When answering “how do users run X”, consult README first; when answering “where is X implemented”, use Repository map and package table above.

### Monorepo (contributors)

| Command        | Description                      |
| -------------- | -------------------------------- |
| `bun check`    | Check all (TypeScript + Rust)    |
| `bun check:ts` | Biome check + tsgo type checking |
| `bun check:rs` | Cargo fmt --check + clippy       |
| `bun lint`     | Lint all                         |
| `bun lint:ts`  | Biome lint                       |
| `bun lint:rs`  | Cargo clippy                     |
| `bun fmt`      | Format all                       |
| `bun fmt:ts`   | Biome format                     |
| `bun fmt:rs`   | Cargo fmt                        |
| `bun fix`      | Fix all (unsafe fixes + format)  |
| `bun fix:ts`   | Biome --unsafe + format-prompts  |
| `bun fix:rs`   | Clippy --fix + cargo fmt         |

- NEVER run: `bun run dev`, `bun test` unless user instructs
- Only run specific tests if user instructs: `bun test path/to/file.test.ts`
- NEVER commit unless user asks
- Do NOT use `tsc` or `npx tsc` - always use `bun check`

## Testing Guidance

**Mechanics**: Prefer targeted runs: `bun test <path-to-test-file>` from repo root or the relevant package; co-locate tests as `*.test.ts` / `*.integration.test.ts` next to or under the package you changed.

When adding or changing tests, test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one concrete, externally observable contract: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- Do not add placeholder tests, tautologies, or assertions that only prove the code executed (`expect(true).toBe(true)`, `not.toThrow()`, non-empty string checks, array length growth checks, or "prompt exists" checks without a stronger semantic assertion).
- Prefer contract-level tests over implementation-detail tests. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail as a documented contract.
- Do not duplicate coverage across abstraction levels. If an integration or public-surface test already proves the behavior, delete or avoid the narrower unit test that only restates it through mocks or internal plumbing.
- Tests MUST be full-suite safe, not just file-local safe. Do not use long-lived file-wide mutations of globals like `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)`, local fakes, and immediate restoration via `vi.restoreAllMocks()`. A test that passes in isolation but poisons later files is broken.
- Never use `mock.module()`. Bun's `mock.module()` mutates the global module registry and leaks across test files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). There is no reliable per-file isolation. Use `spyOn` on the imported module object instead, and restore in `afterEach`. For pass dependencies, import the pass object and spy on its `run` method. For package dependencies, use a namespace import and spy on the exported function.
- For lifecycle or stateful code, prefer one test per invariant or transition over several tiny tests that each assert one field from the same transition.
- For error handling, prefer tests that trigger the real failure path and assert the surfaced error contract over tests that directly instantiate error classes or inspect purely internal metadata.
- Smoke tests are only acceptable when they detect a failure mode narrower tests would miss. A test that only proves a package boots or a command starts is not enough.
- Exact strings, ordering, and formatting should only be asserted when downstream code parses or materially depends on the exact bytes. Otherwise assert semantic content instead.
- If a guarantee is purely compile-time, enforce it with type checks or type-test coverage, not a runtime test disguised as a placeholder.
- Do not add tests for tiny, low-risk changes unless the change affects a real contract, fixes a regression-prone edge case, or would otherwise be easy to break silently.
- When trimming or adding tests, prefer focused package-local verification for the changed area so the surviving suite proves the contract it claims to protect.

### Multi-Consumer Contracts

Registration-based features (commands, tools, extensions, flags, MCP, skills) publish data that **multiple consumers** rely on. Tests must verify every consumer layer, not just the handler.

**Before writing tests for registration features, enumerate consumers:**

|Consumer|What it consumes|Common miss|
|---|---|---|
|Handler/runner|Execution path, notify result|✅ usually tested|
|TUI autocomplete|`getArgumentCompletions`, `getInlineHint`|❌ silently dropped by narrow mocks|
|Renderer|Component props, render metadata|❌ tested with `not.toThrow()` only|
|Help/diagnostics|`description`, field visibility|❌ assumed present, never asserted|
|Downstream APIs|Shape of registered object, optional fields|❌ mock type narrows away new fields|

**Rules:**

1. **Never hand-write a mock that narrows the API type.** If `registerCommand` takes `{ description, handler, getArgumentCompletions, getInlineHint }`, the mock MUST capture all fields. Use `spyOn` on the real API object or type the mock with the full interface — never a hand-typed subset.
2. **Assert registration metadata, not just handler presence.** `expect(cmd.getArgumentCompletions).toBeDefined()` + call it with a prefix and verify the returned items.
3. **One minimal test per consumer layer.** If the feature adds a new optional field to a registration API, write a test that reads it back. The regression pattern is: mock was narrow → new field lost → TUI/help/diagnostic broken.

### Robustness & Fault-Tolerance Testing

The existing rules above cover unit-level contract testing. This subsection covers the **orchestration layer** — code that coordinates multiple components, handles failures, falls back, retries, or recovers. These paths are where silent dead code, swallowed errors, and bypassed fallbacks hide.

Reference template: `packages/pi-gateway/test/cron-warm-bridge-fallback.test.ts` (a cron warm-bridge fallback that was dead code because the guard `!output && !stderr` was always false — the catch block set `stderr` to the error message).

**1. Exercise real orchestration paths, not manually wired components.**

If code has a private method like `#onCronTrigger`, `#handleError`, or `#onMessage` that coordinates multiple components, a test that manually wires those components together and calls them individually tests a *different* code path. The real path — including error handling, guards, fallbacks, and finally blocks — is skipped. MUST instantiate the real orchestrator (e.g., `new Gateway(config)`) and trigger it through its public surface (e.g., schedule a task, send a webhook).

**2. Fault injection: inject the failure, verify the recovery.**

For every error-handling or fallback branch, write a test that injects the fault condition and verifies the fallback *actually fires and produces the correct result*. A log message saying "falling back" is not evidence — assert the final observable outcome (execution status, output content, state transition).

Pattern: use a fake binary or `spyOn` to make the primary path fail, then assert the fallback path's output is what reaches the user/system.

**3. Assert observable outcomes, not intermediate signals.**

- BAD: `expect(logger.warn).toHaveBeenCalledWith("falling back")` — the code logged the intent but may not have executed it.
- BAD: `expect(catchBlock).toHaveBeenCalled()` — the catch ran, but the guard after it may have skipped the fallback.
- GOOD: `expect(execution.status).toBe("success")` + `expect(execution.output).toContain("FALLBACK-OK")` — the fallback's output reached the final state.

Assert the state the user or downstream system actually observes: DB records, response bodies, process exit codes, message delivery status. Logs, internal flags, and intermediate variable assignments are not observable outcomes.

**4. Verify cycle: fail-before, pass-after, no-regression.**

When writing a test for a bug fix:
1. Run the test against the **unfixed** code — it MUST fail. If it passes, the test does not cover the bug.
2. Apply the fix — the test MUST pass.
3. Run existing tests in the same area — they MUST still pass (no regression).

If step 1 passes (test green on buggy code), the test is asserting the wrong thing. Re-examine whether you're testing the real code path and the right observable outcome.

**5. Testability friction is a code smell.**

If writing a fault-injection test requires excessive workarounds — spying on `os.homedir()` because paths are hardcoded, avoiding channel connections because they have no timeout override, working around private methods with no test seam — that friction indicates a design problem. Note it in the test comments and surface it as a follow-up. Testable code has injectable paths; untestable code hides bugs.

## Interactive Testing

After implementing a new feature or tool, **MUST** use tmux to start omp and test the feature in an interactive session.

```bash
# Start omp in tmux for interactive testing
tmux new-session -d -s omp-test "bun packages/coding-agent/src/cli.ts"
```

- Test new tools by invoking them through the agent conversation
- Test TUI components by verifying rendering in the actual terminal
- Test end-to-end workflows, not just unit tests
- Verify the feature works from a user's perspective

## GitHub Issues

When reading issues:

- Always read all comments on the issue

When creating issues:

- Use standard GitHub labels (bug, enhancement, documentation, etc.)
- If an issue affects a specific package, mention it in the issue title or description

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## Tools

- GitHub CLI for issues/PRs
- TUI interaction: use tmux

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features
- `### Breaking Changes` - API changes requiring migration (appears first if present)

### Rules

- New entries ALWAYS go under `## [Unreleased]` section
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`

## Releasing

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   bun run release
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **oh-my-pi** (63038 symbols, 120137 relationships, 276 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

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
