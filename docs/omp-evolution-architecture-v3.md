# OMP Evolution 功能方案设计（V4）

**状态**：当前默认实现（2026-05-22 起）  
**代码包**：`packages/self-evolution/`（内联扩展，随 `omp` 加载）  
**设计决策原文**：[2026-05-19-evolution-v3-radical-redesign.md](./plans/2026-05-19-evolution-v3-radical-redesign.md)  
**背景参考**：[omp-evolution-architecture-v2.1.md](./omp-evolution-architecture-v2.1.md)（Memory × Pipeline 四层模型）  

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

**OMP Evolution** 是 coding-agent 的**项目级学习与上下文增强层**。V4 相比 V3 的核心简化：

1. 唯一的写入口：`write_memory` tool（agent 在对话中主动写） + `user_explicit` regex（兜底）+ `SessionLearner`（降频回退）
2. learnings 表是记忆的唯一 truth
3. 删除 Memory Phase1（不再读 JSONL + LLM），删除 `persona.json`
4. 合并注入为单一区块，不争预算

### 2.2 核心设计原则

1. **Agent 主动写**：agent 在对话中通过 `write_memory` tool 写入 learnings 表，tool 返回值本轮可见
2. **降低 LLM 开销**：短轮跳过 LLM 密集型步骤；Phase1 删除；后台 0 次 LLM
3. **失败不进长期库**：错误模式 → `evolution_escalations` / 当轮 nudge
4. **注入预算小**：默认整段注入约 **2000 字符** 上限，单一区块不重复
5. **晋升简化（2-A）**：`manual_pin` / `agent_written` 直通 active；统计达标后自动 active
6. **用户级存储（默认）**：默认数据在 `~/.omp/self-evolution/`，跨项目共享；可选项目级存储

### 2.3 对标参考

| 能力 | Hermes | OMP V4 |
|------|--------|--------|
| 写入过滤 | Turn / memory tool 审查 | `write_memory` tool + `user_explicit` |
| 长期合并 | Curator | 后台仅拼接 learnings + episodes，0 LLM |
| 短期注入 | 冻结 MEMORY + USER | learnings 表分组注入 |
| 失败处理 | 当轮改 memory | Nudge + escalation only |

### 2.4 架构总览图

