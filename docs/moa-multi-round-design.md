# MOA Multi-Round — 设计与实施计划

**作者**: Pi staff engineer
**日期**: 2026-07-14
**Status**: 设计已锁定，待实施
**前置文档**: [`docs/moa-input-fulfillment.md`](./moa-input-fulfillment.md) — 单轮 TCO 流水线已上线，本文档是其上的 multi-round 增强
**关联**: `packages/moa-extension/`

---

## 1. 背景

`moa-input-fulfillment.md` 解决了"pre-execution 输入补全"：Discovery → TCO → Ask user → Rewrite → Workers → Synthesis，单轮跑完。

e2e 验证（128.32s 真实跑）暴露三个新问题：

1. **3 worker 全输出澄清问题而非方案** — 拿到 TCO 后 worker 仍反问 4-5 个澄清问题就停了
2. **synthesis 跟着 worker 一起反问** — 没人去重，没人收集
3. **LLM 忽略 `worker.md` 底部的 "Do not ask clarifying questions" 规则** — 规则位置错误 + 无结构性约束

单轮设计无法修复这些，因为根因是"**某些 worker 必然出差方案**"和"**答 1 题会暴露 2 新题**"是 multi-round 才有的现象。

## 2. 三个用户约束（决定设计方向）

| # | 约束 | 推到方向 |
|---|---|---|
| C1 | "某个 worker 出差方案是必然事件" | 必须有 worker quality filter，可丢弃差 worker |
| C2 | "答 1 题 → 暴露 2 新题，必须多轮" | 必须支持 bounded re-spawn loop（每轮 ask + re-spawn） |
| C3 | "contract 不能是固定的" | contract 是 per-task 动态 schema，由 Discovery LLM 决定 |

## 3. 目标 / 非目标

### 3.1 目标（TUI 模式）

- 多轮 worker ask 循环，bounded by `maxRounds` 或收敛
- 动态 output schema — Discovery LLM 决定 worker 输出有哪些 section
- Quality heuristic 评分，丢弃差 worker
- 收敛自动检测，无新题即停
- 用户主动 `stop` 按钮
- 所有轮次完整进 archive，事后可回放

### 3.2 非目标（本次）

- **Gateway / cron multi-round** — 本次 `maxRounds=0`，行为完全不变
- **LLM judge** — quality check 用 heuristic 起步
- **Cross-task memory** — TCO 的 `known_inputs` 是 per-task 的，跨 task 复用后续做
- **"auto-fill from memory" 按钮** — 长期项
- **Discovery LLM 模型替换 / re-spawn** — 本次仅扩能（多输出 schema），不动模型选择

### 3.3 硬约束

- **不破坏 Gateway / cron** — `hasUI=false` 时 multi-round 全程短路，行为与本次实施前完全一致
- **不破坏 e2e schema** — 新增字段必须向后兼容
- **不破坏已有 test** — `bun test packages/moa-extension` 必须全过

## 4. 整体架构

```
[Discovery LLM]
   ↓ 输出: TCO.known_inputs / missing_inputs / assumptions
   ↓ 输出: output_schema { sections: [{name, required, type, schema}] }   ← 关键：动态 contract
[Pre-Ask] (TUI only, max 5 题)
   ↓ 答案注入 TCO.known_inputs
[Loop 轮次 1..N]  ← N = settings.maxRounds (TUI=3, gateway=0)
   ├─ [Worker × 3 并行]  每个输出按 output_schema 解析
   ├─ [Quality Check]   丢弃差 worker (score < 40)，score 其余
   ├─ [Collect]         dedup open_questions 跨所有存活 worker
   ├─ [Ask 轮 N]        TUI 弹 top M 题 (M = maxQuestionsPerRound = 5)
   │                     user: answer / skip / "stop"
   ├─ [Inject]          答案写 TCO.known_inputs
   └─ [Convergence]     任一触发即停:
                          - 当前轮 open_questions ⊆ 已知问题集
                          - user 主动 stop
                          - N 达到 maxRounds
                          - 全部 3 worker 最新轮 score ≥ 80 且 0 open_questions
[Synthesis]             用所有存活 worker 输出 + 答案 + assumptions
[Archive]               每个 round 都进 dispatch_log (向后兼容)
```

