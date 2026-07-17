# MOA「一次做对」— 设计方案

**日期**: 2026-07-17  
**状态**: 草案（待确认后实施）  
**包**: `packages/moa-extension`  
**前置**:
- [`docs/moa-input-fulfillment.md`](../moa-input-fulfillment.md) — TCO / Discovery / Pre-Ask
- [`docs/moa-multi-round-design.md`](../moa-multi-round-design.md) — multi-round / quality / schema
**实施计划**: [`docs/plans/2026-07-17-moa-once-right.md`](./2026-07-17-moa-once-right.md)

---

## 1. 设计目标（取舍唯一原则）

**通过构建 MoA 能力，增强「方案设计一次做对」的能力。**

凡有利于该目标的能力都应认真考虑（即使更贵或更打断）；  
凡仅为「无感 / 省事」却增加瞎猜、假收敛、假完整的，一律降级或不做默认。

推论：

| 倾向 | 选择 |
|------|------|
| 关键决策缺口 | **问用户**，不默认假设顶替 |
| Worker 生成 | **互不可见**并行，保多样性；融合在 Synthesis |
| 用户打断 | **默认一轮 Ask**（覆盖意图 + 角色输入），不做连环 Round-Ask |
| 可见性 | Worker 方案应在 TUI **流式可见**，便于早发现跑偏 |

**产品范围**: TUI `/moa`（不以 gateway 为产品目标）。

---

## 2. 目标 UX（用户视角）

```text
/moa <任务>
  → 等待「收集输入」
  → 【唯一一轮问卷】A 任务澄清 ∪ B 子模型输入
  → 等待「生成方案」（各 worker plan 流式出现）
  → 读 synthesis + Assumptions to verify
  → 不满则普通对话纠正，或再 /moa
```

默认**没有**第二轮问卷。专家模式可保留 `--rounds N`（非默认）。

---

## 3. 流水线拓扑

```text
[Context] user.md / moa.yml / cwd
    │
    ├─► [A] Discovery — 任务澄清 + known + missing_A + output_schema(plan)
    │
    └─► [B] Input-collect workers — 互不可见；只出确认清单 missing_B
              │
              ▼
         [Merge] 去重 / 优先级 / top-M
              │
              ▼
         [Ask ×1] answer / skip / STOP
              │
              ▼
         TCO 稳态 (known + assumptions；missing≈∅)
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 Worker1   Worker2   Worker3   ← 同 TCO；互不可见；出 plan
    │         │         │
    └─────────┴────┬────┘
                   ▼
            Quality gate
                   ▼
            Synthesis（assumptions 必呈现）
                   ▼
            moa-result + moa-archive
```

---

## 4. 一轮 Ask = A + B

### 4.1 A — 用户请求梳理澄清

**职责**: 对齐意图与决策边界，不是收集角色技术细节。

**怎么做**:

1. 预读上下文（现有 `gatherDiscoveryContext`）。
2. Discovery LLM 按 **澄清要素 checklist** 扫描，产出：
   - `task_understanding`
   - `known_inputs`
   - `missing_inputs`（A 侧）
   - `output_schema`（**plan 轮**合同）
3. 与 B 合并后再 Ask（实施 Phase 1 可先只 Ask A，见实施计划）。

**澄清要素（A checklist）** — 只问会改变方案骨架的项：

| 类别 | 要素 | 典型 type |
|------|------|-----------|
| 目标 | 交付物、成功标准 | text / confirm |
| 范围 | 做/不做、系统边界 | list / text |
| 约束 | 时间、预算、合规、硬技术限制 | text / number / select |
| 环境 | 目标环境、关键现况缺口 | select / text |
| 决策 | 谁拍板、受众 | text / select |
| 风险偏好 | 速度 vs 稳妥、破坏性变更 | select / confirm |
| 非目标 | 明确不做 | list |

**A 不问**: 实现细节、各角色专属参数（归 B）；仓库可读事实（自助）。

**Prompt 合同**: Discovery 必须按上表扫描；每题单轮可答；`missing_inputs` ≤ `maxMissingInputs`（默认 5，与 B 合并后再裁）。

### 4.2 B — 子模型问题收集

**职责**: 各角色在写 plan 前，报「不确认就只能瞎猜」的输入。

**怎么做**:

1. 轻量 fan-out（可与 A 并行；互不可见）。
2. **专用短 schema**：只允许确认清单 section，禁止完整 plan。
3. Prompt 硬约束：这是唯一问用户的机会；能自助的不问；每角色条数上限。
4. 产出 `missing_B[]`（建议带 `role` / `source: "worker"`）。

**正式 plan 轮** prompt 追加：用户已完成唯一 Ask；禁止再触发编排层 Round-Ask；剩余不确定进 `assumptions`。

### 4.3 合并规则

1. 并集 A ∪ B。  
2. 同义 / 同 key 去重，保留更具体问法。  
3. 优先级：`required` > 多角色需要 > 单角色。  
4. 裁剪至 `maxQuestionsPerRound`（默认 5）。  
5. UI 可分组展示「任务本身 / 执行前确认」，仍是**一次**连问。

Skip / 超时 → `assumptions`（保留 reason）；answered → `known_inputs`（`source: "user"`）。

---

## 5. Plan 轮：无互聊

与行业 MoA（Together / Hermes）一致：

- Worker **生成期互不可见**。
- 共享仅通过 **同一 TCO**（Ask 后稳态）。
- 融合仅在 **Synthesis**（冲突显式裁决）。
- **非目标（本期）**: 生成中 peer 辩论；可选 critique 层仅当日后 e2e 证明 synthesis 合并不了冲突再开。

