# 领域 Agent 客户端 v1：总体架构、实现评审与路线

> 状态：设计基线
> 日期：2026-09-06
> 关联：
> - `docs/agent-task-control-plane-v1.md`
> - `docs/agent-task-control-plane-v1-implementation.md`
>
> 本文是 Agent Client 的上层架构基线。Task Control Plane 是其中一个后续子系统，不再代表整个产品。

## 1. 产品目标

围绕用户的领域 Agent 打造个人 Agent 客户端。每个领域 Agent 是一个长期数字员工，拥有自己的身份、职责、私有知识、共享知识引用、工具、权限和企业入口；客户端持续理解使用者，并把经过筛选的用户上下文提供给相关领域 Agent，使它们逐步成为帮助管理公司的领域伙伴。

首批领域：

```text
coding / HR / 算法 / 软件 / 数据分析 / 机电结构 / 产品 / 融资
```

核心结果不是一个带 Agent 标签的 Kanban，而是：

```text
用户
  ↕ User Model
Agent Client
  ├── Agent Registry
  ├── AgentHome / Knowledge
  ├── Context Adapters
  ├── Collaboration Coordinator
  └── Task Control Plane
        ↕
领域 Agent 群体
```

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Agent Client                                                 │
│                                                              │
│  Agent Registry        User Model        Collaboration       │
│  (索引/状态/路径)      (用户理解真源)     Coordinator         │
│       │                      │                 │             │
│       ▼                      ▼                 ▼             │
│  AgentHome             Context Snapshot   Request/Result     │
│       │                      │                 │             │
│       ├── Private Knowledge  │                 │             │
│       ├── Shared Knowledge  │                 │             │
│       ├── Skills/Tools      │                 │             │
│       └── robot-context.md  │                 │             │
│                              │                 │             │
│                 Task Control Plane             │             │
│                 Topic → Package → Task → Run   │             │
└──────────────────────────────────────────────────────────────┘
             ▲                 ▲                 ▲
             │                 │                 │
      me-context / G-brain   Gateway          intercom / process
      只读来源与引用          原始消息事件      transport adapter
```

### 2.1 核心对象边界

```text
Agent
  长期身份、使命、职责、工具、权限、模型与渠道绑定

Agent Registry
  Agent 的索引、发现、路径、状态；不复制 Agent 定义和知识

AgentHome
  Agent 定义、运行上下文和私有知识的目录真源

Knowledge
  Agent Private / Domain Shared / Company Shared / External References

User Model
  客户端唯一用户理解真源：Observation、Stable Claim、Attention Topic

User Context Snapshot
  Session/Run 启动时按领域裁剪出的不可变用户上下文

Observation
  从消息、会话、任务和外部来源提取的带证据事实或候选，不等同正式状态

Task Control Plane
  Topic、Task Package、Task、TaskRun、Verification、Approval 和审计

Collaboration Request/Result
  持久业务协议；intercom 只是第一阶段实时传输适配器
```

### 2.2 Agent 与知识关系

```text
Agent Client
├── Company Shared Knowledge
├── Domain Shared Knowledge
├── Agent Registry
│   ├── coding Agent
│   ├── HR Agent
│   ├── 算法 Agent
│   ├── 软件 Agent
│   ├── 数据分析 Agent
│   ├── 机电结构 Agent
│   ├── 产品 Agent
│   └── 融资 Agent
└── User Model
```

每个 Agent 可以引用：

- 自己的 Agent Private Knowledge
- 所属领域的 Domain Shared Knowledge
- 按权限可读的 Company Shared Knowledge
- G-brain、me-context、DingTalk 等 External References

知识写入遵循：

```text
Observation → Knowledge Candidate → Approval/授权 → Knowledge Revision
```

领域 Agent 默认只有提议权。客户端运行时强制执行权限，不把 `AGENTS.md` 或 prompt 当作安全边界。

## 3. User Model

User Model 是客户端级唯一真源，不属于某一个领域 Agent，也不把 G-brain 当作自身数据库。

```text
me-context ─┐
G-brain ────┼→ 只读 Adapter → Observation → User Model
会话/任务 ──┘
```

### 3.1 数据层次

```text
Observations
  不可变原始观察，保留来源与证据，可按保留策略清理

