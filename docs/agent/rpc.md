# RPC

> 状态：已实施

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `src/modes/rpc/rpc-mode.ts`
- `src/modes/rpc/rpc-types.ts`
- `src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
cornfield --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- RPC mode disables automatic session title generation by default to avoid an extra model call.
- RPC mode resets workflow-altering `todo.*`, `task.*`, `async.*`, and `bash.autoBackground.*` settings to their built-in defaults instead of inheriting user overrides.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).
- At startup it writes `{ "type": "ready" }` before processing commands.
- When stdin closes, pending host-tool calls are rejected and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Each frame is a single JSON object followed by `\n`.

There is no envelope beyond the object shape itself.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`

### Messages

- `{ id?, type: "get_messages" }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": "...",
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ]
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `todo_auto_clear`

Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- final completion is observed via `agent_end`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `cancel`
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `CORNFIELD_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

### Lifecycle deep dive

The rest of this section expands the base protocol above: the complete lifecycle, id correlation, state machine, and implementation notes.

#### Positioning

Host tools are the mechanism through which a host process injects execution capabilities into the agent in RPC mode. They take the agent from "cornfield built-in tools only" to "any capability the host provides" — querying a database, calling an internal API, driving an IDE, controlling a browser — all through this one interface.

```
┌───────────────────────────────────────────────┐
│              Agent (cornfield process)               │
│                                                │
│   ┌────────────────┐       ┌──────────────────┐│
│   │  built-in tools│   +   │  host tools       ││
│   │  read, bash,   │       │  create_jira,     ││
│   │  edit, grep... │       │  query_db, deploy ││
│   └────────────────┘       └──────────────────┘│
│            │                       │            │
│            │ in-process            │ cross-     │
│            │ execution             │ process    │
│            │                       │ callback   │
└────────────┼───────────────────────┼────────────┘
             │                       │
             ↓                       ↓
        filesystem / shell    stdio (host_tool_call)
                                      │
                                      ↓
                          ┌────────────────────────┐
                          │ Host process           │
                          │ actually executes the  │
                          │ tool logic             │
                          │ (API / DB / IDE ...)   │
                          └────────────────────────┘
```

**Core abstraction:** the model sees only "tool name + description + JSON Schema" — exactly as it sees built-in tools. The difference is the execution path: built-in tools run directly inside cornfield; host tools send the request back to the host and wait for the result.

#### Lifecycle: five phases

**Phase 1 — Registration (host → agent, stdin): `set_host_tools`**

```
host process                          cornfield process
     │                                     │
     │ {type:"set_host_tools", tools:[...]}│
     ├────────────────────────────────────→│
     │                                     │ writes to the session tool registry
     │                                     │ next model call injects the tool
     │                                     │ schemas into the LLM tools list
     │ {type:"response", success:true,     │
     │  data:{toolNames:["..."]}}          │
     │←────────────────────────────────────┤
```

Key characteristics:

- **Full replacement, not incremental.** Re-sending clears the previous tool set.
- Scoped to the **current session** — re-register after switching sessions.
- `description` is the **only basis on which the model decides whether to call** — be explicit about "what it does, when to use it, what it returns".
- `parameters` is JSON Schema; the model generates arguments strictly against it.

**Phase 2 — Model decision**

cornfield merges the host-injected tool schemas with the built-in tool schemas and hands them to the LLM as one list. The LLM decides during reasoning whether to call:

```
LLM sees:
  - read (built-in): read local files
  - bash (built-in): run shell commands
  - create_jira (host): create a Jira ticket
  - deploy_to_staging (host): deploy to staging

LLM thinks: user wants to fix a bug, should track it as a ticket first
LLM outputs tool_call: { name: "create_jira", arguments: {...} }
```

The cornfield agent loop checks the tool_call name, sees it is a host tool, and does **not** execute it directly — it proceeds to Phase 3.

**Phase 3 — Call initiation (agent → host, stdout)**

```
host process                          cornfield process                    LLM
     │                                     │                          │
     │                                     │ tool_call arrives         │
     │                                     │ detects host tool         │
     │                                     │ generates host frame id   │
     │ {type:"host_tool_call",             │                          │
     │  id:"host_1",                       │                          │
     │  toolCallId:"toolu_xyz",            │                          │
     │  toolName:"create_jira",            │                          │
     │  arguments:{...}}                   │                          │
     │←────────────────────────────────────┤                          │
     │                                     │                          │
     │ receives request, routes to the     │                          │
     │ matching handler                    │                          │
     │ executes the tool (may take time)   │                          │
```

Field meanings:

- `id`: the **RPC frame id** — the host must echo it back verbatim in the result
- `toolCallId`: the **LLM-layer tool call id** — used when writing to the `tool_calls` array of message history
- `toolName`: which tool to call
- `arguments`: the model-generated arguments

**Phase 4 — Streaming progress (optional, host → agent, stdin): `host_tool_update`**

Suitable for long-running operations (deploys, test runs, long queries) so the model can observe intermediate state:

```
host process                             cornfield process
     │                                       │
     │ tool executing...                     │
     │                                       │
     │ {type:"host_tool_update",             │
     │  id:"host_1",                         │
     │  partialResult:{                      │
     │    content:[{type:"text",             │
     │             text:"deploy 30%..."}]}}  │
     ├──────────────────────────────────────→│
     │                                       │ appended to the current
     │                                       │ tool_call's partialResult
     │                                       │ (not into message history)
     │                                       │
     │ {type:"host_tool_update",             │
     │  id:"host_1",                         │
     │  partialResult:{content:[...]}}       │
     ├──────────────────────────────────────→│
     │                                       │
     │ continues executing...                │
```

Note: `partialResult` is **not** written to message history; it is only visible while the tool is executing. The final result still arrives via `host_tool_result`.

**Phase 5 — Completion (host → agent, stdin): `host_tool_result`**

```
host process                             cornfield process
     │                                       │
     │ {type:"host_tool_result",             │
     │  id:"host_1",                         │
     │  result:{content:[{type:"text",       │
     │                   text:"CornField-1234 created"}]}}│
     ├──────────────────────────────────────→│
     │                                       │ appends the result to
     │                                       │ message history as the
     │                                       │ tool call's return
     │                                       │ continues the agent loop,
     │                                       │ calls the LLM so the model
     │                                       │ keeps reasoning on the result
     │                                       ├──────────────────────────→│
```

Error case: set top-level `isError: true`:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "isError": true,
  "result": {
    "content": [{"type": "text", "text": "insufficient permissions"}]
  }
}
```

The model sees the text as a tool error and may retry with a different strategy or give up.

#### Complete sequence diagrams

Normal completion:

```
host             cornfield process              LLM
 │                  │                   │
 │ set_host_tools   │                   │
 ├─────────────────→│                   │
 │                  │ registers tools   │
 │                  │                   │
 │ prompt           │                   │
 ├─────────────────→│                   │
 │                  │ agent_start       │
 │                  │ message_start     │
 │                  │ tool_call decision│
 │                  ├──────────────────→│
 │                  │                   │ outputs tool_call
 │                  │←──────────────────┤
 │                  │                   │
 │ host_tool_call   │                   │
 │←─────────────────┤                   │
 │                  │                   │
 │ executes tool    │                   │
 │ host_tool_update │                   │
 ├─────────────────→│ (optional, xN)    │
 │ host_tool_update │                   │
 ├─────────────────→│                   │
 │                  │                   │
 │ host_tool_result │                   │
 ├─────────────────→│                   │
 │                  │ result to history │
 │                  │ continue LLM      │
 │                  ├──────────────────→│
 │                  │←──────────────────┤
 │ message_update   │                   │
 │←─────────────────┤                   │
 │ ...              │                   │
 │ agent_end        │                   │
 │←─────────────────┤                   │
```

Mid-flight cancellation:

```
host             cornfield process          LLM           user
 │                  │                   │                │
 │                  │ after host_tool_call               │
 │                  │ waiting for result│                │
 │                  │                   │                │
 │                  │                   │                │ Ctrl+C
 │                  │                   │                │
 │                  │ receives abort    │                │
 │                  │ cancels the       │                │
 │                  │ executing tool    │                │
 │                  │ call              │                │
 │                  │                   │                │
 │ host_tool_cancel │                   │                │
 │←─────────────────┤                   │                │
 │                  │                   │                │
 │ (host should stop│                   │                │
 │  executing and   │                   │                │
 │  clean up)       │                   │                │
 │                  │                   │                │
```

Note: `host_tool_cancel` is a unilateral notification from cornfield — the host has **no obligation to ack**. If the host is inside an uninterruptible operation (e.g., an HTTP request already sent), it may ignore the cancel and send `host_tool_result` when done; cornfield ignores the late result.

#### State machine

```
        ┌─────────┐
        │  idle   │ ←── ready after set_host_tools
        └────┬────┘
             │ LLM decides to call
             ↓
    ┌────────────────┐
    │ tool_called    │ ←── cornfield has sent host_tool_call, waiting for host
    └─┬──────┬───────┘
      │      │
      │      │ user abort / turn interrupted
      │      ↓
      │   ┌─────────────┐
      │   │ cancelled   │ ←── cornfield sends host_tool_cancel, forced end
      │   └─────────────┘
      │
      │ host sends host_tool_update (optional, 0..N)
      ↓
    ┌──────────────┐
    │  executing   │ ←── host executing; may stream progress
    └─┬────────┬───┘
      │        │
      │        │ host sends host_tool_result
      │        ↓
      │   ┌─────────┐
      │   │  done   │ ←── result enters message history, agent loop continues
      │   └─────────┘
      │
      │ (cancelled can also forcibly end executing)
      └─→ cancelled