---

## 6. TUI：Worker 方案流式显示

**需求**: 每个子任务（worker）生成的方案在 TUI **流式**呈现。

**目标行为**:

- 三路并行时，每路独立面板或可折叠流式块（角色名 + 增量 markdown）。
- 结束后定稿；`qualityDropped` 标 BLOCKED（流式过程可先显示）。
- Synthesis 仍可最后完整输出为 `moa-result` 主交付。

**引擎合同（待实施）**:

```ts
// 方向性 API，实施时以计划为准
execute(input, { onPartial?: (chunk: { name: string; text: string }) => void })
```

subprocess / in-process 均需接通 delta；TUI 节流刷新。

---

## 7. 数据合同

### 7.1 TCO（沿用，小扩展）

现有 `TaskContextObject`（`tco.ts`）保持核心字段。  
A+B 落地时建议扩展 `TcoMissingInput`：

```ts
source?: "discovery" | "worker";  // A vs B
role?: string;                    // B 侧来源角色
```

`assumptions.reason` 可后续加 `post_plan_residual`（plan 轮仍冒出、未再 Ask 的缺口）。

### 7.2 两套 Output Schema

| 轮次 | Schema | 用途 |
|------|--------|------|
| B 征询 | 短清单（如 `needed_inputs` list） | 只收集确认项 |
| Plan | Discovery 的 `output_schema` 或默认 plan/oq/assumptions | 正式方案 |

### 7.3 Synthesis 合同（修复）

- **始终**从 `tco.assumptions` 渲染「Assumptions made / to verify」。
- **去掉** `tco_block` 双重注入（prompt 已有则不再 `prependTco`，或反之只保留一处）。

### 7.4 Soft-recover（修复，双通道）

- 可保留正文填充供打分/展示。
- 必须标记 `softRecovered`；**契约仍硬失败**（或等价 ≤30）。
- 空 `open_questions` + soft-recover **禁止**触发 `all_complete` / 「无问题收敛」。

---

## 8. 默认设置（产品）

| 项 | 取值 | 说明 |
|----|------|------|
| TUI `maxRounds` | **1**（文档写清 opt-in 更大） | 与「默认一轮用户 Ask」一致；Round-Ask 默认关或仅专家 |
| 用户 Ask | 默认开；内容 = A∪B 合并 | |
| Gateway | 非产品目标 | 代码 `hasUI=false` 短路可保留作防御 |

文档 / CHANGELOG 与实现对齐：默认 1，需要深挖再提高 rounds。

---

## 9. 分阶段交付原则

**按业务交互从前到后开发：先把前面做稳定，再做后面。**

| Phase | 业务交互 | 稳定标准（门禁） |
|-------|----------|------------------|
| **P0** | 基础合同修复（不改拓扑） | soft-recover 不假收敛；synthesis assumptions 正确；非法 env 不崩 |
| **P1** | **只稳 A + 单轮 Ask（仅 A）** | Discovery checklist；Ask 只问 A；默认无 workers 后 Round-Ask；单测+手工 `/moa` |
| **P2** | **接入 B + 合并 Ask** | B 清单轮；A∪B 合并；仍一轮用户 Ask；回归 P1 |
| **P3** | **稳 Plan Workers + Quality** | 正式轮禁二次 Ask；schema-aware 评分起步；fail-loud 行为可预期 |
| **P4** | **Synthesis 合同收口** | 无双重 TCO；assumptions 必现；handoff 可读 |
| **P5** | **TUI worker 流式** | 三路并行流式可见；不破坏 P1–P4 |
| **P6** | 观测与韧性（按需） | archive round trace、usage 累加、subprocess 工具收紧等 |

任一 Phase 未过门禁，不启动下一 Phase。

---

## 10. 非目标（本期）

- Gateway / 钉钉上的 MoA 产品化  
- Worker 生成期互聊 / Multi-Agent Debate  
- 默认打开 LLM judge  
- Cross-task memory /「我答过了」按钮  
- 会话级「MoA 当 provider」每轮 fan-out（Hermes 档 2）

---

## 11. 成功标准

1. 用户每个默认 `/moa` **最多被问卷打断一次**，且题覆盖意图（A）与角色输入（B，P2 后）。  
2. 正式 plan 默认不再开第二轮 Ask；残余进 assumptions 并在结果中可见。  
3. Worker plan 在 TUI 流式可见（P5）。  
4. Soft-recover 不能制造假 `all_complete`。  
5. 「一次做对」相关回归：自定义 schema、非法 env、assumptions 展示、A∪B 合并去重。

---

## 12. 已锁定决策（本稿）

| # | 决策 | 取值 |
|---|------|------|
| D1 | 产品原则 | 一次做对方案 |
| D2 | 用户 Ask | 默认一轮 = A + B |
| D3 | `maxRounds` 默认 | 1；文档 opt-in |
| D4 | Plan worker 通信 | 互不可见 |
| D5 | Soft-recover | 双通道（内容可救，契约/收敛不可伪装） |
| D6 | Synthesis assumptions | 始终渲染 TCO.assumptions |
| D7 | 交付顺序 | P0→P1→… 前稳后再后 |
| D8 | Worker TUI 流式 | 要做（P5，不插队到 P1 前） |

---

## 13. 下一步

1. 确认本稿。  
2. 按 [`2026-07-17-moa-once-right.md`](./2026-07-17-moa-once-right.md) 从 **P0 → P1** 开工。  
3. 每 Phase 结束跑该 Phase 门禁测试后再进入下一 Phase。