Stable Claims
  经用户确认的偏好、决策习惯、边界和长期上下文；版本化，不静默覆盖

Attention Topics
  最近滚动 90 天关注的主题；自动观察、衰减，用户可置顶/降权/归档

User Context Snapshots
  注入某次 Session/TaskRun 的领域相关快照，记录 User Model revision
```

准入流程：

```text
Agent 提议 → 客户端审核 → 用户确认 → 写入 User Model
```

明确事实可以按已有授权直接记录，但必须保留来源。行为推断不能直接升级为稳定事实。

## 4. 企业上下文与钉钉

Gateway 负责统一采集、去重、游标和原始消息持久化；领域 Agent 按绑定范围做语义理解；客户端负责确认、正式写入和审计。

现有能力已经覆盖：

```text
dws chat list-all-conversations
→ robot-probe 主动枚举用户群
→ DingTalk robot/groups/robots/query
→ sessions.db upsert
→ robot-context.md 刷新
→ prompt-includes 注入 Agent
```

`robot-context.md` 是 Gateway 自动生成的 Agent 上下文投影，不是人工配置真源；人工编辑会被覆盖。动态群发现当前是显式 `cornfield-gateway robot-context probe`，不是持续后台 Monitor。

第一阶段消息策略：

```text
高优先级信号 → 规则实时筛选
普通消息 → 时间窗口批量理解
```

消息写入边界：

```text
原始消息 → Observation → 候选 → 确认/授权 → Task / Knowledge / User Model
```

不得把群聊中的模糊表达直接变成 `accepted`、正式决策、用户画像或公司知识。

## 5. 协作与运行模型

Agent 是长期身份，Session/Run 是按需启动的短生命周期执行实例。长期能力来自 AgentHome、知识、User Model Snapshot 和历史事实，不依赖一个永不结束的 LLM Session。

```text
Collaboration Request/Result = 持久业务协议
intercom = 同机实时 transport
Session JSONL = 完整会话事实
SQLite/Store = 状态与业务对象真源
```

客户端是跨 Agent 唯一协调器：

```text
primary Agent
  → Client Coordinator 创建 Collaboration Request
  → 生成最小上下文快照
  → 通过 intercom/process/gateway adapter 派发
  → 持久化 Result
  → primary Agent 验收或升级人工
