# Evolution V3：彻底重构设计（Radical Redesign）

**Status**: Approved direction — migration **1-B**, regression **2-A** (default)  
**Date**: 2026-05-19  
**Package**: `packages/self-evolution/`

---

## 决策记录

| 项 | 选择 | 说明 |
|----|------|------|
| 改造幅度 | **方案 C** — 单一 LLM 写入 + Memory 整合 + 简化注入 | 不再在 L1/L1.5/L2/L3 + diagnosis + errorPattern 上补丁 |
| 历史数据 **1-B** | **`/evolution clear` 后从零** | 不导入 1707 条 `conventions`；仅保留/恢复 `MEMORY.md`、手工 **pin**、`.omp/skills/` 文件（按需重导） |
| Regression **2-A** | **取消 convention/learnings 的 fixture replay** | 仅 skill 可选保留轻量门控；`pinned` learning 直通 active |

---

## 1. 问题陈述（数据驱动）

基于 `oh-my-pi/.omp/evolution/evolution.db`（2026-05-19）：

- 1707 conventions，**active = 0**，effectiveness 表 **0 行**
- 81% `negative_rule`（error 模板灌库）
- 87% episodes 无 convention，少数会话 100+ 条（爆发式噪音）
- `memory_summary.md` 几乎空，短期 Memory 注入失效

根因：**中游多路规则提取过宽 + 下游 admission/regression 过死 + 反馈未落库**。

---

## 2. 目标态

> **会话结束：一次 LLM 决定记什么（≤3 条）。空闲：Memory 合并 MEMORY.md。回合开始：只注入 summary + active/pinned learnings + graduated skills + 少量 episodes。工具失败：仅 nudge/escalation，不写长期规则库。**

### 2.1 短 / 中 / 长

| 层级 | 机制 | 产物 |
|------|------|------|
| **短期** | `before_agent_start` | `memory_summary.md` + `learnings`(active/pinned) + skills + episodes + nudges |
| **中期** | `agent_end` + Memory P1 | `learnings` candidate、`episode`、`session_trace`、raw_memories |
| **长期** | Memory P2 + pin/统计晋升 | `MEMORY.md`、`.omp/skills/`、`learnings` active |

### 2.2 对标 Hermes / OpenClaw

| | Hermes | OpenClaw | OMP V3 |
|--|--------|----------|--------|
| 写 | Turn LLM review | — | **SessionLearner**（每会话 1 次 LLM） |
| 并 | Curator | Dreaming consolidate | **Memory Phase2** |
| 护栏 | Rubric + tools | Activity guard | 写时 cap + 长度/来源校验 + pin |
| 失败 | 当轮改 memory | 一般不千条规则 | **nudge + escalation only** |

---

## 3. 数据模型

### 3.1 新表 `learnings`（替代 conventions 主路径）

```sql
CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  kind TEXT NOT NULL,           -- preference | fact | procedure | skill_hint
  content TEXT NOT NULL,        -- min 20 chars, single actionable statement
  source TEXT NOT NULL,         -- user_explicit | session_llm | manual_pin
  confidence INTEGER NOT NULL,  -- 1-5 from LLM at write time
  lifecycle TEXT NOT NULL,      -- candidate | active | archived
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  times_injected INTEGER NOT NULL DEFAULT 0,
  times_helped INTEGER NOT NULL DEFAULT 0,
  times_ignored INTEGER NOT NULL DEFAULT 0
);
```

**写入（Hermes 式）**

- `SessionLearner` LLM 输出 JSON array，**最多 3 条**；`confidence < 4` 丢弃。
- LLM 失败：**0 条**（不靠 L3 规则灌库）。
- 可选：`user_explicit` 白名单 regex ≤5 条（「记住」「别用 console.log」等），最多 **+1 条/会话**。

**晋升 active（简化 OMP，无 regression）**

- `manual_pin` → 立即 `active`
- 或 `times_injected >= 3` 且 `times_helped / times_injected >= 0.5`
- **2-A**：无 fixture replay 门禁

### 3.2 废弃 / 冻结

- `conventions` 表：随 **1-B clear** 删除，不再创建（或 V3 schema 不建表）
- `ErrorPatternExtractor` → conventions：**删除**
- `extractFromDiagnosis` → conventions：**删除**
- `convention-extractor` L1.5/L2/L3 主路径：**删除**
- `negative_rule` 类型：**取消**

### 3.3 保留

- `episodes`, `session_traces`, Memory (`threads`, `stage1_outputs`, jobs), `skill_population`, `skills`（需与 `.omp/skills` 同步）
- `nudge_*`, `evolution_escalations`, `episode_diagnoses`（diagnosis 仅运维）
- `audit` / `fit`（观测）

---

## 4. 运行时流程

### 4.1 `agent_end`（唯一学习写入主路径）

