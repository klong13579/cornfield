# MOA「一次做对」Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按业务交互从前到后，把 MoA 收成「A+B 一轮 Ask → 互不可见 Workers → Synthesis」，并最终支持 TUI worker 方案流式，提升方案一次做对率。

**Architecture:** 不重写整包。先修合同（P0），再稳 Discovery/A+单轮 Ask（P1），再加 B 征询与合并（P2），再收 plan/quality（P3）与 synthesis（P4），最后做流式 TUI（P5）。每 Phase 有门禁，未过不进入下一 Phase。

**Tech Stack:** Bun、`packages/moa-extension`、现有 `stages.ts` / `tco.ts` / `ask-user.ts` / `worker-engine.ts`、`bun:test`

**设计文档:** [`2026-07-17-moa-once-right-design.md`](./2026-07-17-moa-once-right-design.md)

---

## 总原则

1. **先稳前面，再做后面** — 用户交互顺序 = 开发顺序。  
2. **TDD** — 每任务先写失败测试再改实现。  
3. **只跑相关测试** — `bun test packages/moa-extension/test/<file>.test.ts`。  
4. **GitNexus** — 改符号前 `impact`；提交前 `detect_changes`（若用户要求提交）。  
5. **默认不 commit** — 除非用户明确要求。

---

## Phase 0 — 基础合同修复（不改拓扑）

**门禁:** soft-recover 不能假 `all_complete`；synthesis 始终能渲染 TCO assumptions；非法 `PI_MOA_SETTINGS_JSON` 不抛死。

### Task 0.1: Soft-recover 双通道

**Files:**
- Modify: `packages/moa-extension/src/worker-parser.ts`
- Modify: `packages/moa-extension/src/types.ts`（`ParsedWorkerOutput` / result 增加 `softRecovered?`）
- Modify: `packages/moa-extension/src/quality/heuristic.ts`（softRecovered ⇒ contractHardFail 或等价）
- Modify: `packages/moa-extension/src/stages.ts`（`allWorkersComplete` / `hasOpenQuestions` 尊重 softRecovered）
- Test: `packages/moa-extension/test/worker-parser.test.ts`
- Test: 新增或扩 `packages/moa-extension/test/executor.test.ts`（soft-recover 不触发 `all_complete`）

**Step 1:** 写失败测试：全缺 header 的长正文 soft-recover 后，`contractHardFail` 或 score≤30；且 `allWorkersComplete` 为 false。

**Step 2:** 跑测试确认 FAIL。

**Step 3:** 实现：填充 sections 时设 `softRecovered=true`，**不清空**契约失败语义；`hasOpenQuestions` 对 softRecovered 不把空 oq 当「无问题」。

**Step 4:** 跑相关测试 PASS。

**Step 5:** 更新 `packages/moa-extension/CHANGELOG.md` Fixed 一条。

### Task 0.2: Synthesis assumptions + 去双重 TCO

**Files:**
- Modify: `packages/moa-extension/src/stages.ts`（`runSynthesisCore`）
- Modify: `packages/moa-extension/src/prompts/synthesis.md`（若需）
- Test: `packages/moa-extension/test/stages.test.ts` 或 executor 级

**Step 1:** 写失败测试：`askEnabled=true` 且 `tco.assumptions.length>0` 时，synthesis systemPrompt 含真实 assumptions 列表。

**Step 2:** 实现：从 `tco.assumptions` 渲染 `assumptions_block`；`tco_block` 只注入一次（删 `prependTco` 或删模板侧重复，保留一处）。

**Step 3:** 测试 PASS + CHANGELOG。

### Task 0.3: `PI_MOA_SETTINGS_JSON` 容忍失败

**Files:**
- Modify: `packages/moa-extension/src/settings.ts`
- Test: `packages/moa-extension/test/settings.test.ts`

**Step 1:** 非法 JSON5 / 非 object → warn + `{}`，不 throw。  
**Step 2:** 测试 PASS。

### Phase 0 门禁清单

```bash
bun test packages/moa-extension/test/worker-parser.test.ts
bun test packages/moa-extension/test/settings.test.ts
bun test packages/moa-extension/test/stages.test.ts
bun test packages/moa-extension/test/executor.test.ts
```

人工：`/moa run` 短任务，确认 skip 一项后结果含 Assumptions。

---

## Phase 1 — 稳 A + 仅 A 的单轮 Ask（关掉默认 Round-Ask）

**门禁:** Discovery 按 checklist 产出；用户只在 Pre-Ask 被问；workers 后默认不再 Ask；文档写明 `maxRounds` 默认 1。

### Task 1.1: Discovery A checklist 写入 prompt

**Files:**
- Modify: `packages/moa-extension/src/prompts/discovery.md`
- Test: `packages/moa-extension/test/tco.test.ts`（解析仍绿；可加 fixture 含类别 key 的样例）

