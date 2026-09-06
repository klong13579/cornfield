---
name: grill-ticket-squad
version: 0.1.0
description: >-
  大任务组队开工前的固定流程：先 grill-with-docs 审透方案 → to-tickets 拆成带
  依赖边的票 → 转译成 squad 任务包并行执行。Use when 用户要大任务并行组队、说
  "先审方案再拆票"/"功能太大组队做"/"走组队流程"，或已有方案文档要拆票并行。
  Skip for 单文件小改动、纯探索任务、任务已在执行中、用户只点名 squad 不需要前两道。
mutating: true
---

# grill-ticket-squad

> 组队接力壳：把"想法 → 审透 → 拆票 → 并行交付"固化成固定流程。本技能**不实现**
> 访谈/拆票/执行——那些是子技能的事；它只定顺序、定产物契约、做票→任务包转译。
> 权威源：grill-with-docs（+ grilling/domain-modeling）、to-tickets、squad-programming
> 各自 SKILL.md 是唯一事实源，本文不复制其内容，只引用与转译。

## Outcome

大任务经一次完整接力：方案在 grill 里被审透（术语+ADR 落盘）→ 用户确认过的带依赖票集
（`.scratch/`）→ 通过 `bootstrap.ts --check` 校验的 squad 任务包（`~/.cornfield/squads/`）
→ 交接给 squad-programming 集结执行。用户全程只参与：grill 逐题回答、拆票确认、squad 验收拍板。

## 产物地图（写死，不越界）

| 产物 | 落点 | 层 | 生命周期 |
|---|---|---|---|
| 术语 | 根 `CONTEXT.md`（多上下文则 CONTEXT-MAP.md 指向） | 知识 | 长期 |
| 设计决策 ADR | `docs/adr/NNN-*.md` | 知识 | 长期 |
| 方案整体 | `docs/<kebab-name>.md`（先在 docs/README 查重，禁止分叉） | 知识 | 长期 |
| 票集 | `.scratch/<feature-slug>/issues/NN-*.md`（已 gitignore，勿提交） | 过程 | 任务寿命 |
| 任务包/state/归档 | `~/.cornfield/squads/<squadId>/` + `archive/`（repo 外） | 过程 | 任务寿命 |
| 待办/进度/验收 | `TODO.md` + `topics/<slug>.md` | 台账 | 任务寿命 |

**守界三条**：① 不新建任何 docs 子体系——设计决策单定点 `docs/adr/`，人工与流程同源；
② 票/任务包是过程产物，不进 docs/、不进 git；③ 本技能执行细节一律指回子技能，不复制。

## 入口判定

| 入口 | 条件 | 动作 |
|---|---|---|
| 全链 | 大任务、方案未审、可拆 ≥2 个文件不重叠子任务 | Phase 1 起 |
| 从拆票 | 方案已定稿（spec/ADR/设计 doc 已齐，用户确认跳过 grill） | Phase 2 起 |
| 从执行 | 票集已存在且带依赖边、已确认 | Phase 3 起 |
| 不接力 | 单任务/纯探索/用户只要 squad | 指回单 agent 或 squad-programming，不硬套 |

无 ≥2 个文件不重叠子任务的并行收益时**不做**（继承 squad：不为并行而并行）。

## Phase 1 — 审方案（grill-with-docs）

加载 `skill://grill-with-docs`，按其纪律执行：一轮一个问题、带推荐答案、事实自己查
不问用户、决策归用户、设计树 frontier 走空为止。

本技能附加收尾要求（grill-with-docs 不覆盖的）：
1. grill 结束后，汇总**决策清单**：每条不可逆决策（ADR 摘要）+ 被否方案一行 + 范围外一行。
2. 决策清单给用户点头；点头后才进 Phase 2。
3. 大方案整体若要留档 → 按产物地图落 `docs/`（查重后写）；可逆小决策不硬凑 ADR。

**Completion**：设计树 frontier 空 + CONTEXT.md 术语落盘 + 不可逆决策已落 ADR（按需）+
决策清单用户确认。

## Phase 2 — 拆票（to-tickets）

