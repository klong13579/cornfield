# MOA 多轮多 Agent 设计（Input Fulfillment + Multi-Round）

> 状态：已实施 · 对应实现 `packages/moa-extension/`（src + test，34+ 测试文件）
> 合并自：`moa-input-fulfillment.md`（2026-07-13，单轮 TCO 流水线）+ `moa-multi-round-design.md`（2026-07-14，多轮增强）
> 实施历史：2026-07-15 曾短暂引入 "Round1=只问 / Round2+=只写" 的 phase 注入，与本文架构冲突且与 quality heuristic 自相矛盾，已回退——每轮统一 schema，跨轮仅注入 previous answers + already-asked questions。

## 1. 问题与根因

MOA pipeline 最初 `executePlan` 只跑 `plan.workers + synthesis`，两个缺陷：

1. **Data Gap（输入缺失）**：3 个 worker 收到裸任务字符串，没有前置意图理解——任务里"10 个岗位 / 4 周 / 速度成本质量"等隐含信息模型不知道。实证：124.7s 跑出，grounded 和 critical worker 直接反问 4-5 个澄清问题就停了，**没出方案**。数据支撑：AgentAsk (ACL 2026) 对 824 例 multi-agent 失败审计，Data Gap 占 29.1%。
2. **澄清风暴（单轮不可解）**：拿到 TCO 后 worker 仍反问、synthesis 跟着反问、LLM 忽略 `worker.md` 底部的 "Do not ask clarifying questions" 规则。根因是"**某些 worker 必然出差方案**"和"**答 1 题会暴露 2 新题**"是 multi-round 才有的现象。

## 2. 目标

1. 执行前先做意图理解——Discovery stage 读 user.md / moa.yml / cwd，产出 Task Context Object (TCO)
2. 保证每个 worker 需要的输入都被满足——TCO 显式列出 known_inputs / missing_inputs，缺的 ask user 一次问完，不够标 `[assumed: ...]` fallback
3. 不阻塞非交互场景——TUI 走 ask user；gateway / cron 走 assumed fallback，synthesis 显式呈现 assumption
4. 多轮循环 bounded by `maxRounds` 或收敛；质量评分丢弃差 worker；收敛自动检测

**硬约束**：`hasUI=false`（Gateway / cron）时 multi-round 全程短路，行为与单机一致；e2e schema 向后兼容。

## 3. 整体架构

```
[Discovery LLM]
   ↓ 输出 TCO（task_understanding / known_inputs / missing_inputs / assumptions）
   ↓ 输出 output_schema（动态 contract：worker 输出有哪些 section，按任务类型自适应）
[Pre-Ask] (TUI only, max 5 题) → 答案注入 TCO.known_inputs
[Loop 轮次 1..N]   ← N = settings.maxRounds（TUI=3, gateway=0）
   ├─ [Worker × 3 并行]  每个 worker 按 output_schema 输出（含 open_questions）
   ├─ [Quality Check]   丢弃差 worker（score < 40），评分其余
   ├─ [Collect]         dedup open_questions 跨所有存活 worker
   ├─ [Ask 轮 N]        TUI 弹 top M 题（M = maxQuestionsPerRound = 5）
   │                     user: answer / skip / "stop"
   ├─ [Inject]          答案写 TCO.known_inputs
   └─ [Convergence]     任一触发即停（见 §6.1）
[Synthesis]             用所有存活 worker 输出 + 答案 + assumptions
[Archive]               每个 round 进 dispatch_log（向后兼容）
```

模式来源：Hermes Agent dispatcher 生命周期状态机（`kanban_complete`/`kanban_block` + KANBAN_GUIDANCE 注入 worker system prompt 顶部）翻译到 CornField subprocess 架构的产物；动态 schema 来自 pi-fusion；"守契约"评分来自 Hermes KANBAN_GUIDANCE 的反向工程。

## 4. 数据结构

### 4.1 Task Context Object (TCO)

```ts
interface TaskContextObject {
  task_understanding: string;
  known_inputs: Record<string, {
    value: unknown;
    source: "user" | "user_md" | "moa_yml" | "cwd" | "tool_call" | "llm_inferred";
  }>;
  missing_inputs: Array<{
    key: string;             // 注入 worker prompt 的变量名
    question: string;        // 给用户看的题目
    type: "text" | "number" | "list" | "confirm" | "select";
    options?: string[];
    required: boolean;       // required=true 必须答, false 可跳过
    why_critical: string;    // 解释为啥 worker 没这个会卡
    defaultValue?: unknown;  // Discovery 给的默认值，非 TUI 模式使用
  }>;
  assumptions: Array<{
    key: string;
    value: unknown;
    reason: string;          // "user_skipped" | "non_interactive_fallback" | "llm_inferred"
  }>;
}
```

