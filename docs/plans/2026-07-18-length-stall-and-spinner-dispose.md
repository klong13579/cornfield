# Length Stall + Spinner Dispose Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fuse progressless `length` empty-spins in the agent loop and dispose TUI timer children before clear/rebuild so orphaned spinners cannot grow WebKit heap.

**Architecture:** Stall counter in `runLoop` (agent package) with settings; follow-up re-entry gated while stalled/fused. `Component.dispose?` + `Container.clear`/`removeChild` dispose-before-drop; event-controller finalizes pending tools on `length` like abort. TDD for both layers.

**Tech Stack:** Bun, `bun:test`, TypeScript, existing doom-loop/settings patterns.

**Design:** `docs/plans/2026-07-18-length-stall-and-spinner-dispose-design.md`

---

### Task 1: Failing test — progressless length stall fuse

**Files:**
- Create: `packages/agent/test/length-stall-circuit.test.ts`
- Modify: (none yet)

**Step 1: Write the failing test**

Mock stream that returns three assistant messages: each `stopReason: "length"`, content = one thinking block only (no toolCall). Assert after third: loop ends (`agent_end`), model was invoked exactly 3 times (or ≤ N), and a fourth follow-up queued mid-run does not cause a 4th model call in the same run.

Use the same EventStream / agentLoop test helpers as `doom-loop-e2e.test.ts` / `doom-loop-recovery.test.ts`.

**Step 2: Run test to verify it fails**

```bash
bun test packages/agent/test/length-stall-circuit.test.ts
```

Expected: FAIL (no stall logic yet — loop may continue or hang on follow-ups).

**Step 3: Commit test only (optional checkpoint)**

```bash
git add packages/agent/test/length-stall-circuit.test.ts
git commit -m "test(agent): add failing length-stall circuit coverage"
```

---

### Task 2: Implement stall counter in `runLoop`

**Files:**
- Modify: `packages/agent/src/agent-loop.ts`
- Modify: `packages/agent/src/types.ts` (`AgentLoopConfig` — add optional `lengthStall?: { enabled?: boolean; maxConsecutive?: number }`)

**Step 1: Minimal implementation**

In `runLoop`:
- Read `N = config.lengthStall?.maxConsecutive ?? 3`, skip if `enabled === false`.
- Track `stallCount`.
- After each assistant message:
  - If progressless length → `stallCount++`; if `≥ N` → push `agent_end`, `stream.end`, return.
  - If has toolCall or productive stop → `stallCount = 0`.
- When deciding outer follow-up continue: if `stallCount >= 1`, **do not** `continue` outer while (leave follow-ups for next run). Prefer not draining follow-ups into a wasted turn; document deferred behavior.

Helper:

```ts
function isProgresslessLength(message: AssistantMessage): boolean {
  if (message.stopReason !== "length") return false;
  return !message.content.some(c => c.type === "toolCall");
}
```

**Step 2: Run test**

```bash
bun test packages/agent/test/length-stall-circuit.test.ts
```

Expected: PASS for fuse; add case: `length` + toolCall resets and continues.

**Step 3: Commit**

```bash
git add packages/agent/src/agent-loop.ts packages/agent/src/types.ts packages/agent/test/length-stall-circuit.test.ts
git commit -m "fix(agent): fuse consecutive progressless length turns"
```

---

### Task 3: Wire settings + Agent config

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/sdk.ts` (pass `lengthStall` into agent loop config alongside `doomLoop`)
- Modify: `packages/agent/src/agent.ts` if opts need `lengthStall` field on Agent

**Step 1:** Add:
- `agent.lengthStall.enabled` default `true`
- `agent.lengthStall.maxConsecutive` default `3`

**Step 2:** Resolve and pass into `AgentLoopConfig`.

**Step 3:** Quick settings unit test if pattern exists; else skip.

**Step 4: Commit**

```bash
git commit -m "feat(coding-agent): settings for length stall circuit"
```

---

### Task 4: Follow-up deferral while stalled

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` and/or `packages/coding-agent/src/session/agent-session.ts` (`#canAutoContinueForFollowUp`, `#queueFollowUp`)

**Step 1:** When last assistant was progressless length and stall open (or agent just fused), do not `#scheduleAgentContinue` for async follow-ups; keep queue for next user turn.

**Step 2:** Test: after one progressless length, enqueue follow-up → no immediate extra model call until user prompt / continue.

**Step 3: Commit**

```bash
git commit -m "fix(agent): defer follow-ups during length stall"
```

---

### Task 5: Failing test — dispose on clear / length

**Files:**
- Modify: `packages/coding-agent/test/modes/controllers/event-controller-abort-spinners.test.ts`
- Create (optional): `packages/tui/test/container-dispose.test.ts`

**Step 1:** Tests:
1. `Container.clear()` calls child `dispose()`.
2. After simulated `message_end` with `stopReason: "length"` and pending tool component with spinner, 200ms → no further `requestRender`.
3. `rebuildChatFromMessages` / clear after running Loader → timers stopped.

**Step 2:** Run — expect FAIL before implementation.

---

### Task 6: `Component.dispose?` + Container dispose-before-clear

**Files:**
- Modify: `packages/tui/src/tui.ts`
- Modify: `packages/tui/src/components/loader.ts` (`dispose() { this.stop(); }`)
- Modify: other Loaders (cancellable-loader) if needed

**Step 1: Implement**

```ts
clear(): void {
  for (const child of this.children) child.dispose?.();
  this.children = [];
}
```

Idempotent `dispose` on Loader.

**Step 2:** Run TUI + spinner tests → PASS.

**Step 3: Commit**

```bash
git commit -m "fix(tui): dispose children before Container.clear"
```

---

### Task 7: EventController finalize on length

**Files:**
- Modify: `packages/coding-agent/src/modes/controllers/event-controller.ts`
- Modify: spinner regression test

**Step 1:** On `message_end`, if `stopReason === "length"`, dispose pending tools (same as abort/error path), not only `setArgsComplete`.

**Step 2:** Run `event-controller-abort-spinners.test.ts` → PASS.

**Step 3: Commit**

```bash
git commit -m "fix(coding-agent): dispose pending tool spinners on length"
```

---

### Task 8: CHANGELOG + smoke

**Files:**
- Modify: `packages/agent/CHANGELOG.md`, `packages/tui/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`

**Step 1:** Document Fixed entries referencing this design.

**Step 2:**

```bash
bun test packages/agent/test/length-stall-circuit.test.ts packages/coding-agent/test/modes/controllers/event-controller-abort-spinners.test.ts
```

**Step 3: Commit**

```bash
git commit -m "docs: changelog for length stall and spinner dispose"
```

---

## Manual verification

1. Reproduce-ish: force model max_tokens tiny + thinking-only → after 3 length, agent stops and warns.
2. Long edit batch truncated mid-toolCall → still continues (stall resets).
3. Handoff / rebuild chat → RSS stable; no runaway requestRender when idle.

## Execution

After plan save, choose:
1. Subagent-driven (this session)
2. Separate session with executing-plans
