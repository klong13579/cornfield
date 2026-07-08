# Non-compaction auto-retry policy

This document describes the standard API-error retry path in `AgentSession`.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`compaction.md`](../docs/compaction.md).

## Implementation files

- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`../src/modes/rpc/rpc-client.ts`](../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../src/modes/rpc/rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` path, but they are intentionally separated:

1. `agent_end` inspects the last assistant message.
2. `#isRetryableError(...)` runs first.
3. If retry is initiated, compaction checks are skipped for that turn.
4. Context-overflow errors are hard-excluded from retry classification (`isContextOverflow(...)` short-circuits retry).
5. Overflow therefore falls through to `#checkCompaction(...)` instead of standard retry.

So: overload/rate/server/network-style failures use this retry policy; context-window overflow uses compaction recovery.

## Retry classification

`#isRetryableError(...)` requires all of the following:

- assistant `stopReason === "error"`
- `errorMessage` exists
- message is **not** context overflow
- `errorMessage` matches transient transport/envelope patterns or `isUsageLimitError(...)`

Current retryable inputs are regex/string-classified:

- transient transport/envelope failures, including Anthropic stream-envelope failures before `message_start`
- overloaded/provider-returned-error wording
- rate limit / usage limit / too many requests
- HTTP-like server classes: 403, 429, 500, 502, 503, 504
- service unavailable / server/internal error
- network/connection/socket failures, refused/closed connections, upstream connect/reset-before-headers, socket hang up, timeout/timed out, fetch failed, terminated, retry delay wording, and unexpected socket close messages

This is string-pattern classification, not typed provider error codes.

### 403 (access denied) handling

403 is included in the retryable list so that a model the account cannot use (e.g. `403 Model access denied`) does not leave the user stuck on a broken model. When a 403 enters the retry path:

- `parseRateLimitReason` classifies it as `ACCESS_DENIED`
- `calculateRateLimitBackoffMs("ACCESS_DENIED")` returns a 1-hour cooldown
- The selector is suppressed for 1h, so the restore cycle cannot re-pick the same 403 model within the session

Note: 401 is intentionally not in the retryable list. 401 is "token expired/invalid" and the current session cannot fix that mid-run; re-entering the retry path with the same bad token would just thrash.

### Cooldown escalation (flapping guard)

A plain cooldown from `parseRateLimitReason` (5min for UNKNOWN, 45-75s for MODEL_CAPACITY, 1h for ACCESS_DENIED) is sufficient when errors are spaced apart. When the **same selector** fails repeatedly within a 60s window, the cooldown is too short — the next `#maybeRestoreRetryFallbackPrimary()` cycle picks the same selector and triggers another failure (5 model changes in 5s observed in production session `042253__37002e77`).

`#noteRetryFallbackCooldown` keeps a `Map<selector, lastFailureTimestamp>` and calls `computeRetryFallbackCooldown(...)` from [`../src/session/retry-fallback-cooldown.ts`](../packages/coding-agent/src/session/retry-fallback-cooldown.ts):

- First failure of a selector → use the plain cooldown from `parseRateLimitReason`
- Repeat failure within the flapping window → `max(baseCooldownMs * 5, 5 * 60 * 1000)`. A 5s base becomes a 5min floor; a 1h ACCESS_DENIED becomes 5h
- Repeat failure outside the flapping window → treat as cold cache, use the plain cooldown

This breaks the primary → fallback → restore → primary loop without affecting cold-cache behavior.

### User-configurable knobs (settings schema)

Both behaviors are tunable via the `retry` settings group:

| Setting | Default | Effect |
|---|---|---|
| `retry.fallbackCooldownMs` | 60000 | Hard floor applied to the final cooldown. The floor is applied **after** the flapping escalation, so a high user floor (e.g. 10 min) survives a flapping episode that would otherwise produce only 5 min. Prevents thrashing when upstream signals a very short `retry-after-ms` (e.g. 200 ms). |
| `retry.fallbackFlappingWindowMs` | 60000 | Time window for flapping detection. If the same selector fails again within this window, its cooldown is escalated (× 5, floored at 5 min). Set higher to be more permissive; lower to escalate sooner. |

Both default to 60s and are exposed in the model settings tab. `0` or negative values disable the corresponding behavior.

## Retry lifecycle and state transitions

Session state used by retry:

- `#retryAttempt: number` (`0` means idle)
- `#retryPromise: Promise<void> | undefined` (tracks in-progress retry lifecycle)
- `#retryResolve: (() => void) | undefined` (resolves `#retryPromise`)
- `#retryAbortController: AbortController | undefined` (cancels backoff sleep)

Flow (`#handleRetryableError`):

1. Read `retry` settings group.
2. If `retry.enabled === false`, stop immediately (`false`, no retry started).
3. Increment `#retryAttempt`.
4. Create `#retryPromise` once (first attempt in a chain).
5. If attempt exceeded `retry.maxRetries`, emit final failure event and stop.
6. Compute base delay: `retry.baseDelayMs * 2^(attempt-1)`.
7. For usage-limit errors, parse retry hints and call auth storage (`markUsageLimitReached(...)`); if credential switching succeeds, force delay to `0`, otherwise use a larger retry-after/backoff hint when present.
8. If no credential switch occurred, suppress the current model selector for cooldown, try configured retry model fallback chains, and force delay to `0` on model switch.
9. Emit `auto_retry_start`.
10. Remove the trailing assistant error message from agent runtime state (kept in persisted session history).
11. Sleep with abort support.
12. Schedule `agent.continue()` through the post-prompt task scheduler (`delayMs: 1`) for the same prompt generation.

### What resets retry counters

`#retryAttempt` resets to `0` in these cases:

- first successful non-error, non-aborted assistant message after retries started (emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path

`#retryPromise` resolves/clears when retry chain ends (success, cancellation, or max-exceeded), via `#resolveRetry()`.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `3`)
- `retry.baseDelayMs` (default `2000`)

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#retryAttempt - 1` (last attempted retry count)

Backoff sequence with default settings:

- attempt 1: 2000 ms
- attempt 2: 4000 ms
- attempt 3: 8000 ms

Delay override inputs can come from parsed retry headers (`retry-after-ms`, `retry-after`, `x-ratelimit-reset-ms`, `x-ratelimit-reset`) or usage-limit backoff. Credential/model fallback switches set delay to `0`; otherwise parsed hints can extend the exponential local delay.

## Abort mechanics

### Explicit retry abort

`abortRetry()`:

- aborts `#retryAbortController` (if present)
- resolves retry promise (`#resolveRetry()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController:

- swaps `Esc` handler to `session.abortRetry()`
- renders loader text: `Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

On `auto_retry_end`, it restores prior `Esc` handler and clears loader state.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForRetry()` after `agent.prompt(...)` returns.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and RPC

### Configuration knobs

Defined in settings schema under retry group:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.fallbackChains`
- `retry.fallbackRevertPolicy` (`"cooldown-expiry"` by default; `"never"` disables automatic restoration)

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether retry lifecycle promise is active

### RPC controls

RPC command surface:

- `set_auto_retry` → `session.setAutoRetryEnabled(command.enabled)`
- `abort_retry` → `session.abortRetry()`

Client helpers:

- `RpcClient.setAutoRetry(enabled)`
- `RpcClient.abortRetry()`

Both commands return success responses; retry progress/failure details come from streamed session events, not command response payloads.

## Event emission and failure surfacing

Session-level retry events:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }`
- `auto_retry_end { success, attempt, finalError? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- in RPC mode, forwarded directly as JSON event objects (`session.subscribe(event => output(event))`)
- in TUI, consumed by `EventController` for loader/error UI

Final failure surfacing:

- On max-exceeded or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>`
- Extensions/hooks receive `auto_retry_end` with same fields
- RPC consumers receive same event object on stdout stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries exceeded
- user cancels retry (`abort_retry` or `Esc` during retry loader)
- global abort (`abort`) cancels retry first

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Classification is regex text matching; provider-specific structured errors are not used here.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry.
- `RpcSessionState` currently exposes `autoCompactionEnabled` but not an `autoRetryEnabled` field; RPC callers must track their own toggle state or query settings through other APIs.
- Model fallback changes append temporary `model_change` entries and may later restore the primary model when its cooldown expires, depending on `retry.fallbackRevertPolicy`.
