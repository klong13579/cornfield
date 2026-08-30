# MCP

> 状态：已实施
> 合并自：`mcp-config.md`（配置/校验/操作）+ `mcp-runtime-lifecycle.md`（运行时生命周期）+ `mcp-protocol-transports.md`（协议与传输内部）

This guide explains how to add, edit, and validate MCP servers for the coding agent, how servers are discovered, connected, exposed as tools, refreshed, and torn down at runtime, and how the JSON-RPC protocol layer is split from transport concerns.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Standalone `mcp.json` discovery: `packages/coding-agent/src/discovery/mcp-json.ts`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`
- Runtime lifecycle: `packages/coding-agent/src/mcp/{loader,manager,client}.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/session/agent-session.ts`
- Protocol/transports: `packages/coding-agent/src/mcp/{json-rpc,client}.ts`, `packages/coding-agent/src/mcp/transports/`

## Part 1 — Configuration

### Preferred config locations

The agent can discover MCP servers from multiple tools (`.claude/`, `.cursor/`, `.vscode/`, `opencode.json`, and more), but for native configuration you should usually use one of these files:

- Project: `.cornfield/mcp.json`
- User: `~/.cornfield/agent/mcp.json`

Fallback standalone files in the project root are also accepted:

- `mcp.json`
- `.mcp.json`

Use `.cornfield/mcp.json` or `~/.cornfield/agent/mcp.json` when you want the agent to own the configuration. Use root `mcp.json` / `.mcp.json` only when you want a portable fallback file that other MCP clients may also read.

### Add a schema reference

Add this line at the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

The agent writes this automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update a managed MCP file.

### File shape

Top-level structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

Top-level keys:

- `$schema` — optional JSON Schema URL for tooling
- `mcpServers` — map of server name to server config
- `disabledServers` — user-level denylist used to turn off discovered servers by name; runtime loading reads this list from `~/.cornfield/agent/mcp.json`

Server names must match `^[a-zA-Z0-9_.-]{1,100}$`.

### Supported server fields

Shared fields for every transport:

- `enabled?: boolean` — skip this server when `false`
- `timeout?: number` — connection timeout in milliseconds
- `auth?: { ... }` — auth metadata used for OAuth/API-key flows
- `oauth?: { ... }` — explicit OAuth client settings used during auth/reauth

#### `stdio` transport

`stdio` is the default when `type` is omitted.

Required:

- `command: string`

Optional:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

This follows the official Filesystem MCP server package (`@modelcontextprotocol/server-filesystem`).

#### `http` transport

Required:

- `type: "http"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

This matches GitHub's hosted GitHub MCP server endpoint.

#### `sse` transport

Required:

- `type: "sse"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` is still supported for compatibility, but the MCP spec now prefers Streamable HTTP (`type: "http"`) for new servers.

### Auth fields

Two auth-related objects are understood.

#### `auth`

```json
{
  "type": "oauth" | "apikey",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret"
}
```

Use this when the agent should remember how to rehydrate credentials for a server.

#### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback"
}
```

Use this when the MCP server requires explicit OAuth client settings.

Slack is the clearest current example. Slack's MCP server is hosted at `https://mcp.slack.com/mcp`, uses Streamable HTTP, and requires confidential OAuth with your Slack app's client credentials.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Relevant Slack endpoints:

- MCP endpoint: `https://mcp.slack.com/mcp`
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`

### Common copy-paste examples

#### Filesystem server via stdio

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

#### GitHub hosted server via HTTP

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

#### GitHub local server via Docker

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

This matches GitHub's official local Docker image `ghcr.io/github/github-mcp-server`.

#### Slack hosted server via OAuth

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

### Secrets and variable resolution

Before launching a stdio server or making an HTTP/SSE request, stdio `env` values and HTTP/SSE `headers` values resolve like this:

1. If a value starts with `!`, run the rest as a shell command with a 10s timeout and use trimmed stdout.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted.
3. Otherwise check whether the value names an environment variable.
4. If that environment variable is set to a non-empty value, use the environment value; otherwise use the string literally.

Examples:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → copy from the current shell environment
- `"Authorization": "Bearer hardcoded-token"` → use the literal value
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → build the header from a command

In root `mcp.json` and `.mcp.json`, the standalone fallback loader also expands `${VAR}` and `${VAR:-default}` inside strings during discovery for `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`.

Example:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

For the least surprising behavior, prefer `.cornfield/mcp.json` or `~/.cornfield/agent/mcp.json` and use explicit env/header values.

### `disabledServers`

`disabledServers` is read from the user config file (`~/.cornfield/agent/mcp.json`) when a server is discovered from any source and you want the agent to ignore it without editing that other tool's config.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/klong13579/cornfield/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github", "slack"]
}
```

