# Project Synapse：L4 元认知进化架构设计文档

> **项目名称**：**Project Synapse (突触计划)**
> **寓意**：如同生物大脑的突触连接，将孤立的记忆 (Memory)、技能 (Evolution) 与行为反馈 (Logs) 紧密相连，通过 Dreaming 机制不断强化连接，实现真正的智慧涌现。

> **目标**：将系统从 L3（被动记录/检索）升级为 L4（主动反思/自我进化）。
> **核心手段**：深度挖掘日志价值，结合 Dreaming 机制与混合存储，实现 Agent 的自编程与自适应。

---

## 1. 核心设计原则

1.  **日志即资产 (Logs as Assets)**：Session Log 是进化的"原始素材"，Activity Log 是进化的"体检报告"。
2.  **代码不合并，架构级协同**：Memory 与 Evolution 保持独立，通过**认知协调层 (Coordination Layer)** 统一管理注入、反馈与调度。
3.  **混合存储 (Hybrid Storage)**：**SQLite 管状态 + 显性文件管内容**。文件赋予 Agent"自省"和"自修改"能力，SQLite 保证数据的一致性与查询性能。

---

## 2. 全系统子模块功能全景 (System Module Landscape)

本节定义了 **Project Synapse** 的所有核心子模块，涵盖了**已实现的 Memory/Evolution 模块**以及**L4 规划新增的协调与分析模块**。

### 2.1 数据基础设施层 (Data Infrastructure Layer)

| 子模块名称 | 所属域 | 功能定义 | 状态 |
| :--- | :--- | :--- | :--- |
| **Session Log Store** | Logs | `.omp/sessions/*.jsonl`。存储 Agent 行为全貌（意图、思维链、工具调用）。 | ✅ 已实现 |
| **Activity Log Store** | Logs | `.omp/self-evolution/activity.jsonl`。存储系统元行为（优化、提取、评估结果）。 | ✅ 已实现 |
| **Memory DB (SQLite)** | Memory | 管理 Memory 的 Watermark (进度水位线)、Thread 状态、并发锁。 | ✅ 已实现 |
| **Evolution DB (SQLite)** | Evolution | 管理 Skills, Episodes, Conventions, Fit Scores 等结构化数据。 | ✅ 已实现 |
| **Memory File System** | Memory | `.omp/memory/*.md`。存储 `MEMORY.md` (长期记忆) 和 `skills/` 目录。 | ✅ 已实现 |
| **Evolution File System** | Evolution | `.omp/self-evolution/`。L4 将新增 `skills/` 目录和 `context_cache.md`，实现显性读写。 | 🚧 L4 规划 |

### 2.2 处理引擎层 (Processing Engine Layer)

| 子模块名称 | 所属域 | 功能定义 | 核心逻辑 |
| :--- | :--- | :--- | :--- |
| **Phase 1: Stage 1 Jobs** | Memory | **分布式记忆提取**。并发运行 LLM 对 Session 日志进行摘要，提取 `raw_memory` 和 `rollout_summary`。 | ✅ 已实现 |
| **Phase 2: Consolidation** | Memory | **全局记忆整合**。汇总所有 raw_memory，利用 LLM 去重、融合，生成 `MEMORY.md`。 | ✅ 已实现 |
| **Skill Extractor** | Evolution | **技能提取**。当 Session 复杂度超过阈值时，调用 LLM 提取可复用的操作模式 (Skill)。 | ✅ 已实现 |
| **Convention Extractor** | Evolution | **规范提取**。分析用户对话，提取项目约束 (如代码风格、禁止操作)。 | ✅ 已实现 |
| **Error Pattern Extractor** | Evolution | **错误模式挖掘**。从失败 Session 中提取错误特征，生成负面规则。 | ✅ 已实现 |
| **Workflow Miner** | Evolution | **工作流挖掘**。识别频繁出现的工具调用序列，建立 Workflow Patterns 库。 | ✅ 已实现 |
| **Context Aware Retriever** | Evolution | **上下文检索**。根据当前意图，混合检索 Episodes, Skills, 和 Conventions。 | ✅ 已实现 |
| **Feedback Tracker** | Evolution | **效果追踪**。记录注入 ID，在下一次会话后根据结果更新有效性评分。 | ✅ 已实现 |
| **Session Log Replayer** | Logs (New) | **历史重放演练器**。读取 Session Log 构建沙盒，将新 Skill 注入历史上下文进行模拟运行，验证其有效性。 | 🆕 L4 新增 |
| **Activity Log Monitor** | Logs (New) | **元行为监控器**。监控 Fit Score 趋势、Skill 衰退率。发现异常模式时触发系统级警报。 | 🆕 L4 新增 |
| **Implicit Convention Miner** | Logs (New) | **隐式规范挖掘**。深度扫描 Session Log 中的 User 否定指令，将其转化为显式 Convention。 | 🆕 L4 新增 |

