# OMP 进化架构 V2.1：Mock 业务流与输出结果

## 场景设定

**用户**：开发者在 oh-my-pi 项目中工作
**会话**：第 100 次会话
**输入**："我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒"

---

## 一、Memory 模块

### 1.1 输入：双写数据源

**JSONL 全量原始**（`~/.omp/logs/omp.2026-05-13.log`）：

```jsonl
{"type":"session","id":"019e2153-0843-7000-b216-4824927ff6e8","cwd":"/Users/sz-0203015357/Desktop/Narwal/oh-my-pi"}
{"type":"message","role":"user","content":"我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒"}
{"type":"message","role":"assistant","content":"明白了，我会在测试用例设计时自动考虑边界条件..."}
{"type":"tool_call","toolName":"read","args":{"path":"packages/self-evolution/src/convention-extractor.ts"}}
{"type":"tool_result","toolName":"read","isError":false,"result":"..."}
{"type":"tool_call","toolName":"edit","args":{"path":"packages/self-evolution/src/convention-extractor.ts","...":"..."}}
{"type":"tool_result","toolName":"edit","isError":false,"result":"..."}
```

**Episodic Store SQLite 结构化子集**（`omp.sqlite → episodic_session_records`）：

```sql
INSERT INTO episodic_session_records (id, sessionId, scope, content, importance, createdAt, expiresAt)
VALUES
('epi_001', '019e2153-0843-7000-b216-4824927ff6e8', 'decision', '用户要求测试用例设计时自动考虑边界条件', 0.85, 1778675770444, 1779276570444),
('epi_002', '019e2153-0843-7000-b216-4824927ff6e8', 'tool_chain', 'read → edit (convention-extractor.ts)', 0.6, 1778675770445, 1779276570445);
```

### 1.2 Phase 1 提取结果

**LLM 成功路径**：

```json
{
  "rollout_summary": "用户要求测试用例设计时自动考虑边界条件，避免重复提醒。已修改 convention-extractor.ts 增加边界条件检测。",
  "rollout_slug": "test-case-boundary-conditions",
  "raw_memory": "## User Request\n- 需求：测试用例设计时自动考虑边界条件\n- 痛点：用户需要反复提醒\n- 解决方案：修改 convention-extractor.ts，增加边界条件检测逻辑\n\n## Technical Changes\n- Modified: packages/self-evolution/src/convention-extractor.ts\n- Added: boundary condition detection in test case design\n- Impact: Reduces user repetition, improves test coverage"
}
```

**LLM 失败时规则 fallback**（§13.4 缺口 2 补齐后）：

```json
{
  "rollout_summary": "Session 100: test case boundary conditions request. Tools: read, edit. No errors.",
  "rollout_slug": null,
  "raw_memory": "## Tool Calls\n1. read(convention-extractor.ts) → success\n2. edit(convention-extractor.ts) → success\n\n## User Input\n\"我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒\"\n\n## Key Patterns\n- 用户否定关键词: \"不要每次都让我提醒\"\n- 修改目标: convention-extractor.ts"
}
```

### 1.3 Phase 2 整合结果

```markdown
<!-- MEMORY.md -->
# Project Overview
- Repository: oh-my-pi
- Architecture: Bun/TS/Rust monorepo

## Technical Decisions
- Config: ~/.omp/agent/config.yml
- Tool Priority: ast_grep > search > find
- Provider Pitfalls: Qwen 400, Kimi 403

## Self-Evolution System
- Storage: 统一 SQLite (omp.sqlite) + Vector Store (SQLite-vec)
- Human-readable: conventions.md, evolution_log.md, user_profile.md
- Scheduled Tasks: evolution-audit, evolution-fit, memory-lifecycle

## Recent Changes (Session 100)
- **Test Case Boundary Conditions**: User requested automatic boundary condition 
  consideration in test case design. Modified convention-extractor.ts to detect 
  and handle boundary conditions.
```

---

## 二、Episodic Store 模块

### 2.1 会话开始时恢复检查

