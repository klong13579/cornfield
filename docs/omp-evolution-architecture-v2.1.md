# OMP 进化架构 V2.1：Memory × Self-Evolution × Cognitive Pipeline

---

## 1. 核心设计原则

```
Memory          = 长期语义记忆库（异步、静态、项目级）
Self-Evolution  = 实时进化引擎（同步、动态、用户级）
Cognitive       = 认知协调管道（检索 → 融合 → 冲突 → 预算 → 注入）
Pipeline
Episodic        = 会话级缓存（短期、任务级、自动晋升/过期）
```

记忆系统解决两个正交问题，两者缺一不可：
- **Context Engineering**：在正确的时间把正确的内容放到上下文窗口 → 管道设计问题
- **Knowledge Lifecycle**：保持被传递的信息准确、新鲜、非矛盾 → 信息质量问题

底层信息错误时，更好的上下文工程只是更高效地传递错误信息。

---

## 2. 架构总览

### 2.1 四层模型

```
┌──────────────────────────────────────────────────────────────┐
│                        Agent Session                          │
│  User Input → Agent Core → Agent Output → Session Log (.jsonl)│
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                   Cognitive Pipeline（协调层）                  │
│                                                               │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐               │
│  │ Query    │─▶│ Retrieval    │─▶│ Score     │               │
│  │ Analyzer │  │ Orchestrator │  │ Fusion    │               │
│  └──────────┘  └──────────────┘  └─────┬────┘               │
│                                       │                      │
│  ┌──────────────┐  ┌──────────────────┴─────┐               │
│  │ Conflict     │─▶│ Token Budget Allocator  │               │
│  │ Resolver     │  │                         │               │
│  └──────────────┘  └─────┬───────────────────┘               │
│                          │                                    │
│               ┌──────────┴──────────┐                        │
│               │ System Prompt       │                        │
│               │ Injection           │                        │
│               └─────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
       │                │                │
       ▼                ▼                ▼
┌────────────┐  ┌───────────────┐  ┌──────────────┐
│  Memory    │  │ Self-Evolution│  │  User Profile │
│ (长期存储) │  │ (实时进化)     │  │  (用户画像)   │
│            │  │               │  │               │
│ • Vector DB│  │ • Convention  │  │ • Tool Stats │
│ • MEMORY.md│  │   Miner       │  │ • Intent Dist │
│ • skills/  │  │ • Nudge Engine│  │ • Role/Style │
│ • raw_mem  │  │ • Feedback    │  │ • Constraints│
│ • summaries│  │   Tracker     │  │              │
│            │  │ • Activity    │  │ • user_profile│
│            │  │   Monitor     │  │   .md        │
│            │  │ • Virtual     │  │              │
│            │  │   Sandbox     │  │              │
│            │  │ • conventions │  │              │
│            │  │   .md         │  │              │
│            │  │ • evolution_  │  │              │
│            │  │   log.md      │  │              │
      │             │
      ▼             ▼
┌──────────────────────────────────────────────────────────────┐
│              Episodic Store（会话级缓存）                       │
│                                                               │
│  Hot: Redis (optional) — active session context               │
│  Cold: SQLite — completed session archive, TTL expired        │
│  • Session-scoped context (session_id)                        │
│  • Tool chain state, intermediate decisions                   │
│  • Auto-promotion: relevant → Memory / Self-Evolution         │
│  • Auto-expiry: session end + TTL (default 7 days)            │
│  • Resume support: 中断任务恢复                                │
│  • Backend abstraction: EpisodicBackend interface             │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 四层职责

| 层级 | 类比 | 寿命 | 内容 | 管理 |
|------|------|------|------|------|
| **Conversation** | 感觉记忆 | 单轮 | 工具输出、中间推理 | Agent 自身，不持久化 |
| **Episodic** | 情景记忆 | 分钟~天 | 任务进度、工具链状态、失败模式 | TTL 过期 + 晋升 |
| **Semantic** | 语义记忆 | 周~永久 | 项目知识、用户偏好、技能 | Memory + Self-Evolution |
| **Organizational** | 集体记忆 | 永久 | 团队规范、共享上下文 | Memory skills/ |

### 2.3 模块合约总览

| 模块 | 提供（对外承诺） | 依赖（对内要求） |
|------|-----------------|-----------------|
| **Memory** | 跨会话项目知识（MEMORY.md + 向量检索 top-K） | .jsonl 日志输入、SQLite-vec 存储 |
| **Episodic Store** | 会话级上下文（session_id 作用域）、恢复支持 | Agent event hooks、SQLite/Redis 后端 |
| **Self-Evolution** | 实时约定注入、技能建议、反馈闭环 | SessionTrace 输入、SQLite 存储 |
| **Convention Miner** | 隐式规范挖掘（否定指令 + 行为模式） | Session Log + TraceRecorder 输入 |
| **Activity Monitor** | 衰退预警 + 可观测性事件 | skill_population + conventions + retrieval 数据 |
| **Virtual Sandbox** | 技能前瞻验证（时效性 + 适用域 + 不可变规则冲突） | Skill Population 数据、当前任务 intent/domain |
| **Cognitive Pipeline** | 装配完成的 system prompt（Token 预算内） | Memory + Self-Evolution + Profile + Episodic 的检索结果 |
| **Model Router** | 任务感知的最优模型选择 | evolution_model_scores 数据、Query Analyzer 输出 |

---

## 3. 统一存储架构

### 3.1 存储拓扑

单一 SQLite 数据库文件（`~/.omp/data/omp.sqlite`），所有模块共享，通过表前缀命名空间实现逻辑隔离。md 文件为 SQLite 的只读投影。

```
~/.omp/
├── data/
│   └── omp.sqlite              ← 单一数据库，WAL 模式
│       ├── memory_*            （Memory 模块）
│       │   ├── threads          — 会话线程元数据
│       │   ├── stage1_outputs   — Phase 1 提取结果
│       │   ├── stage1_embeddings — 向量表示（SQLite-vec）
│       │   ├── jobs             — 后台任务队列
│       │   └── memory_lifecycle  — 生命周期元数据
│       │
│       ├── evolution_*         （Self-Evolution 模块）
│       │   ├── conventions      — 用户约定（content, confidence, provenance）
│       │   ├── nudge_rules      — 跨会话提醒规则
│       │   ├── feedback_log     — 反馈事件记录
│       │   ├── skill_population  — 技能种群评分
│       │   ├── model_scores     — 模型性能评分
│       │   ├── session_model_stats — 单会话模型表现原始数据
│       │   ├── model_recommendations — 模型推荐缓存
│       │   └── user_profile     — 画像统计（滚动窗口 30 天）
│       │
│       ├── episodic_*          （Episodic Store）
│       │   └── session_records  — 会话级上下文
│       │
│       └── vec_*               （Vector Store，共享基础设施）
│           └── embeddings       — raw_memory + rollout_summary + conventions
│
├── logs/                      ← .jsonl 会话日志（双写：Agent Session 实时写入）
│   └── omp.YYYY-MM-DD.log      — 全量原始：完整对话、工具输出、CoT、LLM payload
│
├── memory/                     （Memory 人类可读投影）
│   ├── MEMORY.md               — 项目长期记忆
│   └── memory_summary.md       — 注入系统提示的精简版
│
├── self-evolution/                  （Self-Evolution 人类可读投影）
│   ├── skill_population/       — 技能手册（skills/<name>.md，graduated 投影）
│   ├── conventions.md          — 当前活跃约定（SQLite 只读投影）
│   ├── evolution_log.md        — 变更审计时间线（只读）
│   └── user_profile.md         — 用户画像摘要
│
└── archives/                   （历史追溯）
    └── superseded/             — 被覆盖的旧记录
```

### 3.2 写入策略

- **SQLite 为结构化数据唯一写入入口**。所有模块的 CRUD 操作通过各自的 Repository 层访问对应命名空间表。
- **.jsonl 为全量原始数据双写**。Agent Session 运行期间实时写入 .jsonl 日志文件（`~/.omp/logs/omp.YYYY-MM-DD.log`），同时由 TraceRecorder/Episodic Store 写入 SQLite 结构化子集。.jsonl 保留完整对话、工具输出、CoT、LLM payload，供 Memory Phase 1 异步读取。
- **md 文件为只读投影**，定时从 SQLite 生成。
- **用户编辑 md 文件** = 反向导入到 SQLite（类似 MEMORY.md 手动修正机制）。
- **模块隔离**：Memory 只访问 `memory_*`，Self-Evolution 只访问 `evolution_*`，Vector Store 为共享基础设施。
- **.jsonl 与 SQLite 的数据关系**：.jsonl 是全量原始记录（Conversation 层），SQLite episodic_session_records 是结构化子集（Episodic 层）。两者数据粒度不同、消费者不同、不互为备份。

### 3.3 状态机：存储一致性

```
SQLite (主) ──定时投影──▶ md (投影)
md (用户编辑) ──反向导入──▶ SQLite (主)

