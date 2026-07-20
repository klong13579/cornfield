# MoA Ask=grill-me + Research 门禁 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 对比/设计类 MoA 跑通「意图分类 → grill-me 决策澄清 → Research 查公开实体 → Workers 复用证据」，消灭「问用户定义 / Research=none / worker 重复搜」三类失败。

**Architecture:** Discovery 产出 `task_intent`；**Research 在 grill Ask 之前**（对齐 Hermes「先搜后 clarify」与会话定稿）；Ask 在 TUI 用 **grill-me（task/design 分支）** 写回 TCO（可注入已有 `research_pack`）；Research cue 覆盖「区别/对比」；plan worker 问人路径保持关闭（`postWorkerAskEnabled=false` 不动）。

**Tech Stack:** `packages/moa-extension`（Bun test、现有 `ask-user` / `stages` / `research-mode`）、项目 skill `.omp/skills/grilling/SKILL.md`、Handlebars prompts。

**状态:** 设计已锁定（用户选定 Ask=grill-me，2026-07-19）  
**前置:** once-right P0–P5、Phase 7 Research、本会话诊断（`moa-20260719-070501-25kyv5`）

---

## 0. 目标流水线（锁定）

```text
Discovery(+ task_intent: compare | design | local-impl)
  → InputCollect B（可选；禁止「可搜实体定义」类 needed_inputs；B 结果先入 TCO，不弹窗）
  → Research（compare / 外部实体 → required|encouraged；写入 research_pack）
  → Ask = grill-me（TUI；一次一题 + 推荐答案；**可读 research_pack**；只烤决策维）
  → Rewrite
  → Plan Workers（共享 research_pack；research≠none 时禁 web_search；缺口→assumptions）
  → Synthesis
```

相对 Phase 7 现状（Ask→Research）：**对 compare / 需外部实体的任务，交换为 Research→Ask。**  
`researchMode=none` 的窄实现题可跳过 Research，直接 grill/form Ask（或跳过 Ask）。

**刻意不做:** 默认打开 `postWorkerAskEnabled`；cron/gateway grill；全量 Hermes kanban。

---

## 1. Ask = grill-me — 行为合同

### 1.1 何时启用

| 条件 | 行为 |
|---|---|
| `hasUI && askEnabled && askStrategy=grill-me`（新默认可为 `grill-me` 或 `auto`） | 走 grill |
| `task_intent` ∈ `{compare, design}` 或 `askStrategy=grill-me` | grill |
| `task_intent=local-impl` 且缺口少 | 可保留短表单 Ask，或仍 grill（`task` 意图）— **默认：一律 grill（task 分支）简化** |
| `!hasUI` / `askEnabled=false` | 与今日相同：全部 `non_interactive_fallback` assumed |

### 1.2 Grill 怎么跑（对齐 `.omp/skills/grilling`）

1. **Intent map（grilling skill）**
   - `compare` / 产品对比 → grilling **`task`**（动态题，无固定模板）
   - `design` / 架构方案 → grilling **`design`**
   - `user` 画像类 → **不进 MoA Ask**（那是会话级 grilling，不是 `/moa run`）
2. **一次一题**，每题附 **recommended answer**；用户可采纳推荐 / 改写 / skip。
3. **Research 已跑完**：grill system 注入 `### Research evidence`；**禁止再问**公开实体定义 / 仓内可搜事实。
4. **轮次硬顶** `grillMaxQuestions`（默认 5，复用 `maxQuestionsPerRound`）防无限烤。
5. 答案写入 TCO：`known_inputs`（`source: "user"`）+ 跳过进 `assumptions`；grill 前/后清掉定义类 `missing_inputs`。

### 1.3 与现有 `askMissingInputs` 关系

- **替换** Pre-Ask 主路径：`runAskStage` → `runGrillAskStage`（新）。
- 保留 `askMissingInputs` / `askQuestionsList` 给：
  - `postWorkerAskEnabled=true` 的 Round-Ask（仍 opt-in）
  - 测试与 fallback（`askStrategy=form`）
- InputCollect B：改 prompt — **禁止** `needed_inputs` 含「X 是什么 / 本项目指什么」；只允许决策维。

### 1.4 实现形态（选定）

**轻量 in-process grill agent（推荐）**，不要嵌套完整交互会话：

1. 拼 system：`grilling` skill 正文 + MoA grill 硬规则（禁止问公开定义；一次一题；输出 JSON）。
2. Loop ≤ N：
   - LLM 产出下一题 JSON：`{ done, key, question, recommended, type, options? }`
   - `done=true` → 结束
   - 否则 `ui.select` / `ui.input`（推荐作默认选项之一）
   - 把 Q+A 追加进 grill transcript，再问下一题
3. 无 LLM 失败 → fallback：`askMissingInputs` 对 **已过滤** 的 `missing_inputs`（去掉定义类）。

备选（不做）：把 `skill://grill-me` 挂到主会话 — 无法干净写回 TCO / 打断 MoA 状态机。

---

## 2. P0 — Research + Discovery 门禁（与 grill 配套）

### 2.1 `research-mode.ts`

`REQUIRED_CUES` / `ENCOURAGED_CUES` 增加：

- `区别|对比|vs\.?|versus|比起|相比较|竞品对比`

`hermes agent 和 workbuddy 的区别是什么？` → **非 none**（至少 encouraged，prefer required）。

### 2.2 Discovery prompt / schema

