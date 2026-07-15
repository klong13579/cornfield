# MOA Quality Check v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade MOA worker quality gating to per-role weighted heuristics plus an optional hybrid LLM judge (default off, model `narwal-plan/minimax-m3`).

**Architecture:** New `packages/moa-extension/src/quality/` module owns weights, heuristic v2, judge trigger/merge, and `applyWorkerQuality`. `worker-parser.ts` keeps parsing and re-exports thin wrappers. `stages.ts` awaits the new apply path. Settings gain a nested `quality` block; archive/dispatchLog carry `qualityMeta`.

**Tech Stack:** Bun, `bun:test`, Handlebars-style static `.md` prompts (same pattern as other moa prompts), existing `spawnMoaWorker` / WorkerEngine for judge spawn.

**Design:** [`docs/plans/2026-07-15-moa-quality-v2-design.md`](./2026-07-15-moa-quality-v2-design.md)

**GitNexus:** Before editing any symbol, run `impact({target, direction:"upstream"})` and report blast radius. Before commit, run `detect_changes()`.

---

### Task 1: Quality types + default weights

**Files:**
- Create: `packages/moa-extension/src/quality/types.ts`
- Create: `packages/moa-extension/src/quality/weights.ts`
- Create: `packages/moa-extension/test/quality-weights.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { DEFAULT_ROLE_WEIGHTS, resolveRoleWeights, V1_FALLBACK_WEIGHTS } from "../src/quality/weights";

describe("resolveRoleWeights", () => {
	it("maps divergent/grounded/critical by worker name", () => {
		expect(resolveRoleWeights("divergent", "").required).toBe(DEFAULT_ROLE_WEIGHTS.divergent.required);
		expect(resolveRoleWeights("critical", "").assumptions).toBe(DEFAULT_ROLE_WEIGHTS.critical.assumptions);
	});

	it("falls back to v1 uniform weights for unknown roles", () => {
		expect(resolveRoleWeights("worker-9", "extra perspective")).toEqual(V1_FALLBACK_WEIGHTS);
	});

	it("applies partial overrides from settings", () => {
		const w = resolveRoleWeights("critical", "", { critical: { assumptions: 40 } });
		expect(w.assumptions).toBe(40);
		expect(w.planSubstance).toBe(DEFAULT_ROLE_WEIGHTS.critical.planSubstance);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/moa-extension/test/quality-weights.test.ts`  
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

`types.ts`: `MoaQualityRoleWeights`, `MoaQualityJudgeSettings`, `MoaQualitySettings`, `MoaQualityMeta`, `WorkerQualityBreakdownV2`.

`weights.ts`: export tables from design §5.2; `resolveRoleWeights(name, role, overrides?)` — match name first, then role string includes token, else fallback; merge overrides shallowly per dimension.

**Step 4: Run test to verify it passes**

Run: `bun test packages/moa-extension/test/quality-weights.test.ts`  
Expected: PASS

**Step 5: Commit** (only if user asked to commit)

```bash
git add packages/moa-extension/src/quality/types.ts packages/moa-extension/src/quality/weights.ts packages/moa-extension/test/quality-weights.test.ts
git commit -m "$(cat <<'EOF'
feat(moa): add quality v2 role weight tables

EOF
)"
```

---

### Task 2: Heuristic v2 scorer

**Files:**
- Create: `packages/moa-extension/src/quality/heuristic.ts`
- Create: `packages/moa-extension/test/quality-heuristic.test.ts`
- Modify: `packages/moa-extension/src/worker-parser.ts` (move REFUSAL_PATTERNS usage or re-export)

**Step 1: Write the failing test**

Use same plan fixture (~250 chars plan, 1 open_question, assumptions present, no refusal). Score as `divergent` vs `critical` — expect divergent `planSubstance` contribution higher path → `divergent.score >= critical.score` on plan-heavy fixture; second fixture assumption-heavy short plan → `critical.score > divergent.score`.

Also: missing required → `score <= 30` and `contractHardFail: true`.

**Step 2: Run — expect FAIL**

`bun test packages/moa-extension/test/quality-heuristic.test.ts`

**Step 3: Implement `scoreWorkerHeuristicV2(parsed, schema, weights)`**

Per design §5.3: weighted hits, round, hard cap. Return `{ score, contractHardFail, breakdown }`.

**Step 4: Run — expect PASS**

**Step 5: Commit** (if requested)

---

### Task 3: `shouldJudge` + apply sync path (judge off)

