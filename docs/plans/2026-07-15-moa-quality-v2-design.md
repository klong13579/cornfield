# MOA Quality Check v2 — 设计

**日期**: 2026-07-15  
**状态**: 已确认（2026-07-15）  
**包**: `packages/moa-extension`  
**前置**: [`docs/moa-multi-round-design.md`](../moa-multi-round-design.md) §6（heuristic v1）  
**对照**: Hermes Kanban — 默认不开 LLM judge；仅 `--goal` 时每 turn 后 auxiliary judge

---

## 1. 背景

v1（`worker-parser.ts`）对所有角色用同一套启发式：

| 维度 | 分 |
|------|-----|
| required section 覆盖 | 0–30 |
| plan 长度 > 200 | +20 |
| open_questions < 5 | +20 |
| 有 assumptions | +10 |
| 无拒绝话术 | +20 |
| 缺任一 required | 硬封顶 ≤30 |

`< qualityMinScore`（默认 40）→ `qualityDropped`，不进 synthesis。

问题：

1. **尺子错位**：critical 短而狠会被 plan 长度拖死；divergent 长而空可能过线。
2. **语义盲区**：结构过了但仍是空壳/跑题，规则抓不住。
3. **成本敏感**：不能默认每 worker 每轮打 LLM（Hermes 也劝 one-shot 别开 goal judge）。

---

## 2. 已锁定决策

| # | 决策 | 取值 |
|---|------|------|
| D1 | Per-role | **维度权重**按角色不同；**不做** per-role `minScore` |
| D2 | Judge 默认 | **关** |
| D3 | Judge 打开后 | **hybrid**：仅灰区或「将 drop」时调用 |
| D4 | Judge 模型 | 默认 `narwal-plan/minimax-m3`，可配置 |
| D5 | 契约硬规则 | 缺 required → 硬封顶 ≤30；**judge 不可救回** |
| D6 | 模块形状 | 新建 `src/quality/`；parser 只解析；`applyWorkerParsing` 薄包装兼容 |
| D7 | 评分对象 | 仅 worker；**不**给 synthesis 打分 |
| D8 | 全量 `qualityMode: llm` | **本次不做**（可后加） |

对照 Hermes：默认协议/规则；贵的 LLM 验收 opt-in。MOA 因「自由 markdown → synthesis」仍需要打分层；Hermes 没有 per-role 加权表。

---

## 3. 目标 / 非目标

### 3.1 目标

1. Per-role 加权启发式替换全局同一权重（未知角色名 → v1 均匀权重）。
2. 可选 hybrid LLM judge（默认关）；打开后只对触发样本调用。
3. Judge 默认模型 `narwal-plan/minimax-m3`。
4. Archive / dispatchLog 可复盘：heuristic 分、是否调 judge、最终分、来源。
5. 缺 required 仍硬封顶；judge 不能救回契约失败。
6. 默认行为与 v1 成本面兼容：`judge.enabled=false` 时只多一次加权计算，零额外 LLM。

### 3.2 非目标

- 不给 synthesis 打分  
- 不做全量 `qualityMode: llm`  
- 不改 multi-round 收敛阈值语义（仍读最终 `qualityScore`；≥80 + 无 open_questions）  
- 不做 per-role `minScore`  
- 不上 SQLite board / 独立 verifier 卡（P2 另议）  
- 不改 gateway `maxRounds=0` 短路  

---

## 4. 架构

```
parseWorkerOutputBySchema (纯，仍在 worker-parser.ts)
        ↓
scoreWorkerHeuristicV2(parsed, schema, role, weights)  → heuristicScore + breakdown
        ↓
[shouldJudge?]  — judge.enabled && !contractHardFail && (willDrop || inGrayZone)
        ↓ yes
runQualityJudge(worker, role, task?, acceptance?)     → judgeScore + rationale
        ↓
finalizeQuality(heuristic, judge?) → qualityScore, qualityDropped, qualityMeta
        ↓
MoaWorkerResult（进 synthesis 过滤 + archive）
```

### 4.1 文件布局