冲突检测：
  SQLite 时间戳 vs md 修改时间 → 如果 md 更新且 SQLite 未同步 → 触发反向导入
  SQLite 更新且 md 未重新生成 → 下次投影周期自动覆盖 md
```

---

## 4. Memory 模块

### 4.1 职责边界

| Memory 做 | Memory 不做 |
|-----------|------------|
| 跨会话知识整合（Phase 2 consolidation） | 实时用户偏好提取 → Self-Evolution |
| 项目架构记忆（MEMORY.md） | 会话级上下文管理 → Episodic Store |
| 异步后台处理（定时任务） | 冲突仲裁 → Cognitive Pipeline |
| 向量语义检索（SQLite-vec） | 技能选择偏置 → Self-Evolution |

### 4.2 数据流

Agent Session 运行期间双写：实时写入 .jsonl 日志文件（全量原始数据），同时由 TraceRecorder/Episodic Store 写入 SQLite（结构化子集）。Memory Phase 1 从 .jsonl 读取（全量上下文，保留完整对话和工具输出），Self-Evolution 从 TraceRecorder 内存结构实时提取。

| 数据源 | 写入者 | 数据粒度 | 消费者 |
|--------|-------|---------|--------|
| .jsonl 日志文件 | Agent Session（实时） | 全量原始：完整对话、工具输出、CoT、LLM payload | Memory Phase 1（异步提取） |
| Episodic Store SQLite | TraceRecorder / Episodic Store（实时） | 结构化子集：tool_chain, error_context, decision | Self-Evolution 实时提取 + Cognitive Pipeline 检索 |

```
.jsonl 会话日志（全量原始）
    │
    ▼
Phase 1: 会话级提取（异步，读取 .jsonl）
    │
    ├──▶ raw_memory（技术决策、失败修复、工作流）
    │    └──▶ 生成 embedding → Vector Store
    │
    └──▶ rollout_summary（紧凑摘要）
         └──▶ 生成 embedding → Vector Store
    │
    ▼
Phase 2: 跨会话整合（异步）
    │
    ├──▶ MEMORY.md（项目长期记忆）
    └──▶ memory_summary.md（注入系统提示）
    │
    （技能不再通过 Memory Phase 2 产出，改为 Self-Evolution skill_population 统一存储 + md 投影）
    │
    ▼
Phase 3: 生命周期管理（定期）
    │
    ├──▶ 合并相似记忆（similarity > 0.85）
    ├──▶ 衰减低重要性记忆（importance × 0.5^(days/90)）
    ├──▶ 修剪低于阈值的记忆（importance < 0.05）
    └──▶ 归档被 supersede 的旧记录
```

### 4.3 输出格式

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

## Superseded Records
- [2024-01-15] ~~Config: settings.json~~ → migrated to config.yml
```

### 4.4 模块合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| `MEMORY.md` 始终反映最新 Phase 2 整合结果 | Phase 2 完成后自动更新 | 检查文件修改时间 ≥ 最后 Phase 2 运行时间 |
| `memory_summary.md` 可直接注入系统提示 | 内容 ≤ Token 预算、格式为 markdown | Token 计数 ≤ 配置的 memorySummary 预算 |
| 向量检索返回 top-K 且 `composite_score ≥ 0.3` | 检索质量有下限 | 查询后所有返回项的 composite_score ≥ 0.3 |
| raw_memory 无语义重复（similarity < 0.85） | Phase 3 合并保证 | 对任意两条 raw_memory 计算相似度 < 0.85 |
| supersede 记录保留审计追踪 | 不删除，只标记 | superseded 记录仍在 archives/ 中可查 |

### 4.5 状态机：Memory 记录生命周期

```
[Extracted] ──Phase 1──▶ [Active]
                           │
              ┌────────────┤
              │            │
      similarity > 0.85    importance × 0.5^(d/90) < 0.05
              │            │
              ▼            ▼
         [Merged]      [Pruned]（删除）
              │
     provenance conflict
              │
              ▼
         [Superseded]（归档到 archives/，保留审计追踪）
```

---

## 5. Episodic Store 模块

### 5.1 职责边界

| Episodic 做 | Episodic 不做 |
|-------------|--------------|
| 会话级上下文缓存（session_id 作用域） | 跨会话知识整合 → Memory |
| 中断任务恢复 | 长期约定存储 → Self-Evolution |
| 自动晋升/过期 | 向量存储管理 → Memory Vector Store |

### 5.2 数据模型

```typescript
interface EpisodicRecord {
    id: string;
    sessionId: string;
    scope: "task_progress" | "tool_chain" | "decision" | "error_context";
    content: string;
    embedding?: Float32Array;  // 语义检索
    importance: number;         // 0~1，初始值由提取时评估
    createdAt: number;
    lastAccessed: number;
    promotedTo?: "memory" | "convention" | "skill";  // 晋升目标
    expiresAt: number;          // TTL 过期时间
}
```

### 5.3 生命周期事件

| 事件 | 操作 |
|------|------|
| 会话开始 | 检查未过期的 episodic records → 恢复上下文 |
| 会话进行中 | 实时写入 tool_chain / error_context 记录 |
| 会话结束 | 标记所有 records 为 "pending review"，启动 TTL 倒计时 |
| TTL 到期（7 天） | 低 importance 删除；高 importance 触发晋升到 Memory/Self-Evolution |
| 用户手动清理 | 删除指定 session 的所有 records |

### 5.4 存储后端

| 实现 | 适用场景 | 特点 |
|------|---------|------|
| **SQLite**（默认） | 单进程 CLI | 零运维、单文件、串行会话足够 |
| **Redis**（可选） | 多进程 daemon、高吞吐会话 | 分布式锁、pub/sub nudge 广播、内存读写 |

```
Hot (Redis, optional):                  Cold (SQLite, always):
├── active_session_context               ├── completed_session_archive
├── tool_chain_state (当前会话)           ├── episodic_records (TTL expired)
├── real-time feedback                   └── promoted_to_memory records
└── nudge pub/sub channel

Session 结束 → 异步 flush Redis → SQLite archive
Redis key TTL = Episodic TTL（默认 7 天），天然实现过期清理
```

### 5.5 EpisodicBackend 接口

```typescript
interface EpisodicBackend {
    // 当前会话操作
    write(sessionId: string, record: EpisodicRecord): Promise<void>;
    query(sessionId: string, scope?: string): Promise<EpisodicRecord[]>;
    // 会话生命周期
    markSessionEnded(sessionId: string): Promise<void>;
    promote(recordId: string, target: "memory" | "convention" | "skill"): Promise<void>;
    // 跨会话检索
    search(query: string, options?: { limit?: number }): Promise<EpisodicRecord[]>;
}
```

### 5.6 模块合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| 会话结束时所有 records 标记 "pending review" | 不遗漏 | `markSessionEnded` 后所有 records 状态 = pending |
| TTL 到期后低 importance 删除、高 importance 晋升 | 自动流转 | 检查 TTL 到期 records：importance < 0.3 的不存在；importance ≥ 0.7 的有 promotedTo 标记 |
| 恢复支持：新会话可加载历史 session 上下文 | 不丢失 | 新会话启动后 `query(prevSessionId)` 返回非空且未过期 |
| SQLite 默认实现零外部依赖 | 可替代 | 无 Redis 依赖时，所有操作通过 SQLite 完成 |
| Redis 实现可选，不影响核心功能 | 可选 | Redis 不可用时自动降级到 SQLite |

### 5.7 状态机：Episodic Record

```
[Created] ──写入──▶ [Active]
                       │
            ┌──────────┤──────────┐
            │          │          │
    session_end    TTL 到期    importance ≥ 0.7
            │          │          │
            ▼          ▼          ▼
   [Pending Review] [Expired]  [Promoted]
            │          │          │
    低 importance    删除      晋升到 Memory/
    → 删除                      Self-Evolution
    高 importance
    → 晋升
```

