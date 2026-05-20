# OMP 进化架构 V2.1 开发计划

---

## 依赖关系图

```
Phase 0 (基础设施) ──▶ Phase 1 (Memory)
                  ──▶ Phase 2 (Self-Evolution)
Phase 1 ──────────────▶ Phase 3 (Episodic Store)
Phase 2 ──────────────▶ Phase 4 (Cognitive Pipeline)
Phase 1 + Phase 2 ────▶ Phase 5 (Model Router)
Phase 4 ──────────────▶ Phase 6 (Commands)
Phase 1-4 ────────────▶ Phase 7 (Safety & Observability)
```

---

## Phase 0：基础设施（存储 + 数据层）

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|
| 0.1 | 创建 omp.sqlite 统一数据库 schema | packages/self-evolution | src/storage/db.ts | L | 无 | **已完成** |
| 0.2 | 实现 memory_* 命名空间表 | packages/coding-agent | src/memories/storage.ts | M | 0.1 | **已完成** |
| 0.3 | 实现 evolution_* 命名空间表 | packages/self-evolution | src/storage/db.ts | M | 0.1 | **已完成** |
| 0.4 | 实现 episodic_* 命名空间表 | packages/self-evolution | src/storage/db.ts | M | 0.1 | **已完成** |
| 0.5 | 实现 vec_* 命名空间表（SQLite-vec） | packages/coding-agent | src/memories/storage.ts | L | 0.1 | **部分完成** |
| 0.6 | 实现 skill_population 表 + 生命周期状态字段 | packages/self-evolution | src/storage/skills.ts | M | 0.1 | **已完成** |
| 0.7 | 实现 EpisodicBackend 接口 + SQLite 默认实现 | packages/self-evolution | src/storage/episodes.ts | L | 0.4 | **已完成** |
| 0.8 | .jsonl 双写集成（Agent Session hooks） | packages/coding-agent | src/memories/index.ts, src/session-logger | M | 0.2 | **已完成** |
| 0.9 | Repository 层模块隔离约束 | packages/self-evolution, packages/coding-agent | 各模块 storage/*.ts | S | 0.2-0.5 | **已完成** |

---

## Phase 1：Memory 模块补齐

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 | 优先级 |
|---|------|--------|-------------|--------|------|--------|
| **1.1** | **Memory Phase 1 规则 fallback**（§13.4 缺口 2） | packages/coding-agent | src/memories/index.ts | L | 0.8 | **P0 — 已完成** |
| **1.2** | **Memory Phase 2 规则 fallback**（§13.4 缺口 2） | packages/coding-agent | src/memories/index.ts | M | 0.8 | **P0 — 已完成** |
| 1.3 | SQLite-vec 向量存储集成 | packages/coding-agent | src/memories/storage.ts | L | 0.5 | **P1 — 已完成** |
| 1.4 | 复合评分检索（0.5×similarity + 0.3×recency + 0.2×importance） | packages/coding-agent | src/memories/retrieval.ts | M | 1.3 | **P1 — 已完成** |
| 1.5 | 矛盾检测 + supersede + provenance 裁决 | packages/coding-agent | src/memories/conflict.ts | M | 1.4 | **P1 — 已完成** |
| 1.6 | 遗忘/淘汰算法（指数衰减 + 阈值修剪 + 合并） | packages/coding-agent | src/memories/lifecycle.ts | M | 1.4 | **P1 — 已完成** |
| 1.7 | MEMORY.md + memory_summary.md 投影生成 | packages/coding-agent | src/memories/projection.ts | S | 1.5 | **P1 — 已完成** |
| 1.8 | MEMORY.md 用户编辑反向导入 | packages/coding-agent | src/memories/import.ts | S | 1.7 | **P1 — 已完成** |

---

## Phase 2：Self-Evolution 增强

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 | 优先级 |
|---|------|--------|-------------|--------|------|--------|
| **2.1** | **Convention Layer 2 LLM Batch Extraction**（§13.4 缺口 1） | packages/self-evolution | src/convention-extractor.ts, src/prompts/extract-convention-batch.md | L | 0.3 | **P0 — 已完成** |
| 2.2 | Convention Layer 3 Fallback Rules | packages/self-evolution | src/convention-extractor.ts | M | 2.1 | **P1 — 已完成** |
| 2.3 | Provenance 分级（4 级：user_stated/implied/inferred/fallback） | packages/self-evolution | src/types.ts, src/convention-store.ts | M | 0.3 | **P1 — 已完成** |
| 2.4 | Convention Miner 集成到三层提取管道 | packages/self-evolution | src/convention-extractor.ts | M | 2.1 | **P1 — 已完成** |
| 2.5 | 否定关键词库 + false positive 过滤实现 | packages/cognitive-coordination | src/convention-miner.ts | S | 0.3 | **P1 — 已完成** |
| 2.6 | 隐式信号提取（连续失败/重复请求/手动撤销） | packages/self-evolution | src/trace-analyzer.ts | M | 0.3 | **P1 — 已完成** |
| 2.7 | 技能种群进化引擎（评分 + 选择偏置 + 变异 + 淘汰 + 毕业） | packages/self-evolution | src/evaluator.ts, src/skill-evolution.ts | L | 0.6 | **P1 — 已完成** |
| 2.8 | 反馈闭环多维度评分（outcome_score + 隐式信号） | packages/self-evolution | src/feedback-tracker.ts | M | 0.3 | **P1 — 已完成** |
| 2.9 | conventions.md 投影生成 + 反向导入 | packages/self-evolution | src/projection.ts | M | 2.3 | **P2 — 已完成** |
| 2.10 | evolution_log.md 审计时间线 | packages/self-evolution | src/logging/evolution-log.ts | S | 2.7 | **P2 — 已完成** |
| 2.11 | user_profile.md 投影 + 滚动窗口聚合 | packages/self-evolution | src/user-profiler.ts | M | 0.3 | **P2 — 已完成** |

---

## Phase 3：Episodic Store

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|
| 3.1 | EpisodicRecord 数据模型实现 | packages/self-evolution | src/types.ts, src/storage/episodic-backend.ts | M | 0.7 | **已完成** |
| 3.2 | Agent event hooks → Episodic Store 写入 | packages/coding-agent | src/trace-recorder.ts (via self-evolution index.ts) | M | 3.1 | **已完成** |
| 3.3 | Session 生命周期管理（markSessionEnded + TTL 倒计时） | packages/self-evolution | src/episodic-manager.ts | M | 3.1 | **已完成** |
| 3.4 | TTL 过期清理 + importance-based 晋升 | packages/self-evolution | src/episodic-manager.ts | M | 3.3 | **已完成** |
| 3.5 | 中断任务恢复（新会话加载历史 session） | packages/coding-agent | src/session-resume.ts | M | 3.1 | **已完成** |
| 3.6 | Episodic Store 语义检索接口 | packages/self-evolution | src/retrieval.ts | M | 0.5 | **已完成** |
| 3.7 | Redis 可选后端实现 | packages/self-evolution | src/storage/episodic-redis.ts | L | 0.7 |

---

## Phase 4：Cognitive Pipeline

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|

| 4.1 | Query Analyzer（意图 + domain + requiresEpisodic） | packages/cognitive-coordination | src/query-analyzer.ts | M | Phase 2 | **已完成** |
| 4.2 | Retrieval Orchestrator（并行 4 源查询 + 3× 过检索） | packages/cognitive-coordination | src/assembler.ts, src/registry.ts | L | 4.1 | **已完成** |
| 4.3 | Score Fusion（0.5/0.3/0.2 复合评分） | packages/cognitive-coordination | src/assembler.ts | M | 4.2 | **已完成** |
| 4.4 | Conflict Resolver（去重 + 矛盾裁决 + supersede） | packages/cognitive-coordination | src/conflict-resolver.ts | M | 4.3 | **已完成** |
| 4.7 | Virtual Sandbox（时效性 + 适用域 + 不可变规则 + 相关性） | packages/cognitive-coordination | src/sandbox.ts | M | 4.2 | **已完成** |
| 4.8 | Activity Monitor（5 维度监控 + 事件生成） | packages/cognitive-coordination | src/activity-monitor.ts | M | Phase 2 | **已完成** |
| 4.5 | Token Budget Allocator（动态分配 + 任务类型调整） | packages/cognitive-coordination | src/assembler.ts | M | 4.4 | **已完成** |
| 4.6 | System Prompt Injection（7 层优先级） | packages/coding-agent | src/system-prompt.ts | M | 4.5 | **已完成** |
| 4.9 | Pipeline 6 阶段串联 + 状态机 | packages/cognitive-coordination | src/assembler.ts | L | 4.1-4.6 | **已完成** |

---

## Phase 5：LLM 模型测评与智能路由

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|
| 5.1 | Model Evaluator 数据收集（session_model_stats） | packages/self-evolution | src/storage/session-model-stats.ts, src/model-evaluator.ts | M | 0.3 | **已完成** |
| 5.2 | model_score 聚合计算（4 维 + 衰减） | packages/self-evolution | src/model-scorer.ts | M | 5.1 | **已完成** |
| 5.3 | /model scores 命令 | packages/coding-agent | src/slash-commands/ | S | 5.2 | **已完成** |
| 5.4 | Model Router（任务感知路由 + 冷却期 + 用户覆盖） | packages/coding-agent | src/model-router.ts | M | 4.1, 5.2 | **已完成** |
| 5.5 | Performance-Aware Fallback（连续失败/token 超耗触发） | packages/coding-agent | src/retry-fallback.ts | M | 5.1 | **已完成** |
| 5.6 | 推荐提示 UI | packages/coding-agent | src/tui/model-recommendation.ts | S | 5.4 | **已完成** |

---

## Phase 6：命令 & UX

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|
| 6.1 | /evolution population 子命令 | packages/coding-agent | src/slash-commands/ | M | Phase 2 | **已完成** |
| 6.2 | /evolution conventions list/search/delete | packages/coding-agent | src/slash-commands/ | M | Phase 2 | **已完成** |
| 6.3 | /evolution nudges | packages/coding-agent | src/slash-commands/ | S | Phase 2 | **已完成** |
| 6.6 | /memory search 向量检索 | packages/coding-agent | src/slash-commands/ | M | 1.4 | **已完成** |
| 6.7 | /memory skills（graduated 投影） | packages/coding-agent | src/slash-commands/ | S | 2.7 | **已完成** |
| 6.9 | /profile show/edit/stats | packages/coding-agent | src/slash-commands/ | M | 2.11 | **已完成** |
| 6.10 | /model scores/reset | packages/coding-agent | src/slash-commands/ | S | 5.3 | **已完成** |

---

## Phase 7：安全 & 可观测性

| # | 任务 | 目标包 | 目标文件/目录 | 复杂度 | 依赖 |
|---|------|--------|-------------|--------|------|
| 7.1 | 不可变规则强制执行 | packages/self-evolution | src/immutable-rules.ts | M | Phase 2 | **已完成** |
| 7.2 | 进化前快照机制 | packages/self-evolution | src/snapshot.ts | M | Phase 2 | **已完成** |
| 7.3 | evolution_log.md 审计追加 | packages/self-evolution | src/logging/evolution-log.ts | S | 2.10 | **已完成** |

| 7.4 | 可观测性事件系统（6 种事件类型） | packages/self-evolution | src/observability.ts | M | 4.8 | **已完成** |
| 7.5 | 告警阈值触发（4 条规则） | packages/cognitive-coordination | src/activity-monitor.ts | S | 7.4 | **已完成** |
| 7.6 | 变体率控制 + 单次变更上限 | packages/self-evolution | src/skill-evolution.ts | S | 2.7 | **已完成** |

---

## 关键缺口追踪

| 缺口 | 来源 | Phase | 任务 # | 状态 |
|------|------|-------|---------|------|
| Memory Phase 1 无规则 fallback | §13.4 缺口 2 | 1 | 1.1 | **已完成** |
| Memory Phase 2 无规则 fallback | §13.4 缺口 2 | 1 | 1.2 | **已完成** |
| Convention Layer 2 LLM Batch | §13.4 缺口 1 | 2 | 2.1 | **已完成** |

这三个缺口是系统最脆弱的点，必须在 Phase 1 和 Phase 2 首先完成。