## 5. 动态 Schema（解决 C3）

### 5.1 Discovery LLM 新增输出

Discovery LLM 在已有 TCO 之外，多输出一段 YAML/JSON：

```yaml
output_schema:
  sections:
    - name: plan
      required: true
      type: markdown
    - name: open_questions
      required: true
      type: list
      item:
        question: string
        context: string
        suggested_default: string
        type: "freeform|choice"
    - name: assumptions
      required: false
      type: list
      item: { claim: string, basis: string }
```

### 5.2 Schema 按任务类型自适应

| 任务类型 | 必有 section | 可选 section |
|---|---|---|
| plan 任务（招聘/市场/产品） | `plan`, `open_questions` | `assumptions`, `risks` |
| code 任务（重构/实现/修复） | `plan`, `open_questions` | `code_diff`, `test_plan`, `risks` |
| debug 任务 | `repro_steps`, `plan`, `open_questions` | `assumptions` |
| research 任务 | `findings`, `open_questions` | `sources`, `assumptions` |

Discovery LLM 根据 task string 选合适的 section 集合，worker prompt 注入 schema，输出按 schema parse。

### 5.3 Parser 行为

- **required section 缺失** → 该 section 视为空（quality score 扣分）
- **非 required section 缺失** → 静默忽略
- **section 内容不符合 schema** → 该 section 视为空（quality score 扣分）
- **整体 raw 输出** 始终保留进 archive（`worker_output.raw`）— 出事能复盘

## 6. Quality Check（解决 C1）

### 6.1 Heuristic v1

```typescript
function scoreWorker(output: ParsedWorkerOutput, schema: OutputSchema): number {
  let score = 0;
  // 基础结构（按动态 schema 评）
  for (const section of schema.sections.filter(s => s.required)) {
    if (output[section.name] !== undefined) score += 30;
  }
  // 内容质量
  if (output.plan?.length > 200) score += 20;          // 拒绝态输出都 < 100 字符
  if ((output.open_questions ?? []).length < 5) score += 20;  // 一堆问号 = 没干活
  if (output.assumptions?.length > 0) score += 10;     // 有自我意识
  if (!/请确认|as an AI|I cannot|让我先/.test(output.raw)) score += 20;  // 守契约
  return score;  // < 40 丢弃
}
```

### 6.2 丢弃行为

- score < 40 → 该 worker 输出从 synthesis 输入中移除，archive 标 `quality_dropped`
- 3 worker 全 < 40 → **fail loud**：不跑 synthesis，返回 `MoaExecutionResult` 带 `synthesis = { ok: false, stderr: "all workers quality-failed" }`
- 0-2 worker 存活 → synthesis 收到部分输入，archive 显式记录

### 6.3 后续升级路径（v2 候选）

- LLM judge 评分（+1 LLM call / worker / round，3-9 个 judge call）
- Per-role 权重可调（divergent 重 plan 长度，critical 重 assumptions 质量）
- v1 跑 e2e 后看实际 score 分布再决定是否升级

## 7. 多轮循环（解决 C2）

### 7.1 收敛检测算法

```typescript
function isConverged(round: RoundTrace, history: RoundTrace[]): boolean {
  // 条件 1: 当前轮 open_questions ⊆ 历史已知问题集合
  const allKnownQuestions = new Set(history.flatMap(r => r.questions.map(q => q.normalized)));
  const allNew = round.questions.every(q => allKnownQuestions.has(q.normalized));
  if (allNew && round.questions.length === 0) return true;

  // 条件 2: user stop
  if (round.userStopped) return true;

  // 条件 3: max_rounds
  if (round.roundNumber >= settings.maxRounds) return true;

  // 条件 4: 全部 3 worker 最新轮 score ≥ 80 且 0 open_questions
  if (round.workers.every(w => w.score >= 80 && w.parsed.open_questions?.length === 0)) {
    return true;
  }

  return false;
}
```

