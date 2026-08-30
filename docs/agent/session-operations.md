# Session Operations: switch / recent listing / export / share / fork / resume

> 状态：已实施

This document describes operator-visible behavior for session export/share/fork/resume operations, how the agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session. It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/src/cli/session-picker.ts`
- `packages/coding-agent/src/modes/components/session-selector.ts`
- `packages/coding-agent/src/export/html/index.ts`
- `packages/coding-agent/src/export/custom-share.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/modes/utils/ui-helpers.ts`

## Operation matrix

| Operation                               | Entry path                | Session mutation                      | Session file creation/switch                                                       | Output artifact                                                   |
| --------------------------------------- | ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/dump`                                 | Interactive slash command | No                                    | No                                                                                 | Clipboard text                                                    |
| `/export [path]`                        | Interactive slash command | No                                    | No                                                                                 | HTML file                                                         |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path     | No runtime session mutation           | No active session; reads target file                                               | HTML file                                                         |
| `/share`                                | Interactive slash command | No                                    | No                                                                                 | Temp HTML + share URL/gist                                        |
| `/fork`                                 | Interactive slash command | Yes (active session identity changes) | Creates new session file and switches current session to it (persistent mode only) | Copies artifact directory to new session namespace when present   |
| `--fork <id\|path>`                     | CLI startup               | Yes after session creation            | Creates a new session fork from the selected source into current cwd/session dir   | None                                                              |
| `/resume`                               | Interactive slash command | Yes (active in-memory state replaced) | Switches to selected existing session file                                         | None                                                              |
| `--resume`                              | CLI startup (picker)      | Yes after session creation            | Opens selected existing session file                                               | None                                                              |
| `--resume <id\|path>`                   | CLI startup               | Yes after session creation            | Opens existing session; cross-project case can fork into current project           | None                                                              |
| `--continue`                            | CLI startup               | Yes after session creation            | Opens terminal breadcrumb or most-recent session; creates new one if none exists   | None                                                              |

## Recent-session discovery

### Directory scope

`SessionManager` stores sessions under a cwd-scoped directory by default:

- `~/.cornfield/agent/sessions/--<cwd-encoded>--/*.jsonl`

`SessionManager.list(cwd, sessionDir?)` reads only that directory unless an explicit `sessionDir` is provided.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit)` (welcome/summary view)
   - Reads only a 4KB prefix (`readTextPrefix(..., 4096)`) from each file.
   - Parses header + earliest user text preview.
   - Returns lightweight `RecentSessionInfo` with lazy `name` and `timeAgo` getters.
   - Sorts by file `mtime` descending.

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Reads full session files.
   - Builds `SessionInfo` objects (`id`, `cwd`, `title`, `messageCount`, `firstMessage`, `allMessagesText`, timestamps).
   - Drops sessions with zero `message` entries.
   - Sorts by `modified` descending.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference: `header.title` -> first user prompt -> `header.id` -> filename
- name is truncated to 40 chars for compact displays
- control characters/newlines are stripped/sanitized from title-derived names

For `SessionInfo` list entries:

- `title` is `header.title` or latest compaction `shortSummary`
- `firstMessage` is first user message text or `"(no messages)"`

## Export and dump

### `/export [outputPath]` (interactive)

Flow:

1. `InputController` routes `/export...` to `CommandController.handleExportCommand`.
2. The command splits on whitespace and uses only the first argument after `/export` as `outputPath`.
3. `AgentSession.exportToHtml()` calls `exportSessionToHtml(sessionManager, state, { outputPath, themeName })`.
4. On success, UI shows path and opens the file in browser.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are explicitly rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state.
- No session entries are appended during export.

Caveat:

- Argument parsing is whitespace-based (`text.split(/\s+/)`), so quoted paths with spaces are not preserved as a single path by this command path.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `SessionManager.open(inputPath)` loads entries, then HTML is generated and written.
4. Process prints `Exported to: ...` and exits.

Behavior details:

- Missing input file surfaces as `File not found: <path>`.
- This path does not create an `AgentSession` and does not mutate any running session.

### `/dump` (interactive clipboard export)

Flow:

1. `CommandController.handleDumpCommand()` calls `session.formatSessionAsText()`.
2. If empty string, reports `No messages to dump yet.`
3. Otherwise copies to clipboard via native `copyToClipboard`.

Dump content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

No session persistence changes are made by dumping.

## Share

`/share` is interactive-only and always starts by exporting current session to a temp HTML file.

### Phase 1: temp export

- Temp file path: `${os.tmpdir()}/${Snowflake.next()}.html`
- Uses `session.exportToHtml(tmpFile)`
- If export fails (notably in-memory sessions), share ends with error.

### Phase 2: custom share handler (if present)

`loadCustomShare()` checks `~/.cornfield/agent` for first existing candidate:

- `share.ts`
- `share.js`
- `share.mjs`

Requirements:

- Module must default-export a function `(htmlPath) => Promise<CustomShareResult | string | undefined>`.

If present and valid:

- UI enters `Sharing...` loader state.
- Handler result interpretation:
  - string => treated as URL, shown and opened
  - object => `url` and/or `message` shown; `url` opened
  - `undefined`/falsy => generic `Session shared`
- Temp file is removed after completion.

Critical fallback behavior:

- If custom handler exists but loading fails, command errors and returns.
- If custom handler executes and throws, command errors and returns.
- In both failure cases, it **does not** fall back to GitHub gist.
- Gist fallback happens only when no custom share script exists.

### Phase 3: default gist fallback

Only when no custom share handler is found:

1. Validates `gh auth status`.
2. Shows `Creating gist...` loader.
3. Runs `gh gist create --public=false <tmpFile>`.
4. Parses gist URL, derives gist id, builds preview URL `https://gistpreview.github.io/?<id>`.
5. Shows both preview and gist URLs; opens preview.