### `/mcp add` vs editing JSON directly

Use `/mcp add` when you want guided setup.

Use direct JSON editing when:

- you need a transport or auth option the wizard does not prompt for yet
- you want to paste a server definition from another MCP client
- you want schema-backed validation in your editor

After editing, use:

- `/mcp reload` to rediscover and reconnect servers in the current session
- `/mcp list` to see which config file a server came from
- `/mcp test <name>` to test a single server
- `/mcp reconnect <name>` to reconnect one server without rediscovering all configs
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

### Validation rules

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

Practical implications:

- Omitting `type` means `stdio`
- If you paste a remote server config and forget `"type": "http"`, it is treated as `stdio` and complains that `command` is missing
- `sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`

### Discovery and precedence

Duplicate server definitions across files are not merged. Discovery providers are prioritized, and the higher-priority definition wins. Separately, `disabledServers` from `~/.cornfield/agent/mcp.json` can suppress a discovered server by name.

In practice:

- prefer `.cornfield/mcp.json` or `~/.cornfield/agent/mcp.json` when you want a native-specific override
- keep server names unique across tools when possible
- use `disabledServers` in the user config when a third-party config keeps reintroducing a server you do not want

## Part 2 — Runtime lifecycle

How MCP servers are discovered, connected, exposed as tools, refreshed, and torn down in the runtime.

### Lifecycle at a glance

1. **SDK startup** calls `discoverAndLoadMCPTools()` (unless MCP is disabled).
2. **Discovery** (`loadAllMCPConfigs`) resolves MCP server configs from capability sources, filters disabled/project/Exa entries, and preserves source metadata.
3. **Manager connect phase** (`MCPManager.connectServers`) starts per-server connect + `tools/list` in parallel.
4. **Fast startup gate** waits up to 250ms, then may return:
   - fully loaded `MCPTool`s,
   - failures per server,
   - or cached `DeferredMCPTool`s for still-pending servers.
5. **SDK wiring** merges MCP tools into runtime tool registry for the session.
6. **Post-connect enrichment** best-effort loads resources, resource templates, prompts, and optional resource subscriptions.
7. **Live session** can refresh MCP tools via `/mcp` flows (`disconnectAll` + rediscover + `session.refreshMCPTools`) and can reconnect individual servers on transport close or `/mcp reconnect`.
8. **Teardown** happens when callers invoke `disconnectServer`/`disconnectAll`; manager also clears MCP tool/resource/prompt registrations for disconnected servers.

### Discovery and load phase

`createAgentSession()` in `packages/coding-agent/src/sdk.ts` performs MCP startup when `enableMCP` is true (default):

- calls `discoverAndLoadMCPTools(cwd, { ... })`,
- passes `authStorage`, cache storage, and `mcp.enableProjectConfig` setting,
- always sets `filterExa: true`,
- logs per-server load/connect errors,
- stores returned manager in `toolSession.mcpManager` and session result.

If `enableMCP` is false, MCP discovery is skipped entirely.

`loadAllMCPConfigs()` (`packages/coding-agent/src/mcp/config.ts`) loads canonical MCP server items through capability discovery, then converts to legacy `MCPServerConfig`. Filtering behavior:

- `enableProjectConfig: false` removes project-level entries (`_source.level === "project"`).
- `enabled: false` servers are skipped before connect attempts.
- Exa servers are filtered out by default and API keys are extracted for native Exa tool integration.

Result includes both `configs` and `sources` (metadata used later for provider labeling).

`discoverAndLoadMCPTools()` distinguishes two failure classes:

- **Discovery hard failure** (exception from `manager.discoverAndConnect`, typically from config discovery): returns an empty tool set and one synthetic error `{ path: ".mcp.json", error }`.
- **Per-server runtime/connect failure**: manager returns partial success with `errors` map; other servers continue.

