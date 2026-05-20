# OMP 进化架构 V2：Memory × Self-Evolution × Cognitive-Coordination

## 核心设计原则

> **Memory = 长期记忆库（异步、静态、项目级）**
> **Self-Evolution = 实时进化引擎（同步、动态、用户级）**
> **Cognitive-Coordination = 认知协调层（桥接、调度、优化）**

---

## 一、三层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent Session                         │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │  User Input   │───▶│  Agent Core   │───▶│  Agent Output│ │
│  └──────────────┘    └──────────────┘    └──────────────┘ │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Cognitive-Coordination（认知协调层）              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              Context Assembler（上下文装配器）           │  │
│  │  - 统一 Memory / Self-Evolution / User Profile        │  │
│  │  - Token 预算分配                                        │  │
│  │  - 优先级排序                                          │  │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           Unified Skill Registry（统一技能注册表）       │  │
│  │  - 加载 Memory skills/（长期沉淀）                      │  │
│  │  - 加载 Self-Evolution skills/（实时提取）              │  │
│  │  - 冲突解决（confidence_score 优先）                    │  │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           Activity Monitor（活动监控器）                │  │
│  │  - Fit Score 趋势分析                                    │  │
│  │  - Skill 衰退检测                                        │  │
│  │  - 错误率监控                                          │  │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           Virtual Sandbox（虚拟沙盒）                   │  │
│  │  - Skill 有效性验证                                      │  │
│  │  - 相关性评分                                            │  │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           Convention Miner（隐式规范挖掘）              │  │
│  │  - 从 Session Log 挖掘用户否定指令                      │  │
│  │  - 生成隐式 Convention                                   │  │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
        ▼                        ▼                        ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│  Memory  │ │ Self-    │ │   User   │
│（长期）   │ │Evolution │ │ Profile  │
└──────────┘ └──────────┘ └──────────┘
```

---

## 二、Memory 模块（长期记忆库）

### 2.1 职责边界

**Memory 只做**：
- ✅ 跨会话知识整合（Phase 2）
- ✅ 长期技能沉淀（skills/）
- ✅ 项目架构记忆（MEMORY.md）
- ✅ 异步后台处理（定时任务）

**Memory 不做**：
- ❌ 实时用户偏好提取
- ❌ 即时反馈闭环
- ❌ 会话级诊断
- ❌ 动态规范注入

### 2.2 数据流

```
.jsonl 会话日志
    │
    ▼
Phase 1: 会话级提取（异步）
    │
    ├──▶ raw_memory（技术决策、失败修复、工作流）
    └──▶ rollout_summary（紧凑摘要）
    │
    ▼
Phase 2: 跨会话整合（异步）
    │
    ├──▶ MEMORY.md（项目长期记忆）
    ├──▶ memory_summary.md（注入系统提示）
    └──▶ skills/（可复用技能手册）
```

### 2.3 输出格式

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
- Storage: SQLite+FTS5
- Scheduled Tasks: evolution-audit, evolution-fit
```

---

## 三、Self-Evolution 模块（实时进化引擎）

### 3.1 职责边界

**Self-Evolution 只做 Memory 未覆盖的实时能力**：

| 功能 | 优先级 | 说明 | Memory 是否覆盖 |
|------|--------|------|----------------|
| **实时用户偏好提取** | P0 | "我希望..." → Convention | ❌ 未覆盖 |
| **即时反馈闭环** | P0 | "好的"/"不对" → 调整 confidence | ❌ 未覆盖 |
| **会话级诊断** | P0 | TraceAnalyzer → 生成 convention | ❌ 未覆盖 |
| **实时规范注入** | P0 | before_agent_start 动态注入 | ❌ 未覆盖 |
| **效果追踪** | P1 | timesApplied, timesViolated | ❌ 未覆盖 |
| **跨会话提醒** | P1 | 基于历史错误的 nudge | ❌ 未覆盖 |
| **用户画像更新** | P1 | toolFrequency, intentDistribution | ❌ 未覆盖 |

**Self-Evolution 不再做（Memory 已实现）**：
- ❌ 跨会话知识整合 → Memory Phase 2
- ❌ 长期技能沉淀 → Memory skills/
- ❌ 异步后台处理 → Memory 定时任务

### 3.2 实时提取流程

```
┌─────────────────────────────────────────┐
│           Agent 会话结束                 │
│              (agent_end)                │
└─────────────────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   Preference Extractor │
        │  （实时提取用户偏好）    │
        └───────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
   ┌────────┐  ┌────────┐  ┌────────┐
   │Regex   │  │LLM     │  │Diagnosis│
   │匹配    │  │分析    │  │驱动    │
   │"我希望"│  │语义    │  │提取    │
   └────────┘  └────────┘  └────────┘
        │           │           │
        └───────────┼───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │     Convention Store    │
        │   （SQLite 实时存储）    │
        └───────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   before_agent_start    │
        │  （动态注入系统提示）     │
        └───────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │      下次会话立即生效   │
        └───────────────────────┘
```