```

Agent 之间不得直接互相修改任务、User Model 或知识库。

## 6. 当前实现 Review

### 6.1 已有且应复用

| 能力 | 当前证据 | 结论 |
|---|---|---|
| Agent Registry | `packages/coding-agent/src/skeleton/registry.ts` 的 `name → path` 注册、发现、stale 检查 | 可作为客户端 Registry 的底座；仍需补领域元数据和生命周期投影 |
| AgentHome 声明 | `skeleton/workspace.ts` 的 `.cornfield/workspace.json`，包含 knowledge、sessions、skills、members 等声明 | 已有目录内声明和 Registry 薄索引模式，适合扩展；不能再复制第二份语义配置 |
| Agent skeleton | `skeleton/dirs.ts`、`assets.ts`、`ensure.ts` 提供幂等骨架初始化 | 可复用；`topics/` 等新目录应通过骨架演进解决 |
| 多 Agent 发现/执行 | `task/discovery.ts`、`task/types.ts`、`task/executor.ts` | 可复用 Agent discovery、输出 schema、事件；executor 是进程内 subagent，不是长期 Agent Runtime |
| Session 持久化 | `src/session/` 与 `AgentStorage` 的 Bun SQLite/WAL/singleton | 可复用会话事实和存储约定；User Model 不应塞进 Session 表 |
| Agent 间实时通信 | `intercom-extension` 及其 broker | 可作为 Collaboration transport；不能作为业务状态真源 |
| 钉钉机器人上下文 | `packages/gateway/src/robot-context.ts` | 已有机器人身份、群/私聊投影和 prompt 注入 |
| 动态群发现 | `packages/gateway/src/robot-probe.ts`、CLI `robot-context probe` | 已有主动群枚举、机器人×群查询、sessions.db 幂等 upsert |
| Gateway 会话存储 | `packages/gateway/src/session-store.ts`、`gateway-message.ts` | 可作为原始会话/消息入口；还缺通用 Observation 层 |
| 现有工作区元数据 | `WorkspaceDeclaration.knowledge`、`memoryDir`、`docsDir`、`sessionsDir` | 已部分表达配置/知识/运行边界，适合先做语义收敛 |

### 6.2 部分实现

- Registry 目前主要是名称到路径的薄索引，Agent 的 domain、职责、渠道、权限和知识引用仍主要隐含在目录文件与配置中。
- AgentHome 与 workspace 仍基本合一；`workspace.json` 已有知识路径声明，但物理目录、状态、配置和业务内容尚未完全分离。
- `robot-context.md` 只提供“机器人所在会话”的投影；它不是任务进展理解，也没有 Observation、证据置信度和人工确认流程。
- Gateway 已能主动探测群，但 probe 是显式命令；没有按窗口批量理解、优先级筛选和领域 Observation store。
- `me-context` 已提供独立数据根、只读画像和决策边界；客户端尚无统一 User Model adapter/store。
- G-brain 已提供知识页面、来源引用、时间线和反向链接；客户端尚无把它纳入 User Model 的只读同步层。
- TaskTool、Task executor、session router 能支持即时 subagent 和运行中控制；尚无持久 Topic/Package/TaskRun/Collaboration 业务协议。
- Desktop 已有 Electron shell、sidecar、preload bridge 和 web-app 装载；尚无 Agent Registry、User Model 或领域 Agent 工作台 UI。

### 6.3 缺失能力

1. 客户端级 User Model store、revision、candidate/approval、Attention Topic 衰减和 Snapshot。
2. Agent domain metadata、生命周期、权限声明、知识引用和渠道绑定的统一运行时模型。
3. Agent Private/Domain Shared/Company Shared 的访问控制与知识写入审批。
4. Observation store：原始来源、证据、提取 Agent、置信度、去重和冲突。
5. DingTalk 原始事件到领域 Observation 的批量理解管线。
6. 持久 Collaboration Request/Result、状态、超时、重试、恢复与客户端协调器。
7. 跨非代码任务的执行资源、产物、Approval 和 Verification 语义。
8. 以 Agent 为中心的客户端 UI 和“我”页面。

### 6.4 设计冲突与风险

- 旧 Task Control Plane 文档把 v1 锁在 `agentId=default`、`kind=code`、Git repository/worktree；这可以作为代码域试点，但不能作为 Agent Client 的顶层模型。
- 现有 `agentDir ≈ workspace` 是可运行的存量约定，但配置、知识、业务内容和运行状态生命周期不同；现在不应先做全量搬家，应先通过 `workspace.json` 和接口语义隔离。
- `robot-context.md` 是自动生成投影，若把它当人工 binding 真源会与 Gateway 刷新冲突。
- intercom 的消息可靠性、生命周期和同机限制不满足持久协作协议，直接把它当状态库会导致丢状态和无法恢复。
- `TaskRun` 在不同设计中含义不同：本项目新控制面应区分领域 TaskRun、Observation Run、Collaboration Run 和未来 Schedule Run，不能只复用同名类型。

## 7. 实施路线：按影响面从小到大

排序原则：先做不改变现有运行语义的纯模型/只读投影，再做增量接线，最后做跨 Agent、权限和任务执行边界。每一步都应有独立验证，不先做全量 agentDir 物理迁移。

### R0：文档与术语收敛（最小影响）

**交付**：本架构文档成为上层基线；旧 Task Control Plane 文档标记为代码研发子系统；统一 Agent、AgentHome、workspace、Knowledge、User Model、Observation、TaskRun 词义。

**影响**：仅文档。

**验证**：文档链接、术语和依赖关系检查；不改运行代码。

### R1：扩展既有 AgentHome/Registry 元数据（低影响）

**交付**：在现有 `workspace.json`/Registry 模式上补齐 domain、mission 引用、knowledgeRefs、channelRefs、lifecycle/status 等索引或声明，不复制完整 Agent 配置；保留旧 AgentHome 兼容读取。

**复用**：现有 skeleton、`workspace.json`、Registry、`agent-cli`。

**不做**：不移动 knowledge、不迁移所有 agentDir、不启用复杂权限。

**验证**：现有 agent init/list/show/validate 测试 + 新增多领域 Agent 发现/旧目录兼容测试。

### R2：Agent Client 只读工作台（低到中影响）

**交付**：客户端能列出 coding、HR、算法、软件、数据分析、机电结构、产品、融资 Agent，查看使命、状态、知识引用和 `robot-context.md` 投影，并启动已有普通 Session。

**复用**：Registry、AgentHome、Desktop sidecar/web-app、现有 Session 创建。

**不做**：不写知识、不改 Task、不自动发群消息。

**验证**：桌面端/本地 web-app 只读冒烟；Agent 缺失、stale、robot-context 缺失可解释。

### R3：User Model 最小闭环（中影响）

**交付**：建立客户端 User Model store，支持 Observation、Stable Claim、Attention Topic、来源引用、确认/拒绝/修改/归档；先接用户直接表达和现有 `me-context` 的只读参考，不接自动群理解。

**复用**：me-context 独立数据根与只读边界；现有 session/event 持久化约定。

**不做**：不自动把行为推断写成 confirmed；不把 User Model 存进 G-brain。

**验证**：真实临时 DB/文件测试；确认、冲突、版本、90 天 Topic 衰减和来源可追溯。

### R4：G-brain 只读适配与 User Context Snapshot（中影响）

**交付**：把 G-brain 和 me-context 的相关内容按需归并为 Observation，生成按领域裁剪的不可变 User Context Snapshot，在新 Session 启动时注入并记录 revision。

**复用**：外部来源引用、Agent prompt/context 注入链。

**不做**：不复制整个 G-brain；不让领域 Agent 写 User Model；运行中不热替换 Snapshot。

**验证**：同一用户不同领域的投影隔离；来源冲突生成候选而非覆盖；Session 可复盘快照版本。

### R5：领域知识边界与候选写入（中到高影响）

**交付**：实现 Private/Domain Shared/Company Shared/External References 的读取边界；领域 Agent 产出知识候选，客户端审批后写入对应知识层并留下版本/来源。

**复用**：`WorkspaceDeclaration.knowledge`、现有 knowledge/handbook、G-brain 引用规则。

**不做**：不物理迁移全部 knowledge；不一次性实现跨 Agent 写锁。

**验证**：越权读取/写入被拒绝；候选、审批、撤回和冲突可追溯。

### R6：DingTalk Observation 管线（高影响）

**交付**：复用 Gateway 的动态群发现、sessions.db 和 robot-context；增加原始消息事件到 Observation 的只读管线：高优先级规则实时筛选，普通消息批量摘要；用户可查看领域进展、风险、阻塞和待确认事项。

**复用**：`robot-probe.ts`、`robot-context.ts`、Gateway session store、已绑定 account/群能力。

**不做**：不自动改正式 Task 状态；不自动群发；不把 `robot-context.md` 改成人工编辑文件。

**验证**：使用真实持久化和 fake RPC/消息事件，覆盖去重、游标、批处理、证据引用和失败重试。

### R7：通用 Task/Artifact/Approval 基础（高影响）

**交付**：把现有代码专用 Task Control Plane 的底层协议抽成可扩展任务：Task kind、Execution Resource、Artifact、Verification/Approval；code 任务继续支持 Repository/Worktree，dataAgent 可使用 Data Workspace/Report 等资源。

**复用**：旧 Task Control Plane 的状态机/事件/SQLite 设计，但不直接沿用 `kind='code'`、repository 必填和 default Agent 全局锁死。

**不做**：不立即实现所有业务任务类型；先落 `code` 与 `analysis/report` 两种最小策略。

**验证**：代码任务和数据分析任务各有真实端到端主链；非代码任务不要求 Git merge。

### R8：Collaboration Coordinator 与多 Agent 协作（高影响）

**交付**：客户端持久化 Collaboration Request/Result，设置 primary Agent 和 collaborators，生成最小上下文快照，通过 intercom/process adapter 传输，支持超时、失败、重试、恢复、冲突和人工升级。

**复用**：intercom 作为 transport，Session JSONL 作为事实，现有 subagent 输出 schema 作为结果校验参考。

**不做**：不让 Agent 直接互调；不把 intercom 消息当状态库；不自动扩大任务范围。

**验证**：至少完成一次 product + algorithm/software 的跨领域协作，断开 transport 后仍能从持久状态恢复。

### R9：Task Package/Main Worker 研发交付闭环（最大影响）

**交付**：把旧控制面作为一个 Agent/Task 类型的执行实现：Topic → Task Package → 一个 Main Worker → 子 Task/TaskRun → 验收/rework → 人工合并或发布。Main Worker 手动启动，支持 waiting_user；非代码任务走自己的 Artifact/Approval 收尾。

**复用**：`docs/agent-task-control-plane-v1*.md` 的领域决策、现有 TaskTool/session/worktree/事件能力。

**不做**：不把 Main Worker 做成全局 Dispatcher；不自动启动、自动合并、自动 stale 回收。

**验证**：代码研发、数据分析各跑通一条人工可控链；同一 Task 的 rework 保留历史；跨 Agent 协作结果可追溯。

### R10：主动协作与持续学习（最大影响）

**交付**：在稳定的 User Model、Observation、Knowledge 和 TaskRun 之上，增加周期性领域摘要、Attention Topic 更新、知识候选推荐、跨领域提醒和可解释主动建议。

**复用**：Gateway 事件、User Model、TaskRun、Approval。

**不做**：不默认自动执行高风险动作；不把推荐直接变成持久任务。

**验证**：推荐理由、证据、去重、忽略/归档和用户撤销均可审计。

## 8. 明确不做的前置重构

在 R0-R6 期间不做：

- 全量物理拆分所有现有 agentDir
- 把 knowledge/整体搬出 AgentHome
- 重写现有 TaskTool/executor
- 把 robot-context.md 改成手工配置
- 把 G-brain 改造成 User Model 数据库
- 为所有领域 Agent 一次性实现完整任务系统
- 让钉钉群消息自动改变正式任务、预算、人事或用户画像

原则：先用接口、声明和只读投影把边界立住；只有真实共享知识、独立备份或权限隔离需求出现时，再对 agentDir 做 expand-contract 迁移。

## 9. 第一阶段建议

当前最适合立即执行的是 **R0 + R1 的最小切片**：

1. 把本文作为总体架构基线。
2. 将现有 Agent Registry/WorkspaceDeclaration 的扩展点定下来。
3. 先做只读多领域 Agent 列表和详情。
4. 用真实现有 `robot-context.md` 展示机器人和绑定群。
5. 暂不进入旧的 9 张 Task Control Plane tickets。

完成这一步后再拆 Agent Registry、User Model 和 Agent Context Snapshot 的实现 tickets。

## 10. 版本记录

### v1.0 — 多领域 Agent 客户端架构基线

- 明确 Agent Client 的核心目标是管理并培养多领域长期 Agent。
- 引入 Agent Registry、AgentHome、分层 Knowledge、User Model、Attention Topics、Observation 和 User Context Snapshot。
- 确认 me-context/G-brain 为只读参考来源，客户端 User Model 为统一真源。
- 确认 Gateway 统一采集钉钉原始消息，领域 Agent 生成 Observation，客户端负责正式写入和审计。
- 将 Collaboration Request/Result 定义为持久业务协议，intercom 定义为第一阶段 transport。
- 将原 Agent Task Control Plane 降级为后续 Task/TaskRun 子系统，并按影响面从小到大排列实施路线。

### v0.1 — 领域 Agent 客户端目标

- 首批领域：coding、HR、算法、软件、数据分析、机电结构、产品、融资。
- 每个领域 Agent 拥有私有知识库，并可引用领域共享和公司共享知识。
- 客户端持续理解使用者的偏好、决策习惯、近期关注和边界。