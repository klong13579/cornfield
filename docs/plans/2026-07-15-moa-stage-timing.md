# MOA Stage Timing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-stage wall-clock timing to MOA with live TUI updates, per-stage notify, and a final summary.

**Architecture:** Pure helpers in `timing.ts`; status bar accepts optional `elapsedMs`; `executePlan` owns a stage clock + 500ms ticker when `hasUI`.

**Tech Stack:** Bun, bun:test, existing `notify` / `setWorkingMessage` / `setStatus` Extension UI hooks.

---

### Task 1: `timing.ts` helpers

**Files:**
- Create: `packages/moa-extension/src/timing.ts`
- Test: `packages/moa-extension/test/timing.test.ts`

**Step 1: Write failing tests** for `formatDuration`, `formatTimingSummary`, and a simple elapsed helper.

**Step 2: Implement** until green.

**Step 3: Commit** `feat(moa): add stage timing helpers`

### Task 2: Status bar elapsed

**Files:**
- Modify: `packages/moa-extension/src/status-bar.ts`
- Modify: `packages/moa-extension/test/status-bar.test.ts`

**Step 1: Failing test** — when `elapsedMs` set, bar ends with ` · 3.2s`.

**Step 2: Implement** append formatted duration.

**Step 3: Commit** `feat(moa): show elapsed time on status bar`

### Task 3: Wire `executePlan`

**Files:**
- Modify: `packages/moa-extension/src/executor.ts`
- Modify: `packages/moa-extension/src/types.ts` (`timings?` on result)
- Test: extend `packages/moa-extension/test/executor.test.ts` — assert notify/setWorking messages include durations when UI mocks are provided; assert `result.timings` keys.

**Step 1: Failing test** with fake timers / stubbed engine that resolves quickly; capture notify + setWorking calls.

**Step 2: Implement** stage starts/stops, ticker, notify suffixes, final summary, `timings` on return (including early quality-fail path).

**Step 3: Commit** `feat(moa): emit stage timings during executePlan`

### Task 4: Verify

Run: `bun test packages/moa-extension/test/timing.test.ts packages/moa-extension/test/status-bar.test.ts packages/moa-extension/test/executor.test.ts`