### 3.3 提取内容

#### 3.3.1 用户偏好（User Preference）

**触发条件**：用户表达愿望、偏好、要求

| 类型 | 匹配模式 | 示例 | 提取方式 |
|------|----------|------|----------|
| preference | "我希望..." / "I hope..." | "我希望测试用例设计时考虑边界" | Regex + LLM |
| preference | "我想要..." / "I want..." | "我想要看到更多日志" | Regex + LLM |
| preference | "Prefer..." / "应该使用..." | "Prefer ast_grep over search" | Regex |
| negative_rule | "不要..." / "Never..." | "不要启动 plan 模式" | Regex + LLM |
| negative_rule | "避免..." / "Avoid..." | "避免使用 console.log" | Regex |
| procedural_rule | "先...再..." / "First..." | "先检查文件存在再读取" | Regex |

#### 3.3.2 即时反馈（Instant Feedback）

**触发条件**：用户对结果的评价

| 用户表达 | 类型 | 操作 |
|----------|------|------|
| "好的" / "OK" / "可以" | positive | confidence += 5 |
| "不对" / "错了" / "不是" | negative | confidence -= 10 |
| "不要这样" / "换一种" | negative | 新增 negative_rule |
| "记住这个" / "以后这样" | preference | 新增 preference |

#### 3.3.3 诊断驱动提取（Diagnosis-Driven）

**触发条件**：TraceAnalyzer 诊断结果

| 诊断项 | 生成的 Convention | 类型 |
|--------|-------------------|------|
| readFailures | "Use find or search to confirm path exists before read" | negative_rule |
| cascadePatterns | "When tool fails, analyze root cause before retry" | procedural_rule |
| redundantSearches | "Prefer ast_grep or find over repeated text searches" | preference |
| slowLoop | "Re-evaluate approach if multiple tool calls produce no modifications" | preference |

### 3.4 反馈闭环

```
┌─────────────────────────────────────────┐
│           Convention 生命周期            │
└─────────────────────────────────────────┘
                    │
        ┌────────.includes("avoid");

    let scoreDelta = 0;
    let reason = "";

    if (relevanceScore > 0.1) {
        if (hasErrors && mentionsFix) {
            scoreDelta = 0.15;
            reason = "Skill addresses errors found in session log.";
        } else if (!hasErrors) {
            scoreDelta = 0.05;
            reason = "Skill is relevant to successful session.";
        } else {
            scoreDelta = -0.05;
            reason = "Skill relevant but session failed.";
        }
    } else {
        scoreDelta = -0.02;
        reason = "Skill not relevant to recent activity.";
    }

    return { skillId: skill.id, scoreDelta, reason, passed: scoreDelta >= 0 };
}
```

### 4.6 Convention Miner（隐式规范挖掘）

```typescript
// 从 Session Log 挖掘隐式规范
export async function mineImplicitConventions(sessionLogPath: string): Promise<ImplicitConvention[]> {
    const conventions: ImplicitConvention[] = [];
    const entries = await parseSessionLog(sessionLogPath);

    // 过滤用户消息
    const userMessages = entries.filter(entry => entry.type === "user_message");

    for (const entry of userMessages) {
        const content = entry.content;
        if (!content) continue;

        // 检查否定关键词
        const matchResult = getBestMatchingKeyword(content);
        if (!matchResult) continue;

        // 提取包含关键词的句子
        const sentence = extractSentence(content, matchResult.keyword);

        // 过滤 false positive
        if (isFalsePositive(sentence)) continue;

        // 跳过过短的句子
        if (sentence.length < 15) continue;

        conventions.push({
            rule: sentence,
            sourceSessionId: sessionLogPath,
            confidence: matchResult.weight,
        });
    }

    return conventions;
}

// 否定关键词库
const NEGATIVE_KEYWORDS = [
    { keyword: "never", weight: 1.0 },
    { keyword: "don't ever", weight: 0.95 },
    { keyword: "must not", weight: 0.9 },
    { keyword: "stop using", weight: 0.85 },
    { keyword: "avoid using", weight: 0.8 },
    { keyword: "don't use", weight: 0.7 },
    { keyword: "never use", weight: 0.8 },
    { keyword: "stop", weight: 0.6 },
    { keyword: "avoid", weight: 0.6 },
    { keyword: "don't", weight: 0.5 },
    { keyword: "do not", weight: 0.5 },
    { keyword: "no", weight: 0.4 },
];

// False Positive 过滤
const FALSE_POSITIVE_PATTERNS = [
    /don't worry/i,
    /don't know/i,
    /don't understand/i,
    /don't think/i,
    /don't want/i,
    /don't have/i,
    /never mind/i,
    /it's not/i,
    /that's not/i,
];
```

