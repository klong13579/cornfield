# OMP Evolution 功能方案设计（V3）

**状态**：当前默认实现（2026-05-19 起）  
**代码包**：`packages/self-evolution/`（内联扩展，随 `omp` 加载）  
**设计决策原文**：[2026-05-19-evolution-v3-radical-redesign.md](./plans/2026-05-19-evolution-v3-radical-redesign.md)  
**背景参考**：[omp-evolution-architecture-v2.1.md](./omp-evolution-architecture-v2.1.md)（Memory × Pipeline 四层模型；V3 在写入路径与注入策略上做了根本调整）

---

## 1. 文档目的与读者

本文档描述 **omp evolution**（自进化子系统）的完整功能方案：顶层设计、记忆分层、各类提取方式、注入管道、数据与存储、运行时流程、模块职责及运维方式。

| 读者 | 建议阅读章节 |
|------|----------------|
| 产品 / 架构 | §2–§5 |
| 实现与调试 | §6–§9、§12 |
| 运维 / 清库迁移 | §11 |
| 使用者（CLI / 命令） | **§10**、`packages/self-evolution/doc/README.md` |

---

## 2. 顶层设计

### 2.1 系统定位

**OMP Evolution** 是 coding-agent 的**项目级学习与上下文增强层**：在会话过程中记录行为轨迹，在会话结束后提炼可复用知识，在下一轮会话开始前把**少量、高信噪比**的内容注入 system prompt，并配合 **Memory** 模块做跨会话的长期整合。

它与 **Memory** 分工明确：

| 子系统 | 时态 | 职责 |
|--------|------|------|
| **Self-Evolution** | 同步、会话级 | 轨迹记录、learnings 写入、episode/skill 检索、实时 nudge、效果反馈 |
| **Memory** | 异步、项目级 | 从 JSONL 会话日志做 Phase1 摘要 → Phase2 合并为 `MEMORY.md` / `memory_summary.md` / skills |

二者共享项目目录 `<repo>/.omp/`，且 Memory 的 SQLite 表与 Evolution 表位于同一文件 `evolution.db`（见 §8）。

### 2.2 V2 的问题与 V3 目标

V2 在真实数据上暴露的典型症状（2026-05-19 审计）：

| 现象 | 根因 |
|------|------|
| 上千条 `conventions`，`active = 0` | 多路规则提取过宽 + admission/regression 过严 |
| 81% 为 `negative_rule` | 工具失败模板被写入长期规则库 |
| `memory_summary.md` 几乎为空 | Phase2 摘要过短且无 `MEMORY.md` 回退 |
| effectiveness 表无数据 | 注入反馈未稳定落库 |

**V3 目标态（一句话）**：

> 会话结束：一次 LLM 决定记什么（≤3 条 learning）。空闲：Memory 合并长期叙事。回合开始：只注入 summary + active/pinned learnings + 少量 skills/episodes。工具失败：仅 nudge/escalation，不写长期规则表。

### 2.3 核心设计原则

1. **Hermes 式写过滤**：每会话至多一次 LLM 提取（`SessionLearner`），输出 ≤3 条；`confidence < 4` 丢弃；LLM 失败则 **0 条**（不靠规则灌库）。
2. **OpenClaw 式长期合并**：Memory Phase1/2 异步处理会话 JSONL，产出 `MEMORY.md` 与可注入的 `memory_summary.md`。
3. **失败不进长期库**：错误模式 → `evolution_escalations` / 当轮 nudge；**不再**从 diagnosis / error pattern 写 convention。
4. **注入预算小**：默认整段注入约 **2000 字符** 上限，优先 memory summary 与 learnings。
5. **晋升简化（2-A）**：learnings **无** fixture replay；`manual_pin` 直通 active；统计达标后自动 active。
6. **项目隔离**：默认数据在 `<repo>/.omp/`，不与其他仓库混用。

### 2.4 对标参考

| 能力 | Hermes | OpenClaw | OMP V3 |
|------|--------|----------|--------|
| 写入过滤 | Turn / memory tool 审查 | — | `SessionLearner` + `user_explicit` |
| 长期合并 | Curator | Dreaming consolidate | Memory Phase2 |
| 短期注入 | 冻结 MEMORY + USER | Bootstrap md | `memory_summary.md` + learnings |
| 失败处理 | 当轮改 memory | 少量全局规则 | Nudge + escalation only |