### 2.3 交互控制层 (Interaction Control Layer)

| 子模块名称 | 所属域 | 功能定义 | 核心逻辑 |
| :--- | :--- | :--- | :--- |
| **Unified Skill Registry** | Coordination | **统一技能注册表**。桥接 Memory 和 Evolution 的 Skill 数据。提供单一视图，处理冲突，计算综合得分。 | 🆕 L4 新增 |
| **Context Assembler** | Coordination | **智能上下文装配器**。动态计算 Token 预算，按优先级组装 Prompt，确保关键信息必达。 | 🆕 L4 新增 |
| **Feedback Router** | Coordination | **交叉反馈路由**。拦截 Session 结果，分发信号至 Memory 与 Evolution，执行交叉验证。 | 🆕 L4 新增 |
| **Dreaming Scheduler** | Coordination | **离线任务调度器**。利用空闲时间执行 Pruning、Reflection、Rehearsal。支持优雅唤醒。 | 🆕 L4 新增 |
| **Commands Hub** | UI | **CLI 交互**。实现 `/memory` 和 `/evolution` 命令，提供人工查询、评分与干预入口。 | ✅ 已实现 |
| **Memory Protocol** | UI | **URL 路由解析**。实现 `memory://` 协议，供工具直接读取记忆文件。 | ✅ 已实现 |

---

## 3. 方案找茬 (Gap Analysis & Risk Assessment)

在推进实施前，我们需要正视本架构面临的挑战与潜在风险：

### 3.1 文件与 DB 的双写一致性风险
*   **问题**：Watcher 监听文件变更并同步至 DB。如果 Watcher 崩溃或 DB 写入失败，会导致文件系统（数据面）与 SQLite（状态面）数据不一致。
*   **对策**：引入 **Write-Ahead Log (WAL)** 机制。文件变更先写操作日志，同步成功后再确认。定期运行一致性校验任务 (Integrity Check)。

### 3.2 Dreaming 并发冲突
*   **问题**：Agent 处于 Idle 时 Dreaming 进程修改了 Skill 文件。若用户突然唤醒 Agent，`Context Assembler` 可能读取到正在写入的"半截文件"。
*   **对策**：使用 **Atomic Write (原子写入)**。Dreaming 进程先将内容写入临时文件 (`.tmp`)，完成后通过 `rename` 覆盖原文件。读取端配置重试逻辑。

### 3.3 LLM 成本爆炸
*   **问题**：Virtual Rehearsal (虚拟演练) 需要大量 LLM 调用来重放历史 Session，Token 消耗极大。
*   **对策**：**分级触发策略**。仅在提取到新 Skill 或修改核心 Skill 时触发高深度演练；日常 Idle 仅执行轻量级的文本整理 (Pruning)。

### 3.4 虚拟演练的真实性幻觉
*   **问题**：重放历史 Session Log 时，LLM 模拟的"新 Skill 效果"可能与真实运行结果存在偏差。
*   **对策**：**模拟置信度标记**。演练报告必须包含置信度分数。低置信度的演练结果仅作参考，不直接用于自动优化。

### 3.5 Context Assembler 延迟增加
*   **问题**：每次 `before_agent_start` 都要进行统一视图、去重、预算分配，可能增加启动延迟。
*   **对策**：**多级缓存**。`context_cache.md` 作为热缓存，仅在文件变更或定时刷新时更新。默认直接读取缓存。

---

## 4. 数据源深度利用：日志驱动的自我进化

