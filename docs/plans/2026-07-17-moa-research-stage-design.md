# MOA Research Stage + 韧性 — 设计方案（Phase 7）

**日期**: 2026-07-17
**状态**: 实施中
**包**: `packages/moa-extension`
**前置**: [`2026-07-17-moa-once-right-design.md`](./2026-07-17-moa-once-right-design.md)（P0–P5 已完成）

---

## 1. 目标（沿用「一次做对」唯一原则）

**通过 MoA 增强「方案设计一次做对」。** 本 Phase 解决实测暴露的两类问题：

1. **重复调研**：3 个互不可见的 plan worker 各自 `web_search` + 读仓，重复最贵的工作，
   开放任务墙钟被拉到 5+ 分钟。
2. **全有或全无失败**：worker 超时 → 空输出 → 契约硬失败 → 0/3 → 无 synthesis。
   用户已答完 Ask，却拿不到任何可纠偏的交付物，直接违背「一次做对」。

---

## 2. 核心判断

经典 Together MoA = **单次 completion、无工具、秒级**；我们是 **带 `web_search` 的多轮 agent**，
分钟级是常态。因此不能用同一套超时/工具策略：把 **调研** 与 **出方案** 拆开，
调研只做一次（或少数几路角度），plan worker 只在共享证据上产出互不可见的方案。

与 once-right 决策一致：D4（worker 互不可见）、D6（assumptions 必现）、"宁可贵也要做对"。

---

## 3. 目标拓扑

```text
Discovery(A) ∥ InputCollect(B) → Merge → Ask×1
        ↓ TCO 稳态
   Research（新增，按 researchMode 触发；1 路默认，可选 2 路角度）
        ↓ research_pack 写入 TCO
   Rewrite（把 research_pack 注入每个 worker 专属提示）
        ↓
 Worker1 ∥ Worker2 ∥ Worker3   ← 同 TCO + 同 research_pack；默认禁 web_search
        ↓
   Quality（分档：ok / timedOutPartial / contractHardFail / dropped）
        ↓
   Synthesis（≥1 存活即出；0 存活但有 pack → 降级摘要，绝不空失败）
```

---

## 4. 数据合同：research_pack

挂在 TCO 上（注入顺路，且能进 archive）：

```ts
interface ResearchSource { claim: string; url: string; relevance: string; confidence?: "high" | "medium" | "low"; }
interface ResearchPack {
  mode: "encouraged" | "required";
  gathered_at: string;      // ISO
  queries: string[];        // 实际搜了什么
  sources: ResearchSource[];// 带 URL 的外部证据
  repo_facts: string[];     // 本仓事实（可空）
  gaps: string[];           // 调研后仍不确定 → 进 assumptions，不再搜
}
```

`TaskContextObject` 增加可选 `research_pack?: ResearchPack`。
`renderTcoForPrompt` 增加 `### Research evidence` 段（在 byte cap 内）。

**原则**：Research 结束后开放任务的外部事实应尽量闭合；plan worker 不再从零搜。

---

## 5. Research 阶段

- 触发：`researchMode !== "none"`（`auto` 推断开放任务时开启）。
- 形态：默认单 Research Agent（`web_search` / `read` / `search`），产出 `research_pack`。
  可选 `researchParallelism: 2` 两路互不可见（产品/文档向 vs 代码/实现向），merge 去重。
- **禁止** 出完整 plan（与 B 的 input-collect 合同对称）。
- 超时：独立 `researchTimeoutMs`（默认 15 min），与 plan worker 解耦。
- prompt：`src/prompts/research.md`；输出用宽容解析 `parseResearchPack`（JSON 优先，
  markdown `## sources` bullet 兜底）。

## 6. Plan Worker 工具与证据

- `researchMode !== "none"` 时，plan worker **移除 `web_search`**（保留 `read`/`search`/`ast_grep`）。
- Rewrite / worker.md 注入 `research_pack` 摘要，三路看同一份证据基线。
- 缺口只能写进 `## assumptions`（一句话 + 为何 pack 不足），由 synthesis 点名，不再自行外搜。
- `required` 模式下 plan worker 硬禁 web_search；`encouraged` 亦默认移除（调研已集中做）。

## 7. 分阶段超时（settings）

新增（缺省从旧 `timeoutMs` 派生，保证向后兼容）：

| 键 | 默认 | 用途 |
|----|------|------|
| `researchTimeoutMs` | `max(timeoutMs, 900_000)` | 唯一允许长搜 |
| `workerTimeoutMs` | `timeoutMs`（研究任务不再强抬 10min） | plan 只写方案 |
| `workerIdleTimeoutMs` | `120_000` | 无 token/工具进度才杀（流式中不杀） |
| `synthesisTimeoutMs` | `timeoutMs` | |
| `synthesisMinSurvivors` | `1` | ≥N 存活即 synthesis |

`resolveWorkerTimeoutMs` 语义调整：research 集中做后，plan worker 不再默认抬到 10min；
研究阶段用 `researchTimeoutMs`。保留旧行为作 fallback（无 research stage 时）。

## 8. 部分成功（不空失败）

worker 结果分档：

| 结果 | Quality | 参与 Synthesis |
|------|---------|----------------|
| 完整 plan | 正常 | ✅ |
| 超时但有 `## plan` 实体 (`timedOutPartial`) | 扣分，不 contractHardFail | ✅（标「不完整」） |
| 超时且几乎无正文 | dropped | ❌ |
| 契约硬失败 | ≤30 | ❌ |

合成门槛 `synthesisMinSurvivors`（默认 1）：
- ≥1 存活 → 必 synthesis。
- 0 存活但 `research_pack` 存在 → **降级 synthesis**：输出调研摘要 + assumptions +
  「未能完成方案，请缩小范围重跑」，仍是 `ok:false` 但带可用内容，而非空 stderr。
- 0 存活且无 pack → 保留现有 fail-loud。

## 9. 重试

对齐 LangGraph / Together MoA：只重试瞬时错误（429/5xx/连接），指数退避 1/2/4s 最多 2 次；
**不重试** 超时/契约失败/用户 abort。Research 阶段对单个 search 重试即可。（本 Phase 可后置）

## 10. 交付顺序（TDD，先稳前面）

| Task | 内容 | 门禁测试 |
|------|------|----------|
| 7.1 | settings 拆分超时 + synthesisMinSurvivors | `settings.test.ts` |
| 7.2 | research_pack 合同 + render | `tco.test.ts` |
| 7.3 | `runResearchStage` + `research.md` + `parseResearchPack` | `stages.test.ts` |
| 7.4 | executor 接线 + worker 禁 web_search + rewrite 注入 | `executor.test.ts` |
| 7.5 | 部分成功：timedOutPartial + minSurvivors + 降级 synthesis | `stages.test.ts` / `executor.test.ts` |
| 7.6 | TUI research 流式 + handoff `## Research evidence` | `trace.test.ts` |

**living regression**：用「对比 Cursor/Claude Code/Continue 压缩策略」任务，
须在 15min 内产出含引用的 synthesis，且 Ask 仍只一轮。

## 11. 非目标（本期）

- plan worker 互相看稿（保 D4）
- 默认开 Round-Ask
- gateway 产品化
- 超时后自动重跑整个 MoA（只重试瞬时 API 错误）