### 2.5 架构总览图

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Session (omp TUI/CLI)                  │
│   User ↔ Agent Core ↔ Tools  →  Session JSONL (~/.omp/agent/)   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ TraceRecorder │     │ NudgeDetector   │     │ Memory Startup   │
│ (in-memory)   │     │ (tool_execution)│     │ Phase1 → Phase2  │
└───────┬───────┘     └─────────────────┘     └────────┬─────────┘
        │ agent_end                                      │ async
        ▼                                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                     evolution.db + .omp 投影文件                    │
│  learnings · episodes · skills · traces · escalations · memory jobs │
└───────────────────────────────┬───────────────────────────────────┘
                                │ before_agent_start
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│              InjectionFormatter → system prompt 追加块               │
│  Memory Summary → Project Learnings → Profile → Episodes → Skills   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 3. 记忆分层（短 / 中 / 长）

Evolution 与 Memory 共同实现「情景 → 语义 → 组织」的知识生命周期；V3 用 **learnings** 替代 conventions 作为**用户/项目偏好**的主载体。

### 3.1 三层对照

| 层级 | 时间尺度 | 触发机制 | 主要产物 | 注入时机 |
|------|----------|----------|----------|----------|
| **短期** | 当前回合 | `before_agent_start` | `memory_summary.md`、active/pinned `learnings`、检索到的 skills/episodes、跨会话 nudge | 每轮 agent 启动 |
| **中期** | 单次会话 ~ 数天 | `agent_end`、Memory Phase1 | `learnings`(candidate)、`episodes`、`session_traces`、`raw_memories.md`、`rollout_summaries/` | 候选 learning 待晋升；episode 供检索 |
| **长期** | 周 ~ 永久 | Memory Phase2、pin、统计晋升、skill 毕业 | `MEMORY.md`、`.omp/skills/*.md`、active `learnings` | 短期层读取；人工可读文件 |

### 3.2 短期记忆（注入上下文）

**来源**（按 `InjectionFormatter` 默认 legacy 顺序）：

1. **User Profile** — 工具频率、意图分布等（`user_profiles` 表 → `user_profile.md`）
2. **Memory Summary** — `/.omp/memory/memory_summary.md`（Phase2 产出；不足 200 字时由 `ensureMemorySummaryFromMemory` 从 `MEMORY.md` 回退截取）
3. **Project Learnings** — `learnings` 表中 `manual_pin` 或 `lifecycle=active` 且 `confidence≥4`（最多约 8 条参与注入）
4. **Relevant Past Experiences** — FTS + 多因子评分的 episodes
5. **Relevant Skills** — 质量筛选后的 skill 片段

**预算**：默认 `maxTokens ≈ 2000`（按字符截断 guard）；`index.ts` 对 formatter 输出另有硬截断保护。

**反馈闭环**：注入时记录 `injectedLearningIds` / `injectedEpisodeIds` / `injectedSkillNames`；本轮 `agent_end` 用会话成败与 `EffectivenessAnalyzer` 更新 `times_helped` 等，并 `refreshLifecycles()`。

### 3.3 中期记忆（会话归档）

**agent_end 写入**：

- **Episode**：工具数、错误数、摘要、修改文件列表
- **Session trace**：完整工具链 JSON（供诊断、回归 fixture、backfill）
- **Learnings (candidate)**：`session_llm` / `user_explicit` 新条
- **Intent / workflow / profile**：意图分类、工作流模式、用户画像增量
- **Diagnosis 行**：`episode_diagnoses`（仅运维/审计，**不**生成 learning）
- **Regression fixture**：可选，供 skill admission replay

**Memory Phase1**（会话启动后后台，`startMemoryStartupTask`）：

- 扫描 `~/.omp/agent/sessions/*.jsonl` 中空闲 thread
- LLM 提取 `raw_memory` + `rollout_summary` → 写入 DB 与 `/.omp/memory/raw_memories.md`、`rollout_summaries/`

### 3.4 长期记忆（项目知识）

**Memory Phase2**（同一 startup 管道或 `/evolution memory enqueue`）：

- 读取累积的 raw + rollout 摘要
- LLM 合并 → `MEMORY.md`、`memory_summary.md`、可选 skills 文件
- `ensureMemorySummaryFromMemory` 保证短摘要可用

