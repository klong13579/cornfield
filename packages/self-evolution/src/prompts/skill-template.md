# Skill 模板（OMP 标准）

不满足本标准的 skill **不应写入** `<repo>/.omp/skills/`（保留在 DB 供演化，但不导出/不优先注入）。

**机器可读指标**（`quality_score`、`times_*`、`population_*`）只放在 YAML frontmatter 或 DB，**禁止**出现在正文。

---

## 一、元数据（YAML frontmatter）

```yaml
---
name: "<kebab-case-name>"
version: "1"
source: "evolution"          # evolution | memory | manual
status: "active"             # active | experimental | deprecated
confidence_score: <0.0-1.0>
quality_score: <0-100>
usage_count: 0
success_count: 0
failure_count: 0
user_rating: 0
last_used_at: "<ISO 8601>"
description: |-
  <动作句：何时触发、解决什么问题；50-120 字符；含触发关键词>
population_state: "candidate"
evolution_score: <0.0-1.0>
population_success_rate: 0
times_injected: 0
times_helped: 0
times_failed: 0
---
```

### description 规则

| 规则 | 好 | 坏 |
|------|----|----|
| 动作句 + 场景 | "Apply boundary value analysis when designing tests for APIs, numeric ranges, or state machines." | "Extracted from session abc: 如何诊断…" |
| 只写触发与目标，不写步骤 | "Identify reusable conventions from long sessions." | "Use search, then read, then edit…" |
| 含触发关键词 | 含 test / boundary / API / latency 等 | 仅 "修复" |
| 50–120 字符，独立可读 | 见上 | 会话标题摘录 |

---

## 二、正文（仅 Agent 消费）

对每一段自问：**Agent 读到后会改变行为吗？**

### 结构（二选一）

**A. 决策型（诊断 / 选型 / 排障）**

```markdown
# <Title>

## Outcome
<完成本 skill 后交付什么>

## When to use
<触发条件、关键词、不适用场景>

## <决策领域 1>

### 识别条件
…

### 可选方案
| 症状 | 行动 |
|------|------|
| … | … |

### 具体操作
…

### 反例 / 不适用
…
```

**B. 流程型（方法论 / 检查清单）**

```markdown
# <Title>

## Outcome
…

## When to use
…

## Procedure
1. …

## Checklist
- [ ] …

## Pitfalls
- …

## Anti-patterns
- …

## Examples
### 示例 1
…
```

### 正文禁止

- 工具序列：`search → read → edit`（单独一行或整段）
- 具体文件路径：`src/foo.ts`、某次会话修改列表
- 评分表、种群生命周期、反馈命令说明（属于演化系统，不是 skill）
- `Extracted from session …` 原文

### 长度

| 部分 | 上限 |
|------|------|
| description | 120 字符 |
| 正文 | 200 行 |
| 单组 bullet | 3–8 条 |

---

## 三、质量标准（与启发式打分对齐）

| 维度 | 正文应体现 |
|------|------------|
| approachSubstance | 判断条件 + 可选方案，非单一路径 |
| pitfallCoverage | 反例、不适用、常见错误 |
| toolDiversity | 何时用何种**方法**，而非工具名罗列 |
| autonomy | 不依赖单次会话上下文也能执行 |

**不应导出为 active skill：**

- 正文为空或仅工具序列
- 正文是会话审计而非通用规则
- description 为 user message 摘录
- 与已有 active skill 正文重合 > 60%（合并时去重）

---

## 四、完整示例（决策型）

```yaml
---
name: "tool-latency-diagnosis"
version: "1"
source: "evolution"
confidence_score: 0.85
quality_score: 0
usage_count: 0
success_count: 0
failure_count: 0
user_rating: 0
last_used_at: "2026-05-18T00:00:00.000Z"
status: "active"
description: "Trace tool-call latency from user request to render when diagnosing slow tool responses. Covers handler, provider, and render paths."
population_state: "candidate"
evolution_score: 0.0
population_success_rate: 0
times_injected: 0
times_helped: 0
times_failed: 0
---

# Tool Latency Diagnosis

## Outcome
A short written verdict: which layer owns the delay and the next measurement to run.

## When to use
Apply when the user reports slow tools, hanging tool calls, or long gaps before TUI updates — not for overall model thinking time alone.

## Isolate the Responsible Layer

### 识别条件
Response time scales with payload size, or spikes at fixed intervals, or only on cache miss.

### 可选方案
| Symptom | Likely owner |
|---------|----------------|
| Time ∝ input size | Handler processing |
| ~30s flat regardless of input | Provider rate limit / queue |
| Instant vs 60s+ alternating | Cache miss or contention |

### 具体操作
- Confirm the tool choice is appropriate for input size before profiling internals.
- If I/O bound, trace subprocess/network waits before blaming the model.

### 反例 / 不适用
- Tool completes in <500ms and user asks about whole-session latency.
- Intentionally long operations (full-repo grep) where duration is expected.
```

---

## 五、导出验收（`skill-validation.ts`）

```json
{
  "must_pass": [
    "description_starts_with_action_verb",
    "body_has_conditional",
    "body_no_tool_sequence_only",
    "body_no_file_paths",
    "body_has_limitation_or_counterexample",
    "body_under_200_lines"
  ],
  "must_fail": [
    "body_empty_or_tool_sequence_only",
    "description_is_session_excerpt",
    "body_is_session_audit_only"
  ]
}
```

实现见 `packages/self-evolution/src/skill-validation.ts` 与 `skill-format.ts`。