### 7.2 轮次间 TCO 注入

Re-spawn worker 的 prompt 包含：

```
[task] <原始 task>
[tco.known_inputs] <所有历史答案（pre-ask + 各轮答案）>
[tco.assumptions] <所有历史假设>
[previous_answers] <本轮注入的新答案>
[previous_questions_already_asked] <历史问过的题 + 用户答复>
[output_schema] <Discovery LLM 输出的 schema>
```

确保 worker 答过的题不再问、答过的答案被尊重。

### 7.3 TUI UX

- 状态条: `Round 2/3 · asking question 3/5 · divergent OK · grounded OK · critical BLOCKED`
- Ask 阶段三个按钮：`answer` / `skip` / `stop all`
- 30s 单题 timeout（沿用 `askTimeoutMs`）
- 全 stop 后：synthesis 立刻跑，用已有 worker 输出 + 答案 + assumptions

## 8. 数据结构新增

### 8.1 `WorkerOutput` 扩展（`src/types.ts`）

```typescript
interface MoaWorkerResult {
  // ... 已有字段 ...
  /** 按 output_schema 解析后的结构化输出 */
  parsed?: Record<string, unknown>;
  /** quality heuristic 评分 */
  qualityScore?: number;
  /** 是否被 quality 丢弃 */
  qualityDropped?: boolean;
}
```

### 8.2 `MoaOutputSchema`（`src/types.ts`）

```typescript
interface MoaOutputSchemaSection {
  name: string;
  required: boolean;
  type: "markdown" | "list";
  item?: Record<string, string>;
}

interface MoaOutputSchema {
  sections: MoaOutputSchemaSection[];
}
```

### 8.3 `TcoMissingInput` 扩展（`src/tco.ts`）

```typescript
interface TcoMissingInput {
  // ... 已有字段 ...
  /** Discovery LLM 给的默认填充值，非 TUI 模式使用 */
  defaultValue?: unknown;
}
```

### 8.4 `MoaRoundTrace`（`src/types.ts`）— PR2 新增

```typescript
interface MoaRoundTrace {
  roundNumber: number;
  workers: Array<{
    name: string;
    ok: boolean;
    score: number;
    durationMs: number;
    qualityDropped: boolean;
  }>;
  questionsAsked: Array<{ question: string; answer?: string; sourceWorkers: string[] }>;
  questionsSkipped: Array<{ question: string; inferredFrom: string }>;
  userStopped: boolean;
  convergenceSignal: "no_new_questions" | "user_stop" | "max_rounds" | "all_complete" | null;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
}
```

## 9. Settings 新增（`src/settings.ts`）

```typescript
interface MoaSettings {
  // ... 已有字段 ...
  /** TUI 模式多轮循环上限. Gateway/cron 强制 0. */
  maxRounds: number;               // 默认 3 (TUI), 0 (gateway)
  /** 每轮 ask 题目数上限. */
  maxQuestionsPerRound: number;    // 默认 5
  /** Quality heuristic 丢弃线. */
  qualityMinScore: number;         // 默认 40
}
```

## 10. TUI vs Gateway / Cron 行为矩阵（实施后）

| 场景 | Discovery | Pre-Ask | Workers | Multi-Round | Ask Round | Synthesis | Archive |
|---|---|---|---|---|---|---|---|
| TUI 交互 | ✅ 跑 | ✅ 弹窗 | ✅ 跑 | ✅ 跑 | ✅ 弹窗 | ✅ 跑 | ✅ dispatch_log |
| Cron | ✅ 跑 | ❌ assumed | ✅ 跑 | ❌ skip | ❌ skip | ✅ 跑 | ✅ dispatch_log（单 round） |
| 钉钉 Gateway | ✅ 跑 | ❌ assumed | ✅ 跑 | ❌ skip | ❌ skip | ✅ 跑 | ✅ dispatch_log（单 round） |
| Batch / 测试 | ✅ 跑 | ❌ assumed | ✅ 跑 | ❌ skip | ❌ skip | ✅ 跑 | ✅ dispatch_log（单 round） |

