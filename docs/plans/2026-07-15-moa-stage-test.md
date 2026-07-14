# MoA Stage-Test Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a real-LLM stage harness (`scripts/stage-test.ts`) that can run Discovery → Ask → Rewrite → Workers → Synthesis as smoke (`--stage all`) or per-stage (`--stage rewrite --from …`), with interactive Ask and artifacts under `tmp/moa-stage/`.

**Architecture:** Extract the five pipeline stages from `executor.ts` into exported runners in `stages.ts`. Keep `executePlan` as an orchestrator over those runners (behavior unchanged). The CLI script loads `moa.yml`, builds auth/modelRegistry, provides a minimal stdin `ExtensionUIContext`, and reads/writes stage JSON artifacts. Reuse existing `StageClock` from `timing.ts` for per-stage `durationMs` in artifacts.

**Tech Stack:** Bun, TypeScript, `@oh-my-pi/pi-coding-agent` (AuthStorage / ModelRegistry / Settings / ExtensionUIContext), existing `moa-extension` worker-engine + ask-user.

**Design doc:** `docs/plans/2026-07-15-moa-stage-test-design.md`

**Related:** `docs/plans/2026-07-15-moa-stage-timing-design.md` / `src/timing.ts` — do not reinvent clocks; import `StageClock`.

---

### Task 1: Mock contract test for exported stage runners

**Files:**
- Create: `packages/moa-extension/test/stages.test.ts`
- (Later) Create: `packages/moa-extension/src/stages.ts`

**Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { buildPlan } from "../src/planner";
import { resolveSettings } from "../src/settings";
import * as subprocess from "../src/subprocess";
import { runDiscoveryStage } from "../src/stages";
import type { WorkerOutput } from "../src/subprocess";

function makeWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
	return {
		ok: overrides.ok ?? true,
		output: overrides.output ?? `{"task_understanding":"t","known_inputs":[],"missing_inputs":[],"assumptions":[]}`,
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		aborted: false,
		timedOut: false,
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		durationMs: 1,
		...overrides,
	};
}

describe("runDiscoveryStage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns tco + outputSchema when discoveryEnabled", async () => {
		vi.spyOn(subprocess, "spawnMoaWorker").mockResolvedValue(
			makeWorkerOutput({
				output: JSON.stringify({
					task_understanding: "hire plan",
					known_inputs: [{ key: "weeks", value: 4, source: "user" }],
					missing_inputs: [],
					assumptions: [],
					output_schema: undefined,
				}),
			}),
		);
		const moaSettings = resolveSettings({
			discoveryEnabled: true,
			rewriteEnabled: false,
			workerExecutionMode: "out-of-process",
		});
		const result = await runDiscoveryStage(
			{ task: "4 week hiring", settings: moaSettings },
			{
				cwd: "/tmp/moa-stage-test",
				authStorage: {} as AuthStorage,
				modelRegistry: { refresh: async () => {}, getAvailable: () => [] } as unknown as ModelRegistry,
				settings: Settings.isolated({}, { cwd: "/tmp/moa-stage-test" }),
				moaSettings,
			},
		);
		expect(result.tco.task_understanding).toContain("hire");
		expect(result.outputSchema).toBeDefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});
```

Adjust fixture JSON to match whatever `parseDiscoveryOutput` currently accepts (see `test/tco.test.ts`).

**Step 2: Run test to verify it fails**

```bash
bun test packages/moa-extension/test/stages.test.ts
```

Expected: FAIL — `Cannot find module '../src/stages'` or `runDiscoveryStage is not exported`.

**Step 3: Minimal stub in `stages.ts`**

```ts
export async function runDiscoveryStage(...): Promise<never> {
	throw new Error("not implemented");
}
```

Re-run — fail with `not implemented` (proves import works).

**Step 4: Commit**

```bash
git add packages/moa-extension/test/stages.test.ts packages/moa-extension/src/stages.ts
git commit -m "test(moa): add failing stages contract for discovery"
```

---

### Task 2: Extract `runDiscoveryStage` / `runAskStage` / `runRewriteStage`

**Files:**
- Create/Modify: `packages/moa-extension/src/stages.ts`
- Modify: `packages/moa-extension/src/executor.ts` (move private runners; re-export or import from stages)
- Test: `packages/moa-extension/test/stages.test.ts`
- Regression: `packages/moa-extension/test/executor.test.ts`

**Step 1: Move discovery / ask / rewrite bodies from `executor.ts` into `stages.ts`**

- Export `runDiscoveryStage`, `runAskStage`, `runRewriteStage`.
- Share `ResolvedPlanOptions` / `resolvePlanOptions` / `resolveModel` / `mapWorkerOutput` as needed (either export helpers from executor or colocate in stages; prefer **one module owns runners**, executor imports them — avoid circular imports).
- Wrap each with `StageClock` or simple `Date.now()` for `durationMs`.
- Keep `parseRewriteOutput` with rewrite stage (export if tests need it; already covered by `parse-rewrite.test.ts` if present).

**Step 2: Wire `executePlan` to call the new exports** for stages 1–3 (discovery → ask → rewrite). Do not change control flow or notify/status messages.

**Step 3: Expand `stages.test.ts`**

- discovery disabled → empty TCO + `DEFAULT_OUTPUT_SCHEMA`, no spawn
- ask with `hasUI=false` → assumptions filled (`non_interactive_fallback`)
- rewrite with fixture markdown `## divergent` / `## grounded` / `## critical` → workers prompts updated

**Step 4: Run tests**

```bash
bun test packages/moa-extension/test/stages.test.ts packages/moa-extension/test/executor.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/moa-extension/src/stages.ts packages/moa-extension/src/executor.ts packages/moa-extension/test/stages.test.ts
git commit -m "refactor(moa): extract discovery/ask/rewrite stage runners"
```