```
packages/moa-extension/src/quality/
  types.ts          # weights、meta、judge 结果类型
  weights.ts        # DEFAULT_ROLE_WEIGHTS + resolveWeights(role)
  heuristic.ts      # scoreWorkerHeuristicV2（纯函数）
  judge.ts          # shouldJudge + runQualityJudge（异步，可注入 caller）
  apply.ts          # applyWorkerQuality（parse + heuristic [+ judge]）
  prompts/judge.md  # judge 静态 prompt（Handlebars）
packages/moa-extension/src/worker-parser.ts
  # 保留 parse*；scoreWorkerOutput / applyWorkerParsing 改为委托 quality/
  # 或 re-export，保证现有单测 import 路径不断
```

### 4.2 调用点

`stages.ts` 里两处 `applyWorkerParsing(...)` 改为：

```ts
await applyWorkerQuality(w, outputSchema, {
  minScore: settings.qualityMinScore,
  role: w.role ?? w.name,
  quality: settings.quality,       // v2 配置块
  task: plan.task,
  engine: workerEngine,            # 或独立 spawnJudge 回调，避免循环依赖
  signal,
});
```

`applyWorkerQuality` 对 `judge.enabled=false` 可同步路径（返回 `Promise` 也行，便于统一）。

---

## 5. 配置

### 5.1 Settings 形状

在 `MoaSettings` 上扩展（向后兼容：缺省 = v2 默认，行为≈v1 成本）：

```ts
interface MoaQualityRoleWeights {
  required: number;       // required section 覆盖
  planSubstance: number;  // plan 实质（长度/结构代理）
  openQuestions: number;  // 问题克制（越少越好）
  assumptions: number;    // 有 assumptions
  noRefusal: number;      // 无拒绝话术
}

interface MoaQualityJudgeSettings {
  enabled: boolean;                 // 默认 false
  mode: "hybrid";                   // 本次只实现 hybrid；预留字段
  model: string;                    // 默认 "narwal-plan/minimax-m3"
  grayMargin: number;               // 默认 10 → 灰区 [minScore, minScore+margin]
  timeoutMs: number;                // 默认 60_000
  /** 失败/超时时：保留 heuristic 分（不因 judge 挂掉改 drop） */
  onError: "keep_heuristic";        // 本次只此一种
}

interface MoaQualitySettings {
  /** 覆盖内建 per-role 权重；未列角色用 v1 均匀权重 */
  roleWeights?: Partial<Record<string, Partial<MoaQualityRoleWeights>>>;
  judge: MoaQualityJudgeSettings;
}

// MoaSettings 新增：
quality?: MoaQualitySettings;
// 保留 qualityMinScore: number（全局门槛，默认 40）
```

YAML 示例（`.omp/moa.yml`）：

```yaml
qualityMinScore: 40
quality:
  judge:
    enabled: false
    mode: hybrid
    model: narwal-plan/minimax-m3
    grayMargin: 10
    timeoutMs: 60000
  # 可选覆盖某一角色权重（分项之和建议 ≈100，实现侧归一化）
  roleWeights:
    critical:
      assumptions: 35
      planSubstance: 10
```

旧配置只写 `qualityMinScore`、不写 `quality` → 完全合法；等价于 v2 启发式 + judge 关。

### 5.2 默认 per-role 权重

各项满分贡献如下（合计 100）。未知角色 → **v1 均匀表**。

| 维度 | divergent | grounded | critical | v1 fallback |
|------|-----------|----------|----------|-------------|
| required | 25 | 30 | 25 | 30 |
| planSubstance | 30 | 25 | 15 | 20 |
| openQuestions | 15 | 20 | 15 | 20 |
| assumptions | 10 | 15 | 30 | 10 |
| noRefusal | 20 | 10 | 15 | 20 |

角色匹配：先 `worker.name`（`divergent`/`grounded`/`critical`），再小写 `role` 字符串包含这些 token；否则 fallback。

### 5.3 启发式计分规则（与 v1 同信号，改权重）

对每个维度算 **hit ∈ {0,1} 或 fraction**，再乘该角色权重：