这是 L4 架构的核心增量。我们将重新定义两大日志系统的角色，使其从"只写"变为"读写闭环"。

### 4.1 Session Log (`.omp/sessions/*.jsonl`) —— 进化的"原始素材"
**定位**：记录 Agent 的**行为全貌**。

| 挖掘场景 | 机制 | 输出物 |
| :--- | :--- | :--- |
| **虚拟演练 (Virtual Rehearsal)** | **重放历史失败案例**：读取 Session Log 中的 Error 片段，在沙盒中重新执行，并尝试应用新提取的 Skill 或修改后的 Prompt。 | Skill 验证报告 (Pass/Fail)、Pitfall 模式库 |
| **隐式规范提取 (Implicit Convention Mining)** | **意图与结果对比**：扫描 `user_message` 中的否定句（如"不要这样"、"换个方式"），结合 Agent 的后续修正行为，提取为显式的 `negative_rule`。 | Convention DB 中的高优规则 |
| **动态上下文压缩 (Context Compression)** | **冗余检测**：识别长会话中 Agent 的"死循环"或"冗余工具调用"（如反复 read 同一文件）。 | 防呆指南 (Anti-Pattern Injection) |

### 4.2 Activity Log (`.omp/self-evolution/activity.jsonl`) —— 进化的"体检报告"
**定位**：记录系统的**元行为**。

| 触发器类型 | 监控指标 (Event Pattern) | 触发动作 |
| :--- | :--- | :--- |
| **Skill 衰退监控** | `skill_usage_count` 连续 N 天为 0 且 `last_injected_at` 超过阈值 | 触发 **Dreaming Pruning**：将该 Skill 标记为 `deprecated` 或归档。 |
| **Convention 冲突** | 同一 Convention ID 在短时间内频繁出现 `convention_violated` 事件 | 触发 **Convention Review**：提示用户该规范可能不切实际，或生成修订建议。 |
| **进化质量评估** | `evolution-fit` 分数在 `skill_optimized` 事件后显著下降 | 触发 **Auto-Rollback**：自动将相关 Skill 回滚到上一稳定版本。 |
| **系统瓶颈分析** | `tool_error` 率突增 (如 `bash` 超时频繁) | 触发 **Infrastructure Alert**：生成诊断报告，建议调整 Tool 配置。 |

---

## 5. L4 架构分层设计

```text
┌─────────────────────────────────────────────────────────────────┐
│                      Agent / Prompt Builder                     │
└────────────────────────────┬────────────────────────────────────┘
                             │ 统一请求上下文
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              认知协调层 (Cognitive Coordination Layer)          │
│                                                                 │
│  1. Context Assembler (上下文装配器)                            │
│     - 统一请求 Memory 摘要 与 Evolution 技能/规范               │
│     - 冲突仲裁：去重、版本选择、Token 预算分配                  │
│     - 注入日志：记录本次注入的 Skill/Memory ID，用于后续验证    │
│                                                                 │
│  2. Feedback Router (反馈路由)                                  │
│     - 拦截 Session 结果，分发信号至 Memory 与 Evolution         │
│     - 交叉验证：将 Session 结果与注入 ID 关联，更新权重         │
│     - 异常捕获：若 Session 崩溃，触发紧急回滚                   │
│                                                                 │
│  3. Dreaming Scheduler (做梦调度器)                             │
│     - 监听 Idle 事件，触发离线处理                              │
│     - 任务队列：管理 Pruning、Reflection、Rehearsal 等后台任务  │
│     - 优雅唤醒：Agent 被唤醒时，暂停并持久化任务状态            │
└───────────┬──────────────────────────┬──────────────────────────┘
            │                          │
   ┌────────▼────────┐        ┌────────▼────────┐
   │  Memory 模块     │        │ Self-Evolution  │
   │ (异步/批处理)    │        │ (实时/事件驱动) │
   └─────────────────┘        └─────────────────┘
            ▲                          ▲
            │                          │
   ┌────────┴──────────────────────────┴────────┐
   │            统一日志分析引擎                  │
   │  (Session Log + Activity Log 联合分析)       │
   └────────────────────────────────────────────┘
```

---