`hasUI=false` 时 multi-round 全程短路，所有 new settings 默认 0 / 0 / 0。

## 11. 实施计划

### 11.1 PR1: F1 + F2 + F3 + worker 契约 + 动态 schema 字段（不含 multi-round executor）

| 文件 | 改动 | LOC |
|---|---|---|
| `src/prompts/worker.md` | 顶部 hard rule + 动态 schema 渲染 | +30 |
| `src/prompts/synthesis.md` | 顶部 hard rule + 接收 round-aware digests（PR2 启用） | +20 |
| `src/prompts/discovery.md` | 加 output_schema 输出指引（PR1 写但不读） | +15 |
| `src/types.ts` | `MoaWorkerResult` 加 `parsed/qualityScore/qualityDropped`；新 `MoaOutputSchema` type | +40 |
| `src/tco.ts` | `TcoMissingInput` 加 `defaultValue?`；`renderTcoForPrompt` 优先用 defaultValue | +30 |
| `src/trace.ts` | archive schema 加 `dispatch_log: DispatchLogEntry[]`（向后兼容） | +40 |
| `src/worker-parser.ts` (新) | 按 schema 解析 worker output；missing required section 返回 error | +80 |
| 测试 6 个文件 | worker-parser / tco defaultValue / trace dispatch_log / type 变化 / prompt 渲染 | +200 |

**PR1 验证**:
- `bun test packages/moa-extension` 全过
- smoke e2e（1 worker 短 prompt）确认 worker 收到新 schema 后真输出新 section — $0.005-0.01

### 11.2 PR2: multi-round executor + quality check + dynamic schema 接入

| 文件 | 改动 | LOC |
|---|---|---|
| `src/executor.ts` | `runRound()` 循环 + `runCollect()` 解析+dedup + `runAskRound()` TUI 弹窗 + `runQualityCheck()` heuristic + `runInjectAnswers()` 写 TCO | +250 |
| `src/settings.ts` | 加 `maxRounds`, `maxQuestionsPerRound`, `qualityMinScore` | +20 |
| `src/types.ts` | `MoaAskUserSummary` 扩字段；新 `MoaRoundTrace` | +30 |
| `src/prompts/discovery.md` | 启用 output_schema 输出解析 | +20 |
| `src/ask-user.ts` | 加 `askQuestionsList()`；支持 round-aware + stop button | +60 |
| 测试 8 个文件 | runRound convergence / collect dedup / ask round stop / inject answers / quality check / settings 默认值 | +300 |

**PR2 验证**:
- `bun test packages/moa-extension` 全过
- full e2e 跑 1-3 轮真实任务，看是否真收敛（< 3 轮达到收敛条件）— $0.10-0.30
- archive 完整 dispatch_log 可读

## 12. 失败模式

| 失败 | 检测 | 处理 |
|---|---|---|
| Discovery LLM 输出无 output_schema | parse 失败 | fallback 到 v1 写死 schema（plan + open_questions + assumptions） |
| Worker 输出无 required section | worker-parser error | 该 section 视为空，quality score 扣分 |
| 3 worker 全 quality 丢弃 | round.workers.every(w => w.qualityDropped) | fail loud，不跑 synthesis，返回 partial failure |
| Ask 单题 timeout | ctx.ui.input() timeout | 该题标 `user_skipped` 跳过，不算 convergence |
| 全部题都 skip | round.questions.length === 0 && no answers | 视为"converged by max_rounds"，继续 synthesis |
| User mid-ask 触发 `stop all` | ui callback | 立刻结束当前轮，run synthesis 用已有数据 |
| 收敛检测死循环（一直有 1 个新题） | round 数达到 maxRounds | 强制停，跑 synthesis |
| 动态 schema 包含未知 type | parser 跳过 | 不影响其他 section，log warn |

## 13. 关键决策记录