---

## 五、三层协作数据流

### 5.1 完整数据流

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent Session                         │
│                                                              │
│  User Input ──▶ Agent Core ──▶ Agent Output                  │
│                    │                                         │
└────────────────────┼────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Cognitive-Coordination（协调层）                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Context Assembler                                      │ │
│  │  - 读取 Memory summary（静态）                          │ │
│  │  - 读取 Self-Evolution conventions（动态）             │ │
│  │  - 读取 User Profile（动态）                           │ │
│  │  - Token 预算分配                                      │ │
│  │  - 优先级排序                                          │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Unified Skill Registry                                 │ │
│  │  - 加载 Memory skills/（长期沉淀）                     │ │
│  │  - 加载 Self-Evolution skills/（实时提取）            │ │
│  │  - 冲突解决（confidence_score 优先）                   │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Activity Monitor                                       │ │
│  │  - 分析 Fit Score 趋势                                 │ │
│  │  - 检测 Skill 衰退                                     │ │
│  │  - 监控错误率                                          │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│  Memory  │ │ Self-    │ │  User    │
│（长期）   │ │Evolution │ │ Profile  │
└──────────┘ └──────────┘ └──────────┘
```

### 5.2 注入优先级

```
System Prompt 注入优先级：

1. AGENTS.md（最高优先级，强制规则）
   └── 不可覆盖

2. Memory summary（项目知识，静态）
   └── 技术决策、架构、规则
   └── 更新频率：低（每次启动时）

3. Self-Evolution conventions（用户偏好，动态）
   └── 用户偏好、否定规则、步骤规范
   └── 更新频率：高（每次会话结束）
   └── 过滤条件：confidence >= 60

4. Self-Evolution skills（技能建议，动态）
   └── 操作手册、最佳实践
   └── 更新频率：中（复杂任务后）
   └── 过滤条件：confidence >= 30

5. User Profile（用户画像，动态）
   └── 工具偏好、语言偏好、意图分布
   └── 更新频率：高（每次会话结束）
```

---

## 六、实施路线图

### Phase 1：清理重复功能（Week 1）

- [ ] **Self-Evolution**：移除 LLM 提取（SkillExtractor.#llmRefine）
- [ ] **Self-Evolution**：移除长期技能沉淀（改为读取 Memory skills/）
- [ ] **Self-Evolution**：移除异步后台任务（依赖 Memory 定时任务）

### Phase 2：强化实时能力（Week 2-3）

- [ ] **Self-Evolution**：增强 PreferenceExtractor（增加"我希望..."匹配）
- [ ] **Self-Evolution**：增强 FeedbackDetector（识别"好的"/"不对"）
- [ ] **Self-Evolution**：优化 Convention 注入逻辑（高置信度优先）

### Phase 3：Cognitive-Coordination 上线（Week 4）

- [ ] **Context Assembler**：实现统一上下文装配
- [ ] **Unified Skill Registry**：实现技能合并与冲突解决
- [ ] **Activity Monitor**：实现活动趋势分析
- [ ] **Virtual Sandbox**：实现技能有效性验证
- [ ] **Convention Miner**：实现隐式规范挖掘

### Phase 4：打通协作（Week 5）

- [ ] **Memory**：Phase 2 整合 Self-Evolution 的 User Profile
- [ ] **Self-Evolution**：读取 Memory 的 summary
- [ ] **Cognitive-Coordination**：统一注入优先级

---

## 七、总结

### 三层职责清晰化

| 维度 | Memory | Self-Evolution | Cognitive-Coordination |
|------|--------|----------------|------------------------|
| **时间** | 长期 | 实时 | 实时 |
| **空间** | 项目级 | 用户级 | 协调级 |
| **方式** | 异步 | 同步 | 同步 |
| **内容** | 技术知识 | 用户偏好 | 统一视图 |
| **目标** | 知识沉淀 | 行为进化 | 智能调度 |

### 核心价值

1. **Memory**：提供稳定的项目知识基础
2. **Self-Evolution**：实时响应用户偏好，快速进化
3. **Cognitive-Coordination**：智能协调两者，优化上下文注入

### 最终目标

```
用户说："我希望测试用例设计时考虑边界"
        │
        ▼
Self-Evolution 实时提取 ──▶ Convention Store
        │
        ▼
Cognitive-Coordination 协调注入
        │
        ├──▶ Memory summary（静态知识）
        ├──▶ Self-Evolution conventions（动态偏好）
        └──▶ User Profile（用户画像）
        │
        ▼
Context Assembler 统一装配
        │
        ▼
System Prompt 注入
        │
        ▼
下次会话立即生效
        │
        ▼
用户说："好的"
        │
        ▼
Feedback Detector 标记 Convention 有效
        │
        ▼
Memory Phase 2 整合为长期知识
```