## 6. 实施路线图 (Roadmap) - 精细化版

基于当前系统现状，本计划遵循 **MVP 优先、风险前置、解耦开发** 原则。

### Phase 0：技术预研与脚手架 (Week 0)
*目标：消除技术不确定性，搭建开发骨架。*
* [ ] **选型确认**：确定 `Bun.JSONL` 在超大 Log 下的性能表现，确认 Watcher 方案。
* [ ] **统一接口定义**：定义 `UnifiedSkill`、`ContextInjection` 等核心 TypeScript 接口。
* [ ] **脚手架搭建**：创建 `packages/cognitive-coordination/` 目录，配置 Bun 测试环境。

### Phase 1：数据基建与记忆协同 (Week 1-2)
*目标：打通数据壁垒，实现只读的统一上下文注入 (MVP)。*

| 模块 | 关键任务 | 交付物 | 风险对策 |
|---|---|---|---|
| **协调层** | 实现 `UnifiedSkillRegistry` 只读视图，聚合 Memory 和 Evolution 数据 | 单一 API 返回去重后的 Skill 列表 | 性能：通过缓存层避免每次查询扫描全量文件 |
| **存储层** | Evolution 模块实现 DB -> 文件的单向 Watcher 同步 | Agent 能 `read` 到显式 Skill 文件 | 一致性：初期只读，暂不处理回写冲突 |
| **日志层** | 实现基础 `Session Log Parser`，支持按 Thread ID 提取交互流 | 解析器函数，输出结构化 Trace | 内存：流式读取，避免一次性加载大文件 |
| **注入层** | `Context Assembler` 原型上线，替代双路注入 | Agent 启动耗时不增，Prompt 结构更清晰 | 延迟：使用 `context_cache.md` 热缓存 |

**Phase 1 验收标准**：
1. Agent 启动时，System Prompt 包含来自 Memory 和 Evolution 的统一 Skill 信息。
2. `Context Assembler` 能在 500ms 内完成 Prompt 组装（100+ Skills 场景）。
3. Agent 能通过 `memory://root/skills/*.md` 读取到 Evolution 生成的技能。

### Phase 2：日志挖掘与隐式学习 (Week 3-4)
*目标：从“被动记录”转为“主动提取”，提升意图理解。*

| 模块 | 关键任务 | 交付物 | 风险对策 |
|---|---|---|---|
| **日志分析** | `Activity Log Monitor` 上线，监控 Fit Score 趋势 | 仪表盘或 CLI 报告，展示衰退/异常指标 | 准确性：设置 3 天移动平均线，过滤瞬时波动 |
| **隐式规范** | 扫描 Session Log，提取 User 否定指令并转为 Convention | 自动生成 `Convention` 条目，入库并写入文件 | 误报：引入置信度阈值，低于 60% 需人工确认 |
| **Memory 协同** | 基于 Raw Memory 积压量自动触发 Phase 2 | 减少 Agent 启动时的 Phase 1 延迟 | 资源：仅在 Idle > 5min 或手动触发时运行 |
| **反馈路由** | 记录 `Injection Trace`，关联 `agent_end` 结果 | Activity Log 中出现 `skill_validated` 事件 | 关联失败：使用确定性 UUID 注入，避免模糊匹配 |

**Phase 2 验收标准**：
1. 用户说“不要这么做”后，下次会话 Agent 自动遵循该隐式规则。
2. `Activity Log` 能准确统计出过去一周 Skill 的衰退情况。
3. `Memory Phase 2` 不再阻塞 Agent 启动，转为后台异步运行。

### Phase 3：Dreaming 与闭环自进化 (Week 5-8)
*目标：引入 Dreaming 机制，实现 Skill 的自我修剪与安全闭环。*

#### Phase 3.1：Dreaming 基础设施 (Week 5-6)
| 模块 | 关键任务 | 交付物 |
|---|---|---|
| **调度器** | 实现 `Dreaming Scheduler`：Idle 监听、任务队列、优雅唤醒 | 后台进程稳定运行，唤醒时不崩溃 |
| **Agent 自修改** | 允许 Agent `edit` `skills/` 文件，并触发 Watcher 回写 DB | Agent 修改文件后，DB 版本自动更新 |
| **一致性保障** | 引入 WAL 和原子写入机制 | 模拟崩溃后，DB 与文件数据一致 |