**Learnings 晋升 active**：

- `manual_pin` / `seed` → 立即 active
- 或 `times_injected ≥ 3` 且 `times_helped / times_injected ≥ 0.5`

**Skills**：

- 会话结束规则/LLM 提取 → SQLite `skills` + 可选同步 `.omp/skills/*.md`
- `benefit-admission` + 可选 regression replay 管理 skill 种群（**不**作用于 learnings）

---

## 4. 提取方式

V3 **仅保留**下表路径作为「写入长期可注入知识」的手段；V2 的 Convention L1/L2/L3、diagnosis→convention、error→convention **已移除**。

### 4.1 Learnings（主路径）

#### 4.1.1 SessionLearner（`session_llm`）

| 项 | 说明 |
|----|------|
| 触发 | 每会话 `agent_end`，有 background LLM 模型与 API key |
| 实现 | `packages/self-evolution/src/session-learner.ts` |
| Prompt | `prompts/extract-session-learnings.md` + `extract-session-learnings-input.md` |
| 输入 | 用户消息集合 + 助手消息摘要（截断） |
| 输出 | JSON 数组，最多 **3** 条 |
| 字段 | `kind`: `preference` \| `fact` \| `procedure` \| `skill_hint`；`content` ≥20 字；`confidence` 1–5 |
| 过滤 | `confidence < 4` 丢弃；`validateLearningContent` 拒绝模板句/代码片段等 |
| 失败 | 返回 `[]`，**无** L3 规则回退 |

#### 4.1.2 User explicit（`user_explicit`）

| 项 | 说明 |
|----|------|
| 触发 | 同 `agent_end`，与 SessionLearner 并行 |
| 实现 | `user-explicit-learnings.ts` |
| 方式 | 窄 regex（如「请记住：…」「必须…」），**非**全量 convention miner |
| 上限 | 与会话 LLM 合计仍受 `LEARNING_MAX_PER_SESSION = 3` 约束 |
| 初始状态 | `candidate`（与 `session_llm` 相同），靠 pin 或注入统计晋升 |

#### 4.1.3 Manual pin / seed（`manual_pin`）

| 项 | 说明 |
|----|------|
| 命令 | `/evolution learnings pin <text>`、`/evolution learnings seed [file]` |
| 文件 | 默认 `<repo>/.omp/evolution/learnings-seed.json` |
| 生命周期 | 写入即 **`active`**，跳过后台统计门禁 |

### 4.2 Skills（辅助长期能力）

| 项 | 说明 |
|----|------|
| 触发 | `agent_end`，`toolCallCount ≥ skillThreshold` 或 hadRecovery 或 errorCount>0 |
| 实现 | `extractor.ts`（规则 + 可选 `extract-skill.md` LLM） |
| 管理 | `manager.ts`：合并、版本、归档、rollback |
| 优化 | `optimize_skill_prompt` 工具、GEPA 风格 `optimizer.ts` |
| 门控 | `benefit-admission.ts` + 可选 regression replay（**仅 skill**） |

### 4.3 Memory 提取（异步，非 agent_end 同步）

| 阶段 | 输入 | 输出 | 说明 |
|------|------|------|------|
| **Phase1** | 会话 JSONL thread | `raw_memory`、`rollout_summary` | 并发 job 队列，`threads` / `stage1_outputs` |
| **Phase2** | 聚合 raw + summaries | `MEMORY.md`、`memory_summary.md`、skills | `prompts/consolidation.md`；完成后 refresh summary |

手动触发：`/evolution memory enqueue`（或 `rebuild`）→ `enqueueMemoryConsolidation`。

### 4.4 明确不再作为「长期规则」的提取

| 原 V2 路径 | V3 行为 |
|------------|---------|
| ConventionExtractor L1/L2/L3 | 已删除 |
| `extractFromDiagnosis` → convention | 仅 `episode_diagnoses` 行 |
| ErrorPatternExtractor → convention | 仅 `evolution_escalations` |
| `negative_rule` 类型 | 不再创建 |
| Convention regression replay | 已取消 |

---

## 5. 认知管道与注入

### 5.1 钩子时序