| 维度 | hit 条件 |
|------|----------|
| required | `requiredHits / requiredTotal`（无 required section 时视为 1） |
| planSubstance | `plan.length > 200` → 1，否则 0（后续可升级为「非空 bullet 数」但不在本版） |
| openQuestions | `oqCount < 5` → 1，否则 0 |
| assumptions | section 非空 → 1 |
| noRefusal | 无 REFUSAL_PATTERNS 命中 → 1 |

```
raw = Σ weight_i * hit_i
score = round(raw)
if requiredHits < requiredTotal: score = min(score, 30)   // 硬封顶
```

`REFUSAL_PATTERNS` 从 v1 原样搬到 `heuristic.ts`。

---

## 6. Hybrid Judge

### 6.1 触发条件（全部满足才调用）

1. `quality.judge.enabled === true`  
2. **非**契约硬失败（`requiredHits < requiredTotal`）— 硬失败直接 drop，不浪费 judge  
3. 下列之一：  
   - **willDrop**：`heuristicScore < qualityMinScore`  
   - **grayZone**：`heuristicScore ∈ [minScore, minScore + grayMargin]`（默认 `[40, 50]`）

未触发 → `qualityScore = heuristicScore`，`source = "heuristic"`。

### 6.2 合并规则

| 情况 | `qualityScore` | `source` |
|------|----------------|----------|
| 未调 judge | heuristic | `heuristic` |
| judge 成功 | **judge 分覆盖** | `judge` |
| judge 失败/超时/解析失败 | 保留 heuristic | `heuristic`（`judgeError` 记入 meta） |
| 契约硬失败 | ≤30 的 heuristic | `heuristic`（`contractHardFail: true`） |

Judge **可以**把 willDrop 救回（例如 35→70），也可以把灰区打落（48→20）。  
Judge **不可以**在契约硬失败时被调用，因此无法救回缺 section。

### 6.3 Judge 合同

- **模型**: `settings.quality.judge.model`  
- **工具**: `none`（纯文本 JSON）  
- **执行**: 复用现有 `WorkerEngine` / `spawnMoaWorker` 路径之一（推荐 subprocess + `--no-session`，与 worker 隔离）；或注入 `judgeFn` 便于单测  
- **超时**: `judge.timeoutMs`  
- **输出**: 严格 JSON（prompt 要求；解析失败 → onError）

```json
{
  "score": 0,
  "pass": true,
  "rationale": "…",
  "role_fit": "high|medium|low",
  "issues": ["…"]
}
```

`score` clamp 到 `[0, 100]`。`pass` 仅审计用；drop 仍只看 `score < minScore`。

### 6.4 Prompt 要点（`prompts/judge.md`）

输入：

- 原 task（截断）  
- worker `name` / `role`  
- 该角色评分侧重说明（一行）  
- 解析后的 sections（plan / open_questions / assumptions，各截断）  
- 可选：后续若加 acceptance 块则注入（**本版可不做 CLI，预留 `{{#if acceptance}}`**）

规则：

- 按角色评判（critical 重风险/假设；divergent 重覆盖；grounded 重可执行）  
- 只输出 JSON，无散文  
- 缺实质计划但结构完整 → 低分  
- 与 Hermes goal judge 不同：本版 **不做** 多 turn 循环；单次打分后返回 orchestrator

### 6.5 并发与成本上界

每轮最多 3 次 judge，且仅触发子集。  
并行：对需 judge 的 worker `Promise.all`。  
最坏：3 worker × 每轮都在灰区 → 3 call/round；默认 `enabled=false` → 0。

---

## 7. 结果与持久化

### 7.1 `MoaWorkerResult` 扩展（向后兼容）

```ts
qualityScore?: number;          // 最终分（synthesis / 收敛用）
qualityDropped?: boolean;
qualityMeta?: {
  version: 2;
  heuristicScore: number;
  judgeScore?: number;
  source: "heuristic" | "judge";
  roleKey: string;              // 匹配到的权重键或 "fallback"
  contractHardFail: boolean;
  judged: boolean;
  judgeError?: string;
  breakdown?: WorkerQualityBreakdown; // 启发式明细
};
```