```sql
-- 查询未过期的 episodic records（假设前次会话有相关经验）
SELECT * FROM episodic_session_records 
WHERE expiresAt > 1778675770444 AND scope = 'error_context'
ORDER BY importance DESC;

-- 结果：上次会话有 "read 工具路径错误" 的 error_context，importance = 0.7
-- 该记录被加载到当前会话上下文
```

### 2.2 会话进行中实时写入

```
Session 进行中 → Episodic Store 实时写入:

[Created] → tool_chain scope: "read → edit (convention-extractor.ts)"
[Created] → decision scope: "用户要求边界条件自动考虑"
[Created] → error_context scope: (无错误，不写入)
```

### 2.3 会话结束时生命周期管理

```
Session 结束 → markSessionEnded(sessionId)

所有 records → 状态变为 [Pending Review], TTL 倒计时启动（7 天）

低 importance (< 0.3) → TTL 到期后删除
高 importance (≥ 0.7) → TTL 到期前触发晋升:
  - epi_001 (importance=0.85) → promotedTo = "convention"（晋升到 Convention Store）
  - epi_002 (importance=0.6) → 不晋升，7 天后过期删除
```

---

## 三、Self-Evolution 模块

### 3.1 三层 Convention 提取

**Layer 1：Heuristic Rules (Regex)**

```
用户输入: "我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒"

Regex 匹配结果:
├── "我希望..." → preference, boost: 85
│   → convention: "测试用例设计时自动考虑边界条件（空值、最大值、最小值、异常值）"
│   → provenance: user_stated, confidence: 85
│
└── "不要..." → negative_rule, boost: 60
    → convention: "不要等用户提醒才考虑边界条件"
    → provenance: user_stated, confidence: 60
```

**Convention Miner 否定关键词匹配**：

```json
[
  {
    "rule": "不要每次都让我提醒",
    "confidence": 0.60,
    "provenance": "user_stated",
    "sourceSessionId": "019e2153-0843-7000-b216-4824927ff6e8"
  }
]
```

**Layer 2：LLM Batch Extraction**（累积 10 轨迹后，§13.4 补齐后新增）：

```json
{
  "conventions": [
    {
      "type": "preference",
      "content": "测试用例设计时应自动覆盖边界条件（null, max, min, NaN, Infinity）",
      "provenance": "system_inferred",
      "confidence": 65
    }
  ]
}
```

**Layer 3：Fallback Rules**（更宽松匹配）：

```
（本轮无额外 fallback 触发，Layer 1 已覆盖核心意图）
```

### 3.2 生成的 Convention（SQLite 存储）

```sql
INSERT INTO evolution_conventions (id, type, content, provenance, confidence, createdAt, lastSeenAt)
VALUES 
('conv_test_boundary_001', 'preference', 
 '测试用例设计时自动考虑边界条件（空值、最大值、最小值、异常值）', 
 'user_stated', 85, 1778675770444, 1778675770444);

INSERT INTO evolution_conventions (id, type, content, provenance, confidence, createdAt, lastSeenAt)
VALUES 
('conv_test_boundary_002', 'negative_rule', 
 '不要等用户提醒才考虑边界条件', 
 'user_stated', 60, 1778675770444, 1778675770444);
```

### 3.3 Provenance 分级标注

```
conv_test_boundary_001: provenance = user_stated → 置信度基准 90-100 → 冲突优先级最高
conv_test_boundary_002: provenance = user_stated → 置信度基准 90-100 → 冲突优先级最高

（两条均为用户显式声明，未来与 system_inferred 规则冲突时，用户声明优先）
```

### 3.4 反馈闭环（多维度评分）

**场景 1：用户说"好的"**

```
用户输入: "好的"
    │
    ▼
FeedbackTracker:
    ├── outcome_score += 0.1 (显式肯定)
    └── provenance = user_stated
    │
    ▼
更新 Convention:
    - conv_test_boundary_001 confidence: 85 → 95 (user_stated 范围内)
    - timesApplied: 0 → 1
```

**场景 2：用户说"不对，还是漏了边界条件"**

