# Length Stall Circuit Breaker + Spinner Dispose Design

**Date:** 2026-07-18  
**Status:** Approved  
**Approach:** B — conditional length stall fuse + dispose-before-clear

## Background

Interactive `omp` PID 33923 (`omp-atomix`, ~22h) reached ~20GB `WebKit Malloc` footprint. Root causes:

1. **Agent empty-spin:** `runLoop` treats `stopReason: "length"` like a continuable turn. Pure-thinking length storms (no toolCall) plus `async-result` follow-ups re-entered the outer loop without user input (observed: up to 9 consecutive length turns).
2. **Orphaned TUI spinners:** `Loader` / tool spinners use 80ms `setInterval` → `requestRender()`. `Container.clear()` drops children without `dispose()`/`stop()`, so intervals keep allocating into JSC heap. Abort-path dispose was fixed in `d565e8ddd` (2026-07-02); `clear()` / rebuild / handoff paths remain open.

`length` continue itself is legitimate (truncated toolCall batches, long answers). The bug is **unconditional** continue.

## Goals

- Fuse **progressless** `length` runs so agent does not empty-spin.
- Dispose all timer-owning UI children before clear/rebuild/handoff.
- Keep normal continue for `length` + toolCall and productive text turns.
- Settings kill-switch for the stall fuse.

## Non-goals

- Changing doom-loop *intra-stream* detection algorithm.
- Treating every `length` as hard abort.
- Process-level OOM killer / heap profiler.

---

## Part A — Length stall circuit breaker

### Location

`packages/agent/src/agent-loop.ts` (`runLoop`), config on `AgentLoopConfig` / settings wired from `packages/coding-agent/src/sdk.ts`.

### Definition: progressless length

A message counts as progressless length when:

- `stopReason === "length"`, **and**
- content has **no** `toolCall` blocks.

(Having visible `text` still counts as progressless for *stall counting* only if we want stricter fuse later; **v1:** no toolCall is enough — matches the observed storm of think-only length.)

### Counter (per agent run)

- `stallCount` starts at 0 at `runLoop` entry.
- Progressless length → `stallCount++`.
- Reset to 0 when:
  - assistant message has ≥1 `toolCall`, or
  - `stopReason === "stop"` with visible text, or
  - user/steering message injected that is not a system async follow-up (optional; v1: reset on any toolCall or clean stop-with-text).

### Behavior

| Case | Action |
|------|--------|
| `length` + toolCall(s) | Execute tools as today; reset `stallCount`; continue |
| Progressless `length`, `stallCount < N` | Finish turn; **do not** re-enter outer loop via follow-ups this run (see Follow-up gate); leave deferred follow-ups for next user turn |
| Progressless `length`, `stallCount ≥ N` | Emit `agent_end` with descriptive `errorMessage`; end run |
| `aborted` / `error` | Unchanged (hard stop) |

**Default `N`:** 3 (`agent.lengthStall.maxConsecutive`).

### Follow-up gate

When `stallCount ≥ 1` after a progressless length (and before reset):

- Outer `getFollowUpMessages` must **not** continue the same run.
- Prefer: dequeue into a **deferred** queue (or leave in agent follow-up queue but skip auto-continue) so subagent `async-result` is not lost — delivered on next user prompt / explicit continue.
- Reuse existing `#canAutoContinueForFollowUp` / `clearFollowUpQueue` / deferred patterns in `agent-session.ts` where possible.

When `stallCount ≥ N`, open the circuit and end; deferred messages still available next turn.

### Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `agent.lengthStall.enabled` | `true` | Master switch |
| `agent.lengthStall.maxConsecutive` | `3` | Fuse threshold |

Wire through settings schema + `resolveDoomLoopConfig`-style helper in `sdk.ts` (or sibling resolver).

### UX

On fuse: status/warning in TUI (existing `showWarning` path) — e.g. “Stopped: repeated length with no tool progress. Reply to continue; queued follow-ups will run then.”

---

## Part B — Spinner dispose-before-clear

### Location

- `packages/tui/src/tui.ts` — `Component`, `Container`
- `packages/coding-agent` — event-controller length finalize; components already have `dispose()`

### P0 — Container lifecycle

```ts
interface Component {
  // existing...
  dispose?(): void;
}

clear(): void {
  for (const child of this.children) {
    child.dispose?.();
  }
  this.children = [];
}

removeChild(component: Component): void {
  // dispose then splice (or dispose only if removed)
}
```

- `Loader`: `dispose()` → `stop()`.
- `CancellableLoader` / bash / python / tool execution: already dispose; ensure Loader children are covered when parent dispose runs.
- `rebuildChatFromMessages`, handoff `chatContainer.clear()`, selector clears — all inherit fix.

### P1 — `length` message_end finalize

In `event-controller.ts` `#handleMessageEnd`:

- Today: abort/error → `dispose()` pending; else → `setArgsComplete()`.
- Change: treat `length` like abort for **pending tool UI finalize** (call `dispose()` on pending tools), or extract `finalizePendingTools(reason)` used by abort/error/length.

`#handleAgentEnd` dispose paths remain.

### P2 — Tests

1. **Agent:** consecutive mock progressless length × N → no further model calls; `agent_end` fired; follow-up does not restart same run.
2. **TUI/coding-agent:** extend `event-controller-abort-spinners.test.ts` — after `length` finalize and after `rebuildChatFromMessages`/`clear`, wait 200ms → 0 extra `requestRender`.
3. Optional: `Container.clear` unit test that child `dispose` was called.

---

## Data flow

```
LLM length
  ├─ has toolCall → execute → stall=0 → continue
  └─ no toolCall → stall++
        ├─ stall < N → end turn; block follow-up re-entry this run (defer)
        └─ stall ≥ N → agent_end (circuit open)

UI clear / rebuild / handoff
  → dispose(timer children) → drop refs
  → no orphaned setInterval
```

## Risks

| Risk | Mitigation |
|------|------------|
| Long productive answers truncated mid-text | v1 only fuses no-toolCall length; text-only length can still continue once unless N hit — tune N |
| Subagent results delayed | Defer to next user turn; document in warning |
| Double-dispose | `dispose` must be idempotent (already true for Loader.stop) |

## Rollback

- Disable `agent.lengthStall.enabled`.
- Dispose-before-clear is backward compatible (no-op if no `dispose`).

## Implementation plan

See: `docs/plans/2026-07-18-length-stall-and-spinner-dispose.md`