```
session 启动
  → startMemoryStartupTask()     # Memory Phase1 + Phase2（后台）
  → before_agent_start           # 注入 + 跨会话 escalation 通知 + cross-session nudge

会话进行中
  → tool_execution_end           # NudgeDetector → NudgeDeliverer（TUI，冷却）

session 结束
  → agent_end                    # 归档 + 提取 + 反馈 + 投影 MD
```

### 5.2 `before_agent_start` 逻辑摘要

1. 若有 open escalation 且 TUI 可用 → 最多 2 条 `ui.notify`
2. `recorder.seedPrompt` / `beginTurn`
3. 可选 **CrossSessionNudgeEngine** → 写入 pending agent nudge
4. 若 `enablePromptInjection`：
   - 意图规则分类 → `ContextAwareRetriever.retrieve`
   - `learningStore.listForInjection(cwd, 8)`
   - 读 `memory_summary.md`
   - `InjectionFormatter.formatInjection` → 追加到 `systemPrompt`
   - 记录 injected ids 供 `agent_end` 反馈

**注意**：`conventions` 注入数组在 V3 中恒为空；规范语义由 **learnings** 承担。

### 5.3 `agent_end` 逻辑摘要

按执行顺序：

1. 结束 trace，hydrate JSONL（若更丰富）
2. Nudge 会话级 effectiveness 结算
3. 写入 **episode** + **session_trace**
4. 异步投影：`learnings.md`、`evolution_log.md`、`user_profile.md`、`system-diagnosis.md`
5. **TraceAnalyzer** → diagnosis 入库（不写 learning）
6. **Regression fixture**（可选）
7. **IntentClassifier** + **WorkflowMiner** + **UserProfiler**
8. **extractUserExplicitLearnings** + **extractSessionLearnings** → `learnings`
9. **ErrorPatternExtractor** → 仅 escalation 检测日志
10. 对上轮 injected learnings → `recordOutcome` + `refreshLifecycles`
11. **EffectivenessAnalyzer** + **FeedbackTracker**（episodes/skills）
12. **SkillExtractor** + **SkillManager.integrate**
13. **refreshAdmissionAfterSessionEnd**（skills）
14. **syncEvolutionEscalations**
15. episode 数量裁剪（`maxEpisodes`）

### 5.4 episode 检索评分（中期 → 短期）

`ContextAwareRetriever` 多因子加权（示意）：

| 因子 | 权重思路 |
|------|----------|
| 意图匹配 | 0–40 |
| 关键词 | 0–30 |
| 会话成功 | 0–15 |
| 恢复/新近/画像亲和 | 各 0–10~15 |
| 历史注入效果 | 0–20 |
| 可选 LLM rerank | `rerank-episodes.md` |

---

## 6. 实时干预（Nudge 与 Escalation）

工具失败**默认不写入 learnings**；改为即时与跨会话提示。

### 6.1 会话内 Nudge

| 组件 | 职责 |
|------|------|
| `NudgeDetector` | 监听 trace：编辑后验证失败、级联读失败、搜索空转、错误级联等 |
| `NudgeDeliverer` | TUI 提示，按类型冷却（warn 15s / info 30s） |
| `nudge_history` | 持久化记录，供效果分析 |

### 6.2 跨会话

| 组件 | 职责 |
|------|------|
| `CrossSessionNudgeEngine` | 基于历史模式在 `before_agent_start` 排队 nudge |
| `evolution_escalations` | 重复错误模式升级；`/evolution stuck` 查看 ack/resolve |

---

## 7. 数据模型

### 7.1 `learnings`（V3 主表）

```sql
-- packages/self-evolution/src/storage/db.ts
id, cwd, kind, content, source, confidence, lifecycle, session_id,
created_at, updated_at, times_injected, times_helped, times_ignored

kind:     preference | fact | procedure | skill_hint
source:   user_explicit | session_llm | manual_pin
lifecycle: candidate | active | archived
```

人类可读投影：`<repo>/.omp/evolution/learnings.md`（`projection/learnings.ts`）。

### 7.2 核心 Evolution 表

| 表 / 对象 | 用途 |
|-----------|------|
| `episodes` + `episodes_fts` | 会话摘要与全文检索 |
| `skills` + `skill_versions` | 技能库与版本史 |
| `session_traces` | 完整轨迹 JSON |
| `episode_intents` | 意图分类 |
| `workflow_patterns` | 工具序列模式 |
| `user_profiles` | 行为画像 |
| `episode_effectiveness` / `skill_effectiveness` | 注入效果 |
| `episode_diagnoses` | 因果诊断（运维） |
| `regression_fixtures` / `regression_trials` | Skill replay |
| `evolution_escalations` | 卡住模式升级 |
| `nudge_history` | Nudge 记录 |
| `fit_scores` | `/evolution fit` 评分历史 |