```
用户输入: "不对，还是漏了边界条件"
    │
    ▼
FeedbackTracker:
    ├── outcome_score -= 0.2 (显式否定)
    ├── 触发矛盾检测
    └── provenance = user_stated
    │
    ▼
更新 Convention:
    - conv_test_boundary_001 confidence: 95 → 85 (否定降权)
    - timesViolated: 0 → 1
    │
    ▼
生成新 Convention:
    - content: "测试用例设计时必须显式列出边界条件清单"
    - provenance: user_stated
    - confidence: 85
```

**场景 3：隐式信号 — 用户手动撤销修改**

```
Agent 执行 edit → 用户手动 revert
    │
    ▼
FeedbackTracker:
    ├── outcome_score -= 0.15 (隐式否定)
    └── 检测: edit 后紧跟 revert
    │
    ▼
生成 Convention:
    - type: negative_rule
    - content: "不要自动修改测试文件格式"
    - provenance: user_implied
    - confidence: 75
```

### 3.5 技能种群进化

```sql
-- skill_population 表状态
SELECT name, skill_score, status FROM evolution_skill_population;

-- 结果:
-- test-case-design: skill_score=0.85, status=stable
-- bash-scripting: skill_score=0.62, status=evaluating
-- debug-workflow: skill_score=0.22, status=incubating
```

**毕业路径**：

```
test-case-design: skill_score > 0.7 持续 3 评估窗口 → graduated
    │
    ▼
生成 skills/test-case-design.md 投影（SQLite 只读投影）
退出进化循环，不再参与评分
```

**淘汰路径**：

```
某低效技能: skill_score < 0.35 持续 3 评估窗口 → deprecated
不再注入系统提示，不再参与选择偏置
```

### 3.6 提取去重（Unified Dedup Gate）

```
提取结果（同一条教训可能从多路径产出）:
├── Memory raw_memory: "边界条件检测需求"
├── Convention: "测试用例设计时考虑边界条件"
└── Skill: test-case-design approach 中包含边界条件步骤
    │
    ▼
Unified Dedup Gate → Conflict Resolver:
    │
    ├── raw_memory vs convention → 语义相似度 > 0.85 → 合并
    │   → 保留 convention (provenance=user_stated，优先级更高)
    │   → raw_memory 标记为 "已合并到 convention"
    │
    └── convention vs skill → 去重
    │   → 保留 skill approach 中的具体步骤
    │   → convention 保留为偏好声明
    │   → 两者不矛盾，同时保留（convention 是偏好声明，skill 是操作手册）
```

### 3.7 conventions.md 投影

```markdown
<!-- conventions.md — SQLite 只读投影 -->
# Active Conventions

## User Stated (confidence 90-100)
- NEVER use console.log/error/warn (added: 2024-01-10)
- 中文回复，除非用户切换语言 (added: 2024-02-15)
- 测试用例设计时自动考虑边界条件（空值、最大值、最小值、异常值） (added: 2026-05-13)

## User Implied (confidence 70-89)
- 优先使用 find 确认路径再 read (confidence: 78)
- 不要自动修改测试文件格式 (confidence: 75)

## System Inferred (confidence 50-69)
- read 工具失败时优先检查路径参数 (confidence: 62)
- 测试用例设计时应自动覆盖边界条件 (confidence: 65)

## Negative Rules
- 不要使用 mock.module() (violation_count: 0)
- 不要等用户提醒才考虑边界条件 (confidence: 60)
```

---

## 四、Cognitive Pipeline（六阶段管道）

### 4.1 下次会话开始：完整管道执行