旧字段语义不变：下游只读 `qualityScore` / `qualityDropped` 的代码无需改。

### 7.2 Archive / dispatchLog

- `dispatchLog` 条目增加可选 `qualityMeta`（或至少 `heuristicScore` / `source` / `judged`）  
- transcript 渲染一行：`quality=72 (heuristic=45 → judge=72)`  
- `/moa status` 增加：`quality judge: off|hybrid@model`、`grayMargin`

### 7.3 Trace / moa-result

用户可见 handoff **不强制**塞满 meta（控字节）；details / archive 保留完整 meta。

---

## 8. 错误处理

| 情况 | 行为 |
|------|------|
| Judge 超时 / spawn 失败 | `keep_heuristic`；记 `judgeError` |
| Judge 非 JSON / 缺 score | 同上 |
| Judge 返回越界 score | clamp 0–100 |
| 全部 worker 仍 drop | 与 v1 相同：`quality_failed`，不跑 synthesis |
| `judge.enabled` 但无 API key | 同上 fallback；不 fail 整次 run |

---

## 9. 兼容与迁移

| 场景 | 行为 |
|------|------|
| 无 `quality` 块 | judge 关；per-role 默认权重启用（**分数分布会相对 v1 变化**） |
| 要咬死 v1 分数 | `roleWeights` 显式设成 v1 均匀表，或文档说明「升级后启发式即 v2」 |
| 仅 `qualityMinScore` | 仍生效，全局门槛 |
| 单测 `scoreWorkerOutput` | 保留函数名；内部走 v2 + fallback 权重，或测 `heuristic.ts` 新 API |

**刻意变化**：默认启用 per-role 权重后，同输入分数可能与 v1 不同——这是 v2 目标，不是 bug。CHANGELOG 写明。

若需紧急回滚启发式：settings 可加 `quality.heuristicVersion: 1 | 2`（**可选**；本版若嫌多可砍，靠 git revert）。

**推荐本版**：不设 `heuristicVersion`，直接切 v2 权重；CHANGELOG + 单测锁定新表。

---

## 10. 测试计划

| 层 | 内容 |
|----|------|
| 单元 `weights.ts` | 角色解析；未知 → fallback；偏权重覆盖 |
| 单元 `heuristic.ts` | 同 fixture 下 divergent vs critical 分数差；硬封顶 |
| 单元 `judge.ts` | `shouldJudge` 真值表（enabled/硬失败/灰区/willDrop） |
| 单元 `apply.ts` | mock judgeFn：救回 / 打落 / 错误回退 |
| 回归 | 现有 `executor` / `stages` quality_failed、部分 drop 用例仍过 |
| 可选 e2e | `quality.judge.enabled=true` + 灰区 fixture（API key 门控） |

不加默认 CI 真 LLM judge。

---

## 11. 实施顺序（确认设计后 → writing-plans）

1. `quality/types` + `weights` + `heuristic` + 单测  
2. `apply` 同步路径接 `stages`；`worker-parser` 委托  
3. `judge` + prompt + hybrid 接线 + mock 单测  
4. settings / moa-config 解析 + `/moa status`  
5. archive / dispatchLog / CHANGELOG  
6. 可选：stage-test 打印 qualityMeta  

---

## 12. 后续（本次不做）

| 项 | 备注 |
|----|------|
| `qualityMode: llm` 全量 | 评测/研究用 |
| acceptance CLI 块 | prompt 已预留 |
| 独立 verifier 卡 | Hermes Swarm 风格，P2 |
| per-role minScore | 等分数分布数据 |
| planSubstance 升级为结构分 | bullet/标题启发式 |

---

## 13. 确认清单

- [x] §2 决策表（D1–D8）  
- [x] §5.2 默认权重表  
- [x] §6 hybrid 触发与「judge 覆盖分数」  
- [x] §9 默认切换 v2 权重（允许分数分布变化）  
- [x] Judge 模型默认 `narwal-plan/minimax-m3`  

**已确认 2026-07-15。** 实施计划：[`2026-07-15-moa-quality-v2-implementation.md`](./2026-07-15-moa-quality-v2-implementation.md)。