**Files:**
- Create: `packages/moa-extension/src/quality/judge.ts` (export `shouldJudge` first)
- Create: `packages/moa-extension/src/quality/apply.ts`
- Create: `packages/moa-extension/src/quality/index.ts`
- Create: `packages/moa-extension/test/quality-should-judge.test.ts`
- Create: `packages/moa-extension/test/quality-apply.test.ts`

**Step 1: Failing tests for `shouldJudge`**

Truth table from design §6.1:

| enabled | hardFail | heuristic | minScore | margin | expect |
|---------|----------|-----------|----------|--------|--------|
| false | false | 35 | 40 | 10 | false |
| true | true | 20 | 40 | 10 | false |
| true | false | 35 | 40 | 10 | true (willDrop) |
| true | false | 45 | 40 | 10 | true (gray) |
| true | false | 70 | 40 | 10 | false |

**Step 2: Failing tests for `applyWorkerQuality` with `judge.enabled=false`**

- Sets `parsed`, `qualityScore`, `qualityDropped`, `qualityMeta.version===2`, `source==="heuristic"`, `judged===false`.
- Does not call `judgeFn` even if provided.

**Step 3: Implement**

```ts
export function shouldJudge(input: {
  enabled: boolean;
  contractHardFail: boolean;
  heuristicScore: number;
  minScore: number;
  grayMargin: number;
}): boolean
```

```ts
export async function applyWorkerQuality(
  result: MoaWorkerResult,
  schema: MoaOutputSchema,
  options: {
    minScore?: number;
    quality?: MoaQualitySettings;
    now?: () => Date;
    judgeFn?: (args: JudgeFnArgs) => Promise<JudgeResult>;
    task?: string;
    signal?: AbortSignal;
  },
): Promise<MoaWorkerResult>
```

When judge off or `!shouldJudge`: finalize from heuristic only.

**Step 4: Run tests — PASS**

**Step 5: Commit** (if requested)

---

### Task 4: Wire settings + types

**Files:**
- Modify: `packages/moa-extension/src/types.ts` — add `quality?: MoaQualitySettings` on `MoaSettings`; add `qualityMeta?` on `MoaWorkerResult`; optional fields on `MoaDispatchLogEntry`
- Modify: `packages/moa-extension/src/settings.ts` — `DEFAULT_QUALITY_SETTINGS`, resolve/clamp `quality.judge.*`
- Modify: `packages/moa-extension/test/settings.test.ts`

**Step 1: Failing tests**

- `DEFAULT_SETTINGS.quality.judge.enabled === false`
- `DEFAULT_SETTINGS.quality.judge.model === "narwal-plan/minimax-m3"`
- clamp `grayMargin` to ≥0; `timeoutMs` ≥0; unknown `mode` → `"hybrid"`
- partial `quality` merge keeps defaults

**Step 2: Implement resolve**

```ts
export const DEFAULT_QUALITY_JUDGE = {
  enabled: false,
  mode: "hybrid" as const,
  model: "narwal-plan/minimax-m3",
  grayMargin: 10,
  timeoutMs: 60_000,
  onError: "keep_heuristic" as const,
};
```

Merge into `DEFAULT_SETTINGS.quality = { judge: DEFAULT_QUALITY_JUDGE }`.

**Step 3: Run `bun test packages/moa-extension/test/settings.test.ts` — PASS**

**Step 4: Commit** (if requested)

---

### Task 5: Delegate `worker-parser` + stages async apply

**Files:**
- Modify: `packages/moa-extension/src/worker-parser.ts` — `scoreWorkerOutput` / `applyWorkerParsing` delegate to quality (sync apply without judge for back-compat sync callers)
- Modify: `packages/moa-extension/src/stages.ts` — replace `applyWorkerParsing` with `await applyWorkerQuality(..., { quality: settings.quality, task, minScore })`
- Modify: existing tests if they assumed exact v1 scores for named roles

**Important:** `applyWorkerParsing` stays **sync** for unit tests: call heuristic-only finalize (ignore judge even if enabled in options — document that async path is required for judge). Or make `applyWorkerParsing` call heuristic with role from `result.name`.

Preferred:
- `applyWorkerParsing` → sync heuristic v2 using `result.name`/`result.role` (no judge)
- `applyWorkerQuality` → async, full hybrid
- `stages.ts` uses **only** `applyWorkerQuality`

**Step 1:** Update `worker-parser.test.ts` score expectations if per-role changes break them (use `name: "unknown"` for v1-like fallback, or update expected numbers).