```
用户下次输入: "帮我写一个测试用例"
    │
    ▼
Stage 1: Query Analyzer
    输入: "帮我写一个测试用例" + 当前任务上下文
    输出: { 
        intent: "edit", 
        domain: "testing", 
        requiresEpisodic: false, 
        timeRange: "recent"
    }
    │
    ▼
Stage 2: Retrieval Orchestrator（并行 4 源查询，目标数 × 3 过检索）
    ├── Memory Retriever: MEMORY.md + vector top-K → 6 条候选 (composite_score >= 0.3)
    ├── Convention Retriever: 7 条 active conventions → 21 条候选 (3× 过检索)
    ├── Profile Retriever: user_profile 全量 → 1 条
    └── Episodic Retriever: session_id 作用域 → 3 条相关 error_context
    │
    ▼
Stage 3: Score Fusion
    composite_score = 0.50 × semantic + 0.30 × recency + 0.20 × importance
    │
    排序结果（前 15 条）:
    1. conv_test_boundary_001 (composite: 0.92)
    2. memory_summary (composite: 0.88)
    3. skill_test-case-design (composite: 0.85)
    4. conv_test_boundary_002 (composite: 0.78)
    5. profile (composite: 0.75)
    ...
    │
    ▼
Stage 4: Conflict Resolver
    ├── conv_test_boundary_001 vs conv_test_boundary_002: 语义相似度 0.72 (< 0.85) → 不重复，保留两者
    ├── memory_summary vs conv_test_boundary_001: 语义相似度 0.45 → 不重复
    ├── 无 negation sets 重叠 → 无矛盾
    └── 无 superseded 记录
    │
    ▼
Stage 5: Token Budget Allocator（编码任务动态调整）
    total: 8000 tokens
    allocations (coding task adjusted):
    ├── AGENTS.md: 2000 (固定)
    ├── memorySummary: 900 (10-15% → coding 调整 -0.10)
    ├── conventions: 1600 (10-20%)
    ├── skills: 1600 (10-20%)
    ├── profile: 1200 (5-15%)
    ├── episodic: 400 (5%)
    └── buffer: 300 (+0.10 coding 调整)
    │
    裁剪策略: 按 composite_score 降序截断，低于阈值的排除
    │
    ▼
Stage 6: System Prompt Injection（7 层优先级）
```

### 4.2 Virtual Sandbox（技能前瞻验证）

```
skill_test-case-design 被检索到候选技能
    │
    ▼
Virtual Sandbox 四项检查:
    ├── 时效性: last_success = 2026-05-13, half_life = 30天 → valid ✓
    ├── 适用域: skill.domain = "testing", task.domain = "testing" → match ✓
    ├── 不可变规则冲突: approach 不违反 immutable_rules ✓
    ├── 相关性: intent="edit", skill.taskPattern="add test cases" → semantic sim = 0.88 ✓
    │
    ▼
所有检查通过 → 进入 Score Fusion
```

### 4.3 Activity Monitor（活动监控输出）

```json
{
  "skillScoreTrend": {
    "scores": [0.72, 0.75, 0.78, 0.80, 0.82, 0.85, 0.88],
    "average": 0.83,
    "dateRange": { "start": "2026-05-06", "end": "2026-05-13" }
  },
  "conventionConfidenceTrend": {
    "declining": [],
    "stable": ["conv_test_boundary_001", "conv_test_boundary_002"]
  },
  "retrievalQuality": {
    "averageCompositeScore": 0.78,
    "trend": "stable"
  },
  "extractionStats": {
    "lastExtractionFactCount": 3,
    "consecutiveEmptyResults": 0
  },
  "writeSuccessRate": 1.0,
  "alerts": []
}
```

---

## 五、LLM 模型测评

### 5.1 模型评分数据

```sql
SELECT model_key, task_type, avg_success_rate, avg_efficiency_score, avg_tool_success_rate, avg_error_rate, sample_count
FROM evolution_model_scores
WHERE task_type = 'edit';

-- 结果:
-- claude-sonnet-4-20250514/edit: success=0.92, efficiency=0.85, tool_success=0.88, error=0.08, samples=42
-- gpt-4o/edit: success=0.85, efficiency=0.78, tool_success=0.82, error=0.12, samples=28
-- gpt-4o-mini/edit: success=0.78, efficiency=0.92, tool_success=0.75, error=0.18, samples=15
```

### 5.2 Model Router 决策

```
Query Analyzer 输出: intent = "edit"
    │
    ▼
Model Router:
    ├── 查找 edit 任务推荐模型: claude-sonnet-4-20250514 (model_score = 0.86)
    ├── 样本数 = 42 ≥ 5 (min_samples) ✓
    ├── 模型可用 ✓
    └── 输出: { selected_model: "claude-sonnet-4-20250514", fallback_model: "default-role" }
```

---

## 六、完整业务流 Mock

### 6.1 会话开始