**Step 1:** 在 discovery.md 增加强制扫描类别：目标 / 范围 / 约束 / 环境 / 决策 / 风险 / 非目标；仍 ≤5 题、单轮可答。  
**Step 2:** 确认 `parseDiscoveryOutput` 无需改即可接受（字段不变）。  
**Step 3:** 测试 PASS。

### Task 1.2: 默认关闭 workers 后 Round-Ask

**Files:**
- Modify: `packages/moa-extension/src/settings.ts`（保持 `maxRounds: 1`；增加清晰注释，或引入 `roundAskEnabled` 默认 false——**优先最小改动**：`effectiveMaxRounds` 在「单轮 Ask 模式」下对 collectOpenQuestions 短路）
- Modify: `packages/moa-extension/src/stages.ts` / `executor.ts`
- Modify: `packages/moa-extension/README.md` + CHANGELOG（默认 1；opt-in `--rounds` / settings）
- Test: `packages/moa-extension/test/executor.test.ts` — 默认路径 workers 后 `questionsAsked` 为空；`maxRounds>=2` 专家路径仍可 Ask

**推荐最小语义:**

- 新增 settings：`postWorkerAskEnabled: false`（默认），或文档约定「默认 maxRounds 表示 plan 轮预算，Round-Ask 另旗标」。  
- **选定并写死一种**，避免双义。推荐：`postWorkerAskEnabled` 默认 `false`；`maxRounds` 仅在该旗标为 true 时生效。

**Step 1:** 失败测试：默认 settings 下多轮 oq 不再触发第二轮 Ask。  
**Step 2:** 实现旗标 + executor/stages 接线。  
**Step 3:** 更新 settings.test / executor multi-round 测试期望。  
**Step 4:** PASS。

### Task 1.3: A-only 路径手工稳定

**Step 1:** 用 stage-test 或 `/moa run` 跑 2～3 个真实任务，记录 missing_inputs 是否像「意图澄清」。  
**Step 2:** 修 prompt/裁剪直到 A 题质量可接受。  
**Step 3:** 在设计文档或 CHANGELOG 记「P1 完成」。

### Phase 1 门禁清单

```bash
bun test packages/moa-extension/test/tco.test.ts
bun test packages/moa-extension/test/settings.test.ts
bun test packages/moa-extension/test/executor.test.ts
bun test packages/moa-extension/test/ask-user.test.ts
```

---

## Phase 2 — B 征询 + A∪B 合并为一轮 Ask ✅ 完成

**门禁:** 用户仍只被问一次；题来自 A∪B；B 轮不产出完整 plan。

**实施结果（2026-07-17）:**
- `INPUT_COLLECT_SCHEMA` + `src/prompts/input-collect.md`（B 只出 `## needed_inputs`，无 plan、无工具）。
- `parseNeededInputs`（`tco.ts`）容错解析 B 清单；soft-recover 正文 → `[]`；`select` 降级为 `text`（B 无法给 options）。
- `mergeMissingInputs`（`src/merge-missing.ts`）纯函数：key/同文案去重、OR required、并 roles、优先级 `required > discovery > 多角色 > 单角色`、封顶 `maxQuestionsPerRound`。
- `runInputCollectStage`（`stages.ts`）+ executor 接线：`Discovery → InputCollect(B) → Merge → Ask×1 → Rewrite → Workers → Synthesis`；B 仅在 `hasUI && askEnabled && inputCollectEnabled`（默认 true）时运行，gateway 短路。
- 门禁测试全绿：`merge-missing` / `stages` / `executor`（含「只问一次 + A∪B 去重有序」「hasUI=false 跳过 B」「askEnabled=false 跳过 B」）。

### Task 2.1: B 输出 schema + prompt

**Files:**
- Create: `packages/moa-extension/src/prompts/input-collect.md`
- Modify: `packages/moa-extension/src/types.ts`（`INPUT_COLLECT_SCHEMA` 常量）
- Test: parser 测短 schema

### Task 2.2: `runInputCollectStage`

**Files:**
- Modify: `packages/moa-extension/src/stages.ts`
- Test: `packages/moa-extension/test/stages.test.ts`

行为：对 baseWorkers（或默认 3 slot）轻量执行；`tools: none` 或 read-only；超时短于 plan 轮；解析 `needed_inputs` → `TcoMissingInput[]`（`source: "worker"`, `role`）。

### Task 2.3: Merge A∪B

**Files:**
- Create: `packages/moa-extension/src/merge-missing.ts`（纯函数：去重、优先级、top-M）
- Test: `packages/moa-extension/test/merge-missing.test.ts`

### Task 2.4: 接线 executePlan 顺序

**新顺序:**

```text
Discovery(A) ∥ InputCollect(B) → Merge → Ask×1 → Rewrite → Workers(plan) → Synthesis
```

**Files:**
- Modify: `packages/moa-extension/src/executor.ts`
- Modify: `packages/moa-extension/src/tco.ts`（optional fields on missing）
- Test: executor / stages 集成测：Ask 只调用一轮；合并后 key 无重复

### Phase 2 门禁清单