```
1. Finalize trace → episode + session_trace
2. SessionLearner.run(trace) → 0..3 learnings (session_llm)
3. Optional: user_explicit regex → 0..1 learning
4. Optional: skill extract (threshold + LLM) → skill file + population
5. traceAnalyzer → diagnosis row only (no learnings)
6. errorPattern → escalation counters only (no learnings)
7. feedbackTracker → episode/skill effectiveness (mandatory)
8. enqueue Memory Phase1
9. project learnings.md, system-diagnosis.md, evolution_log.md
```

### 4.2 `before_agent_start`（注入顺序 + token cap ~2k）

1. `memory_summary.md`
2. `learnings` where lifecycle in (active) or source = manual_pin
3. graduated skills (≤3)
4. episodes retrieve (≤ maxEpisodes, optional llmRerank)
5. cross-session nudges (≤2)

### 4.3 Memory（OpenClaw 轨，不变核心）

- Phase1/2 LLM 为主，fallback 保留
- Phase2 后刷新 `memory_summary.md` from `MEMORY.md`（避免 47B 空摘要）

---

## 5. 迁移 1-B：清库重来清单

**执行前**：用户自行备份 `~/.omp` 与 `<repo>/.omp`（可选）。

**保留（复制出 clear 范围或 clear 后恢复）**

| 资产 | 路径 | 动作 |
|------|------|------|
| 长期记忆叙事 | `<repo>/.omp/memory/MEMORY.md` | clear **前**复制到 `/tmp` 或 `docs/evolution-seed/`，clear **后**写回 |
| 技能 markdown | `<repo>/.omp/skills/*.md` | 同上（或 clear 后从 git/备份恢复） |
| 用户配置 | `~/.omp/agent/config.yml` | 不动 |
| 会话 JSONL | `~/.omp/agent/sessions/` | 不动（可选 backfill episodes  later） |

**`/evolution clear` 删除**

- `<repo>/.omp/evolution/`（含 evolution.db、conventions.md、system-diagnosis.md）
- `<repo>/.omp/memory/`（除用户恢复的 MEMORY.md）
- `<repo>/.omp/skills/`（除用户恢复的文件）

**清库后手工种子（Day 0）**

1. 恢复 `MEMORY.md`
2. 从 MEMORY 生成 `memory_summary.md`（首段 800–1200 字或 `/memory enqueue`）
3. `/evolution learnings pin`（新命令）写入 3–5 条核心偏好（中文、可执行）
4. 新开会话验证 `prompt_injected` / learnings count

**不做的**

- 不从 `conventions_legacy` 导入 1707 条
- 不跑 `refresh-admission` 指望 promote

---

## 6. 代码变更范围（R0–R5）

| 阶段 | 内容 |
|------|------|
| **R0** | Flag `self-evolution-v2-writer`；agent_end 停写 conventions/error/diagnosis-conv；修 effectiveness 落库 |
| **R1** | `session-learner.ts` + `extract-session-learnings.md` + `learnings` schema + store |
| **R2** | `injection-formatter` 读 learnings；弃用 `listForInjection(conventions)` |
| **R3** | Commands: `/evolution learnings` list/search/pin/archive；迁移帮助文案 |
| **R4** | 删除 layer2/3、error→conv、convention 主投影；更新 tests |
| **R5** | `docs/omp-evolution-architecture-v3.md`；CHANGELOG |

**删除/废弃文件（R4）**

- `convention-extractor-layer2.ts`, `layer3.ts`
- `error-pattern-extractor.ts` convention 写入路径
- `prompts/extract-conventions*.md`（由 session-learnings 替代）
- regression 对 convention 的 replay 分支

---

## 7. 验收标准

1. Clear 后 DB 无 `conventions` 表或为空；`learnings` 仅种子 + 新会话写入
2. 连续 10 会话：新增 learnings ≤ 30，平均每会话 ≤ 3
3. active learnings 5–15；下轮 prompt 可见
4. 无新增 `negative_rule`
5. `episode_effectiveness` / `skill_effectiveness` 有注入必有行
6. `memory_summary.md` ≥ 500 字符

---

## 8. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 丢失历史 convention | 1-B 接受；偏好靠 MEMORY.md + 手工 pin |
| 丢失 episodes | clear 会删；若需保留则 **改选 1-A** 或 clear 前只删 conventions 表 |
| R0 与 R1 之间无写入 | 短窗口仅 Memory + 手工 pin 有效 |

回滚：恢复 backup 的 `evolution.db`；关闭 `self-evolution-v2-writer` flag。

---

## 9. 下一步

1. 用户确认 **2-A**（已默认）或改为 2-B  
2. `writing-plans` → `docs/plans/2026-05-19-evolution-v3-implementation.md`（PR 级任务拆分）  
3. 实施 **R0** 或先执行 **1-B 运维清库**（可在 R0 前做种子）