**Step 2:** Run:

```bash
bun test packages/moa-extension/test/worker-parser.test.ts
bun test packages/moa-extension/test/stages.test.ts
bun test packages/moa-extension/test/executor.test.ts
```

Expected: PASS (adjust fixtures if role weights shift scores across minScore).

**Step 3: Commit** (if requested)

---

### Task 6: Judge prompt + hybrid merge with mock

**Files:**
- Create: `packages/moa-extension/src/quality/prompts/judge.md`
- Modify: `packages/moa-extension/src/quality/judge.ts` — `parseJudgeResponse`, `runQualityJudge`
- Modify: `packages/moa-extension/src/quality/apply.ts` — call judgeFn when `shouldJudge`
- Modify: `packages/moa-extension/test/quality-apply.test.ts`

**Step 1: Failing tests**

- Mock `judgeFn` returns `{ score: 80 }` on heuristic 35 → final 80, `source:"judge"`, `judged:true`, `qualityDropped:false`
- Mock returns `{ score: 10 }` on heuristic 45 → dropped
- Mock throws → keep heuristic, `judgeError` set, `source:"heuristic"`
- `contractHardFail` → never calls `judgeFn`

**Step 2: Implement prompt + JSON parse**

Prompt: static import `judge.md` with `{ type: "text" }`; simple `{{var}}` replace (match how other moa prompts render, or tiny Handlebars if already used).

Judge spawn (production): thin wrapper using `spawnMoaWorker` with `tools: "none"`, model from settings, system prompt from template, task = JSON instruction payload. Injected `judgeFn` skips spawn in tests.

**Step 3: Run quality-apply tests — PASS**

**Step 4: Commit** (if requested)

---

### Task 7: Persist meta + status surface

**Files:**
- Modify: `packages/moa-extension/src/stages.ts` — copy `qualityMeta` into dispatch log entries
- Modify: `packages/moa-extension/src/trace.ts` — render `heuristic→judge` line when meta present
- Modify: `packages/moa-extension/src/extension.ts` — `/moa status` lines for judge
- Modify: `packages/moa-extension/test/trace.test.ts`
- Modify: `packages/moa-extension/CHANGELOG.md` under `## [Unreleased]`

**Step 1:** Tests for transcript/dispatch including `qualityMeta.source`

**Step 2:** Implement + CHANGELOG:

```md
### Changed
- MOA quality check v2: per-role heuristic weights; optional hybrid LLM judge (default off, `narwal-plan/minimax-m3`).
```

**Step 3:** Run targeted tests — PASS

**Step 4: Commit** (if requested)

---

### Task 8: README + config example

**Files:**
- Modify: `packages/moa-extension/README.md` — short “Quality v2” section with YAML snippet from design §5.1
- Modify: `docs/moa-multi-round-design.md` §6 / §15 — mark P1 LLM judge / P3 per-role as done via v2 doc link

**Step 1:** Edit docs only  
**Step 2:** No test required  
**Step 3: Commit** (if requested)

---

### Task 9: Verification sweep

**Step 1:** Run:

```bash
bun test packages/moa-extension/test/quality-weights.test.ts
bun test packages/moa-extension/test/quality-heuristic.test.ts
bun test packages/moa-extension/test/quality-should-judge.test.ts
bun test packages/moa-extension/test/quality-apply.test.ts
bun test packages/moa-extension/test/worker-parser.test.ts
bun test packages/moa-extension/test/settings.test.ts
bun test packages/moa-extension/test/stages.test.ts
bun test packages/moa-extension/test/executor.test.ts
bun test packages/moa-extension/test/trace.test.ts
```

Expected: all PASS

**Step 2:** GitNexus `detect_changes` before any commit; confirm only moa-extension quality paths + docs.

**Step 3:** Stop. Do **not** run full `bun test` / `bun check` unless user asks.

---

## Execution notes

- Prefer **TDD** per task (red → green).
- **YAGNI:** no `qualityMode: llm`, no per-role minScore, no acceptance CLI in this plan.
- Judge production spawn may land in Task 6 as `createDefaultJudgeFn(engine|spawn)` inside `judge.ts`; stages pass it when `enabled`.
- User rule: **do not commit unless explicitly asked** — skip commit steps until then.

---

## Plan complete

Saved to `docs/plans/2026-07-15-moa-quality-v2-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (this session)** — fresh subagent per task, review between tasks  
2. **Parallel Session (separate)** — new session with `executing-plans`, batch with checkpoints  

Which approach?