Startup does not fail the whole agent session when individual MCP servers fail.

### Manager state model

`MCPManager` tracks runtime lifecycle with separate registries:

- `#connections: Map<string, MCPServerConnection>` — fully connected servers.
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — handshake in progress.
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — connected but tools still loading.
- `#tools: CustomTool[]` — current MCP tool view exposed to callers.
- `#sources: Map<string, SourceMeta>` — provider/source metadata even before connect completes.
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — reconnects in progress after a dropped transport or explicit reconnect.
- `#serverConfigs: Map<string, MCPServerConfig>` — original unresolved configs preserved so reconnect can re-resolve credentials without leaking resolved tokens.

`getConnectionStatus(name)` derives status from these maps:

- `connected` if in `#connections`,
- `connecting` if pending connect, pending tool load, or pending reconnect,
- `disconnected` otherwise.

### Connection establishment and startup timing

For each discovered server in `connectServers()`:

1. store/update source metadata,
2. skip if already connected/pending/reconnecting,
3. validate transport fields (`validateServerConfig`),
4. resolve auth/shell substitutions (`#resolveAuthConfig`),
5. call `connectToServer(name, resolvedConfig)` with manager notification/request handlers,
6. wire HTTP OAuth refresh and transport `onClose` reconnect handling,
7. call `listTools(connection)`,
8. cache tool definitions (`MCPToolCache.set`) best-effort,
9. best-effort load resources, resource templates, prompts, and subscriptions after tools load.

`connectToServer()` behavior (`packages/coding-agent/src/mcp/client.ts`):

- creates stdio or HTTP/SSE transport,
- performs MCP `initialize`,
- for HTTP/SSE, starts the optional background SSE listener before `notifications/initialized`,
- sends `notifications/initialized`,
- uses timeout (`config.timeout` or 30s default),
- closes transport on init failure.

`connectServers()` waits on a race between:

- all connect/tool-load tasks settled, and
- `STARTUP_TIMEOUT_MS = 250`.

After 250ms:

- fulfilled tasks become live `MCPTool`s,
- rejected tasks produce per-server errors,
- still-pending tasks:
  - use cached tool definitions if available (`MCPToolCache.get`) to create `DeferredMCPTool`s,
  - otherwise block until those pending tasks settle.

This is a hybrid startup model: fast return when cache is available, correctness wait when cache is not.

Each pending `toolsPromise` also has a background continuation that eventually:

- replaces that server's tool slice in manager state via `#replaceServerTools`,
- writes cache,
- logs late failures only after startup (`allowBackgroundLogging`).

### Tool exposure and live-session availability

`discoverAndLoadMCPTools()` converts manager tools into `LoadedCustomTool[]` and decorates paths (`mcp:<server> via <providerName>` when known). `createAgentSession()` then pushes these tools into `customTools`, which are wrapped and added to the runtime tool registry with names like `mcp__<server>_<tool>`.

- `MCPTool` calls tools through an already connected `MCPServerConnection`.
- `DeferredMCPTool` waits for `waitForConnection(server)` before calling; this allows cached tools to exist before connection is ready.
- Both attempt a reconnect + single retry for retriable connection failures.

Both return structured tool output and convert remaining transport/tool errors into `MCP error: ...` tool content (abort remains abort).

### Refresh/reload paths

Initial startup path: one-time discovery/load in `sdk.ts`; tools are registered in initial session tool registry.

`/mcp reload` path (`packages/coding-agent/src/modes/controllers/mcp-command-controller.ts`):

1. `mcpManager.disconnectAll()`,
2. `mcpManager.discoverAndConnect()`,
3. `session.refreshMCPTools(mcpManager.getTools())`.

`session.refreshMCPTools()` (`packages/coding-agent/src/session/agent-session.ts`) removes all `mcp__` tools, re-wraps latest MCP tools, and re-activates tool set so MCP changes apply without restarting session.

There is also a follow-up path for late connections: after waiting for a specific server, if status becomes `connected`, it re-runs `session.refreshMCPTools(...)` so newly available tools are rebound in-session.

### Health, reconnect, and partial failure behavior

The runtime is connection-event driven:

- **No autonomous polling health monitor** in manager/client.
- **Automatic reconnect is wired to `transport.onClose`** for managed connections.
- Reconnect retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and notifies consumers on success.
- Tool calls that see retriable connection errors also attempt one reconnect + retry.
- Reconnect is also explicit via `/mcp reconnect <name>` or broader `/mcp reload`.

Operationally:

- one server failing does not remove tools from healthy servers,
- connect/list failures are isolated per server,
- stale tools may remain visible while reconnect is attempted; calls report MCP errors if recovery fails,
- tool cache, resource/prompt loading, subscriptions, and background updates are best-effort (warnings/errors logged, no hard stop).

### Teardown semantics

`disconnectServer(name)`:

- removes pending entries, source metadata, saved config, resource refresh/subscription state,
- detaches `onClose` so explicit close does not trigger reconnect,
- closes transport if connected,
- filters manager tool state for names beginning with `mcp__${name}_`.

`disconnectAll()`:

- detaches `onClose` for all active transports, then closes them with `Promise.allSettled`,
- clears pending maps, sources, saved configs, connections, subscriptions, resource refreshes, and manager tool list.

In current wiring, explicit teardown is used in MCP command flows (for reload/remove/disable). Startup stores the manager on the session; callers that need deterministic MCP shutdown should invoke manager disconnect methods.

`src/mcp/index.ts` re-exports loader/manager/client APIs for external callers. `src/sdk.ts` exposes `discoverMCPServers()` as a convenience wrapper returning the same loader result shape.

### Failure modes and guarantees

| Scenario                                             | Behavior                                                                                                                  | Hard fail vs best-effort       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Discovery throws (capability/config load path)       | Loader returns empty tools + synthetic `.mcp.json` error                                                                  | Best-effort session startup    |
| Invalid server config                                | Server skipped with validation error entry                                                                                | Best-effort per server         |
| Connect timeout/init failure                         | Server error recorded; others continue                                                                                    | Best-effort per server         |
| `tools/list` still pending at startup with cache hit | Deferred tools returned immediately                                                                                       | Best-effort fast startup       |
| `tools/list` still pending at startup without cache  | Startup waits for pending to settle                                                                                       | Hard wait for correctness      |
| Late background tool-load failure                    | Logged after startup gate                                                                                                 | Best-effort logging            |
| Runtime dropped transport                            | Manager attempts reconnect; stale tools remain while reconnecting and future calls may retry once or fail with MCP errors | Best-effort automatic recovery |

## Part 3 — Protocol and transport internals

How the coding agent implements MCP JSON-RPC messaging and how protocol concerns are split from transport concerns.

### Layer boundaries

Protocol layer (JSON-RPC + MCP methods):

- Message shapes are defined in `types.ts` (`JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`, `JsonRpcMessage`).
- MCP client logic (`client.ts`) decides method order and session handshake:
  1. `initialize` request
  2. for HTTP/SSE transports, start the optional background SSE listener after the initialize response has established any session id
  3. `notifications/initialized` notification
  4. method calls like `tools/list`, `tools/call`

Transport layer (`MCPTransport`):

- `request(method, params, options?) -> Promise<T>`
- `notify(method, params?) -> Promise<void>`
- `close()`
- `connected`
- optional callbacks: `onClose`, `onError`, `onNotification`, `onRequest`

Transport implementations own framing and I/O details:

- `StdioTransport`: newline-delimited JSON over subprocess stdio
- `HttpTransport`: JSON-RPC over HTTP POST, with optional SSE responses/listening

Manager/client wiring:

- `connectToServer()` always installs an `onRequest` handler for standard server-to-client requests.
- `MCPManager` installs notification handlers, OAuth refresh hooks for HTTP OAuth servers, and `onClose` reconnect handling for managed connections.

### Transport selection

`client.ts:createTransport()` chooses transport from config:

- `type` omitted or `"stdio"` -> `createStdioTransport`
- `"http"` or `"sse"` -> `createHttpTransport`

`"sse"` is treated as an HTTP transport variant (same class), not a separate transport implementation.

### JSON-RPC message flow and correlation

Request IDs: each transport generates per-request IDs with `Snowflake.next()`. IDs are transport-local correlation tokens.

Stdio correlation path:

- Outbound request is serialized as one JSON object + `\n`.
- `#pendingRequests: Map<id, {resolve,reject}>` stores in-flight requests.
- Read loop parses JSONL from stdout and calls `#handleMessage`.
- If inbound message has matching `id`, request resolves/rejects.
- If inbound message has `method` and no `id`, treated as notification and sent to `onNotification`.
- If inbound message has both `method` and `id`, treated as a server-to-client request and answered through `onRequest`; without a handler the transport replies with JSON-RPC `-32601 Method not found`.

Unknown response IDs are ignored (no rejection, no error callback).

HTTP correlation path:

- Outbound request is HTTP `POST` with JSON body and generated `id`.
- Non-SSE response path: parse one JSON-RPC response and return `result`/throw on `error`.
- SSE response path (`Content-Type: text/event-stream`): stream events, return first message whose `id` matches expected request ID and has `result` or `error`.
- SSE messages with `method` and no `id` are treated as notifications.
- SSE messages with both `method` and `id` are treated as server-to-client requests and answered with a POSTed JSON-RPC response.

If SSE stream ends before matching response, request fails with `No response received for request ID ...`. After the matching response is captured, the transport drains remaining SSE messages in the background.

Notifications:

- Client emits JSON-RPC notifications via `transport.notify(...)`.
- Stdio: writes notification frame to stdin (`jsonrpc`, `method`, optional `params`) plus newline.
- HTTP: sends POST body without `id`; success accepts `2xx` or `202 Accepted`.

Server-initiated notifications are surfaced through transport `onNotification`; `MCPManager` consumes known MCP list/update notifications and can forward all notifications through its own callback.

### Stdio transport internals

Lifecycle and state transitions:

- Initial: `connected=false`, `process=null`, pending map empty
- `connect()`:
  - spawn subprocess with configured command/args/env/cwd
  - mark connected
  - start stdout read loop (`readJsonl`)
  - start stderr loop (read/discard; currently silent)
- `close()`:
  - mark disconnected
  - reject all pending requests (`Transport closed`)
  - kill subprocess
  - await read loop shutdown
  - emit `onClose`

If read loop exits unexpectedly, `finally` triggers `#handleClose()` which performs the same pending-request rejection and close callback.

Timeout and cancellation:

- per request, timeout defaults to `config.timeout ?? 30000`
- optional `AbortSignal` from caller
- abort and timeout both reject the pending promise and clean map entry
- cancellation is local only: transport does not send protocol-level cancellation notification to the server

Malformed payload handling:

- each parsed JSONL line is passed to `#handleMessage` in `try/catch`
- malformed/invalid message handling exceptions are dropped (`Skip malformed lines` comment)
- loop continues, so one bad message does not kill the connection
- if the underlying stream parser throws, `onError` is invoked (when still connected), then connection closes

Disconnect/failure behavior:

- all in-flight requests are rejected with `Transport closed`
- no automatic restart or reconnect
- higher layers must reconnect by creating a new transport

Backpressure/streaming notes:

- outbound writes use `stdin.write()` + `flush()` without awaiting drain semantics
- no explicit queue or high-watermark management in transport
- inbound processing is stream-driven (`for await` over `readJsonl`), one parsed message at a time

### HTTP/SSE transport internals

Lifecycle and connection semantics:

- `connect()` sets `connected=true` (no socket/session handshake)
- optional server session tracking via `Mcp-Session-Id` header
- `close()` optionally sends `DELETE` with `Mcp-Session-Id`, aborts SSE listener, emits `onClose`

So `connected` means "transport usable", not "persistent stream established".

Session header behavior:

- On POST response, if `Mcp-Session-Id` header is present, transport stores it.
- Subsequent requests/notifications include `Mcp-Session-Id`.
- `close()` tries to terminate server session with HTTP DELETE; termination failures are ignored.

Timeout, cancellation, and auth refresh:

- for `request()`: timeout uses `AbortController` (`config.timeout ?? 30000`); external signal, if provided, is merged via `AbortSignal.any([...])`; AbortError handling distinguishes caller abort vs timeout
- for `notify()`: timeout uses an internal `AbortController` (`config.timeout ?? 30000`); there is no external abort option on the transport interface
- for HTTP OAuth configs managed by `MCPManager`, `request()` retries once on `HTTP 401`/`403` if token refresh returns replacement headers