---

## 6. Self-Evolution 模块

### 6.1 职责边界

| 功能 | 优先级 | Memory 是否覆盖 |
|------|--------|----------------|
| 实时用户偏好提取 | P0 | No |
| 即时反馈闭环 | P0 | No |
| 会话级诊断提取 | P0 | No |
| 实时规范注入 | P0 | No |
| **Convention Miner（隐式规范挖掘）** | P0 | No |
| 效果追踪 | P1 | No |
| 跨会话提醒（nudge） | P1 | No |
| 技能种群进化 | P1 | No |
| **Activity Monitor（活动监控）** | P1 | No |
| **Virtual Sandbox（虚拟沙盒）** | P1 | No |
| 用户画像更新 | P1 | No |
| 安全快照 | P1 | No |
Self-Evolution 不做：跨会话知识整合 → Memory Phase 2；异步后台处理 → Memory 定时任务；向量存储管理 → Memory Vector Store。

### 6.2 Convention 提取：三层机制

```
User Message / Session Log
    │
    ▼
┌─────────────────────────────────────┐
│ Layer 1: Heuristic Rules (60-70%)   │
│ - Regex 模式匹配                     │
│ - 否定关键词过滤                      │
│ - 快速、稳定、零成本                  │
└──────────────┬──────────────────────┘
               │ 未匹配的进入 Layer 2
               ▼
┌─────────────────────────────────────┐
│ Layer 2: LLM Batch Extraction       │
│ - 累积 10 轮或 50KB 后批量提取       │
│ - 语义理解复杂偏好和隐式规则          │
│ - provenance: inferred              │
└──────────────┬──────────────────────┘
               │ 仍无结果的进入 Layer 3
               ▼
┌─────────────────────────────────────┐
│ Layer 3: Fallback Rules             │
│ - 更宽松的匹配规则                   │
│ - 低置信度（confidence 40-50）       │
│ - 检索时自动降权                     │
└─────────────────────────────────────┘
```

### 6.3 Provenance 分级

每条 Convention / Memory 必须标注来源可信度。冲突时高 provenance 优先于低 provenance，同 provenance 时新者优先。

| Provenance | 置信度基准 | 示例 | 冲突优先级 |
|-----------|-----------|------|-----------|
| **user_stated** | 90-100 | "请记住：不要使用 console.log" | 最高 |
| **user_implied** | 70-89 | 用户多次纠正同一行为推断出的规则 | 中 |
| **system_inferred** | 50-69 | TraceAnalyzer 诊断结果 | 低 |
| **system_fallback** | 30-49 | Layer 3 fallback rules | 最低 |


### 6.4 Convention Miner（隐式规范挖掘）

Convention Miner 是 V2 Cognitive-Coordination 层的显式组件，V2.1 将其功能吸收进 Self-Evolution 三层提取机制并增强为隐式信号挖掘。

**职责**：从 Session Log 和 TraceRecorder 中挖掘用户未显式表达但行为上反复体现的规范。

#### 挖掘维度

| 输入源 | 挖掘目标 | 输出产物 | provenance |
|--------|---------|---------|-----------|
| Session Log 中的否定关键词（"never", "avoid", "don't use"） | 显式否定指令 | negative_rule convention | user_stated |
| Session Log 中的否定关键词但含 false positive（"don't worry", "never mind"） | 误触发过滤 | 过滤掉，不生成 convention | — |
| TraceRecorder 检测到同一工具连续失败 ≥ 3 次 | 工具链失败模式 | procedural_rule convention | system_inferred |
| TraceRecorder 检测到用户重复相同请求 ≥ 2 次 | Agent 能力不足 | 触发技能变异生成 | system_inferred |
| 用户手动撤销修改（edit 后紧跟 revert） | Agent 操作被否定 | negative_rule convention | user_implied |
| 用户跳过 Agent 推荐步骤 | 操作偏好 | 工具链优化建议 | user_implied |

#### 否定关键词库

```typescript
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

#### 与三层提取的关系

Convention Miner 的否定关键词挖掘 = §6.2 Layer 1 Heuristic Rules 的 Regex 模式匹配 + 否定关键词过滤。隐式信号挖掘（连续失败、重复请求、手动撤销） = §6.7 隐式信号提取表。Convention Miner 作为显式组件名保留，统一入口为三层提取管道的 Layer 1。


### 6.5 技能种群进化

所有技能统一存储在 `skill_population` SQLite 表中，不再维护两套技能系统。通过生命周期状态区分阶段：

```
孵化中（新技能） → 评估中（有 outcome 数据） → 稳定（skill_score > 0.7） → 已毕业
                                              ↓
                                           淘汰（skill_score < 0.35）

skills/<name>.md = skill_population 表中 graduated 技能的 md 投影（只读）
```

每次技能执行产生两个信号：
1. **Outcome** — 任务是否成功（用户接受 / 测试通过 / 报错）
2. **Cost** — Token 消耗 + 执行时间 vs 同类技能中位数

#### 评分公式

```
skill_score = 0.70 × outcome_rate
            + 0.20 × efficiency_ratio
            + 0.10 × recency_decay
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| outcome_rate | 成功率（成功次数 / 总调用次数） | — |
| efficiency_ratio | 效率比（中位数成本 / 本次成本，上限 1.0） | — |
| recency_decay | 近因衰减（0.5^(days/30)） | half_life = 30 天 |

#### 进化规则

| 规则 | 触发条件 | 操作 |
|------|---------|------|
| 选择偏置 | 检索相关技能时 | 按 skill_score 降权排序 |
| 变异生成 | 特定场景连续失败 ≥ 3 次 | 合成变体（修改 approach），并行测试 |
| 自动淘汰 | skill_score < 0.35 持续 3 个评估窗口 | 标记 deprecated，不再注入 |
| 毕业 | skill_score > 0.7 持续 3 窗口 + 用户未标记 deprecated | 生成 skills/<name>.md 投影，标记 graduated，退出进化循环 |
| 群体智能 | （可选）跨部署共享 | 发布匿名 outcome 到共享 registry |

### 6.6 反馈闭环

```
用户反馈 → FeedbackTracker
    │
    ├── "好的" / "OK"        → outcome_score += 0.1
    ├── "不对" / "错了"       → outcome_score -= 0.2 + 触发矛盾检测
    ├── "不要这样"            → 新增 negative_rule convention
    ├── "记住这个"            → 新增 preference，provenance = user_stated
    └── 隐式信号：
        ├── 用户接受修改且无后续修正 → outcome_score += 0.05
        ├── 用户手动撤销修改         → outcome_score -= 0.15
        └── 用户重复相同请求         → 触发 SkillClaw 变异生成
```

### 6.7 提取内容矩阵

#### 层级一：Session 级提取（全局行为特征）

| 提取维度 | 字段 | 提取方式 | 去向 |
|---------|------|---------|------|
| 会话元数据 | session_id, user_id, 创建/结束时间, 会话类型, 状态, 中断标记 | Agent 启动/结束时自动生成 | Episodic Store |
| 全局统计 | 总工具调用次数, 失败/重试/打断回退次数, 平均思考耗时, Token 消耗 | 会话结束时聚合计算 | User Profile + user_profile.md |
| 行为模式 | 循环提问、重复调用、无效追问检测 | 会话日志模式匹配 | Convention Store（negative_rule） |
| 高价值信号 | 会话整体意图是否达成、用户是否中途放弃 | LLM 会话结束评估 + 隐式信号 | raw_memory（长期模式） |

#### 层级二：Conversation 单轮级提取（交互轨迹）

| 提取维度 | 字段 | 提取方式 | 去向 |
|---------|------|---------|------|
| 交互原始轨迹 | Query 原文, CoT 中间推理, Answer, 时间戳 | TraceRecorder 实时捕获 | Episodic Store + .jsonl |
| 工具调用全链路 | 调用顺序, 入参, 出参, 成功/失败/超时 | Tool execution hooks | Episodic Store (tool_chain scope) |
| 工具异常 | 冗余调用、漏调用、错调用 | TraceAnalyzer 诊断 | Convention Store（procedural_rule） |
| 错误与异常 | 回答偏离意图、逻辑断层、步骤缺失 | LLM 诊断 + 规则匹配 | raw_memory + Convention Store |