- 输出增加 `task_intent: "compare"|"design"|"local-impl"`
- Hard rule：`compare` 时 **不要** 把「实体定义」放进 `missing_inputs`；写 `known_inputs` 占位 `needs_research: true` 或留给 Research
- 默认理解：对比题是业界/外部对象，**勿默认「OMP 仓内两个组件」**

### 2.3 Input-collect prompt

Hard rule：同 Discovery — 禁止定义题 / 仓内可搜事实。

---

## 3. P1 — Worker 证据（问人已修好，只动搜）

- 保持 `postWorkerAskEnabled=false`
- `restrictPlanWorkerTools` 在 research≠none 时 strip `web_search`（Phase 7 已有则补测）
- `worker.md` 已禁止 prose 问人 — 不改语义，最多加一句「证据以 research_pack 为准」

---

## 4. Settings

```ts
askStrategy: "grill-me" | "form" | "auto";  // 默认 "grill-me"
grillMaxQuestions: number;                   // 默认 = maxQuestionsPerRound (5)
// askEnabled / inputCollectEnabled / postWorkerAskEnabled 行为不变
```

`auto`：`compare|design`→grill-me，否则 form（若实现成本高，可砍掉 auto，只留 grill-me + form）。

---

## 5. 文件清单

| 文件 | 动作 |
|---|---|
| `src/research-mode.ts` | cue 扩展 + 单测 |
| `src/prompts/discovery.md` | intent + 反本地偏见 + 禁定义题 |
| `src/prompts/input-collect.md` | 禁定义题 |
| `src/prompts/grill-ask.md`（新） | grill 循环 system 合同 |
| `src/grill-ask.ts`（新） | loop + UI + 写 TCO |
| `src/ask-user.ts` | 可选：`filterNonDecisionMissing` 纯函数供 fallback |
| `src/stages.ts` | `runAskStage` 按 strategy 分派 |
| `src/settings.ts` / `types.ts` | 新字段 |
| `src/tco.ts` | `task_intent?` 解析 |
| `test/research-mode.test.ts` | 区别→research |
| `test/grill-ask.test.ts`（新） | TDD |
| `test/stages` / `executor` | strategy 分派 |
| `CHANGELOG.md` | Unreleased |
| 本计划文档 | 实施后勾选 |

---

## 6. 任务拆解（TDD）

### Task 1: Research cue

**Step 1:** 单测 `inferResearchMode("hermes agent 和 workbuddy 的区别是什么？")` ≠ `"none"`  
**Step 2:** 改 `research-mode.ts` 绿灯  
**Step 3:** 提交（若用户要求）

### Task 2: 过滤「定义类」missing（纯函数）

**Step 1:** 测 `isDefinitionStyleQuestion` / `filterDecisionMissing`  
**Step 2:** 实现；Discovery/B merge 后 Ask 前调用（form 与 grill fallback 共用）

### Task 3: grill-ask 核心 loop（mock UI + mock LLM）

**Step 1:** 失败测：一次一题、推荐答案、写 known_inputs、达到 max 停、done 停、无 UI assumed  
**Step 2:** 实现 `runGrillAsk`  
**Step 3:** 绿灯

### Task 4: stages 接线 + settings + **顺序改为 Research→Ask**

**Step 1:** `askStrategy=grill-me` 走 grill；`form` 走旧路径  
**Step 2:** Discovery 解析 `task_intent`（宽容默认 → grill）  
**Step 3:** 改 `executor.ts`：当 `resolveResearchMode ≠ none` 时，**先 `runResearchStage` 再 grill/form Ask**；`none` 时跳过 Research。单测锁定 timings 顺序。

> 对齐 Hermes「宽泛请求先 search，再 clarify 决策」；grill 带着 pack 出题。

### Task 5: Prompt 更新 Discovery / B / grill-ask.md

静态 `.md`，无 inline 长 prompt。

### Task 6: 回归说明

文档 + CHANGELOG；手工验收用例见下。

---

## 7. 验收

```text
/moa run hermes agent 和 workbuddy 的区别是什么？
```

期望：

1. Ask UI 为 **grill 一次一题**（带推荐），**无**「workbuddy 在 OMP 指什么」
2. timings 含 **research**（cue 命中）
3. `post-worker ask: off`
4. workers 不因重复搜而大面积空超时（有 pack 时）
5. synthesis 有来源或明确 assumptions

---

## 8. 运维（并行、非代码）

- TUI：`~/.bun/bin/omp` → `dist/omp`（已 symlink）
- Gateway：`cp dist → ~/.local/bin/omp` + graceful restart（另做）

---

## 9. 决策记录

| # | 决策 | 取值 |
|---|---|---|
| D1 | Ask 策略 | **grill-me**（用户 2026-07-19 选定） |
| D2 | Plan worker 再问人 | 保持关闭 |
| D3 | Grill 实现 | in-process 题循环，非嵌套主会话 skill |
| D4 | Ask vs Research 顺序 | **Research→grill Ask**（纠正计划稿折中；对齐会话定稿 + Hermes 先搜后问） |
| D5 | Gateway grill | 不启用，assumed |

---

## 10. 实施勾选

- [x] Task 1 Research cue
- [x] Task 2 定义题过滤
- [x] Task 3 grill-ask
- [x] Task 4 stages/settings
- [x] Task 5 prompts
- [x] Task 6 CHANGELOG + 手工验收