HTTP error propagation:

- on non-OK response, response text is included in thrown error (`HTTP <status>: <text>`)
- if present, auth hints from `WWW-Authenticate` and `Mcp-Auth-Server` are appended
- on JSON-RPC error object, throws `MCP error <code>: <message>`
- malformed JSON body (`response.json()` failure) propagates as parse exception

SSE behavior and modes:

1. **Per-request SSE response** (`#parseSSEResponse`): used when POST response content type is `text/event-stream`; consumes stream until matching response id found; can process interleaved notifications during same stream.
2. **Background SSE listener** (`startSSEListener()`): optional GET listener for server-initiated notifications and server-to-client requests; `connectToServer()` starts it for HTTP/SSE transports after `initialize` and before `notifications/initialized`; if GET returns `405`, another non-OK status, or no body, listener silently disables itself.

Malformed payload and disconnect handling:

- SSE JSON parsing errors bubble out of `readSseJson` and reject request/listener.
- Request SSE parse errors reject the active request.
- Background listener errors trigger `onError` (except AbortError).
- Transport does not restart the listener itself; managed connections may reconnect through manager `onClose` handling.

### `json-rpc.ts` utility vs transport abstraction

`packages/coding-agent/src/mcp/json-rpc.ts` provides `callMCP()` and `parseSSE()` helpers for direct HTTP MCP calls (used by Exa integration), not the `MCPTransport` abstraction used by `MCPClient`/`MCPManager`.

Notable differences from `HttpTransport`:

- parses entire response text first, then extracts first `data: ` line (`parseSSE`), with JSON fallback
- no request timeout management, no abort API, no session-id handling, no transport lifecycle
- returns raw JSON-RPC envelope object

This path is lightweight but less robust than full transport implementation.

### Retry/reconnect responsibilities

Transport-level: current transport implementations do **not**:

- retry ordinary failed requests, except the HTTP transport's single OAuth-refresh retry when `onAuthError` is wired
- reconnect after stdio process exit
- reconnect SSE listeners by themselves
- resend in-flight requests after disconnect

They fail fast and propagate errors.

Manager/tool-bridge level:

- `MCPManager` wires `transport.onClose` for managed connections and runs `reconnectServer(name)` when a transport closes unexpectedly. Reconnect tears down the stale connection, re-resolves auth/config values, retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and preserves stale tools while reconnecting.
- `MCPTool` and `DeferredMCPTool` also attempt one reconnect + retry for retriable connection errors during a tool call. This is tool availability recovery, not transport-level retry.

### Failure scenarios summary

- **Malformed stdio message line**: dropped; stream continues.
- **Stdio stream/process ends**: transport closes; pending requests rejected as `Transport closed`; manager-managed connections trigger reconnect.
- **HTTP non-2xx**: request/notify throws HTTP error; managed OAuth requests can refresh auth and retry once on 401/403.
- **Invalid JSON response**: parse exception propagated.
- **SSE ends without matching id**: request fails with `No response received for request ID ...`.
- **Timeout**: transport-specific timeout error.
- **Caller abort**: AbortError/reason propagated from caller signal where the method accepts one.

### Practical boundary rule

If the concern is message shape, id correlation, or MCP method ordering, it belongs to protocol/client logic.

If the concern is framing (JSONL vs HTTP/SSE), stream parsing, fetch/spawn lifecycle, timeout clocks, or connection teardown, it belongs to transport implementation.

## Troubleshooting

### `Server "name": stdio server requires "command" field`

You probably omitted `type: "http"` on a remote server.

### `Server "name": both "command" and "url" are set`

Pick one transport. `command` treats as stdio and `url` as http/sse.

### `/mcp add` worked but the server still does not connect

The JSON is valid, but the server may still be unreachable. Use `/mcp test <name>` and check whether:

- the binary or Docker image exists
- required environment variables are set
- the remote URL is reachable
- the OAuth or API token is valid

### The server exists in another tool's config but not in CornField

Run `/mcp list`. The agent discovers many third-party MCP files, but project-level loading can also be disabled via the `mcp.enableProjectConfig` setting, and a user-level `disabledServers` entry can suppress a server by name.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/