### 7.3 Memory 表（同库 `evolution.db`）

| 表 | 用途 |
|----|------|
| `threads` | 会话 thread 元数据 |
| `stage1_outputs` | Phase1 产物指针 |
| `jobs` | Phase2 水位与租约 |
| `vector_embeddings` | 语义检索（`/evolution memory search`） |

### 7.4 文件布局（项目本地默认）

```
<repo>/.omp/
├── memory/
│   ├── MEMORY.md              # 长期叙事（Phase2）
│   ├── memory_summary.md      # 短期注入摘要
│   ├── raw_memories.md        # Phase1 聚合视图
│   └── rollout_summaries/
├── evolution/
│   ├── evolution.db           # SQLite WAL + FTS5（Evolution + Memory）
│   ├── learnings.md           # learnings 投影
│   ├── user_profile.md
│   ├── system-diagnosis.md
│   ├── activity.log           # JSONL 运维事件
│   └── evolution_log.md
└── skills/*.md                # 技能导出（与 DB 同步）
```

会话 transcript：`~/.omp/agent/sessions/*.jsonl`（不进项目 `.omp`，但 Memory Phase1 会读）。

**Legacy**：`--self-evolution-global-store` → `~/.omp/self-evolution/`；首次可迁移到项目 `.omp/`。

---

## 8. 功能模块说明

### 8.1 按生命周期分组

| 阶段 | 模块 | 文件（主要） |
|------|------|----------------|
| 记录 | `TraceRecorder` | `trace.ts` |
| 会话结束提取 | `SessionLearner` | `session-learner.ts` |
| | `extractUserExplicitLearnings` | `user-explicit-learnings.ts` |
| | `SkillExtractor` / `SkillManager` | `extractor.ts`, `manager.ts` |
| 准入 | `learning-admission` | `learning-admission.ts` |
| | `benefit-admission` | `benefit-admission.ts` |
| 存储 | `SqliteLearningStore` 等 | `storage/*.ts` |
| 注入 | `InjectionFormatter` | `injection-formatter.ts` |
| | `ContextAwareRetriever` | `context-aware-retriever.ts` |
| 反馈 | `EffectivenessAnalyzer` | `effectiveness-analyzer.ts` |
| | `FeedbackTracker` | `feedback-tracker.ts` |
| 实时 | `NudgeDetector` / `NudgeDeliverer` | `nudge-*.ts` |
| | `CrossSessionNudgeEngine` | `cross-session-nudge.ts` |
| 诊断 | `TraceAnalyzer` | `trace-analyzer.ts` |
| | `ErrorPatternExtractor` | `error-pattern-extractor.ts`（仅 escalation） |
| Memory | Phase1/2 管道 | `memory/index.ts` |
| | Summary 回退 | `memory/summary.ts` |
| 投影 | learnings / diagnosis / profile | `projection/*.ts` |
| 命令 | `/evolution` 子命令 | `commands.ts`, `evolution-memory.ts` |
| 扩展入口 | 注册钩子与工具 | `index.ts`, `tools.ts` |

### 8.2 Agent 可调用工具

| 工具 | 作用 |
|------|------|
| `query_episodic_memory` | FTS + 评分检索历史 episode |
| `list_evolved_skills` | 浏览技能库 |
| `optimize_skill_prompt` | GEPA 风格优化 skill 文本 |

### 8.3 观测与报告（实现模块）

| 模块 | 作用 |
|------|------|
| `audit-report.ts` + `projection/system-diagnosis.ts` | 健康审计 → `system-diagnosis.md` |
| `daily-report.ts` | 会话日报 |
| `eval/fit-evaluator.ts` | 「懂我程度」五维评分 |

用户入口见 **§10 Slash Commands**。

### 8.4 与 coding-agent 的集成

- 以 **inline extension** 注册于 `packages/self-evolution/src/index.ts`
- 监听 `agent_end`、`before_agent_start`、`tool_execution_end` 等扩展事件
- **禁止**在包内使用 `console.log`（见 AGENTS.md）；日志走 `@oh-my-pi/pi-utils` logger