```
┌─────────────────────────────────────────┐
│           用户启动新会话                 │
│  "帮我写一个测试用例"                   │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│     before_agent_start 动态注入          │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│  Cognitive Pipeline 六阶段执行                           │
│                                                          │
│  1. Query Analyzer → intent=edit, domain=testing         │
│  2. Retrieval Orchestrator → 4源并行检索                  │
│  3. Score Fusion → composite_score 排序                  │
│  4. Conflict Resolver → 无矛盾                           │
│  5. Token Budget → 8000 tokens 动态分配                   │
│  6. System Prompt Injection → 7层优先级装配               │
│                                                          │
│  + Virtual Sandbox 技能前瞻验证                            │
│  + Model Router 模型选择                                  │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         生成 System Prompt               │
└─────────────────────────────────────────┘
```

### 6.2 生成的 System Prompt（7 层注入结果）

```markdown
# Layer 1: AGENTS.md（强制规则，不可覆盖）
- NO console.log/error/warn — use pi-utils logger
- USE Bun.file().json() with isEnoent
- Shell: ast_grep > search > find
- Prompts: static .md files with Handlebars
- Private Fields: use # syntax

---

# Layer 2: Memory Summary（项目知识，10-25%）
OMP is a Bun/TS/Rust monorepo with strict AGENTS.md rules.
Config centralized at ~/.omp/agent/config.yml (YAML, no hot-reload).
Self-evolution uses 统一 SQLite + SQLite-vec with daily audit and 3-day fit evaluation.
Tool priority is prompt-gated; missing from system-prompt.md = invisible to agent.
Provider pitfalls: Qwen thinking mode rejects tool_choice required; Kimi has quota limits.

---

# Layer 3: Self-Evolution Conventions（用户偏好，10-20%）
- [user_stated/85] 测试用例设计时自动考虑边界条件（空值、最大值、最小值、异常值）
- [user_stated/60] 不要等用户提醒才考虑边界条件
- [user_implied/75] 不要自动修改测试文件格式
- [system_inferred/62] read 工具失败时优先检查路径参数

---

# Layer 4: Self-Evolution Skills（技能建议，10-20%）
## test-case-design (graduated, skill_score=0.85)
1. 明确输入范围和边界条件
2. 考虑异常情况（空值、越界、非法输入）
3. 使用等价类划分和边界值分析
4. 自动生成边界条件测试用例

---

# Layer 5: User Profile（5-15%）
- 工具偏好: read(420), bash(320), edit(151), search(140)
- 语言偏好: python, shell, typescript, json
- 意图分布: exploration(77), bugfix(37), optimization(12)

---

# Layer 6: Episodic Context（5%）
(requiresEpisodic=false, 不注入)

---

# Layer 7: Relevant Past Episodes（5-10%）
(无高相关性历史 episodes, relevance_score < 40, 不注入)
```

### 6.3 Agent 执行 + 反馈闭环

```
用户输入: "帮我写一个测试用例"
    │
    ▼
Agent 收到 System Prompt（包含 7 层注入结果）
    │
    ▼
Model Router 选择: claude-sonnet-4-20250514 (edit 任务最优)
    │
    ▼
Agent 自动考虑边界条件（受 Convention 驱动）:
    - 空值 (null, undefined)
    - 最大值 (Number.MAX_SAFE_INTEGER)
    - 最小值 (Number.MIN_SAFE_INTEGER)
    - 异常值 (NaN, Infinity)
    │
    ▼
Agent 生成测试用例:
    - test("should handle null input")
    - test("should handle MAX_SAFE_INTEGER")
    - test("should handle MIN_SAFE_INTEGER")
    - test("should handle NaN")
    - test("should handle Infinity")
    │
    ▼
用户反馈: "好的，这次考虑得很全面"
    │
    ▼
FeedbackTracker:
    ├── outcome_score += 0.1 (显式肯定)
    └── provenance = user_stated
    │
    ▼
更新 Convention:
    - conv_test_boundary_001 confidence: 85 → 95
    - timesApplied: 0 → 1
```

### 6.4 会话结束 → 后续异步处理