---

### Task 3: Extract `runWorkersStage` / `runSynthesisStage`

**Files:**
- Modify: `packages/moa-extension/src/stages.ts`
- Modify: `packages/moa-extension/src/executor.ts`
- Test: `packages/moa-extension/test/stages.test.ts`

**Step 1: Failing tests**

- `runWorkersStage` with discovery/rewrite off, mock 3 conforming workers → `surviving.length === 3`, `dispatchLog` entries
- all quality-dropped → `signal === "quality_failed"`, no synthesis call from orchestrator (test synthesis stage separately)
- `runSynthesisStage` with 2 surviving digests → synthesis spawn called once

**Step 2: Move fanout / multi-round loop / synthesis from `executor.ts` into stages**

`executePlan` becomes:

```ts
const discovery = await runDiscoveryStage(...)
const ask = await runAskStage(...)
const rewrite = await runRewriteStage(...)
const workers = await runWorkersStage(...)
const synthesis = workers.signal === "quality_failed"
  ? qualityFailedSynthesis()
  : await runSynthesisStage(...)
```

Preserve: status bar, notify, `previousQuestionKeys`, fail-loud, `dispatchLog`.

**Step 3: Run full moa-extension tests**

```bash
bun test packages/moa-extension/test/
```

Expected: all green (same count as before ± new stages tests).

**Step 4: Commit**

```bash
git commit -m "refactor(moa): extract workers/synthesis stage runners"
```

---

### Task 4: Minimal stdin UI (`stage-cli-ui.ts`)

**Files:**
- Create: `packages/moa-extension/src/stage-cli-ui.ts`
- Create: `packages/moa-extension/test/stage-cli-ui.test.ts`

**Step 1: Failing test**

Mock `process.stdin` / use injectable `readline` interface:

- `input(prompt)` resolves to typed line
- empty line → `undefined` (skip)
- `select(prompt, options)` prints options, returns chosen value

**Step 2: Implement `createStageCliUI(): ExtensionUIContext`**

Implement only what `ask-user.ts` needs: `input`, `select`, `notify`, `setStatus`, `setWorkingMessage`, no-ops for the rest (same shape as executor's `createNoopUI`).

**Step 3: Pass tests + commit**

```bash
bun test packages/moa-extension/test/stage-cli-ui.test.ts
git commit -m "feat(moa): add stdin ExtensionUIContext for stage-test CLI"
```

---

### Task 5: Artifact I/O helpers

**Files:**
- Create: `packages/moa-extension/src/stage-artifacts.ts`
- Create: `packages/moa-extension/test/stage-artifacts.test.ts`

**Step 1: Failing tests**

- `writeStageRun(dir, { tco, ... })` creates `tco.json` / `meta.json`
- `loadStageRun(dir)` reads back
- `requireArtifacts(dir, ["tco.json","output_schema.json"])` throws with missing names listed

**Step 2: Implement + pass + commit**

```bash
git commit -m "feat(moa): stage artifact read/write for stage-test harness"
```

---

### Task 6: CLI `scripts/stage-test.ts`

**Files:**
- Create: `packages/moa-extension/scripts/stage-test.ts`
- Modify: `.gitignore` — add `/tmp/moa-stage/` or `tmp/moa-stage/`
- Modify: `packages/moa-extension/README.md` — Stage test section
- Modify: `packages/moa-extension/CHANGELOG.md` — Unreleased Added

**Step 1: Implement argv parser**

Flags: `--stage`, `--task`, `--from`, `--out`, `--rounds`, `--continue-on-fail`, `--help`.

Bootstrap (mirror extension / e2e patterns):

```ts
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { loadMoaConfigOverrides } from "../src/moa-config";
import { resolveSettings } from "../src/settings";
import { buildPlan } from "../src/planner";
import { createStageCliUI } from "../src/stage-cli-ui";
import { runDiscoveryStage, ... } from "../src/stages";
```

Use `cwd = process.cwd()`, load overrides from `loadMoaConfigOverrides(cwd)`, discover auth the same way `extension.ts` does (`discoverAuthStorage` via coding-agent if available — if awkward from a script, document using env API keys + `AuthStorage` from agent dir `~/.omp/agent`).

**Step 2: Stage switch**

- `discovery` / `ask` / … as in design §4
- `all`: sequential; on fail exit 1 unless `--continue-on-fail`
- print each stage duration to stderr

**Step 3: Manual smoke (real keys; not CI)**

```bash
bun packages/moa-extension/scripts/stage-test.ts --stage discovery --task "ping stage harness"
ls tmp/moa-stage/*/tco.json
```

**Step 4: Commit**

```bash
git commit -m "feat(moa): add stage-test CLI for per-stage and full smoke runs"
```

---

### Task 7: Verification + docs polish

**Step 1: Regression**

```bash
bun test packages/moa-extension/test/
```

**Step 2: README snippet**

```markdown
## Stage test harness (local / real LLM)

bun packages/moa-extension/scripts/stage-test.ts --stage all --task "..."
bun packages/moa-extension/scripts/stage-test.ts --stage rewrite --from tmp/moa-stage/<id>
```

**Step 3: Final commit if docs leftover**

```bash
git commit -m "docs(moa): document stage-test harness usage"
```

---

## Execution notes

- **Impact:** Before editing exported symbols, run GitNexus `impact` on `executePlan` / moved functions; warn if HIGH/CRITICAL.
- **TDD:** Each task writes failing test first when adding behavior.
- **Do not** register `/moa stage` or gate this into default CI.
- Prefer `workerExecutionMode` from user `moa.yml` (often `in-process`).

## Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (this session)** — fresh subagent per task, review between tasks  
2. **Parallel Session** — new session with `executing-plans` on this file  

Which approach?