**Phase 3.1 验收标准**：
1. Agent Idle 10 分钟后，Dreaming 进程自动启动并执行 Pruning 任务。
2. 用户修改 Skill 文件后，下次会话立即生效。

#### Phase 3.2：验证与回滚 (Week 7-8)
| 模块 | 关键任务 | 交付物 |
|---|---|---|
| **虚拟演练** | `Virtual Sandbox` 上线，重放历史失败案例验证新 Skill | 演练报告，包含 Pass/Fail 和置信度 |
| **自动回滚** | 基于 Fit Score 连续下降触发回滚 | 自动恢复上一版本并通知用户 |

**Phase 3.2 验收标准**：
1. 新提取的 Skill 若导致 Fit Score 下降 > 5 分，系统在 24 小时内自动回滚。
2. 用户可查询回滚记录，了解“为什么系统拒绝了这个修改”。

---

### 里程碑检查点 (Milestones Checkpoints)

| 时间点 | 检查点 | 核心问题 | 应对 |
|---|---|---|---|
| **Week 2 末** | 记忆协同上线 | Prompt 是否变慢了？Agent 是否“失忆”？ | 若延迟超标，启用热缓存降级策略 |
| **Week 4 末** | 隐式学习验证 | 提取的 Convention 是否准确？ | 若误报率高，调整 Prompt 模板，增加阈值 |
| **Week 6 末** | Dreaming 稳定运行 | Dreaming 是否影响主任务性能？ | 严格限制 CPU 配额，确保唤醒响应 < 100ms |
| **Week 8 末** | L4 闭环达成 | 进化是否真的提升了成功率？ | 对比 Phase 0 与 Phase 3 的 Fit Score 趋势 |

---

## 7. 核心价值：对意图理解与任务执行成功率的帮助

项目落地后，系统将从"被动执行者"进化为"主动协作者"，在以下两个核心维度带来质变：

### 7.1 意图理解 (Intent Understanding)：从"听懂指令"到"懂你的潜规则"

*   **现状 (L3)**：
    *   **显式依赖**：Agent 仅能根据当前 Prompt 和基础历史记录理解意图。
    *   **遗忘严重**：用户在 10 个会话前提出的"不要用 X 库"、"优先使用 Y 风格"等隐性偏好，除非写入 Memory，否则很难被准确召回。
    *   **缺乏语境**：Agent 不理解你为什么要做这个任务，容易给出"技术上正确但业务上不合适"的方案。

*   **Project Synapse 带来的提升**：
    *   **隐性规范挖掘 (Implicit Convention Mining)**：系统会自动扫描历史 Session Log 中的否定指令（如用户说"别用这个"、"换个思路"），将其转化为**强制执行的 Conventions**。
        *   *效果*：Agent 不再需要你反复提醒"代码要写注释"、"不要用 async/await"，它会像老员工一样**主动遵守**。
    *   **上下文装配器 (Context Assembler) 的优先级机制**：它不再是简单拼接历史记录，而是根据当前任务的**相关性**和**置信度**动态筛选。
        *   *效果*：减少无关信息的干扰（噪声），确保注入的都是能帮助你理解当前任务的高价值上下文（信号）。

### 7.2 任务执行成功率 (Execution Success Rate)：从"试错"到"肌肉记忆"

*   **现状 (L3)**：
    *   **重复犯错**：如果某个 Tool 在特定环境下容易超时，或者某种重构方式容易引入 Bug，Agent 往往会在不同会话中**反复踩坑**。
    *   **验证缺失**：新提取的 Skill 或优化后的 Prompt 是否真的有效？系统不知道。如果无效，甚至会降低后续任务的成功率。