```
agent_end
    │
    ├──▶ Self-Evolution 实时提取:
    │   ├── Convention 提取（三层，无新 preference）
    │   ├── FeedbackTracker 更新（outcome_score）
    │   ├── TraceAnalyzer 诊断（无错误）
    │   └── SkillEvaluator 更新（test-case-design outcome += success）
    │
    ├──▶ Episodic Store:
    │   ├── markSessionEnded → TTL 倒计时启动
    │   ├── 高 importance records → 晋升到 Convention Store
    │   └── 低 importance records → 7 天后过期删除
    │
    ├──▶ Memory Phase 1 (异步，读取 .jsonl):
    │   ├── LLM 提取 → raw_memory + rollout_summary
    │   ├── (LLM 失败时 → 规则 fallback: 工具调用序列 + 错误模式)
    │   └──▶ embedding 生成 → Vector Store
    │
    ├──▶ Memory Phase 2 (异步):
    │   ├── 更新 MEMORY.md
    │   └── 更新 memory_summary.md
    │
    ├──▶ Memory Phase 3 (定期):
    │   ├── 合并相似记忆 (similarity > 0.85)
    │   ├── 衰减低重要性 (importance × 0.5^(d/90))
    │   └── 归档 superseded
    │
    ├──▶ Activity Monitor:
    │   ├── skill_score 趋势: 0.85 → 0.88 (上升)
    │   ├── convention 趋势: 稳定
    │   ├── retrieval quality: composite avg 0.78 → 0.82 (提升)
    │   └── 无告警触发
    │
    ├──▶ Model Evaluator:
    │   ├── session_model_stats 写入
    │   └── model_score 聚合更新
    │
    ▼
下次会话准备就绪
```

---

## 七、数据对比

### 7.1 V2 vs V2.1 关键差异

| 维度 | V2 | V2.1 | 变化 |
|------|-----|------|------|
| **Convention 提取** | Regex only | 三层（Regex + LLM Batch + Fallback） | +隐式偏好 |
| **Provenance** | 无 | 4 级分级（user_stated/implied/inferred/fallback） | +冲突裁决 |
| **反馈评分** | confidence += 5 / -= 10 | outcome_score ± 0.1/0.2 + 隐式信号 | +多维度 |
| **技能系统** | 两套独立（Memory + Evolution） | 单一 skill_population + graduated 投影 | +统一 |
| **向量检索** | 无 | SQLite-vec + composite scoring (0.5/0.3/0.2) | +语义检索 |
| **矛盾解决** | confidence_score 优先 | supersede + provenance 裁决 | +审计追踪 |
| **遗忘机制** | 无 | 指数衰减 + 阈值修剪 + 合并 | +生命周期 |
| **Episodic Store** | 无 | session 作用域 + TTL + 晋升 | +会话缓存 |
| **Virtual Sandbox** | 简单评分 | 前瞻验证（时效/域/冲突/相关性） | +4 维度 |
| **Activity Monitor** | fit score 趋势 | 5 维度监控 + 事件生成 | +可观测性 |
| **Model Router** | 静态 modelRoles | 任务感知路由 + 冷却期 | +动态 |
| **Memory fallback** | 无（LLM only） | 规则 fallback（LLM 失败时兜底） | +可靠性 |
| **存储** | JSONL + SQLite 双重 | 统一 SQLite + md 投影 + .jsonl 双写 | +一致性 |

### 7.2 核心价值验证

| 设计目标 | V2.1 Mock 结果 | 状态 |
|----------|---------------|------|
| Memory 长期沉淀 | MEMORY.md + vector 检索 | 实现 |
| Self-Evolution 实时提取 | 三层 Convention + provenance | 实现 |
| Episodic 会话缓存 | session 作用域 + TTL + 晋升 | 实现 |
| Cognitive Pipeline 协调 | 6 阶段 + Virtual Sandbox | 实现 |
| Token 预算控制 | 动态分配 + 任务类型调整 | 实现 |
| 反馈闭环 | 多维度 outcome + 隐式信号 | 实现 |
| 矛盾解决 | provenance 裁决 + supersede | 实现 |
| 遗忘机制 | 衰减 + 淘汰 + 合并 | 实现 |
| Model Router | 任务感知 + 冷却期 | 实现 |