```

#### Field reference table

| Field | On side | Meaning | Notes |
|---|---|---|---|
| `id` | `host_tool_call` | RPC frame id | host echoes it back verbatim on result/update |
| `toolCallId` | `host_tool_call` | LLM-layer tool call id | written to message history; host does not need it |
| `id` | `host_tool_update` | correlates to host_tool_call | must equal `host_tool_call.id` |
| `id` | `host_tool_result` | correlates to host_tool_call | must equal `host_tool_call.id` |
| `id` | `host_tool_cancel` | RPC frame id (newly generated) | unrelated to the cancelled call's id |
| `targetId` | `host_tool_cancel` | points at the call to cancel | must equal `host_tool_call.id` |
| `isError` | `host_tool_result` | flags tool failure | top-level field, not inside result |
| `partialResult` | `host_tool_update` | intermediate result | never enters message history |
| `result` | `host_tool_result` | final result | enters message history as the tool return |

#### id association — the most confusing part

```
LLM output:
  message.tool_calls = [
    { id: "toolu_xyz", function: {name:"create_jira", arguments:"..."} }
  ]
                          │
                          │ wrapped by cornfield
                          ↓
agent → host:
  {
    id: "host_1",            ← RPC frame id (generated by cornfield)
    toolCallId: "toolu_xyz", ← LLM-layer id (passed through)
    toolName: "create_jira",
    arguments: {...}
  }
                          │
                          │ host reply
                          ↓
host → agent:
  {
    id: "host_1",            ← must equal host_tool_call.id
    result: {...}
  }
                          │
                          │ processed by cornfield
                          ↓
message history:
  tool_use {
    id: "toolu_xyz",       ← uses toolCallId
    name: "create_jira",
    input: {...}
  }
  tool_result {
    tool_use_id: "toolu_xyz", ← correlates to the tool_use above
    content: [...]
  }
```

Mnemonic:

- `id` is the **RPC protocol layer** correlation — used by the host
- `toolCallId` is the **LLM message layer** correlation — used by cornfield to write history

#### Key design points & common pitfalls

Design points:

1. **Tool description is prompt engineering.** A bad `description` means the model never knows when to call it. Write: verb, applicable scenario, return content, caveats.
2. **Registration is state, not a handshake.** `set_host_tools` is not a one-off RPC — it **modifies session state**. Every subsequent model call is based on the currently registered tool set.
3. **Errors are information.** On tool failure use `isError: true` with clear text; the model decides itself whether to retry, switch tools, or give up. **Do not swallow errors.**
4. **Streaming updates never enter history.** `host_tool_update` content is real-time progress-bar material and does not pollute message history. The final result must arrive via `host_tool_result`.
5. **Cancellation is best-effort.** `host_tool_cancel` is an advisory notification the host may refuse. Design tools to be interruptible (long loops check a cancel flag).

Common pitfalls:

| Pitfall | Symptom | Fix |
|---|---|---|
| `description` too short | model never calls | write "used for X scenario, does Y, returns Z" |
| Repeated `set_host_tools` | previous tools disappear | host maintains the full list and sends it entirely every time |
| Tools disappear after session switch | model reports tool missing | re-register after switching sessions |
| Wrong id across concurrent host_tool_call | results cross-correlate | unique id per call; host keeps an id→handler map |
| Tool returns huge object | context explosion | summarize/truncate inside the tool |
| Treating `partialResult` as final | model acts on an intermediate value as if done | terminate only with `host_tool_result` |
| Ignoring `host_tool_cancel` | keeps executing after user cancelled | tool implementation should respond to cancel events |
| Loose parameter schema | model passes wrong types | strict JSON Schema + a second validation on the host side |

#### Minimal implementation example

```typescript
// === host process ===
class HostToolServer {
  handlers = new Map<string, (args: any) => Promise<any>>();

  register(definition: ToolDef, handler: Function) {
    this.handlers.set(definition.name, handler);
  }

  start(ompStdin, ompStdout) {
    // register tools with cornfield
    ompStdin.write({
      type: "set_host_tools",
      tools: Array.from(this.handlers.entries()).map(([name, h]) => h.definition)
    });

    // handle requests coming from cornfield
    readJsonl(ompStdout).onFrame(async (frame) => {
      if (frame.type === "host_tool_call") {
        const handler = this.handlers.get(frame.toolName);
        try {
          const result = await handler(frame.arguments);
          ompStdin.write({
            type: "host_tool_result",
            id: frame.id,        // echo back verbatim
            result: { content: [{ type: "text", text: JSON.stringify(result) }] }
          });
        } catch (err) {
          ompStdin.write({
            type: "host_tool_result",
            id: frame.id,
            isError: true,
            result: { content: [{ type: "text", text: err.message }] }
          });
        }
      }
    });
  }
}

// usage
const server = new HostToolServer();
server.register(
  { name: "get_weather", description: "查询某城市天气", parameters: {...} },
  async (args) => fetch(`https://api.weather.com/${args.city}`).then(r => r.json())
);
server.start(process.stdout, process.stdin);  // reversed: cornfield is the one spawned externally
```

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Notes on `RpcClient` helper

`src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches only recognized `AgentEvent` types to listeners
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Does **not** expose helper methods for every protocol command (for example, `set_interrupt_mode` and `set_session_name` are in protocol types but not wrapped as dedicated methods)

Use raw protocol frames if you need complete surface coverage.