---

## 9. 配置与 CLI 标志

| 标志 | 默认 | 说明 |
|------|------|------|
| `--self-evolution` | on | 总开关 |
| `--no-self-evolution-enable-prompt-injection` | — | 关闭注入 |
| `--self-evolution-skill-threshold` | 5 | 技能提取最少工具调用 |
| `--self-evolution-max-episodes` | 100 | episode 保留上限 |
| `--no-self-evolution-llm-refinement` | — | 技能仅规则提取 |
| `--no-self-evolution-llm-rerank` | — | episode 仅关键词检索 |
| `--self-evolution-global-store` | off | 使用 `~/.omp/self-evolution` |

实现与自动补全定义：`packages/self-evolution/src/commands.ts`、`evolution-memory.ts`、`memory-commands.ts`。

---

## 10. Slash Commands 功能说明

### 10.1 入口与约定

| 项 | 说明 |
|----|------|
| **主入口** | `/evolution <subcommand> [args]` |
| **帮助** | 无子命令或未知子命令 → 输出内置 help（同 `handleHelp`） |
| **别名** | `/memory …` ≡ `/evolution memory …`（`memory-commands.ts`） |
| **旧命令** | `/evolution-status` 等扁平命令已废弃，会提示重定向到 `/evolution` |
| **作用域** | 默认操作当前项目 `ctx.cwd` 下 `.omp/`；`--self-evolution-global-store` 时用 legacy 全局路径 |
| **前置条件** | 多数子命令需已启动过至少一次会话（`ensureInit` 打开 `evolution.db`） |

**已移除（V3）**：`/evolution conventions`、`--no-self-evolution-v2-writer`。

### 10.2 `/evolution` 子命令总览

| 子命令 | 用法摘要 | 功能 |
|--------|----------|------|
| `status` | `/evolution status` | episodes / skills / versions / 已归档会话数；回归 fixture 与 replay 配置摘要 |
| `skills` | `/evolution skills [--detail]` | 列出技能：质量分、成功率、使用次数、用户星级；`--detail` 显示启发式评分维度 |
| `rate` | `/evolution rate <name> <1-5>` | 为技能打 1–5 星，重算 `qualityScore` 并写入 activity log |
| `clear` | `/evolution clear` | **全量重置**：确认后删除 `.omp/memory` + `evolution` + `skills`（1-B 清库） |
| `memory` | 见 §10.3 | Memory 子命令枢纽 |
| `learnings` | 见 §10.4 | V3 项目 learnings 管理 |
| `archive` | `/evolution archive` | 归档低质量技能（质量 < 30 且长期未用） |
| `history` | `/evolution history <skill-name>` | 查看技能版本历史（changeType、时间、原因） |
| `rollback` | `/evolution rollback <name> <version>` | 回滚技能到指定版本号（生成新版本快照） |
| `profile` | `/evolution profile` | 用户行为画像：会话数、工具/文件均值、错误率、恢复率、Top 工具与意图 |
| `workflows` | `/evolution workflows [intent]` | 列出挖掘的工具序列模式；可选按意图过滤 |
| `audit` | `/evolution audit` | 生成系统健康报告（V3 含 learnings / memory 指标），写入 `system-diagnosis.md` 并在 TUI 展示摘要 |
| `report` | `/evolution report` | 当日会话日报：成功/失败/空会话、错误模式、新 learnings 等 |
| `fit` | `/evolution fit` | 「懂我程度」五维评估（记忆/思维/风格/预判/历史），写入 `fit_scores` |
| `population` | `/evolution population` | 技能种群状态：candidate / experimental / graduated / deprecated / archived 计数与本轮迁移 |
| `log` | `/evolution log` | 最近 50 条 `activity.log` JSONL 事件 |
| `nudges` | 见 §10.5 | 会话内/跨会话 nudge 历史 |
| `stuck` | 见 §10.6 | 重复错误模式 escalation（需人工介入） |
| `sync-skills` | `/evolution sync-skills` | 将 DB 中技能导出为 `<cwd>/.omp/skills/*.md`（含质量过滤与修复统计） |
| `backfill-traces` | `/evolution backfill-traces [limit]` | 从 `~/.omp/agent/sessions/*.jsonl` 回填 `session_traces`、fixtures；修复标签；刷新 admission / escalation（默认 limit=200） |
| `refresh-admission` | `/evolution refresh-admission` | 手动重跑 **skill** benefit admission（**不含** learnings regression） |
| `regression` | `/evolution regression [limit]` | 列出近期 regression trial（keep/discard、replay 后端、原因摘要；默认 15 条） |