### 4.2 动态 Output Schema

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

按任务类型自适应（Discovery LLM 根据 task string 选 section 集）：plan 任务必有 `plan`/`open_questions`；code 任务加 `code_diff`/`test_plan`；debug 任务用 `repro_steps`；research 任务用 `findings`/`sources`。

**Parser 行为**：required section 缺失/不符合 schema → 视为空 + quality 扣分；非 required 缺失 → 静默忽略；整体 raw 输出始终进 archive（`worker_output.raw`）——出事能复盘。

### 4.3 MoaWorkerResult 扩展

```ts
interface MoaWorkerResult {
  // ... 已有字段 ...
  parsed?: Record<string, unknown>;     // 按 output_schema 解析后的结构化输出
  qualityScore?: number;
  qualityDropped?: boolean;
}
```

### 4.4 轮次追踪 MoaRoundTrace

```ts
interface MoaRoundTrace {
  roundNumber: number;
  workers: Array<{ name: string; ok: boolean; score: number; durationMs: number; qualityDropped: boolean }>;
  questionsAsked: Array<{ question: string; answer?: string; sourceWorkers: string[] }>;
  questionsSkipped: Array<{ question: string; inferredFrom: string }>;
  userStopped: boolean;
  convergenceSignal: "no_new_questions" | "user_stop" | "max_rounds" | "all_complete" | null;
  startedAt: string;   // ISO
  endedAt: string;     // ISO
}
```

## 5. Quality Check

### 5.1 Heuristic v1

```typescript
function scoreWorker(output, schema): number {
  let score = 0;
  for (const section of schema.sections.filter(s => s.required)) {
    if (output[section.name] !== undefined) score += 30;
  }
  if (output.plan?.length > 200) score += 20;                 // 拒绝态输出都 < 100 字符
  if ((output.open_questions ?? []).length < 5) score += 20;  // 一堆问号 = 没干活
  if (output.assumptions?.length > 0) score += 10;
  if (!/请确认|as an AI|I cannot|让我先/.test(output.raw)) score += 20;  // 守契约
  return score;  // < 40 丢弃
}
```

### 5.2 丢弃行为

- score < 40 → 从 synthesis 输入移除，archive 标 `quality_dropped`
- 3 worker 全 < 40 → **fail loud**：不跑 synthesis，返回 `synthesis = { ok: false, stderr: "all workers quality-failed" }`
- 0-2 worker 存活 → synthesis 收到部分输入，archive 显式记录

### 5.3 Quality v2（已实施，运行时以 `src/quality/` 为准）

§5.1 的 v1 是 multi-round 初版思路；v2 已落地：per-role 加权启发式（divergent/grounded/critical 维度权重，默认启用）+ 可选 hybrid LLM judge（灰区/willDrop 触发，`enabled: false` 默认关闭）+ 契约硬失败（缺 required section 硬封顶 ≤30，judge 不可救回）。

## 6. 多轮循环

### 6.1 收敛检测

```typescript
function isConverged(round, history): boolean {
  // 条件 1: 当前轮 open_questions ⊆ 历史已知问题集（且本轮无新题）
  // 条件 2: user stop
  // 条件 3: roundNumber >= settings.maxRounds
  // 条件 4: 全部 3 worker 最新轮 score ≥ 80 且 0 open_questions
}
```

### 6.2 轮次间 TCO 注入

Re-spawn worker prompt 包含：原始 task、所有历史 answers（pre-ask + 各轮）、assumptions、本轮新答案、**已问过的问题 + 用户答复**、output_schema——确保 worker 答过的题不再问、答过的答案被尊重。

### 6.3 TUI UX

- 状态条：`Round 2/3 · asking question 3/5 · divergent OK · grounded OK · critical BLOCKED`（`ui.setStatus("moa", …)`）
- Ask 三选项：`answer` / `skip` / `stop all`；freeform 输入 `STOP` 为 fallback
- 30s 单题 timeout（`askTimeoutMs`）；全 stop 后 synthesis 立刻跑

## 7. Settings

```ts
interface MoaSettings {
  // ... 已有字段 ...
  discoveryEnabled: boolean;          // 已存在, 接通
  rewriteEnabled: boolean;            // 已存在, 接通
  discoveryModel?: string;            // 默认 = synthesisModel
  discoveryToolMode: MoaPlannerToolMode;  // 默认 read-only
  injectStyle: "preamble" | "context_block";  // TCO 注入格式
  maxMissingInputs: number;           // 默认 5
  askTimeoutMs: number;               // 默认 30000
  maxRounds: number;                  // TUI 默认 3；Gateway/cron 强制 0
  maxQuestionsPerRound: number;       // 默认 5
  qualityMinScore: number;            // 默认 40
}
```