```
┌──────────────────────────────────────────────────────────────┐
│                      写入口（唯一）                              │
│                                                                 │
│  用户说"请记住 X" → write_memory(target, content)               │
│     └─ learnings 表（truth）                                    │
│          source=agent_written, lifecycle=active                 │
│          tool 返回值当前轮可见                                    │
│                                                                 │
│  agent 没调 tool → agent_end:                                   │
│     user_explicit regex                                        │
│     SessionLearner (LLM, 仅长轮)                                 │
└──────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                      注入（before_agent_start）                  │
│                                                                 │
│  learnings 表查询:                                              │
│    active + source=agent_written | manual_pin                   │
│    → 按 kind 分组                                               │
│    → 注入单一区块「Project Context」                               │
│    → 不含重复（learnings 表是唯一 truth，无 file 投影）             │
│                                                                 │
│  Skills:                                                        │
│    → skill_store 查询 top N                                     │
│    → 不自动提取，来源改为 write_memory + Skills Hub               │
└──────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                      反馈 + 后台                                 │
│                                                                 │
│  agent_end:                                                     │
│    user_explicit regex（0 LLM）                                 │
│    SessionLearner（仅长轮降频）                                    │
│    lifecycle refresh                                             │
│    recordOutcome                                                 │
│    debounce 投影（仅 learnings.md，变更时写）                       │
│    跳过：traceAnalyzer, SkillExtractor, intentClassifier          │
│                                                                 │
│  后台:                                                           │
│    从 learnings + episodes 拼接 session_summary.md               │
│    0 次 LLM                                                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 记忆分层（短 / 中 / 长）

### 3.1 三层对照

| 层级 | 时间尺度 | 触发机制 | 主要产物 | 注入时机 |
|------|----------|----------|----------|----------|
| **短期** | 当前回合 | `before_agent_start` | active/pinned `learnings`、检索到的 skills/episodes、跨会话 nudge | 每轮 agent 启动 |
| **中期** | 单次会话 ~ 数天 | `agent_end` | `learnings`(candidate)、`episodes`、`session_traces` | 候选 learning 待晋升；episode 供检索 |
| **长期** | 周 ~ 永久 | pin、统计晋升 | `learnings`(active)、`.omp/skills/*.md` | 短期层读取 |

### 3.2 短期记忆（注入上下文）

**来源**（单一块 `InjectionFormatter`）：

1. **Project Context** — `learnings` 表中 `active` 且 `source=agent_written|manual_pin|高 confidence`，按 kind 分组
2. **Relevant Past Experiences** — FTS + 多因子评分的 episodes
3. **Relevant Skills** — 质量筛选后的 skill 片段

**预算**：默认 `maxTokens ≈ 2000`（按字符截断 guard）。

**反馈闭环**：注入时记录 `injectedLearningIds`；本轮 `agent_end` 更新 `times_helped` 等，并 `refreshLifecycles()`。

### 3.3 中期记忆（会话归档）

**agent_end 写入**：

- **Episode**：工具数、错误数、摘要、修改文件列表
- **Session trace**：完整工具链 JSON
- **Learnings (candidate)**：`session_llm` / `user_explicit` 新条
- **Intent / workflow / profile**：意图分类、工作流模式、用户画像增量

**不再有 Memory Phase1**：不读 JSONL，不调 LLM。

### 3.4 长期记忆（项目知识）

**不再有 Memory Phase2 LLM 调用**：改为从 learnings + episodes 拼接成 session_summary.md，0 次 LLM。

**Learnings 晋升 active**：

- `manual_pin` / `agent_written` → 立即 active
- 或 `times_injected ≥ 3` 且 `times_helped / times_injected ≥ 0.5`

---

## 4. 提取方式

### 4.1 `write_memory` tool（主路径）

| 项 | 说明 |
|----|------|
| 触发 | 对话中 agent 主动调用，或用户明确说"记住" |
| 实现 | 注册为 agent tool（类似 `identity`） |
| 参数 | `action`: add/replace/remove；`target`: user/memory；`content`；`kind`(可选) |
| 写入 | learnings 表，source=agent_written，lifecycle=active |
| 可见性 | tool 返回值当前轮可见 |
| 护栏 | content ≥20 字符；注入/泄露扫描 |

写入同时将同一内容同步至 `user_explicit` 路径（正则也走同一条 learnings 插入路径）。

### 4.2 User explicit（user_explicit）

| 项 | 说明 |
|----|------|
| 触发 | `agent_end`，与 SessionLearner 并行 |
| 实现 | `user-explicit-learnings.ts` |
| 方式 | 窄 regex（「请记住：…」「必须…」），**非**全量 convention miner |
| 上限 | 与会话 LLM 合计仍受 `LEARNING_MAX_PER_SESSION = 3` 约束 |
| 初始状态 | `candidate`（与 `session_llm` 相同），靠 pin 或注入统计晋升 |

### 4.3 SessionLearner（session_llm，降频回退）

| 项 | 说明 |
|----|------|
| 触发 | 仅长轮（toolCallCount > 3 且无主动写入） |
| 实现 | `packages/self-evolution/src/session-learner.ts` |
| Prompt | `prompts/extract-session-learnings.md` + `extract-session-learnings-input.md` |
| 输出 | JSON 数组，最多 **3** 条 |
| 跳过条件 | user_explicit 已命中 ≥1 条；trace.entries < 5 |

### 4.4 Manual pin / seed（manual_pin）

| 项 | 说明 |
|----|------|
| 命令 | `/evolution learnings pin <text>`、`/evolution learnings seed [file]` |
| 生命周期 | 写入即 **`active`** |

### 4.5 Skills（改为手动安装）

| 项 | 说明 |
|----|------|
| 来源 | `write_memory(target="memory")` + Skills Hub 安装 |
| 自动提取 | 已删除（不再有 SkillExtractor） |
| 管理 | `manager.ts`：合并、版本、归档、rollback |
| 优化 | `optimize_skill_prompt` tool |

---

## 5. 认知管道与注入

### 5.1 钩子时序

```
session 启动
  → before_agent_start   # 注入 + 跨会话 escalation 通知 + cross-session nudge

会话进行中
  → tool_execution_end   # NudgeDetector → NudgeDeliverer（TUI，冷却）
  → write_memory tool    # agent 主动写记忆（可选）

session 结束
  → agent_end            # 归档 + 提取 + 反馈 + 投影写盘（debounce）
```

### 5.2 `before_agent_start` 逻辑摘要

1. 若有 open escalation 且 TUI 可用 → 最多 2 条 `ui.notify`
2. `recorder.seedPrompt` / `beginTurn`
3. 可选 **CrossSessionNudgeEngine** → 写入 pending agent nudge
4. 若 `enablePromptInjection`：
   - 意图规则分类 → `ContextAwareRetriever.retrieve`
   - `learningStore.listForInjection(cwd, 8)`（按 kind 分组）
   - `InjectionFormatter.formatInjection` → 追加到 `systemPrompt`
   - 记录 injected ids 供 `agent_end` 反馈

### 5.3 `agent_end` 逻辑摘要

```
1. 结束 trace，hydrate JSONL（若更丰富）
2. Nudge 会话级 effectiveness 结算
3. 写入 episode + session_trace
4. user_explicit regex → learnings
5. SessionLearner（仅跳过条件不满足时）
6. 对上轮 injected learnings → recordOutcome + refreshLifecycles
7. ErrorPatternExtractor → 仅 escalation
8. syncEvolutionEscalations
9. episode 数量裁剪
10. debounce 投影（learnings.md, 仅在变更时）
```

**不再执行**：
- TraceAnalyzer（LLM）
- IntentClassifier（LLM）
- SkillExtractor
- BenefitAdmission per-turn
- 投影 user_profile.md
- Memory Phase1 trigger

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

### 7.1 `learnings`（唯一 truth）

```sql
-- packages/self-evolution/src/storage/db.ts
id, cwd, kind, content, source, confidence, lifecycle, scope, session_id,
created_at, updated_at, times_injected, times_helped, times_ignored

kind:     preference | fact | procedure | skill_hint | identity (未来扩展)
source:   user_explicit | session_llm | manual_pin | agent_written
lifecycle: candidate | active | archived
scope:    global | project | ephemeral
```

注入时按 kind 分组展示：
- `identity` → `【用户】`
- `fact` → `【项目】`
- `preference` → `【规则】`

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

### 7.3 已删除的表

| 表 | 删除原因 |
|----|---------|
| `threads` | Phase1 删除 |
| `stage1_outputs` | Phase1 删除 |
| `jobs` | 不再需要多 worker 协调 |
| `vector_embeddings` | 改为 FTS（可选项） |

### 7.4 文件布局

```
~/.omp/self-evolution/
├── evolution.db              # SQLite WAL + FTS5
├── learnings.md               # learnings 投影（仅在变更时写）
├── system-diagnosis.md
├── activity.log
├── skills/*.md               # 技能导出
```

不再有：
- `~/.omp/persona.json`
- `~/.omp/agent/memories/`（整个目录不再使用）
- `raw_memories.md`、`rollout_summaries/`、`MEMORY.md`
- `user_profile.md`、`evolution_log.md`、`nudges.md`

---

## 8. 功能模块说明

### 8.1 按生命周期分组

| 阶段 | 模块 | 文件（主要） |
|------|------|----------------|
| 记录 | `TraceRecorder` | `trace.ts` |
| 会话中写入 | `write_memory` tool | `write-memory-tool.ts` |
| 会话结束提取 | `SessionLearner` | `session-learner.ts` |
| | `extractUserExplicitLearnings` | `user-explicit-learnings.ts` |
| 准入 | `learning-admission` | `learning-admission.ts` |
| 存储 | `SqliteLearningStore` 等 | `storage/*.ts` |
| 注入 | `InjectionFormatter` | `injection-formatter.ts` |
| | `ContextAwareRetriever` | `context-aware-retriever.ts` |
| 反馈 | `EffectivenessAnalyzer` | `effectiveness-analyzer.ts` |
| | `FeedbackTracker` | `feedback-tracker.ts` |
| 实时 | `NudgeDetector` / `NudgeDeliverer` | `nudge-*.ts` |
| | `CrossSessionNudgeEngine` | `cross-session-nudge.ts` |
| 投影 | learnings / diagnosis | `projection/*.ts` |
| 命令 | `/evolution` 子命令 | `commands.ts` |
| 扩展入口 | 注册钩子与工具 | `index.ts`, `tools.ts` |

**已删除：**
- `persona/store.ts`、`persona/types.ts`（合并到 learnings）
- `memory/index.ts` 的 Phase1 逻辑
- `memory/summary.ts`（不再需要）
- `extractor.ts`、`manager.ts`（SkillExtractor 删除）
- `memory/db-access.ts`、`memory/storage.ts`、`memory/schema.ts`（threads/stage1_outputs/jobs 表删除）
- `trace-analyzer.ts`（不再每轮调 LLM）
- `benefit-admission.ts`（不再 auto-deprecate skills per-turn）

### 8.2 Agent 可调用工具

| 工具 | 作用 |
|------|------|
| `write_memory` | 对话中写 learnings（主入口） |
| `query_episodic_memory` | FTS + 评分检索历史 episode |
| `list_evolved_skills` | 浏览技能库 |
| `optimize_skill_prompt` | GEPA 风格优化 skill 文本 |

### 8.3 观测与报告（实现模块）

| 模块 | 作用 |
|------|------|
| `audit-report.ts` + `projection/system-diagnosis.ts` | 健康审计 → `system-diagnosis.md` |
| `daily-report.ts` | 会话日报 |

---

## 9. 配置与 CLI 标志

| 标志 | 默认 | 说明 |
|------|------|------|
| `--self-evolution` | on | 总开关 |
| `--no-self-evolution-enable-prompt-injection` | — | 关闭注入 |
| `--self-evolution-max-episodes` | 100 | episode 保留上限 |
| `--no-self-evolution-llm-rerank` | — | episode 仅关键词检索 |
| `--self-evolution-global-store` | on | 用户级 `~/.omp/self-evolution`（默认） |
| `--self-evolution-project-store` | off | 项目级 `<cwd>/.omp/` |

**已移除**：
- `--self-evolution-skill-threshold`（SkillExtractor 删除）
- `--no-self-evolution-llm-refinement`（SkillExtractor 删除）

---

## 10. Slash Commands 功能说明

### 10.1 入口与约定

| 项 | 说明 |
|----|------|
| **主入口** | `/evolution <subcommand> [args]` |
| **作用域** | 默认用户级 `~/.omp/self-evolution`；`--self-evolution-project-store` 时用当前项目 `ctx.cwd` 下 `.omp/` |

**已移除**：`/evolution memory` 子命令体系（Phase1/Phase2 删除）。

### 10.2 `/evolution` 子命令总览

| 子命令 | 用法摘要 | 功能 |
|--------|----------|------|
| `status` | `/evolution status` | episodes / skills / learnings 统计 |
| `learnings` | 见 §10.3 | learnings 管理 |
| `skills` | `/evolution skills [--detail]` | 列出技能：质量分、成功率、使用次数 |
| `rate` | `/evolution rate <name> <1-5>` | 为技能打 1–5 星 |
| `clear` | `/evolution clear` | 全量重置 |
| `archive` | `/evolution archive` | 归档低质量技能 |
| `history` | `/evolution history <skill-name>` | 查看技能版本历史 |
| `rollback` | `/evolution rollback <name> <version>` | 回滚技能 |
| `sync-skills` | `/evolution sync-skills` | 将 DB 中技能导出为 `.omp/skills/*.md` |
| `audit` | `/evolution audit` | 系统健康报告 |
| `report` | `/evolution report` | 当日会话日报 |
| `fit` | `/evolution fit` | 「懂我程度」五维评估 |
| `log` | `/evolution log` | 最近 50 条 activity 事件 |
| `nudges` | 见 §10.4 | nudge 历史 |
| `stuck` | 见 §10.5 | escalation 管理 |

### 10.3 `/evolution learnings`

| 子命令 | 用法 | 功能 |
|--------|------|------|
| `list` | `/evolution learnings` | 列出最多 30 条 |
| `search` | `/evolution learnings search <keyword>` | 按内容子串过滤 |
| `pin` | `/evolution learnings pin <id>` | 设为 manual_pin + active |
| `archive` | `/evolution learnings archive <id>` | 设为 archived |
| `delete` | `/evolution learnings delete <id>` | 删除 |

### 10.4 `/evolution nudges`

| 用法 | 功能 |
|------|------|
| `/evolution nudges` | 最近 20 条 nudge |
| `/evolution nudges ack <id>` | 确认已读 |
| `/evolution nudges dismiss <id>` | 忽略 |

### 10.5 `/evolution stuck`

| 用法 | 功能 |
|------|------|
| `/evolution stuck` | 列出 open escalation |
| `/evolution stuck ack <id>` | 确认已知悉 |
| `/evolution stuck resolve <id>` | 标记已解决 |

---

## 11. 迁移与运维

### 11.1 从 V3 迁移到 V4

```
1. /evolution clear（清库）
2. 重新 start session（自动创建新表结构）
3. /evolution learnings pin 恢复核心规则
```

V3 的 `stage1_outputs`、`threads`、`jobs`、`vector_embeddings` 表在 schema 更新时自动删除（或保留不引用）。

### 11.2 数据迁移脚本

```bash
bash packages/self-evolution/scripts/migrate-evolution-data.sh /path/to/repo
```

### 11.3 回滚

恢复备份的 `evolution.db` 与 `.omp/` 目录。

---

## 12. 验收标准

| # | 检查项 |
|---|--------|
| 1 | `learnings` 中 active/pinned 约 5–15 条；下轮 prompt 含 `## Project Context` |
| 2 | 连续 10 会话新增 learnings ≤ 30（场均 ≤3） |
| 3 | 无新增 `negative_rule` 写入 |
| 4 | 有 learning 注入时 `times_injected` 递增；会话成功后 `times_helped` 可增长 |
| 5 | 用户说"请记住" → 当前轮 tool 可见；下一轮 prompt 注入 |
| 6 | 短轮（"继续"）不触发 SessionLearner LLM 调用 |
| 7 | `whoisme` 从 learnings 表渲染，内容正确 |

---

## 13. 源码与文档索引

| 类型 | 路径 |
|------|------|
| 扩展入口 | `packages/self-evolution/src/index.ts` |
| V3 设计决策 | `docs/plans/2026-05-19-evolution-v3-radical-redesign.md` |
| 包 README | `packages/self-evolution/doc/README.md` |
| 测试方案 | `docs/omp-evolution-test-plan.md` |

---

## 14. 版本沿革（简表）

| 版本 | 写入主路径 | 注入主路径 | 备注 |
|------|------------|------------|------|
| V2.x | Convention L1/L2/L3 + error/diagnosis | conventions + episodes + skills | 噪音与 admission 问题 |
| V3 | SessionLearner + user_explicit + Memory | memory_summary + learnings + episodes + skills | 当前默认 |
| **V4** | `write_memory` tool + user_explicit + SessionLearner(降频) | learnings 表分组注入 | 0-1 LLM/轮，删除 Phase1 + persona |

---

*本文档随 `packages/self-evolution` 实现演进；若与代码冲突，以代码与 CHANGELOG 为准。*