加载 `skill://to-tickets`（本地模式），垂直切片 + 依赖边 + quiz 用户一次（粒度/依赖/
合并拆分），通过后发布到 `.scratch/<feature-slug>/issues/NN-*.md`，依赖序编号（blocker 在前）。

**粒度契约（本技能强约束，防止转译时二次拆）**：
- 一票 ≈ 单 fresh context ≈ squad 单 worktree 范围：交付可验证、可 demo，文件改动 ≤3-5 个级别。
- 宽重构（机械改名/跨仓符号重定义）按 to-tickets 的 expand–contract 拆，不硬塞垂直切片。
- 票面保持意图层干净（**不写文件路径**，to-tickets 原则）——执行层 scope 由 Phase 3 现场补。

**Completion**：票集用户确认 + 落盘 + 每票 Blocked by 引用存在 + frontier（无阻塞票）非空。

## Phase 3 — 转译 票 → .squad.json（本技能核心粘合）

读 `.scratch/<slug>/issues/*.md`，逐票映射到 squad 任务包 schema（`squadVersion: 2`）：

| 票字段 | .squad.json 字段 | 转译规则 |
|---|---|---|
| 文件编号 01..NN | `id` | `T1..TN`（保持依赖序） |
| 标题 | `title` | 原文 |
| — | `kind` | 按交付物判 code/test/docs/review/research |
| Blocked by | `deps` | 号码→T 编号；**顺序依赖不得并行** → 合并同一执行序列，只有契约式依赖（先定接口再各自开发）才允许 deps |
| Acceptance | `acceptance`/`gate.acceptance` | 行为语言改为**可跑命令或明确产物路径**；无法推导 → `gate.kind: unknown` → mergePolicy 强制 human-review |
| — | `gate.verifiers` | derived 默认继承仓库验证链（bun check/test <scope>） |
| — | `scope.files` | **现场查代码补**，squad 硬规则：互不相交；重叠 → 合并票或改契约式依赖 |
| — | `isolation` | 默认 worktree；纯只读 → shared-read |
| — | `modelTier` | code→mid，轻接线/docs/test→cheap，重活显式 high；父模型 ≥ 子模型（bootstrap 兜底） |
| — | `reportProtocol` | `ask-with-to`（squad 既有默认） |

顶层：`squadId: squad-YYYYMMDD-<feature-slug>`、`baseBranch`（当前分支或用户指定）、
`maxConcurrency: 3`。任务包落 `~/.cornfield/squads/<squadId>/bundle.json`（repo 外）。

**校验（硬闸门）**：`bun run .cornfield/skills/squad-programming/scripts/bootstrap.ts --check <bundle>`
必须通过；不过 = 转译失败，重转译，不跳过。

**Completion**：`--check` 绿 + 用户对最终任务包无异议（可选展示：票→T 映射表）。

## Phase 4 — 交接 squad-programming

本技能到此退出。读 `skill://squad-programming` Phase 1 起：集结命令（`bootstrap.ts --bundle
<路径> --parent-target <父> --parent-session-id <id> --parent-model <模型>`）、readiness gate、
GO 发放、盯盘、integrate 合体验证、交接合并——全部按 squad SKILL 本体执行，不在此复制。
父 agent 的盯盘/恢复命令（reconcile/probe）同样指回 squad。

**Completion**：集结启动成功 = 本技能完成；此后一切归 squad 生命周期。

## 反模式

- **为流程而流程** — 小任务也走全链 → 入口判定挡掉。
- **方案未审就拆票** — 大任务跳 grill 直接拆 → 不允许；已有 spec/ADR 才可降级入口。
- **拍脑袋转译** — scope/gate/kind 不查代码硬编 → 现场取证；推导不出 = unknown + human-review。
- **票粒度错位** — 一票超 worktree 范围 → Phase 3 被迫二次拆 = Phase 2 拆解失败，重拆。
- **顺序依赖当 deps 并行** — 合并执行序列，只有契约式依赖可并行（squad 硬规则）。
- **复制子技能内容** — 本文出现 squad 执行细节 = 分叉，改回引用。
- **过程产物进 docs/ 或 git** — 票/任务包按产物地图落位。
