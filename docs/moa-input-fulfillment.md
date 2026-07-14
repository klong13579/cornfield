# MOA Input Fulfillment — 设计与实施计划

**作者**: Pi staff engineer
**日期**: 2026-07-13
**Status**: 设计已确认，已实施 (2026-07-13)
**关联**: `packages/moa-extension/`

---

## 1. 问题

MOA pipeline 当前 `executePlan` 只跑 `plan.workers + synthesis`，不跑 `plan.discoveryPrompt` / `plan.rewritePrompt`。结果：

- 3 个 worker 收到的是裸任务字符串，没有前置意图理解
- 任务里有"10 个岗位 / 4 周 / 速度成本质量"等隐含信息，模型不知道
- 实证：上一轮 124.7s 跑出，grounded 和 critical worker 直接反问 4-5 个澄清问题就停了，**没出方案**

数据支撑：AgentAsk (ACL 2026) 对 824 例 multi-agent 失败审计，**Data Gap 占 29.1%** — 我们这次踩的就是这个。

## 2. 目标

1. **执行前先做意图理解** — Discovery stage 读 user.md / moa.yml / cwd 项目文件，产出 Task Context Object (TCO)
2. **保证每个 worker 需要的输入都被满足** — TCO 显式列出 known_inputs 和 missing_inputs，缺的 ask user 一次问完，不够就标 `[assumed: ...]` fallback
3. **不阻塞非交互场景** — TUI 模式走 ask user；gateway / cron 走 assumed fallback，synthesis 把 assumption 显式呈现给用户

## 3. 解决方案：4 stage pipeline

```
[Discovery LLM]         ← 读 user.md / moa.yml / cwd / 工具调用
   ↓ 产出 TCO = { task_understanding, known_inputs, missing_inputs[] }
[Ask user]              ← TUI 模式: ctx.ui.input() 一次问完 missing_inputs
   ↓                  ← 非 TUI: 全部标 assumed
[Rewrite LLM]           ← 把 TCO 拆成 3 个 worker-specific prompts
   ↓                  ← (可选 stage, settings.rewriteEnabled)
[Worker 1/2/3 parallel] ← 每个 worker 拿到 rewritten prompt
   ↓
[Synthesis]             ← 拿 3 worker 输出 + assumption 清单 → 最终建议
```

## 4. 数据结构

### 4.1 Task Context Object (TCO)

```ts
interface TaskContextObject {
  /** Discovery LLM 重述的任务 */
  task_understanding: string;

  /** 已从 context 推断 + 用户显式给的输入 */
  known_inputs: Record<string, {
    value: unknown;
    source: "user" | "user_md" | "moa_yml" | "cwd" | "tool_call" | "llm_inferred";
  }>;

  /** 真正缺、必须 ask user 的输入（3-5 条上限） */
  missing_inputs: Array<{
    key: string;             // 注入 worker prompt 的变量名
    question: string;        // 给用户看的题目
    type: "text" | "number" | "list" | "confirm" | "select";
    options?: string[];      // select 类型的候选项
    required: boolean;       // required=true 必须答, false 可跳过
    why_critical: string;    // 解释为啥 worker 没这个会卡
  }>;

  /** 用户跳过 / 非 TUI 模式自动填的假设 */
  assumptions: Array<{
    key: string;
    value: unknown;
    reason: string;          // "user_skipped" | "non_interactive_fallback" | "llm_inferred"
  }>;
}
```

### 4.2 MoaSettings 新增字段

```ts
interface MoaSettings {
  // ... 已有字段 ...
  discoveryEnabled: boolean;          // 已存在, 接通
  rewriteEnabled: boolean;            // 已存在, 接通
  /** Discovery LLM 用什么模型. 默认 = synthesisModel */
  discoveryModel?: string;
  /** Discovery 阶段给 worker 用的工具. 默认 read-only */
  discoveryToolMode: MoaPlannerToolMode;
  /** TCO 注入 worker prompt 的格式. "preamble" | "context_block" */
  injectStyle: "preamble" | "context_block";
  /** missing_inputs 数量上限, 3-5 合理 */
  maxMissingInputs: number;           // 默认 5
  /** Ask user 单条 timeout ms. TUI 模式生效 */
  askTimeoutMs: number;               // 默认 30000
}
```

## 5. 实施

### Phase 1: 接通现有 discovery / rewrite slot（最小改动）

**文件**: `packages/moa-extension/src/executor.ts`

1. `executePlan` 改造为 4 段式
2. 新增 `runDiscovery(plan, options)` — 跑 discovery LLM, 解析 TCO JSON
3. 新增 `runAskUser(tco, ctx, options)` — TUI 模式调 `ctx.ui.input()` / 非 TUI 标 assumed
4. 新增 `runRewrite(plan, tco, options)` — 跑 rewrite LLM, 拆 3 worker prompt
5. `runWorker` 改用 rewritten prompt + TCO 注入

**LOC 估**: ~200 行 executor.ts + ~150 行新 prompt 模板改写

### Phase 2: TCO 结构化 + 校验

**文件**: `packages/moa-extension/src/tco.ts`（新）

1. 定义 `TaskContextObject` / `MissingInput` / `Assumption` 类型
2. `parseDiscoveryOutput(raw: string): TaskContextObject` — Discovery LLM 输出转结构化
3. `validateTco(tco): { ok: boolean, errors: string[] }` — 校验 known_inputs 完整, missing_inputs 在限制内
4. `injectIntoPrompt(workerPrompt, tco, style): string` — 注入到 worker prompt