```bash
bun test packages/moa-extension/test/merge-missing.test.ts
bun test packages/moa-extension/test/stages.test.ts
bun test packages/moa-extension/test/executor.test.ts
```

---

## Phase 3 — Plan Workers + Quality 收口 ✅ 完成

**门禁:** plan 轮 prompt 禁止二次 Ask；soft-recover 回归仍绿；quality 对自定义 schema 不误杀到不可用。

**实施结果（2026-07-17）:**
- `worker.md` / `rewrite.md`：unique Ask already done；残余不确定进 `## assumptions`，不期待再问用户；示例/提醒改为 schema 相对写法。
- `quality/heuristic.ts`：`planSubstance` → 主 required markdown；`openQuestions` → required list / name 含 `question`；默认 schema 回归绿。
- 门禁：`quality-heuristic` / `worker-parser` / `executor` / `planner` 全绿。

### Task 3.1: Worker / rewrite prompt 合同

**Files:**
- Modify: `packages/moa-extension/src/prompts/worker.md`
- Modify: `packages/moa-extension/src/prompts/rewrite.md`
- 文案：唯一 Ask 已完成；oq 仅作 assumptions，不期待再问用户。

### Task 3.2: Schema-aware 启发式（最小可用）

**Files:**
- Modify: `packages/moa-extension/src/quality/heuristic.ts`
- Test: `packages/moa-extension/test/quality-heuristic.test.ts`

最小：`planSubstance` → 主 required markdown section；问题列表 → required `type:list` 或 name 含 `question`；不要只写死 `plan`/`open_questions`。

### Phase 3 门禁

```bash
bun test packages/moa-extension/test/quality-heuristic.test.ts
bun test packages/moa-extension/test/worker-parser.test.ts
bun test packages/moa-extension/test/executor.test.ts
```

---

## Phase 4 — Synthesis 收口 ✅ 完成

**门禁:** P0.2 已做则本 Phase 做回归与 handoff 文案；确认 `moa-result` 含 assumptions 摘要。

**实施结果（2026-07-17）:**
- `renderAssumptionsToVerify` + handoff 布局：`## Assumptions to verify` 在 byte-cap 之外（含 `maxBytes=0`）。
- `MoaTraceDetails.assumptionsSummary` 同步暴露；`buildTraceDetails` / `buildSummary` 接线。
- 门禁：`trace.test.ts` 全绿（含 P4 专测）。

### Task 4.1: Trace / moa-result 展示 assumptions

**Files:**
- Modify: `packages/moa-extension/src/trace.ts`
- Test: `packages/moa-extension/test/trace.test.ts`

### Phase 4 门禁

```bash
bun test packages/moa-extension/test/trace.test.ts
```

---

## Phase 5 — TUI Worker 方案流式 ✅ 完成

**门禁:** 三 worker 并行时 TUI 可见增量文本；完成后 quality 标记正确；不影响 Ask 与 synthesis。

### Task 5.1: Engine 流式回调 ✅

**Files:**
- Modify: `packages/moa-extension/src/worker-engine.ts`
- Modify: `packages/moa-extension/src/subprocess.ts`
- Test: `test/stream-ui.test.ts` (`applyWorkerStreamEvent`)

### Task 5.2: Executor / UI 接线 ✅

**Files:**
- Modify: `packages/moa-extension/src/executor.ts` / `stages.ts`
- New: `packages/moa-extension/src/stream-ui.ts` (`createWorkerStreamSink` → `setWidget("moa-workers")`)

### Task 5.3: 流式 e2e 或集成测 ✅

假 engine 推送 chunks → `runWorkersStage` hooks `onWorkerPartial` 按 name 分组；sink 单测覆盖 paint / markStatus / clear。

### Phase 5 门禁

手工 `/moa run`：三路正文滚动；结束有 moa-result。（单元/集成测已绿；手工仍建议确认一次。）

---

## Phase 6 — 按需（不阻塞主路径）

仅在 P0–P5 稳定后挑选：

- Archive 含 round / schema / askRoundSummaries  
- Subprocess usage 累加  
- Gateway/cron 强制 read-only tools（防御）  
- Discovery 失败重试 1 次  
- `emptyTco` reason 语义修正  
- Judge in-process 路径  

每项单开小任务，同样先测后改。

---

## 建议开工顺序（给人看的）

```text
本周:     P0（合同）→ P1（A + 关 Round-Ask）
稳定后:   P2（B + 合并）
再后:     P3 → P4
体验:     P5 流式
杂项:     P6
```

---

## Execution Handoff

设计与计划已落盘：

- 设计: `docs/plans/2026-07-17-moa-once-right-design.md`
- 计划: `docs/plans/2026-07-17-moa-once-right.md`

**执行方式二选一：**

1. **按 Phase 在本会话推进** — 从 Task 0.1 开始（推荐，符合「先稳前面」）。  
2. **另开执行会话** — 使用 executing-plans，指示「只做 P0，门禁过后再说」。

未要求前不自动 commit。确认设计后回复「开始 P0」即可开工。