### 10.3 `/evolution memory`（及 `/memory` 别名）

默认子命令：`stats`（无参数时）。

| 子命令 | 用法 | 功能 |
|--------|------|------|
| `stats` | `/evolution memory` 或 `memory stats` | 向量嵌入总数、各 namespace 计数、`memory_summary.md` 字符数、`MEMORY.md` 路径 |
| `search` | `/evolution memory search <query>` | 语义检索（有 embedding 时）或 `vec_embeddings` 关键词 LIKE 回退 |
| `report` | `/evolution memory report` | 从 DB sections 生成 MEMORY 风格报告（TUI 截断约 2000 字） |
| `view` | `/evolution memory view` | 预览将注入的 `memory_summary.md` 全文（约 2500 字截断） |
| `skills` | `/evolution memory skills` | 列出 memory 索引中已毕业技能条目（按 importance） |
| `enqueue` | `/evolution memory enqueue` | 将 Phase2 全局合并任务入队（空闲时跑 consolidation） |
| `rebuild` | 同 `enqueue` | 别名 |
| `refresh-summary` | `/evolution memory refresh-summary` | 从 `MEMORY.md` 回写 `memory_summary.md`（LLM 摘要 <200 字时回退截取） |
| `clear` | `/evolution memory clear` | **仅清 Memory**：DB memory 行 + `.omp/memory/` 文件；**保留** evolution.db 与 skills |
| `reset` | 同 `clear` | 别名 |

与 `/evolution clear` 区别：`memory clear` 不动 evolution 表与 `.omp/skills/`；全项目重置用 `/evolution clear`。

### 10.4 `/evolution learnings`（V3 核心）

默认子命令：`list`（无 action 时）。

| 子命令 | 用法 | 功能 |
|--------|------|------|
| `list` | `/evolution learnings` | 列出当前项目最多 30 条：lifecycle、kind、内容摘要、confidence、source、id |
| `search` | `/evolution learnings search <keyword>` | 按内容子串过滤 |
| `pin` | `/evolution learnings pin <id>` | 将 learning 设为 `manual_pin` + **active**，下轮注入；刷新 `learnings.md` |
| `archive` | `/evolution learnings archive <id>` | 设为 `archived`，不再注入 |
| `delete` | `/evolution learnings delete <id>` | 从 DB 删除 |
| `seed` | `/evolution learnings seed [file]` | 从 JSON 导入 pinned learnings；默认 `<repo>/.omp/evolution/learnings-seed.json`；成功后投影 `learnings.md` 并尝试 refresh `memory_summary.md` |

**pin / seed 场景**：清库后 Day 0、或把团队共识写成种子文件，无需等待 SessionLearner。

### 10.5 `/evolution nudges`

| 用法 | 功能 |
|------|------|
| `/evolution nudges` | 最近 20 条 nudge：类型、严重级别、是否已注入上下文、ack/dismiss、outcome 分数 |
| `/evolution nudges ack <id>` | 确认已读 |
| `/evolution nudges dismiss <id>` | 忽略并在约 7 天内抑制同类型 |

Nudge 由 `tool_execution_end` 实时检测产生，**不**写入 learnings 表。

### 10.6 `/evolution stuck`

| 用法 | 功能 |
|------|------|
| `/evolution stuck` | 列出 `status=open` 的 escalation：重复次数、自动修复失败次数、模式标签、建议 |
| `/evolution stuck ack <id>` | 确认已知悉（仍可能再次提醒，取决于实现） |
| `/evolution stuck resolve <id>` | 标记已解决，恢复该 pattern 的自动处理 |
| `/evolution stuck sync` | 手动触发 escalation 与 fixture / trial 同步扫描 |

TUI 在 `before_agent_start` 也会对 open escalation 最多弹 2 条 warning notify。

### 10.7 关联独立命令（非 `/evolution` 前缀）

与 Evolution 数据同源，便于 TUI 快捷输入：