#### 层级三：高价值特征提取（自进化燃料）

| 特征类别 | 触发条件 | 提取产物 | 去向 |
|---------|---------|---------|------|
| 意图理解类 | 意图识别错误、歧义未澄清 | clarification_strategy convention | Convention Store |
| 任务规划类 | 拆解不合理、子任务顺序错误 | task_template rule | skills/ 或 Convention Store |
| 工具使用类 | 不该调用乱调用、该调不调 | tool_constraint convention | Convention Store |
| 表达反思类 | 回答冗长、术语滥用 | style_preference convention | Convention Store + user_profile.md |

#### 层级四：进化沉淀产出

| 产出类型 | 来源 | 更新频率 | 存储 |
|---------|------|---------|------|
| System Prompt 规则 | Convention Store 高 confidence 规则 | 实时 | 注入系统提示 |
| 任务拆解模板 | skill_population 高分技能 | 每次评估 | skills/*.md |
| 工具调用约束 | 工具失败模式聚合 | 实时 | Convention Store |
| 失败案例 Few-Shot | Conversation 错误轨迹 | 异步批量 | raw_memory + Vector Store |
| 反问澄清策略 | 意图理解错误案例 | 异步 | skills/ 或 Convention |
| 上下文压缩规则 | rollout_summary 模式提炼 | 异步 | Memory Phase 2 |

### 6.8 会话数据提取去重

当前两条独立提取路径（Self-Evolution Trace + Memory JSONL）存在重叠和盲区，需合并。

#### 统一去重机制

```
提取结果 → Unified Dedup Gate → Conflict Resolver
    │                              │
    ├── raw_memory ──────────────→ │ 语义相似度 > 0.85 → 合并
    ├── convention ──────────────→ │ provenance 分级 → 裁决
    └── skill ───────────────────→ │ 去重后输出
```

#### Trace 信息增强

| 当前 | 增强后 | 收益 |
|------|--------|------|
| tool_result 只存第一行 | 存储完整 result（截断至 2KB） | 保留错误上下文 |
| 无 agent reasoning | 捕获最后 3 条 assistant_message | 支持隐式规则提取 |
| 无 LLM 调用信息 | 记录 model_error 的 status code 和 message | 分析 provider 失败模式 |

#### 隐式信号提取

| 隐式信号 | 检测方法 | 提取结果 |
|---------|---------|---------|
| 用户多次手动撤销修改 | 检测 edit 后紧跟用户手动 revert | negative_rule convention |
| 用户重复相同请求 | 相同 user_input 出现 ≥ 2 次 | 触发技能变异生成 |
| Agent 反复尝试同一操作失败 | tool_call 同一工具 ≥ 3 次且 result 均为 error | procedural_rule convention |

#### 提取层到架构映射

```
外部提取层级          →  V2.1 对应模块              →  产物
Session 全局行为     →  Episodic Store + Profile   →  session_records + user_profile
Conversation 单轮    →  TraceRecorder + Analyzer   →  tool_chain + error_context
高价值特征提取       →  Self-Evolution 三层提取     →  convention + skill + raw_memory
进化沉淀产出         →  Cognitive Pipeline Stage 6 →  system prompt injection
```

### 6.9 人类可读投影

| 文件 | 内容 | 生成方式 | 用户可编辑 |
|------|------|---------|-----------|
| **conventions.md** | 当前活跃约定（按 provenance 分组） | SQLite → md 定时投影 | Yes，反向导入到 SQLite |
| **evolution_log.md** | 所有变更的审计时间线 | 每次进化变更追加写入 | No，只读 |
| **user_profile.md** | 用户画像摘要 | SQLite 滚动窗口聚合 | Yes，反向导入到 SQLite |

```markdown
<!-- conventions.md 示例 -->
# Active Conventions

## User Stated (confidence 90-100)
- NEVER use console.log/error/warn (added: 2024-01-10)
- 中文回复，除非用户切换语言 (added: 2024-02-15)

## User Implied (confidence 70-89)
- 优先使用 find 确认路径再 read (confidence: 78)

## System Inferred (confidence 50-69)
- read 工具失败时优先检查路径参数 (confidence: 62)

## Negative Rules
- 不要使用 mock.module() (violation_count: 0)
```

### 6.10 模块合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| Convention 提取不遗漏用户明确声明 | "记住 X" → provenance = user_stated | 搜索 conventions 表有 user_stated 条目 |
| 反馈闭环即时生效 | "不对" → confidence 立即调整 | FeedbackTracker 写入后，convention confidence 值已更新 |
| 技能毕业自动生成 md 投影 | skill_score > 0.7 持续 3 窗口 → skills/<name>.md 存在 | 检查 graduated 技能的 md 文件存在且内容与 SQLite 一致 |
| 技能淘汰后不再注入 | skill_score < 0.35 → deprecated | 检索结果中不含 deprecated 技能 |
| 提取去重保证无三份重叠 | 同一教训不出现在 skill + convention + memory | Conflict Resolver 输出中同一语义内容只出现在一个去向 |
| conventions.md 与 SQLite 一致 | 定时投影 + 用户编辑反向导入 | 比对 conventions.md 内容与 SQLite conventions 表 |
| 不可变规则不可被进化覆盖 | immutable_rules 永远存在 | 进化后 immutable_rules 条目不变 |

### 6.11 状态机：Convention

```
[Extracted] ──三层提取──▶ [Active]
                           │
              ┌────────────┼────────────┐
              │            │            │
     provenance 冲突    confidence < 60   用户 "不要这样"
     (新 provenance     (月度衰减)        (显式否定)
      更高)                                   │
              │            │            │
              ▼            ▼            ▼
         [Superseded]  [Archived]   [Negative Rule]
```

### 6.12 状态机：Skill Population

```
[Incubating] ──首次执行──▶ [Evaluating]
                           │
              ┌────────────┼────────────┐
              │            │            │
    score > 0.7 持续 3 窗口  score 在中间   score < 0.35 持续 3 窗口
              │            │            │
              ▼            ▼            ▼
         [Graduated]    [Stable]     [Deprecated]
              │            │            │
    生成 md 投影       继续进化循环   不再注入系统提示
    退出进化循环                      不再参与选择偏置
```

---

## 7. Cognitive Pipeline

六阶段管道，每阶段有明确的输入/输出合约。

### 7.1 管道定义

```
User Message + Task Context
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ Stage 1: Query Analyzer                              │
│ 输入: 用户消息 + 当前任务上下文                        │
│ 输出: { intent, domain, time_range, scope_hints,     │
│         requiresEpisodic }                            │
│ 方法: 轻量 LLM 调用（smol role）或 heuristic 分类      │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Stage 2: Retrieval Orchestrator                      │
│ 输入: Query Analyzer 输出                             │
│ 输出: 原始候选记忆列表（过检索：目标数 × 3）            │
│ 方法: 并行查询 Memory + Self-Evolution + Profile      │
│ 子步骤:                                               │
│   2a. Memory Retriever    — 向量语义 + BM25 混合       │
│   2b. Convention Retriever — 语义相似度 + 类型匹配     │
│   2c. Profile Retriever   — 画像数据全量读取           │
│   2d. Episodic Retriever  — session_id 作用域查询      │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Stage 3: Score Fusion                                │
│ 输入: 各源候选记忆                                    │
│ 输出: 统一评分排序的候选列表                           │
│ 公式: composite_score =                              │
│   0.50 × semantic_similarity                        │
│ + 0.30 × recency_decay                              │
│ + 0.20 × importance_score                           │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Stage 4: Conflict Resolver                           │
│ 输入: 评分排序的候选列表                               │
│ 输出: 无矛盾的候选列表 + 矛盾关系标记                   │
│ 方法:                                                 │
│   4a. 语义相似度 > 0.85 → 重复，保留高分              │
│   4b. negation sets 重叠 → 按 provenance 裁决         │
│   4c. 被 supersede → 排除（保留审计追踪）             │
│   4d. 无法裁决 → 同时注入，标注矛盾关系                │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Stage 5: Token Budget Allocator                      │
│ 输入: 无矛盾的候选列表 + 总 Token 预算                  │
│ 输出: 裁剪后的上下文片段                               │
│ 动态分配：                                             │
│   编码任务: memory 10-15%, conventions 10-15%        │
│   知识任务: memory 20-25%, conventions 15-20%        │
│ 裁剪策略: 按 composite_score 降序截断                 │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Stage 6: System Prompt Injection                     │
│ 输入: 裁剪后的上下文片段                               │
│ 输出: 装配完成的 system prompt                        │
│ 注入优先级：                                           │
│   1. AGENTS.md（最高，不可覆盖）                       │
│   2. Memory summary（静态项目知识）                    │
│   3. Self-Evolution conventions（动态用户偏好）        │
│   4. Self-Evolution skills（技能建议）                 │
│   5. User Profile（用户画像）                          │
│   6. Episodic context（会话级上下文）                   │
│   7. Relevant past episodes（历史经验）                │
└─────────────────────────────────────────────────────┘
```

### 7.2 Token 预算配置

```typescript
interface TokenBudget {
    total: number;           // 总预算（如 8000 tokens）
    allocations: {
        memorySummary: 0.25; // 2000 tokens - 项目知识
        conventions: 0.30;   // 2400 tokens - 用户约定（按 composite_score 排序）
        profile: 0.15;       // 1200 tokens - 用户画像
        skills: 0.20;        // 1600 tokens - 相关技能
        episodic: 0.05;      // 400 tokens  - 会话上下文
        buffer: 0.05;        // 400 tokens  - 预留
    };
    evictionPolicy: "score-cutoff";  // 低于阈值的直接排除
    taskTypeAdjustment: {             // 按任务类型动态调整
        coding:    { memorySummary: -0.10, buffer: +0.10 },
        knowledge: { memorySummary: +0.10, conventions: +0.05 },
        planning:  { skills: +0.10, profile: +0.05 },
    };
}
```

### 7.3 注入优先级详细规格

| 层 | 来源 | Token 预算 | 过滤条件 | 特性 |
|----|------|-----------|---------|------|
| 1 | AGENTS.md | 固定，不裁剪 | — | 不可覆盖，来自代码仓库 |
| 2 | Memory summary | 10-25%（按任务类型动态调整） | composite_score ≥ 0.3 | 技术决策、架构、规则 |
| 3 | Self-Evolution conventions | 10-20% | confidence ≥ 60，按 provenance 加权 | 用户偏好、否定规则、步骤规范 |
| 4 | Self-Evolution skills | 10-20% | skill_score ≥ 0.30 | 操作手册、最佳实践 |
| 5 | User Profile | 5-15% | — | 工具偏好、语言偏好、意图分布 |
| 6 | Episodic context | 5% | requiresEpisodic = true 时注入 | 当前 session_id 上下文 |
| 7 | Relevant past episodes | 5-10% | relevance_score ≥ 40 || help_rate > 0.5 | 历史会话的晋升记录 |

### 7.4 各组件接口定义

#### QueryAnalyzer

```typescript
interface QueryAnalysis {
    intent: "edit" | "explore" | "debug" | "plan" | "review" | "ask";
    domain?: string;              // 推断的领域（如 "auth", "testing"）
    timeRange?: "recent" | "historical" | "all";
    scopeHints?: string[];        // 可能相关的记忆 scope
    requiresEpisodic: boolean;    // 是否需要 session 级上下文
}
```

#### RetrievalOrchestrator

```typescript
interface RetrievalResult {
    source: "memory" | "convention" | "profile" | "episodic";
    items: Array<{
        content: string;
        embedding?: Float32Array;
        semanticScore: number;    // 0~1
        recencyScore: number;     // 0~1
        importanceScore: number;  // 0~1
        provenance: Provenance;
        type?: ConventionType;
    }>;
    overRetrieveFactor: 3;       // 过检索倍数
}
```

#### ConflictResolver

```typescript
interface ConflictRelation {
    itemA: string;
    itemB: string;
    type: "duplicate" | "contradiction" | "superseded";
    resolution: "keep_a" | "keep_b" | "keep_both_annotated" | "merge";
    reasoning: string;
}
```

### 7.5 管道合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| Stage 1 输出始终有 intent 分类 | 不遗漏 | QueryAnalysis.intent 非空 |
| Stage 2 过检索 ≥ 3× 目标数 | 保证 recall | RetrievalResult.items.length ≥ 目标数 × 3 |
| Stage 3 composite_score 范围 [0, 1] | 归一化 | 所有 items 的 composite_score ∈ [0, 1] |
| Stage 4 输出无语义重复（similarity < 0.85） | 去重有效 | 输出列表中任意两项相似度 < 0.85 |
| Stage 5 输出总 Token ≤ 预算 | 不超限 | 计算输出总 Token ≤ TokenBudget.total |
| Stage 6 注入顺序遵循优先级表 | 不乱序 | system prompt 中各层按 1→7 排列 |
| AGENTS.md 不被裁剪 | 最高优先级 | AGENTS.md 始终完整注入 |
| 矛盾信息标注矛盾关系 | 透明 | 无法裁决的矛盾同时注入 + 标注 |


### 7.6 Activity Monitor（活动监控）

Activity Monitor 是 V2 Cognitive-Coordination 层的显式组件，V2.1 将其职责明确为 Self-Evolution 的持续监控子组件。

**职责**：持续追踪 skill_score 趋势、Convention 衰退、错误率变化，输出可观测性事件和预警信号。

#### 监控维度

| 监控对象 | 指标 | 预警条件 | 输出事件 |
|---------|------|---------|---------|
| Skill 衰退 | skill_score 变化率 | skill_score 连续 3 窗口下降 > 0.1 | skill_evolution 事件 |
| Convention 衰退 | confidence 月度变化 | confidence < 60 且持续下降 | contradiction_trends 事件 |
| 检索质量 | composite_score 分布均值 | 连续 3 次 retrieval average_score 下降 | retrieval_quality 事件 |
| 提取效果 | 每次提取的事实数 | primary_extraction 连续 3 次返回 0 结果 | extraction_stats 事件 |
| 系统健康 | 写入成功率 | write_failure 导致全量更新停止 | write_failures 事件 |

#### 与 §10 可观测性的关系

Activity Monitor 是 §10.2 可观测性事件的生成源。§10 定义了事件类型和告警条件，Activity Monitor 是实际产生这些事件的组件。

#### 合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| Skill 衰退预警不遗漏 | skill_score 连续下降时产生 skill_evolution 事件 | 模拟 skill_score 3 窗口连续下降 → 事件产生 |
| 检索质量退化可检测 | average_score 下降时产生 retrieval_quality 事件 | 模拟 average_score 3 次连续下降 → 事件产生 |
| 提取失败可检测 | extraction 返回 0 结果时产生 extraction_stats 事件 | 模拟 3 次空提取 → 事件产生 |


### 7.7 Virtual Sandbox（虚拟沙盒）

Virtual Sandbox 是 V2 Cognitive-Coordination 层的显式组件，V2.1 中完全缺失，现在补回。

**职责**：在技能被注入 system prompt 前主动验证其有效性，防止过时或不适用的技能污染上下文。与 skill_population 的 retrospective scoring（事后评分）互补，Virtual Sandbox 做 prospective validation（前瞻验证）。

#### 验证机制

| 验证类型 | 方法 | 触发时机 | 输出 |
|---------|------|---------|------|
| **相关性评分** | 当前任务 intent/domain 与技能 approach 的语义相似度 | Retrieval Orchestrator 检索到技能后 | relevance_score (0~1) |
| **时效性检查** | 技能最后成功执行时间 vs half_life_days | 注入前 | valid = (last_success < half_life_days) |
| **适用域检查** | 技能记录的适用 domain 与当前任务 domain 是否匹配 | 注入前 | domain_match = (skill.domain ∩ task.domain ≠ ∅) |
| **不可变规则冲突检查** | 技能 approach 是否与 immutable_rules 矛盾 | 注入前 | conflict = check_approach_vs_immutable(approach) |

#### 验证流程

```
Skill Population 检索到候选技能
    │
    ▼
┌─────────────────────────────────────┐
│ Virtual Sandbox                      │
│                                      │
│ 1. 时效性检查：last_success 仍在半衰期 │
│ 2. 适用域检查：domain 与当前任务匹配   │
│ 3. 不可变规则冲突检查                 │
│ 4. 相关性评分：语义相似度计算          │
│                                      │
│ 任意检查失败 → 排除该技能              │
│ 所有检查通过 → 进入 Score Fusion       │
└────────────────────┬────────────────┘
                     │
                     ▼
         Score Fusion (composite_score 包含 relevance_score)
```

#### 合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| 过时技能不注入 | last_success > half_life_days 的技能被排除 | 注入前所有技能 last_success < half_life |
| 不适用域技能不注入 | domain 不匹配的技能被排除 | 注入技能 domain ∩ task.domain ≠ ∅ |
| 与 immutable_rules 矛盾的技能不注入 | approach 违反不可变规则被排除 | 注入技能 approach 不违反任何 immutable_rule |
| Sandbox 验证不替代 retrospective scoring | Sandbox 是前置过滤，skill_score 是后置评分 | Sandbox 过滤后的技能仍按 skill_score 排序 |


### 7.8 状态机：Pipeline 单次执行

```
[Idle] ──用户消息──▶ [QueryAnalyzed]
                          │
                          ▼
                    [Retrieved]（并行查询 4 源）
                          │
                          ▼
                    [Scored]（composite_score 排序）
                          │
                          ▼
                    [Resolved]（无矛盾列表）
                          │
                          ▼
                    [Budgeted]（Token 裁剪）
                          │
                          ▼
                    [Injected]（system prompt 完成）
                          │
                          ▼
                    [Idle]
```

---

## 8. 知识生命周期管理

### 8.1 记忆衰减算法

```
衰减后重要性 = base_importance × 0.5^(days_since_last_access / half_life_days)

half_life_days 配置：
- 项目技术决策: 180 天（长期稳定）
- 用户偏好: 90 天（可能变化）
- 工具使用习惯: 30 天（高频变化）
- 会话级上下文: 7 天（短期）
```

### 8.2 淘汰策略

| 策略 | 适用对象 | 触发条件 | 操作 |
|------|---------|---------|------|
| 过期淘汰 | Episodic records | session_end + TTL 到期 | 低 importance 删除，高 importance 晋升 |
| 容量淘汰 | raw_memory | 超过 N 条后 | 淘汰最旧且最低 relevance |
| 置信度衰减 | Conventions | 每月 confidence -= decay_rate | 低于阈值 → archived |
| 矛盾淘汰 | 冲突约定 | 新约定 provenance > 旧约定 | 旧约定 → superseded |
| 技能淘汰 | Skills | skill_score < 0.35 持续 3 窗口 | deprecated |
| 滚动窗口 | User Profile | 仅保留最近 30 天 | 超出窗口聚合为历史摘要 |

### 8.3 记忆合并

当两条记忆的语义相似度 > 0.85 时触发合并：
1. 内容基本相同 → 保留重要性高的，删除另一条
2. 内容互补 → 合并为一条，保留双方信息
3. 内容矛盾 → 按 provenance 裁决，旧的标记 superseded

---

## 9. LLM 模型测评与智能路由

### 9.1 数据存储

```
omp.sqlite
├── evolution_model_scores        — 模型评分表
│   ├── model_key                 (provider/modelId)
│   ├── task_type                 (edit|explore|debug|plan|review|ask)
│   ├── avg_success_rate          (0~1)
│   ├── avg_efficiency_score      (0~1)
│   ├── avg_tool_success_rate     (0~1)
│   ├── avg_error_rate            (0~1)
│   ├── sample_count              (累计样本数)
│   ├── last_updated              (unix timestamp)
│   └── half_life_days            (衰减周期，默认 30)
│
├── evolution_session_model_stats  — 单会话模型表现（原始数据）
│   ├── session_id
│   ├── model_key
│   ├── task_type
│   ├── token_total
│   ├── token_input, token_output, cache_read, cache_write
│   ├── tool_call_count, tool_success_count
│   ├── error_count, recovery_count
│   └── completed_successfully
│
└── evolution_model_recommendations — 模型推荐缓存
    ├── task_type
    ├── recommended_model_key
    ├── confidence
    └── generated_at
```

### 9.2 评分公式

```
model_score(task_type) =
    0.40 × success_rate           (任务成功率)
  + 0.25 × efficiency_score       (token 效率: median_cost / actual_cost)
  + 0.20 × tool_success_rate      (工具调用成功率)
  + 0.15 × (1 - error_rate)       (错误率倒数)

衰减: score = score × 0.5^(days_since_last_used / half_life_days)
```

| 维度 | 计算方式 | 说明 |
|------|---------|------|
| success_rate | completed_successfully / total_sessions | 任务整体是否成功完成 |
| efficiency_score | median_tokens / actual_tokens (上限 1.0) | 同类任务中该模型的 token 效率 |
| tool_success_rate | tool_success_count / tool_call_count | 工具调用成功率 |
| error_rate | error_count / (tool_call_count + 1) | 错误率 |

### 9.3 Model Router

在 Cognitive Pipeline Stage 1（Query Analyzer）之后介入。

```
Query Analyzer 输出
    │
    ▼
┌─────────────────────────────────────────┐
│ Model Router                             │
│ 输入: intent + domain + 可用模型列表       │
│                                         │
│ 1. 查找 task_type 对应的推荐模型          │
│ 2. 推荐模型不可用 → 降级到 role 默认       │
│ 3. 样本数 < min_samples (默认 5)          │
│    → 使用 role 默认，记录探索性调用        │
│ 4. 输出: { selected_model, fallback_model }│
└────────────────────┬────────────────────┘
                     ▼
             Retrieval Orchestrator
```

| 任务类型 | 推荐策略 | 降级路径 |
|---------|---------|---------|
| `edit` | 代码任务最高 model_score | default role |
| `debug` | 调试任务最高 model_score | default role |
| `plan` | 规划任务最高 model_score | plan role |
| `review` | 审查任务最高 model_score | default role |
| `explore` | 探索任务最低 token cost | smol role |
| `ask` | 知识任务最高 model_score | default role |

### 9.4 安全护栏

| 护栏 | 说明 |
|------|------|
| 最小样本数 | model_score 需 ≥ 5 次同类任务样本才参与路由 |
| 冷却期 | 模型切换后 3 轮内不自动切换，避免震荡 |
| 用户覆盖 | 用户手动选择的模型优先级高于自动路由 |
| 降级回退 | 推荐模型 API 不可用时降级到 role 默认模型 |

### 9.5 Performance-Aware Fallback

| 触发条件 | 操作 |
|---------|------|
| 同一模型在同类任务中连续 2 次失败 | 自动切换到 fallback_model |
| 同一模型 token 消耗超过同类任务中位数 3× | 记录警告，下次同类任务降级 |
| 同一模型工具成功率 < 50%（滚动窗口 10 次） | 记录警告，下次同类任务降级 |

### 9.6 用户交互

| 功能 | 交互方式 |
|------|---------|
| 查看模型评分 | `/model scores [task_type]` |
| 手动覆盖 | 用户通过 model selector 选择的模型 = 自动路由失效（本轮） |
| 推荐提示 | 会话开始时显示 "Using {model} for {task_type} tasks (score: {score})" |
| 重置评分 | `/model reset [model_key]` |

### 9.7 与现有系统集成点

| 现有组件 | 集成方式 |
|---------|---------|
| AgentSession.setModelTemporary | Model Router 调用此方法切换模型 |
| TraceAnalyzer | 增加 model_key 字段到诊断结果 |
| SessionStats | 会话结束时写入 evolution_session_model_stats |
| model-resolver.ts | Model Router 复用 resolveModelRoleValue |
| retry fallback 框架 | Performance-Aware Fallback 扩展 RetryFallbackSelector |

### 9.8 模块合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| 数据收集不影响行为 | 仅写入，不改变模型选择 | 启用 Model Evaluator 后行为与禁用时一致 |
| 冷却期防止震荡 | 3 轮内不自动切换 | 连续 3 次请求使用同一模型（除非用户手动切换） |
| 用户覆盖优先 | 手动选择 > 自动路由 | 用户选择模型后，Model Router 输出 = 用户选择 |
| 降级回退保证可用性 | 推荐模型不可用时降级 | 推荐模型 API 不可用 → 自动使用 fallback |
| 评分数据按任务类型隔离 | edit/debug/plan 评分独立 | `/model scores edit` 和 `/model scores plan` 结果不同 |

---

## 10. 安全护栏与可观测性

### 10.1 安全护栏

| 规则 | 说明 |
|------|------|
| 进化前快照 | 每次进化前快照 MEMORY.md, memory_summary.md, conventions.md, evolution_log.md, user_profile.md, skills/ |
| 不可变规则 | "NEVER use console.log/error/warn"、"NEVER use mock.module()"、"NEVER use ReturnType<>"、"NEVER build prompts in code" — 不可被进化覆盖 |
| 变更审计 | evolution_log.md 记录所有变更 |
| 变更频率限制 | 单次进化最多 10 条变更 |
| 变异率控制 | 8% 的技能可生成变体 |
| 重大变更需确认 | require_user_approval: true |

### 10.2 可观测性事件

| 事件 | 说明 |
|------|------|
| extraction_stats | 每次提取的事实数、fallback 触发次数、矛盾数 |
| write_failures | 写入失败事件 |
| compaction_snapshots | 压缩前后的 memory 文件行数对比 |
| contradiction_trends | 矛盾数量增长/减少趋势 |
| retrieval_quality | 检索结果的 composite_score 分布 |
| skill_evolution | skill_score 变化趋势、变异生成记录 |

### 10.3 告警指标

| 指标 | 告警条件 | 含义 |
|------|---------|------|
| primary_extraction 连续 3 次返回 0 结果 | 提取逻辑可能失效 |
| contradiction_count 持续增长 | 矛盾解决可能失效 |
| retrieval average_score 持续下降 | 记忆质量可能退化 |
| write_failure 导致全量更新停止 | 存储可能损坏 |

---

## 11. 命令设计

### 11.1 `/evolution` — Self-Evolution 模块专属

| 子命令 | 说明 | V2.1 变化 |
|--------|------|----------|
| `population` | 查看动态进化种群（评分、deprecated、usageCount） | 替代旧的 `skills` |
| `conventions list` | 查看当前活跃约定（按 provenance 分组） | 新增 |
| `conventions search <q>` | 语义检索 conventions | 新增 |
| `conventions delete <id>` | 删除错误约定 | 新增 |
| `nudges` | 查看跨会话提醒规则 | 新增 |
| `status` | 全模块统计（扩展） | 扩展 |
| `log` | 查看 evolution_log.md 审计时间线 | 新增 |
| `report` | 生成日报 | 保留 |
| `clear` | 清除数据 | 保留 |

### 11.2 `/memory` — Memory 模块专属

| 子命令 | 说明 | V2.1 变化 |
|--------|------|----------|
| `show` | 查看 MEMORY.md | 保留 |
| `summary` | 查看 memory_summary.md | 保留 |
| `skills` | 查看已毕业技能的 md 投影 | 语义变更：从独立存储改为 graduated 投影 |
| `search <query>` | 向量语义检索 raw_memory | 新增 |

### 11.3 `/episodic` — Episodic Store（新增命令）

| 子命令 | 说明 |
|--------|------|
| `sessions` | 查看历史会话记录 |
| `show <session-id>` | 查看单会话详情（tool_chain、error_context） |
| `clear` | 清理过期记录 |

### 11.4 `/profile` — User Profile（从 `/evolution` 拆出）

| 子命令 | 说明 | V2.1 变化 |
|--------|------|----------|
| `show` | 查看 user_profile.md | 新增 |
| `edit` | 手动修正偏好 | 新增 |
| `stats` | 查看滚动窗口统计（30 天） | 新增 |

### 11.5 `/model` — 模型测评与路由（新增命令）

| 子命令 | 说明 |
|--------|------|
| `scores [task_type]` | 显示各模型在不同任务上的评分 |
| `reset [model_key]` | 清除指定模型的评分数据 |

### 11.6 `status` 子命令输出

```
Self-Evolution:
  Conventions: 23 active | 5 archived
  Skills (population): 12 active | 3 deprecated | 2 graduated | avg score: 0.72
  Nudges: 4 active

Memory:
  Memories: 18 raw_memory entries | 42 embeddings
  Skills (graduated): 5 files in skills/

Episodic:
  Active sessions: 1
  Records: 47 (7 pending review)
```

### 11.7 防重复机制

| 场景 | 处理 |
|------|------|
| `/evolution population` 默认列表 | 排除 graduated 技能（可用 `--all` 查看） |
| `/memory skills` | 只显示 graduated 技能的 md 投影 |
| 毕业 | skill_score > 0.7 持续 3 窗口 → 生成 skills/<name>.md → graduated → 退出进化循环 |
| 淘汰 | skill_score < 0.35 持续 3 窗口 → deprecated → 不再注入 |

---

## 12. 设计决策记录

| 决策 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 向量存储 | SQLite-vec | FAISS / LanceDB | 零新依赖，与现有 SQLite 共存，Bun 原生支持 |
| 复合评分权重 | 0.5/0.3/0.2 | 自定义权重 | 业界共识，经过验证 |
| 遗忘算法 | 指数衰减 `0.5^(days/half_life)` | 线性衰减 / LRU | 指数衰减更符合人类记忆衰减曲线 |
| 冲突解决 | supersede（标记而非删除） | 覆盖删除 | 保留审计追踪，支持历史查询 |
| 技能进化 | 种群进化（SkillClaw 模式） | 单技能优化 | 种群进化 +18.53% over baseline（Mem²Evolve） |
| 安全快照 | 进化前快照 + 不可变规则 | 无安全机制 | 防止退化失控的最低要求 |
| 数据源合并 | 双路径合并 + Conflict Resolver 去重 | 独立提取无去重 | 避免同一教训提取为 skill/convention/memory 三份 |
| 过检索倍数 | 3× | 2× / 5× | recall quality 和 cost 的最优平衡 |
| Token 预算分配 | 按任务类型动态调整 | 固定比例 | 编码任务和知识任务的上下文需求差异显著 |
| 统一 SQLite 存储 | 单一数据库 + 表前缀命名空间 | 多数据库文件 / 单表混合 | 零额外依赖、单文件备份、跨模块原子事务 |
| Session 日志格式 | 双写：.jsonl（全量原始）+ SQLite（结构化子集） | 仅 SQLite / 仅 .jsonl | .jsonl 保留完整对话和工具输出供 Memory Phase 1 异步提取；SQLite 提供结构化查询供 Self-Evolution 和 Pipeline 实时检索；两者数据粒度不同、不互为备份 |
| Self-Evolution md 文件 | SQLite 只读投影 | 无 md 文件 / 双写维护 | 人类可读窗口降低调试成本；SQLite 为主避免不一致 |
| Episodic 存储后端 | EpisodicBackend 接口（SQLite 默认 + Redis 可选） | 仅 SQLite / 仅 Redis | 单进程 CLI 不需要 Redis 运维负担；多进程场景可切换 |
| 模型评分 | 按任务类型四维评分 | 无评分 / 仅全局评分 | 同一模型在不同任务上表现差异显著 |
| 智能路由 | Model Router + 冷却期 + 用户覆盖 | 静态 modelRoles 映射 | 数据驱动比静态映射更适应实际工作负载 |
| 性能降级 | 连续失败/token 超耗/成功率 < 50% 触发 | 仅 retry fallback | 性能劣化比 API 错误更常见且更难察觉 |
| 命令拆分 | `/evolution` + `/memory` + `/episodic` + `/profile` 四命令 | 单一 `/evolution` | 按模块边界组织，避免功能混杂 |
| 技能命名 | `/evolution population`（动态）+ `/memory skills`（graduated 投影） | 两套独立 skills | 单一数据源，毕业后自动生成投影，消除重复 |
| Convention Miner 归属 | Self-Evolution §6.4（三层提取 Layer 1 统一入口） | 独立组件或 Cognitive Pipeline 子组件 | 否定关键词挖掘和隐式信号挖掘是提取行为，不是调度行为，归属 Self-Evolution 更合理 |
| Activity Monitor 归属 | Cognitive Pipeline §7.6（产生可观测性事件） | Self-Evolution 子组件 | 监控对象跨 Memory + Self-Evolution + Pipeline，属于协调层职责 |
| Virtual Sandbox 验证时机 | Retrieval Orchestrator 之后、Score Fusion 之前（前置过滤） | 注入前验证 / 不验证 | 前置过滤避免无效技能进入评分环节浪费计算，与 retrospective scoring 互补 |
| Virtual Sandbox 验证方式 | 时效性 + 适用域 + 不可变规则冲突 + 语义相关性 | 仅 skill_score 过滤 | skill_score 是事后评分，不检测时效性和适用域；Sandbox 补充前瞻验证 |

---

## 13. LLM 提取策略规格

当前系统在提取环节中使用了两种策略：**规则优先**（Regex/heuristic/statistical）和 **LLM 增强**（异步后台调用）。每个提取点的策略配置、prompt 设计规范和成本控制策略如下。

### 13.1 核心原则：规则优先 + LLM 增强 + 规则 fallback

所有提取链遵循三层架构：

```
Layer 1: 规则提取（60-70% 覆盖率，<1ms，零成本）
Layer 2: LLM 增强（20-30% 覆盖率，1-5s，Token 成本）
Layer 3: 规则 fallback（LLM 失败时兜底）
```

**不应全部替换为 LLM**，原因：
- 规则提取确定性 100%，可直接单元测试
- 规则提取成本为零、延迟 <1ms
- LLM 提取依赖模型可用性，失败时必须有 fallback
- 规则对显式表达（"请记住X"、"不要使用Y"）准确率更高
- LLM 对隐式偏好和语义理解更好，但不能替代规则

### 13.2 各提取点 LLM 使用配置

| 提取点 | 模块 | 规则能力 | LLM 能力 | Prompt 文件 | 触发条件 | LLM 失败 fallback | 当前状态 |
|--------|------|---------|---------|-----------|---------|-----------------|---------|
| **Convention 提取** | Self-Evolution | Regex 匹配否定关键词/偏好词 | **缺失** — Layer 2 未实现 | — | 每次会话结束 | 规则结果（当前仅有规则） | **需要新增 LLM Batch** |
| **Skill 提取** | Self-Evolution | 规则生成（toolCallCount >= threshold） | LLM 精炼 approach/pitfalls | extract-skill.md | completedSuccessfully + llmRefinement=true | 规则提取结果（llmRefined=false） | **已实现** |
| **Trace 诊断** | Self-Evolution | 规则诊断（readFailures/cascadePatterns） | LLM 深度诊断 + 合并 | trace-analysis.md + trace-analysis-input.md | 每次会话结束 | 规则诊断结果 | **已实现** |
| **意图分类** | Self-Evolution | 关键词+工具信号评分 | LLM 分类 fallback | classify-intent.md | rule confidence < 70 | 规则分类结果 | **已实现** |
| **Episode 重排** | Self-Evolution | BM25/向量排序 | LLM 相关性重排 | rerank-episodes.md | topCandidates > 3 + llmRerank=true | 规则排序结果 | **已实现** |
| **技能优化** | Self-Evolution | — | LLM rewrite approach | optimize-prompt.md / aggressive-optimize.md | 手动触发 | 不优化（保持原 approach） | **已实现** |
| **Fit 评估** | Self-Evolution | 统计评分 | LLM judge 评估 | fit-judge-prompt.md | fit 评估周期 | 统计评分 | **已实现** |
| **Memory Phase 1** | Memory | **缺失** — 无规则 fallback | 全量 LLM 提取 | stage_one_system.md + stage_one_input.md | 会话结束后异步 | **返回空**（脆弱！） | **需要新增规则 fallback** |
| **Memory Phase 2** | Memory | **缺失** — 无规则 fallback | 全量 LLM 整合 | consolidation.md | 累积后异步 | **返回空**（脆弱！） | **需要新增规则 fallback** |
| **Convention Miner** | Self-Evolution | 否定关键词 + false positive Regex | **不使用 LLM** | — | 每次会话结束 | 不需要（纯规则） | **已实现** |
| **FeedbackTracker** | Self-Evolution | 数值调整 confidence | **不使用 LLM** | — | 每次用户反馈 | 不需要（纯数值） | **已实现** |

### 13.3 Prompt 设计规范

所有 LLM prompt 文件遵循以下规范：

| 规范 | 说明 |
|------|------|
| Prompt 存储 | 静态 `.md` 文件，使用 Handlebars `{{variable}}` 模板，通过 `import content from "./prompt.md" with { type: "text" }` 加载 |
| Prompt 调用 | 通过 `callBackgroundLlm(model, systemPrompt, userPrompt)` — 统一入口，失败时返回空字符串 |
| LLM 角色 | 使用 `smol` role（低成本模型）进行后台提取，不占用主模型 |
| JSON 输出 | 所有提取 prompt 要求返回 strict JSON（`"Return ONLY a JSON object"`），解析失败时 fallback 到规则 |
| Token 限制 | `maxTokens: 2000`（callBackgroundLlm 默认值） |
| 异步执行 | 所有 LLM 提取在后台执行（不阻塞主会话），结果写入 SQLite |
| 不可内联 | **NEVER build prompts in code**（AGENTS.md 硬约束）— 所有 prompt 必须在 `.md` 文件中 |

### 13.4 两个必须修复的缺口

#### 缺口 1：Convention 提取缺少 Layer 2 LLM Batch

当前 ConventionExtractor 和 Convention Miner 都是纯 Regex（§6.2 Layer 1），**Layer 2 LLM Batch Extraction 未实现**。隐式偏好和复杂语义规则无法通过 Regex 提取。

**规格**：
- 触发条件：累积 10 轮用户对话或 50KB Session Log 后批量提取
- Prompt 设计：新建 `prompts/extract-convention-batch.md`，输入为累积对话文本，输出为 JSON Convention 数组（含 provenance=inferred, confidence=50-70）
- 成本控制：每次批量提取 ≤ 1 次 LLM 聃用，maxTokens ≤ 2000
- fallback：LLM 失败时仅保留 Layer 1 Regex 结果

#### 缺口 2：Memory Phase 1/2 缺少规则 fallback

当前 Memory 的 stage_one 和 consolidation **完全依赖 LLM**，LLM 不可用或返回空时 Memory 完全无法产出。这是系统中最脆弱的点。

**规格**：
- Phase 1 规则 fallback：从 .jsonl 中提取关键工具调用序列 + 错误模式作为最小可用 raw_memory（无语义理解，但有结构信息）
- Phase 2 规则 fallback：从 Phase 1 的 raw_memory 中拼接关键决策行作为最小 MEMORY.md（无整合，但有事实）
- fallback 质量：规则 fallback 的 raw_memory 仅有结构信息（工具调用、错误文本），无语义提炼；LLM 提取的 raw_memory 有语义提炼（技术决策、工作流归纳）
- 优先级：LLM 成功时使用 LLM 结果；LLM 失败时使用规则 fallback（保证 Memory 不空）

### 13.5 LLM 成本控制策略

| 策略 | 说明 |
|------|------|
| 使用 `smol` role | 背景提取使用低成本模型（如 GPT-4o-mini），不占用主模型 Token 预算 |
| 单次调用 Token 上限 | `maxTokens: 2000` — 超过此上限的输出被截断，触发 fallback |
| 批量累积 | Convention Layer 2 累积 10 轮或 50KB 后才触发一次 LLM 聃用 |
| 条件触发 | Skill LLM 精炼仅在 completedSuccessfully=true + toolCallCount >= threshold 时触发 |
| 重排条件 | Episode rerank 仅在 topCandidates > 3 且 llmRerank=true 时触发 |
| 失败即止 | `callBackgroundLlm` 失败时返回空字符串，不重试，直接 fallback |
| 离线可用 | 规则提取不需要 LLM，Agent 在 LLM 不可用时仍可基本运作 |

### 13.6 提取点合约

| 合约 | 说明 | 验证方式 |
|------|------|---------|
| Convention 三层提取完整 | Layer 1 Regex + Layer 2 LLM Batch + Layer 3 Fallback | 每层有独立测试；LLM 不可用时 Layer 2 跳过，Layer 1 + Layer 3 正常产出 |
| Memory Phase 1 不返回空 | LLM 失败时 fallback 到规则提取 | 模拟 LLM 返回空 → Phase 1 仍有 raw_memory 输出（结构信息） |
| Memory Phase 2 不返回空 | LLM 失败时 fallback 到规则拼接 | 模拟 LLM 返回空 → Phase 2 仍有最小 MEMORY.md 输出 |
| 所有 LLM prompt 在 .md 文件中 | 不内联 | 搜索代码中无模板字符串 prompt |
| LLM 提取不阻塞主会话 | 异步后台执行 | 主会话延迟不受 LLM 提取影响 |
| LLM 聃用失败不重试 | 直接 fallback | 模拟 LLM 聃用失败 → 无第二次调用 → fallback 结果生效 |