**LOC 估**: ~150 行

### Phase 3: Ask user 流程

**文件**: `packages/moa-extension/src/ask-user.ts`（新）

1. `shouldAskUser(ctx): boolean` — `ctx.hasUI === true && missing_inputs.length > 0`
2. `askMissingInputs(missing, ctx, timeoutMs): Promise<Map<key, value>>` — 串行调 `ctx.ui.input()`
3. Timeout 处理: 单条 timeout → 该项标 `user_skipped` assumed
4. `select` 类型用 `ctx.ui.select()`, `confirm` 类型用 yes/no
5. Required 项用户 skip → 强制标 assumed 但 `reason = "user_skipped_required"` 给 synthesis 显式标记

**LOC 估**: ~100 行

### Phase 4: 测试

**文件**:
- `packages/moa-extension/test/tco.test.ts`（新, ~100 行）
- `packages/moa-extension/test/ask-user.test.ts`（新, ~80 行）
- `packages/moa-extension/test/planner.test.ts`（改, +60 行）
- `packages/moa-extension/test/moa-e2e-input-fulfillment.test.ts`（新, ~150 行, e2e, 需 E2E=1）

**测试场景**:
1. TCO 解析: Discovery LLM 输出标准 / 缺字段 / 多 missing_inputs 超限 / 错类型
2. Ask user: 正常流 / timeout / required skip / 非 TUI fallback
3. 端到端: 用真实 OMP 跑"招聘计划"任务，3 worker 全产出方案（不卡反问）
4. 端到端: gateway 模式（无 UI）走 assumed fallback，synthesis 显式呈现 assumption

### Phase 5: 文档与 changelog

**文件**:
- `packages/moa-extension/CHANGELOG.md` — 新增 `### Changed` / `### Added`
- `packages/moa-extension/README.md` — 新增"Input Fulfillment"小节
- `docs/moa-input-fulfillment.md`（本文件）— 实施完成后标注 "状态: 已实施"

## 6. 配置示例

`~/.omp/agent/moa.yml` 新增段（与现有 `discoveryEnabled` 等并存）：

```yaml
# 现有字段
discoveryEnabled: true
rewriteEnabled: true
workerCount: 3
workers:
  - name: divergent
    role: divergent
    model: narwal-plan/qwen3.5-flash
  # ...

# 新增字段
discoveryModel: narwal-plan/deepseek-v4-pro-202606   # 可选, 默认 = synthesisModel
discoveryToolMode: read-only                          # 默认 read-only
injectStyle: preamble                                 # 默认 preamble
maxMissingInputs: 5                                   # 默认 5
askTimeoutMs: 30000                                   # 默认 30s
```

## 7. TUI vs 非 TUI 行为矩阵

| 场景 | Discovery | Ask user | Rewrite | Workers | Synthesis 标记 |
|---|---|---|---|---|---|
| TUI 交互 | ✅ 跑 | ✅ 弹窗问 (3-5 题) | ✅ 跑 | ✅ 跑 | assumption 来源分清 |
| Cron | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ✅ 跑 | `[assumed: non_interactive]` |
| 钉钉 Gateway | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ✅ 跑 | `[assumed: non_interactive]` |
| Batch / 测试 | ✅ 跑 | ❌ 全 assumed | ✅ 跑 | ✅ 跑 | `[assumed: non_interactive]` |

## 8. 失败模式

| 失败 | 检测 | 处理 |
|---|---|---|
| Discovery LLM 超时 | 30s timeout | Fallback 到无 Discovery 模式, log warn, 走旧路径 |
| Discovery LLM 输出无法 parse | JSON.parse 失败 | 重试 1 次, 仍失败则按空 TCO 跑（旧路径）+ log error |
| Ask user 单条 timeout | ctx.ui.input() timeout | 该项标 `user_skipped` assumed, 继续 |
| Ask user 必填项 skip | required && !answered | 仍标 assumed, reason = `user_skipped_required`, synthesis 高亮 |
| Rewrite LLM 失败 | spawn error | Fallback 到旧 buildWorkerPlans（用裸 task）, log warn |
| Worker 收到 `[assumed: ...]` 后还反问 | output 包含 `?` + `请确认` 等模式 | synthesis 标 `worker_blocked_on_assumption`, 用户可见 |

## 9. 实施时间线（估）

| Phase | 工作量 | 估时 |
|---|---|---|
| Phase 1 (接通 slot) | 200 + 150 行 | 1 天 |
| Phase 2 (TCO) | 150 行 | 0.5 天 |
| Phase 3 (Ask user) | 100 行 | 0.5 天 |
| Phase 4 (测试) | 400 行 | 1 天 |
| Phase 5 (文档) | 50 行 | 0.5 天 |
| **合计** | **~1050 行** | **~3.5 天** |

## 10. 参考

- AgentAsk (ACL 2026, arXiv 2510.07593) — multi-agent edge-level 错误归因, Data Gap 29.1%
- Ask-before-Plan (EMNLP 2024 Findings, arXiv 2406.12639) — CEP framework
- Ask or Assume (arXiv 2603.26233) — uncertainty-aware scaffold
- Together MoA (ICLR 2025, arXiv 2406.04692) — 原始 MoA 论文, 无 clarification 机制