| 命令 | 用法 | 功能 |
|------|------|------|
| `/episodic` | `sessions` \| `show <session-id>` \| `clear` | **情景缓存**：最近 session 列表、单 session 事件流、清空 `episodic_records` |
| `/profile` | `show`（默认）\| `stats` | 与 `/evolution profile` 类似；`stats` 输出更偏统计字段 |
| `/model` | `scores`（默认） | 会话级模型用量聚合（token、耗时、成功率）；用于 evolution 模型路由实验 |

### 10.8 Agent 工具（对话内调用，非 slash）

LLM 在会话中可调用的注册工具（`tools.ts`）：

| 工具名 | 功能 |
|--------|------|
| `query_episodic_memory` | 关键词 + 评分检索历史 episode，补充上下文 |
| `list_evolved_skills` | 浏览技能库（质量、是否 deprecated） |
| `optimize_skill_prompt` | 对指定技能做 GEPA 风格 prompt 优化 |

### 10.9 常用运维组合

```text
# 清库后 Day 0
/evolution clear          # 确认后备份已恢复 MEMORY.md
/evolution learnings seed
/evolution memory refresh-summary
/evolution memory enqueue

# 诊断注入是否生效
/evolution memory view
/evolution learnings
/evolution status

# 回归 / 轨迹修复
/evolution backfill-traces 50
/evolution regression 20
/evolution refresh-admission
```

---

## 11. 迁移与运维（策略 1-B）

### 11.1 清库重来

`/evolution clear` 删除项目下 memory / evolution / skills 目录。

**清库前建议备份**：

- `MEMORY.md`、`.omp/skills/*.md`
- 可选：整个 `.omp/`

**清库后种子（Day 0）**：

1. 恢复 `MEMORY.md`
2. `/evolution memory refresh-summary` 或 `enqueue` 生成 `memory_summary.md`
3. `/evolution learnings seed` 或手工 **pin** 3–5 条核心偏好
4. 新开会话确认 prompt 中出现 Project Learnings

**不要**：从旧 `conventions` 表批量导入。

### 11.2 数据迁移脚本

```bash
bash packages/self-evolution/scripts/migrate-evolution-data.sh /path/to/repo
bun packages/self-evolution/scripts/backfill-episodes-from-sessions.ts --cwd /path/to/repo --per-project
```

### 11.3 回滚

- 恢复备份的 `evolution.db` 与 `.omp/memory`
- 若需 V2 行为：当前主干已移除 convention 管道，仅能通过旧分支/备份恢复

---

## 12. 验收标准

清库 + seed 后，建议验证：

| # | 检查项 |
|---|--------|
| 1 | `learnings` 中 active/pinned 约 5–15 条；下轮 prompt 含 `## Project Learnings` |
| 2 | `memory_summary.md` ≥ 500 字符（或 MEMORY 回退有效） |
| 3 | 连续 10 会话新增 learnings ≤ 30（场均 ≤3） |
| 4 | 无新增 `negative_rule` / conventions 写入 |
| 5 | 有 learning 注入时 `times_injected` 递增；会话成功后 `times_helped` 可增长 |
| 6 | `episode_effectiveness` 在注入 episode 后有记录 |

---

## 13. 源码与文档索引

| 类型 | 路径 |
|------|------|
| 扩展入口 | `packages/self-evolution/src/index.ts` |
| V3 设计决策 | `docs/plans/2026-05-19-evolution-v3-radical-redesign.md` |
| V2.1 背景 | `docs/omp-evolution-architecture-v2.1.md` |
| 包 README | `packages/self-evolution/doc/README.md` |
| 测试方案 | `docs/omp-evolution-test-plan.md` |
| L4 规划（未默认实现） | `l4-evolution-architecture.md` |
| 功能看板 | `docs/evolution-board.yaml` |

---

## 14. 版本沿革（简表）

| 版本 | 写入主路径 | 注入主路径 | 备注 |
|------|------------|------------|------|
| V2.x | Convention L1/L2/L3 + error/diagnosis | conventions + episodes + skills | 噪音与 admission 问题 |
| **V3** | SessionLearner + user_explicit + Memory | memory_summary + learnings + episodes + skills | 当前默认 |

---

*本文档随 `packages/self-evolution` 实现演进；若与代码冲突，以代码与 CHANGELOG 为准。*