配置示例（`~/.cornfield/agent/moa.yml`）：「现有 discoveryEnabled/rewriteEnabled/workerCount/workers 字段」+ 上述新增字段。

## 8. TUI vs 非 TUI 行为矩阵

| 场景 | Discovery | Ask user | Workers | Multi-Round | Ask Round | Synthesis | Archive |
|---|---|---|---|---|---|---|---|
| TUI 交互 | ✅ 跑 | ✅ 弹窗问 3-5 题 | ✅ 跑 | ✅ 跑（maxRounds=3） | ✅ 弹窗 answer/skip/stop | ✅ 跑 | ✅ dispatch_log 多 round |
| Cron | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ❌ skip（maxRounds=0） | ❌ skip | ✅ 跑 | ✅ dispatch_log 单 round |
| 钉钉 Gateway | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ❌ skip | ❌ skip | ✅ 跑 | ✅ dispatch_log 单 round |
| Batch / 测试 | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ❌ skip | ❌ skip | ✅ 跑 | ✅ dispatch_log 单 round |

## 9. 失败模式

| 失败 | 检测 | 处理 |
|---|---|---|
| Discovery LLM 超时 | 30s timeout | fallback 无 Discovery 模式，log warn |
| Discovery 输出无法 parse | JSON.parse 失败 | 重试 1 次，仍失败按空 TCO 跑旧路径 + log error |
| Discovery 无 output_schema | parse 失败 | fallback v1 写死 schema（plan + open_questions + assumptions） |
| Worker 输出无 required section | worker-parser error | 视为空 + quality 扣分 |
| Ask user 单条 timeout | input() timeout | 该项标 `user_skipped` assumed，不算收敛 |
| 必填项 skip | required && !answered | 仍标 assumed，reason = `user_skipped_required`，synthesis 高亮 |
| Rewrite LLM 失败 | spawn error | fallback 旧 buildWorkerPlans（裸 task）+ log warn |
| Worker 收到 assumed 还反问 | output 含 `?` + 确认词 | synthesis 标 `worker_blocked_on_assumption` |
| 3 worker 全 quality 丢弃 | 全 qualityDropped | fail loud，不跑 synthesis |
| 收敛死循环 | round 达 maxRounds | 强制停跑 synthesis |
| 动态 schema 未知 type | parser 跳过 | 不影响其他 section + log warn |

## 10. 关键决策记录

| # | 决策 | 取值 | 备选 / 否决理由 |
|---|---|---|---|
| D1 | maxRounds (TUI) | 3 | 2 太短 / 5 user 烦 |
| D2 | maxQuestionsPerRound | 5 | 3 题量大时多轮 / 10 疲劳 |
| D3 | Re-spawn 范围 | 全部 3 worker | 只重 spawn quality-fail 会错杀（heuristic 不可靠） |
| D4 | Quality 模式 | heuristic 起步 | LLM judge 贵 1× call/round、黑盒 |
| D5 | 用户停止按钮 | answer / skip / stop | — |
| D6 | Discovery 扩能 | 输出 output_schema | 用新 LLM 节点多余 |
| D7 | F1+F2+F3 一起做 | 是 | 独立 PR 割裂 |
| D8 | Schema 解析失败 fallback | v1 写死 schema | 抛错太严 / 接受空太松 |
| D9/T10 | 验证级别 | PR1 smoke / PR2 full e2e | 成本校准 |

## 11. 参考

- AgentAsk (ACL 2026, arXiv 2510.07593) — multi-agent 失败归因，Data Gap 29.1%
- Ask-before-Plan (EMNLP 2024 Findings, arXiv 2406.12639) — CEP framework
- Ask or Assume (arXiv 2603.26233) — uncertainty-aware scaffold
- Together MoA (ICLR 2025, arXiv 2406.04692) — 原始 MoA 论文
- Hermes Agent kanban（dispatcher 生命周期 + KANBAN_GUIDANCE）、pi-fusion、pi-ask-user — 参考系统见 §3

## 12. 后续工作（本次不做）

| 优先级 | 项目 | 备注 |
|---|---|---|
| P1 | Gateway / cron multi-round | 加 `CORNFIELD_MOA_GATEWAY_ASK_URL` 让 cron 也能 ask 钉钉用户 |
| P2 | Cross-task memory | 答过的题进 user.md / TCO cache，新 task 自动复用 |
| P2 | auto-fill from memory 按钮 | TUI ask 阶段点"我答过了"跳过 |
| P3 | Worker 模型选择 per round | 后半轮换更便宜模型 |
| P3 | 收敛算法升级 | LLM 评"问题相关性"，避免假收敛 |

> 注：LLM judge / per-role 权重可调已在 Quality v2（§5.3）实现，不在上表。