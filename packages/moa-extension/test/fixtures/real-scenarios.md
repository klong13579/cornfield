# MoA 真实测试用例

**用途**：手工 `/moa run`、stage-test、e2e 门禁的**业务场景题**（不是组件单测占位句）。  
**更新**：2026-07-23  
**约定**：跑完可在本文件「结果记录」补一行；CI 默认不跑真实 LLM，e2e 需 `E2E=1` + API key。

---

## 1. Design — 招聘 / 方案设计

### D1 · 米克原子 4 周招聘（锁定 e2e）

```text
为米克原子（室内家庭服务机器人创业公司，2C，研发阶段，天使轮）设计一份 4 周招聘计划，10 个岗位，从速度、成本、质量三个角度权衡
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| research | `encouraged`（架构/取舍类） |
| 来源 | `test/moa-e2e-real-config.test.ts`、`test-mr-e2e-cotest.ts` |
| 脚本答案（cotest） | 深圳；研发期 50 人四组（世界模型/行为智能/软件系统/机电系统）等 |

### D2 · 2 周校园招聘（预算/城市未定）

```text
设计一个为期 2 周的校园招聘流程，预算未定，目标城市未定
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| 来源 | `tmp/moa-p0-smoke.ts` |
| 关注点 | Discovery→Ask auto-skip 后 assumptions 是否进 synthesis |

### D3 · 2 周校园招聘（短版，Discovery 质量）

```text
设计一个为期 2 周的校园招聘流程
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| 来源 | `tmp/moa-p1-discovery-smoke.ts` |
| 关注点 | `missing_inputs` 是否像意图澄清（非定义题） |

### D4 · 内部知识库 RAG 方案

```text
给内部知识库做一个检索增强问答方案
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| 来源 | `tmp/moa-p1-discovery-smoke.ts` |

### D5 · 线上发布回滚演练

```text
规划一次线上发布回滚演练
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| 来源 | `tmp/moa-p1-discovery-smoke.ts` |

### D6 · 长会话上下文治理（research encouraged）

```text
为 omp 设计长会话上下文膨胀治理方案，给出可选架构与取舍
```

| 字段 | 值 |
|------|-----|
| intent | `design` |
| research | `encouraged` |
| 来源 | `test/research-mode.test.ts` |

### D7 · Feature A vs B 产品取舍（英文 e2e）

```text
Need a concise planning recommendation. Choose between launching Feature A this month or Feature B next month. No tools are required; reason from generic product tradeoffs only.
```

| 字段 | 值 |
|------|-----|
| intent | `design` / 取舍 |
| research | 倾向 `none`（显式禁工具） |
| 来源 | `test/moa-e2e.test.ts` |

---

## 2. Compare — 产品 / 工具对比

### C1 · Hermes vs WorkBuddy（grill + Research 验收）

```text
hermes agent 和 workbuddy 的区别是什么？
```

| 字段 | 值 |
|------|-----|
| intent | `compare` |
| research | `required` |
| 来源 | `docs/plans/2026-07-19-moa-grill-me-ask-and-research-fix.md` §验收 |
| 验收点 | Research≠none；不问「X 是什么」；grill 问维度/受众/深度 |

### C2 · WorkBuddy vs OpenClaw（手工实跑）

```text
对比一下 workbuddy 和 openclaw
```

| 字段 | 值 |
|------|-----|
| intent | `compare` |
| research | `required` |
| 来源 | 手工 tmux 验收（`moa-20260719-102635-6tsulu`） |

### C3 · Cursor / Claude Code / Continue 压缩策略（living regression）

```text
对比 Cursor 与 Claude Code 的会话压缩策略
```

扩展（设计文档 living）：

```text
对比 Cursor / Claude Code / Continue 的会话压缩策略
```

| 字段 | 值 |
|------|-----|
| intent | `compare` |
| research | `required` |
| 来源 | `test/research-mode.test.ts`；`docs/plans/2026-07-17-moa-research-stage-design.md` |

### C4 · OpenClaw 对比收益

```text
比起 OpenClaw，omp 的收益是什么
```

| 字段 | 值 |
|------|-----|
| intent | `compare` |
| research | `required` |
| 来源 | `test/research-mode.test.ts` |

### C5 · 业界 / 竞品调研类

```text
调研业界实践并给出参考方案
```

```text
看看竞品和开源方案怎么做
```

```text
对比业界压缩策略
```

| 字段 | 值 |
|------|-----|
| intent | `compare` 或 open research |
| research | `required` |
| 来源 | `test/research-mode.test.ts`、`test/stages.test.ts` |

---

## 3. Local-impl — 窄实现（应少问、少搜）

### L1 · 修 typo

```text
fix the typo in agent-loop.ts
```

```text
修个 typo
```

| 字段 | 值 |
|------|-----|
| intent | `local-impl` |
| research | `none` |
| 来源 | `test/research-mode.test.ts`、`test/stages.test.ts` |

### L2 · 最小 health check

```text
写一个最小 GET /health 实现，仅含返回 JSON
```

| 字段 | 值 |
|------|-----|
| intent | `local-impl` |
| research | `none` |
| 来源 | `test/research-mode.test.ts` |

---

## 4. 反例 / 负向用例（Ask 不应出现）

这些不是完整 `/moa run` 题，而是 Ask 过滤验收：

| 坏问题（应过滤） | 好问题（应保留） |
|------------------|------------------|
| workbuddy 在 OMP 项目中具体指什么？ | 您希望从哪个维度对比？ |
| hermes agent 是什么？ | 对比深度要功能层面还是架构层面？ |
| workbuddy 和 openclaw 分别是什么？ | （维度 / 受众 / 深度） |
| workbuddy 具体是哪个项目/工具？ | |

来源：`test/decision-missing.test.ts`、`test/stages.test.ts`（form ask filter）。

---

## 5. 怎么跑

```bash
# 手工整跑（需 omp / bun CLI）
/moa run <上表某一整句>

# Stage 诊断
bun packages/moa-extension/scripts/stage-test.ts --stage all --task "对比一下 workbuddy 和 openclaw"

# 真实 LLM e2e（门控）
E2E=1 bun test packages/moa-extension/test/moa-e2e-real-config.test.ts
E2E=1 bun run packages/moa-extension/test-mr-e2e-cotest.ts

# Discovery / P0 smoke
bun tmp/moa-p0-smoke.ts
bun tmp/moa-p1-discovery-smoke.ts
```

---

## 6. 结果记录（可选）

| 日期 | ID | 用例 | 结果 | 备注 |
|------|-----|------|------|------|
| 2026-07-19 | moa-20260719-102635-6tsulu | C2 | Workers 3/3 OK；Research→Ask | Research ~14min（后续已压预算 + researchModel） |
| 2026-07-23 | `tmp/moa-c2-probe/2026-07-23T14-12-22-746Z` | C2 | 整跑 ok；Workers 3/3；intent=compare；grill×3 维度题 | Research **785s salvage 0 sources**（budget=8）；Rewrite fallback；总墙钟 ~21min |
| 2026-07-23 | `tmp/moa-c2-probe/2026-07-23T14-55-10-403Z` | C2 | 对比题跳过 B；Research **457s salvage 20 sources**；Rewrite OK | early-stop+tool-trace salvage；总 ~19min；见 `tmp/moa-c2-probe/before-after.md` |