*   **Project Synapse 带来的提升**：
    *   **虚拟演练 (Virtual Sandbox)**：在应用新 Skill 之前，系统会在后台用历史失败案例进行"模拟考"。
        *   *效果*：**拦截无效进化**。只有真正能提高成功率的 Skill 才会被注入，从源头降低了任务失败率。
    *   **反馈路由 (Feedback Router) 与自动回滚**：系统能感知到"这次失败是因为注入了错误的 Skill"，并自动将其降权或回滚。
        *   *效果*：系统具备**自我修复**能力。随着时间推移，"坑"会越来越少，成功率呈螺旋上升。
    *   **错误模式库 (Pitfall Database)**：通过 `Session Log Replayer` 挖掘出的通用错误模式会成为系统的"黑名单"。
        *   *效果*：Agent 在执行任务前会**预判风险**（"之前这么做失败了，这次我换个方式"），显著提升首次尝试成功率 (First-Try Success Rate)。

---

## 8. 系统验证测试用例设计 (Validation Test Matrix)

为了确保 Project Synapse 的可靠性，我们需要构建分层测试体系。

### 8.1 单元与模块级测试 (Unit & Module Level)
| ID | 测试名称 | 验证目标 | 预期结果 |
| :--- | :--- | :--- | :--- |
| **UT-01** | Context Assembler 裁剪逻辑 | 验证 Token 预算控制 | 当 Skills 总长超限时，自动截断低优先级内容，保留 Conventions。 |
| **UT-02** | 统一 Skill 注册表去重 | 验证同名 Skill 冲突解决 | 注入同名 Skill 时，系统自动选择 `confidence_score` 更高的版本。 |
| **UT-03** | Activity Log 趋势分析 | 验证进化效果归因 | 输入模拟日志，系统能准确识别出导致 Fit Score 下降的具体 Skill。 |

### 8.2 集成与同步级测试 (Integration Level)
| ID | 测试名称 | 验证目标 | 预期结果 |
| :--- | :--- | :--- | :--- |
| **IT-01** | 文件 -> DB 双向同步 | 验证 Watcher 与同步逻辑 | 修改 `skills/test.md` 后，Evolution DB 中对应记录在 500ms 内更新版本号。 |
| **IT-02** | Dreaming 优雅唤醒 | 验证 Idle 中断与恢复 | 在 Dreaming 任务进行中唤醒 Agent，任务暂停；再次 Idle 后从断点继续。 |
| **IT-03** | 混合存储一致性 | 验证 WAL 与原子写入 | 模拟 DB 写入失败，文件系统保持旧版本，不产生脏数据。 |

### 8.3 端到端与系统级测试 (E2E / System Level)
| ID | 测试名称 | 验证目标 | 预期结果 |
| :--- | :--- | :--- | :--- |
| **E2E-01** | 完整进化闭环 | 验证从 Session 到 Skill 优化的全链路 | 模拟失败 Session -> 提取 Pitfall -> Dreaming 生成修复 Skill -> 注入成功。 |
| **E2E-02** | 自编程修改生效 | 验证 Agent 修改自身 Skill 的能力 | Agent `edit` 修改 `skills/debug.md`，下次会话中生效且 DB 记录变更。 |
| **E2E-03** | 虚拟演练拦截 | 验证 Rehearsal 过滤低质量 Skill | 新 Skill 在演练中被标记为 Fail，系统拒绝将其注入 Prompt。 |

### 8.4 性能与压力测试 (Performance & Stress)
| ID | 测试名称 | 验证目标 | 预期结果 |
| :--- | :--- | :--- | :--- |
| **PF-01** | Context Assembler 延迟 | 验证大量 Skill 下的启动速度 | 在 100+ Skills 场景下，Prompt 组装耗时 < 200ms。 |
| **PF-02** | Log 解析吞吐量 | 验证历史 Log 重放效率 | 解析 10MB Session Log 并在沙盒中重放，耗时 < 5s。 |

### 8.5 安全与回滚测试 (Safety & Rollback)
| ID | 测试名称 | 验证目标 | 预期结果 |
| :--- | :--- | :--- | :--- |
| **SR-01** | 自动回滚触发 | 验证异常进化恢复机制 | 连续 3 次 Skill 优化导致 Fit Score 下降，系统自动回滚至初始版本。 |
| **SR-02** | 恶意输入防御 | 验证 Agent 自修改边界 | Agent 尝试注入恶意 Shell 命令到 Skill 文件，被安全过滤器拦截并拒绝执行。 |