| # | 决策 | 取值 | 备选 / 否决理由 |
|---|---|---|---|
| D1 | maxRounds (TUI) | 3 | 2 (太短不彻底) / 5 (user 烦) |
| D2 | maxQuestionsPerRound | 5 | 3 (题量大时多轮) / 10 (疲劳) |
| D3 | Re-spawn 范围 | 全部 3 worker | 只重 spawn quality-fail (heuristic 不可靠，会错杀) |
| D4 | Quality 模式 | heuristic 起步 | LLM judge (贵 1× call/round，黑盒) |
| D5 | 用户停止按钮 | answer / skip / stop | — |
| D6 | Discovery 扩能 | 输出 output_schema | 用新 LLM 节点 (多余) |
| D7 | F1+F2+F3 一起做 | 是 | 独立 PR (割裂) |
| D8 | Schema 解析失败 fallback | v1 写死 schema | 抛错 (太严) / 接受空 (太松) |
| D9 | PR1 验证 e2e 级别 | smoke (1 worker 短 prompt) | full e2e (PR1 不需要, 浪费) |
| D10 | PR2 验证 e2e 级别 | full e2e (1-3 轮) | unit only (无法证明 convergence) |

## 14. 参考

### 14.1 参考系统

- **Hermes Agent kanban** (NousResearch/hermes-agent) — dispatcher 拥有 lifecycle state machine；worker 必须 `kanban_complete` 或 `kanban_block` 终止；commit 40217aa 显式 "tell workers not to use clarify; route to kanban_block instead"，KANBAN_GUIDANCE 注入到每个 worker system prompt 顶部 `## Do NOT` section。`kanban_block(reason="needs_input: ...")` 任意时刻可触发，dispatcher 路由到 dashboard，unblock 后 respawn 带 thread。
- **pi-fusion** (leblancfg/pi-fusion) — 本地 pi subprocess，parallel fan-out，synthesis 注入，无 question 收集。
- **pi-ask-user** (edlsh/pi-ask-user) — TUI `ask_user` 工具，bundled `ask-user` skill 强制调用，decision handshake 流程。

### 14.2 设计来源

- 本次设计是 Hermes dispatcher 模式翻译到 OMP subprocess 架构的产物
- 动态 schema 来自 pi-fusion 的 fusion prompts configurable 思路
- 质量 heuristic 的"守契约"评分来自 Hermes KANBAN_GUIDANCE 的反向工程

### 14.3 上游文档

- [`docs/moa-input-fulfillment.md`](./moa-input-fulfillment.md) — 单轮 TCO 流水线（已实施）
- AgentAsk (ACL 2026, arXiv 2510.07593) — Data Gap 29.1% 失败归因
- Ask-before-Plan (EMNLP 2024 Findings, arXiv 2406.12639) — CEP framework
- Together MoA (ICLR 2025, arXiv 2406.04692) — 原始 MoA 论文

## 15. 后续工作（本次不做）

| 优先级 | 项目 | 备注 |
|---|---|---|
| P1 | Gateway / cron multi-round | 加 `OMP_MOA_GATEWAY_ASK_URL` 让 cron 任务也能 ask 钉钉用户 |
| P1 | LLM judge 质量评分 | 当前 heuristic 准度有限，跑 e2e 看分布后决定 |
| P2 | Cross-task memory | 答过的题进 user.md / TCO cache，新 task 自动复用 |
| P2 | "auto-fill from memory" 按钮 | TUI ask 阶段可点"我答过了"，跳过 |
| P3 | Per-role 权重可调 | divergent 重 plan 长度，critical 重 assumptions |
| P3 | Worker 模型选择 per round | 后半轮换更便宜的模型 |
| P3 | 收敛算法升级 | 引入 LLM 评"问题相关性"，避免假收敛 |

## 16. 状态

- [x] 三个用户约束已记录
- [x] 整体架构已锁定
- [x] 动态 schema 设计完成
- [x] Quality heuristic v1 设计完成
- [x] 多轮循环 + 收敛算法设计完成
- [x] TUI UX 设计完成
- [x] 数据结构 / Settings 扩展定义完成
- [x] PR1 / PR2 实施计划完成
- [x] 失败模式 / 决策记录 / 参考完整
- [ ] PR1 实施（待用户启动）
- [ ] PR2 实施（待 PR1 验收）