Cancellation/abort semantics in share:

- Loader has `onAbort` hook that restores editor UI and reports `Share cancelled`.
- The underlying `gh gist create` command is not passed an abort signal in this code path; cancellation is UI-level and checked after command returns.

## Fork

Interactive `/fork` creates a new session from the current one and switches the active session identity.

### Preconditions and immediate guards

- If agent is streaming, `/fork` is rejected with warning.
- UI status/loading indicators are cleared before operation.

### Session-level flow

`AgentSession.fork()`:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending writes.
3. Calls `SessionManager.fork()`.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Updates `agent.sessionId`.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and existing session file.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
- Keeps all non-header entries unchanged in the new file.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) call `SessionManager.forkFrom(path, cwd, sessionDir)`.
3. Other values resolve like resumable session ids via current scope and then global search when allowed.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup.

## Resume and continue

### Interactive `/resume`

Flow:

1. Opens session selector populated via `SessionManager.list(currentCwd, currentSessionDir)`.
2. On selection, `SelectorController.handleResumeSession(sessionPath)` calls `session.switchSession(sessionPath)`.
3. UI clears/rebuilds chat and todos, then reports `Resumed session`.

Notes:

- This picker only lists sessions in the current session directory scope.
- It does not use global cross-project search.

### CLI `--resume` (no value)

Handled after initial session-manager construction in `main.ts`:

1. List local sessions with `SessionManager.list(cwd, parsed.sessionDir)`.
2. If empty: print `No sessions found` and exit early.
3. Open TUI picker (`selectSession`).
4. If canceled: print `No session selected` and exit early.
5. If selected: `SessionManager.open(selectedPath)`.

### CLI `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\`, or ends with `.jsonl`)
   - direct `SessionManager.open(sessionArg, parsed.sessionDir)`
2. ID prefix value
   - find match in `SessionManager.list(cwd, sessionDir)` by `id.startsWith(sessionArg)`
   - if no local match and `sessionDir` is not forced, try `SessionManager.listAll()`
   - first match is used (no ambiguity prompt)

#### Cross-project match behavior

- if matched session cwd differs from current cwd, CLI prompts whether to fork into current project:
  - `Session found in different project ... Fork into current directory? [y/N]`
- yes -> `SessionManager.forkFrom(...)` creates a new local forked file
- no (or non-TTY default) -> throws error (`Session "..." is in another project (...)`)

No match -> throws error (`Session "..." not found.`).

### CLI `--continue` and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.cornfield/agent/terminal-sessions/<terminal-id>`)
2. Validate breadcrumb:
   - current terminal can be identified
   - breadcrumb cwd matches current cwd (resolved path compare)
   - referenced file still exists
3. If breadcrumb is invalid/missing, fall back to newest file by mtime in the session dir (`findMostRecentSession`)
4. If none found, create a new session

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`KITTY_WINDOW_ID`, `TMUX_PANE`, `TERM_SESSION_ID`, `WT_SESSION`).

Breadcrumb writes are best-effort and non-fatal.

This is startup-only behavior; there is no interactive `/continue` slash command.

## Session picker internals

### CLI picker (`packages/coding-agent/src/cli/session-picker.ts`)

`selectSession(sessions)` creates a standalone TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected path
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and `process.exit(0)`

### Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch sessions from current session dir via `SessionManager.list(currentCwd, currentSessionDir)`
2. mount `SessionSelectorComponent` in editor area using `showSelector(...)`
3. callbacks:
   - select -> close selector and call `handleResumeSession(sessionPath)`
   - cancel -> restore editor and rerender
   - exit -> `ctx.shutdown()`

### Session selector component behavior

`SessionList` supports:

- arrow/page navigation
- Enter to select
- Esc to cancel
- Ctrl+C to exit
- fuzzy search across session id/title/cwd/first message/all messages/path

Empty-list render behavior:

- renders a message instead of crashing
- Enter on empty does nothing (no callback)
- Esc/Ctrl+C still work

Caveat: UI text says `Press Tab to view all`, but this component currently has no Tab handler and current wiring only lists current-scope sessions.

## Runtime session switching

`AgentSession.switchSession(sessionPath)` is the core in-process switch path used by resume-like operations. No new session file is created by `switchSession()` itself.

### Lifecycle/state transition

1. capture `previousSessionFile`
2. emit `session_before_switch` hook event (`reason: "resume"`, cancellable)
3. if canceled -> return `false` with no switch
4. disconnect from current agent event stream
5. abort active generation/tool flow
6. clear queued steering/follow-up/next-turn message buffers
7. flush session writer (`sessionManager.flush()`) to persist pending writes
8. `sessionManager.setSessionFile(sessionPath)`
   - updates session file pointer
   - writes terminal breadcrumb
   - loads entries / migrates / blob-resolves / reindexes
   - if missing/invalid file data: initializes a new session at that path and rewrites header
9. update `agent.sessionId`
10. rebuild display context via `buildDisplaySessionContext()`
11. restore persisted/discovered MCP tool selections and rebuild active tools/system prompt when discovery is enabled
12. emit `session_switch` hook event (`reason: "resume"`, `previousSessionFile`)
13. replace agent messages with rebuilt context and sync todos
14. close provider sessions when switching to a different session or when same-session reload changed replay messages
15. restore default model from `sessionContext.models.default` if available and present in model registry
16. restore thinking level and service tier:
    - thinking uses persisted `thinking_level_change`, otherwise the configured default clamped to model capability
    - service tier uses persisted `service_tier_change`, otherwise the configured `serviceTier` setting (`"none"` becomes unset)
17. reconnect agent listeners and return `true`

### UI state rebuild after interactive switch

`SelectorController.handleResumeSession` performs UI reset around `switchSession`:

- stop loading animation
- clear status container
- clear pending-message UI and pending tool map
- reset streaming component/message references
- call `session.switchSession(...)`
- clear chat container and rerender from session context (`renderInitialMessages`)
- reload todos from new session artifacts
- show `Resumed session`

So visible conversation/todo state is rebuilt from the new session file.

### Startup resume vs in-session switch

Startup resume (`--continue`, `--resume`, direct open):

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds `existingSession = sessionManager.buildSessionContext()`.
- Agent messages are restored once during session creation.
- Model/thinking are selected during creation (including restore/fallback logic).
- Interactive mode then runs `#restoreModeFromSession()` to re-enter persisted mode state (currently plan/plan_paused).

In-session switch (`/resume`-style selector path):

- Uses `AgentSession.switchSession(...)` on an already-running `AgentSession`.
- Messages/model/thinking are rebuilt immediately in place.
- Hook `session_before_switch`/`session_switch` events are emitted.
- UI chat/todos are refreshed.
- No dedicated post-switch mode restore call is made in selector flow; mode re-entry behavior is not symmetric with startup `#restoreModeFromSession()`.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`, caller prints `No session selected`, process exits early.
- Interactive picker cancel -> editor restored, no session change.
- Hook cancellation (`session_before_switch`) -> `switchSession()` returns `false`.
- Cross-project `--resume <id>` can be cancelled by declining the fork prompt (non-TTY defaults to no).

### Empty list paths

- CLI `--resume` (no value): empty list prints `No sessions found` and exits.
- Interactive selector: empty list renders message and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- ENOENT -> treated as empty -> new session initialized at that exact path and persisted.
- malformed/invalid header (or effectively unreadable parsed entries) -> treated as empty -> new session initialized and persisted.

This is recovery behavior, not hard failure.

### Hard failures

Switch/open can still throw on true I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- ID matching uses `startsWith` and takes first match in sorted list.
- No ambiguity UI if multiple sessions share prefix.
- `SessionManager.list(...)` excludes sessions with zero messages, so those sessions are not resumable via ID match/list picker.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
  - reasons: `new`, `fork`, `resume`
  - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
  - same reason set
  - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- `/fork` is blocked while streaming (user must wait/abort current response first).
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining fork prompt.
- `/share` has UI abort path (`Share cancelled`) for gist flow; it does not wire process-kill semantics for `gh gist create` in this code path.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` and `/share` fail with `Cannot export in-memory session to HTML` (propagated to command error UI).
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- CLI resume/continue semantics are bypassed if `--no-session` is set, because manager creation returns in-memory immediately.

## Known implementation caveats

- `SelectorController.handleResumeSession()` does not check the boolean result from `session.switchSession(...)`; a hook-cancelled switch can still proceed through UI "Resumed session" repaint/status path.
- `/share` custom-share failures do not degrade to default gist fallback; they terminate the command with error.
- `/export` argument tokenization is simplistic and does not preserve quoted paths with spaces.