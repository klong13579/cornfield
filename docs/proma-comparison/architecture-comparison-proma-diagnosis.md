# Cornfield × Proma 架构诊断与 Agent-first 方案

日期：2026-09-15

> 这是诊断和方案底稿，不是批准实施计划。源码结论来自 Cornfield 当前仓库和 `/tmp/Proma` 的静态检查；未做性能或端到端验收。

## 1. 核心决策

推荐采用：

```text
Agent-first product model
+ Project-scoped context
+ Session tree
+ optional isolated Session Process
```

- Agent：长期数字员工，拥有身份、配置、模型策略、权限、长期记忆和全局 Skills，可服务多个 Project。
- AgentDir：Agent 的物理 home，存配置、session、memory、skills、日志；不是用户主要业务概念。
- Project：业务/代码/文件上下文，可被多个 Agent 服务。
- WorkspaceContext：`Agent + Project + effective config/permission/skills/memory` 的一次有效工作上下文，不必成为独立顶级持久化对象。
- Session：Agent 在某个 Project/Context 上执行的一项具体工作。
- Schedule：创建 Root Session 的规则，不是 Session 本身。
- Worker：`AgentSession + TaskAssignment + ParentEdge + ExecutionPolicy`，不是第二套 Agent runtime。

关系：

```text
Agent
├── AgentDir / Profile / long-term Memory / global Skills
├── Project bindings
│   └── WorkspaceContext
│       └── Root Session
│           ├── Child Session A
│           └── Child Session B
└── Schedules → create Root Sessions
```

## 2. Proma 与 Cornfield 的定位差异

| 维度 | Cornfield | Proma |
|---|---|---|
| 中心 | Agent runtime 与平台 | Electron 专业工作台 |
| Agent | 独立 runtime/registry，可多端接入 | Pi runtime 嵌入桌面产品 |
| Workspace | 当前缺少统一领域对象，project/cwd/agentDir 容易混称 | `AgentWorkspace → AgentSession` 明确层级 |
| Session | JSONL 与多种入口，关系元数据较分散 | 富元数据，含 workspace、parent、delegation、exploration |
| Skill | 多来源、Provider scope、远程、xd、self-evolution | 静态 Markdown，按 workspace 管理 |
| 通信 | Wire、IRC（进程内）、intercom（跨进程） | IPC、EventBus、utility process channel |
| 任务编排 | squad：依赖、worktree、gate、reconcile、验收 | delegation：会话和结果摘要，默认不做代码合并 |
| UI | Web-app + Desktop 壳，可多端复用 | Electron Main/Preload/Renderer 一体化体验 |

## 3. Proma Workspace-first

Proma 的 Workspace 是上下文容器：项目根、项目文件、项目规则、Skills、MCP、workspace files 和 Sessions 围绕它组织。Session 元数据有 `workspaceId`，主会话、子会话和探索分支都归属某个 Workspace。

Workspace-first 的用户心智是：

```text
进入项目工作区 → 选择/恢复会话 → 在工作区内处理文件、Diff、终端和子会话
```

它解决项目上下文隔离；不代表 Agent 不存在。你的 Agent-first 方案应借鉴其 `WorkspaceContext` 作用域，但不必把 Workspace 做成产品最高层。

## 4. Agent / Workspace / Skill

### Agent

Cornfield 的 Agent 更适合作为长期数字员工主体；Proma 的 Agent 主要在当前工作区中作为执行能力出现。你的 Agent-first 方向适合跨项目记忆、领域身份和持续学习，但必须防止跨项目记忆泄露和规则污染。

### WorkspaceContext

不要把 AgentDir、cwd、project root、session folder 都叫 workspace。建议明确：

```text
AgentDir = Agent 长期资产的物理 home
Project = 文件/业务资源边界
WorkspaceContext = Agent 在 Project 上的有效运行上下文
Session = 一次具体任务
```

### Skill

Proma Skill：静态 Markdown、按 Workspace 管理、可启停。

Cornfield Skill：用户级/项目级/Provider 级、远程 Skill、xd:// discoverable tools，以及 self-evolution 产生的 EvolvedSkill。

前端至少展示：`source`、`scope`、`activation`、`version`、`enabled/deprecated`。Skill 与 xd:// 工具挂载不是同一个概念。

## 5. Session、子会话与进程

### Proma 的确定结论

源码调用链：

```text
AgentOrchestrator
→ PiUtilityAdapter
→ AgentRuntimeClient
→ utilityProcess.fork()
→ utility/agent-runtime.ts
```

每个 `AgentRuntimeClient` 拥有一个 utility process，注入 Session ID；stop 会 abort、shutdown、kill，并用 bootId/generation 防止旧进程事件污染。因此 Proma 的 Agent runtime 是独立 OS 进程，不是共享线程。

但 Proma 仍限制：单 Session query 串行、父 delegation 数量、委派深度和队列并发。独立进程不等于无限并发。

### Cornfield 当前状态

- `runSubprocess()`：同一个 Bun 进程内的 AgentSession 对象，共享 heap/event loop。
- 当前 IRC：通过 `AgentRegistry.global()` 做进程内协作，不能跨独立 cornfield 进程。
- `intercom`：通过 broker socket 跨进程通信，支持 parentId、mailbox、history、ask/reply、重连。
- squad worker：由独立 cornfield 进程承载，通常配合 worktree、intercom、state.json、gate、reconcile 和 integration worktree。

### 推荐边界

```text
同一 Session Process：AgentSession/Task ↔ IRC
不同 Session Process：Session Process ↔ intercom broker
```

IRC 是逻辑执行单元的进程内消息机制，不宣称 OS thread；Task Coordinator 才负责会话内并发、依赖、超时和取消。

## 6. Session 树与 Worker

树关系必须持久化，不能只在 UI 拼：

```text
Root Session
├── Child A
│   ├── Grandchild A1
│   └── Grandchild A2
└── Child B
```

节点至少需要：

```text
sessionId, agentId, projectId?, parentSessionId?, rootSessionId,
depth, kind, status, delegationRole?, objective,
resultRef?, resultBroughtBackAt?
```

`result_ready` 与 `result_brought_back` 分开。跨树通信不改变 parent edge。

Worker 不做独立业务实体，也不做第二套 runtime。使用两种执行策略：

```text
in-process      = 当前轻量 AgentSession/async task
isolated-process = 独立 cornfield Session process
```

## 7. Squad-programming 应成为通用编排基线

当前 squad 已经具备：

- `.squad.json` 任务包、parent、deps、scope、并发槽位；
- `state.json` 权威状态机；
- intercom 父子进程消息；
- worktree/shared-read/shared-write 隔离；
- GO gate、reconcile、gate verifiers；
- verifiedCommit 和 integration worktree；
- 父中断恢复、验收和清理。

不要另造脱离 squad 的 Session Tree scheduler。应该把 squad 的任务包和状态模型提升为通用 Orchestration Record，squad 作为代码任务策略。

职责：

```text
Session Tree Manager  → 父子关系、状态、结果、恢复
Process Supervisor    → 启停、crash、restart、并发上限
Task Coordinator      → 单会话并发、依赖、取消、聚合
Orchestrator/Squad    → 任务包、GO、gate、验收
IRC                   → 进程内消息
intercom              → 跨进程消息
```

## 8. 当前前端为什么混乱

当前 `web-app/src/router.tsx` 将 Home、Workspace、Agents、Records、Voice、Todo、Models、Insights、Memory、Tasks、Skills、Settings 作为同级 panel；这把工作对象、能力配置和系统管理混在一起。

另有：

- `panelRegistry/PanelDef` 与旧 `PAGE_META` 双份元数据；
- `/models` 壳和子路由的层级在导航中表达不足；
- Workspace 使用独立 Topbar，但 shell contract 未明确；
- `PiClientAdapter` 聚合通信和多个领域；
- `wire-server.ts` 混合传输、分发、权限和业务 handler；
- 文件、Agent、Session、Project 的 scope 在 UI 中不够显式。

建议目标导航：

```text
工作：Home / Workspace / Records
Agent：Agent 总览 / 项目 / 会话树
能力：Models / Skills / Memory / Todo / Voice
系统：Tasks / Insights / Diagnosis / Settings
```

但不应立即迁移所有目录；先稳定领域契约。

## 9. TODO 对比与 Agent 绑定

当前 `project-todo` skill 绑定 git toplevel 下的 `<projectRoot>/TODO.md`：项目 backlog、topic 链接、事实进度；自动化不得写入；它与会话级 `todo` 工具分离。当前根 `TODO.md` 是 Cornfield 项目工程台账。

Proma Todo 是结构化 planning manager 对象，支持状态、截止时间、提醒、标签，以及 Agent 创建/查询/修改；它更像用户日常规划系统，不是项目 Markdown 台账。

用户希望 TODO.md 与 Agent 绑定时，建议不要让现有 project TODO 改义。采用双层且明确来源：

```text
Agent
└── AgentTodoBoard（跨项目长期任务/提醒）

Project
└── TODO.md（项目工程台账）
```

如采用 Markdown Agent board，应使用明确的 `<agentDir>/TODO.md`，另建 `agent-todo` contract；禁止同一个 project-todo skill 根据上下文模糊选择两个 TODO.md，也不要自动双写。前端必须标注 scope 和 source。

## 10. Default Agent

Default Agent 是解析策略，不是特殊 Agent 类型：

```text
显式 session.agentId
  > project.defaultAgentId
  > workspaceContext.defaultAgentId
  > user.globalDefaultAgentId
  > system bootstrap agent
```

但 Schedule、Gateway webhook、子会话和历史 Session 恢复不得读取当前 UI 选择作为隐式默认；它们必须持久化 resolved `agentId`。候选 Agent 需检查存在、启用、模型可用、权限可用和 Project binding 有效；无可用候选时明确报错并要求选择。

## 11. 底座优先实施顺序

### Phase 0：术语和契约

定义 Agent、AgentDir、Project、WorkspaceContext、Session、Schedule、Worker、ContextItem；标出 owner scope 和权威存储来源。

### Phase 1：通用 Orchestration Record

抽象 squad 的任务包、state machine、依赖、并发、reconcile、gate 和 verified commit；现有 squad 通过 adapter 继续运行。

### Phase 2：Session Process Policy

引入 `in-process` / `isolated-process`；增加 Process Supervisor、握手、intercom 注册、退出、crash、restart、pending request 和全局并发限制。

### Phase 3：结果、权限和恢复

统一 event/result envelope；定义 ask/permission 上浮、取消、超时、重试、幂等；区分 result ready/brought back。

### Phase 4：研究型端到端闭环

主 Session 委派只读子 Session → 独立进程运行 → 状态回传 → 结果带回 → 父重启恢复。先不改代码文件。

### Phase 5：产品能力

文件编辑/选区引用/Diff → Session 树 → 可见终端 → 浏览器/日程/知识工作区。

### Phase 6：前端重组

收敛 PanelDef/PAGE_META、导航分组、领域 client、features 目录和 Workspace 工作台。

## 12. 目录树何时调整

现在不重排顶层 monorepo；保留 runtime、wire、client、web-app、desktop、gateway 边界。领域模型和两个以上真实工作流稳定后，再逐步形成：

```text
web-app/src/
├── client/
├── features/{agent,workspace,conversation,files,changes,collaboration,execution}/
├── layout/
├── pages/
└── state/
```

触发条件：领域有两个以上稳定模块、接口不再频繁变化、迁移有测试保护。不要先搬目录再寻找职责。

## 13. UX 文档

新方案的前端布局定义在仓库根目录：

```text
UX.md
```

它描述 Agent 入口、Project/WorkspaceContext、主/子 Session、Files/Diff/Artifacts、终端、浏览器、Skills、Memory、Schedule 和交互原则。


## 36. UX.md 与当前前端功能覆盖审计

当前 router 共确认 19 个路由、17 个独立页面组件和一个 models 子路由组。新版 `docs/proma-comparison/UX.md` 已覆盖全部现有功能，并补充目标交互：

| 当前功能 | UX.md 覆盖位置 | 处理结论 |
|---|---|---|
| Home | HomeView | 保留并增加 Agent/Project/继续工作入口 |
| Workspace/Composer/Transcript | Workspace、Conversation | 核心工作流 |
| Agents/Agent Detail | Agent 总览/详情 | 提升为 Agent-first 主入口 |
| Records/Playback/Diagnosis | Records/Playback/Diagnosis | 归入 Session 历史和运行质量 |
| Voice | VoiceView | 拆为语音输入、Jarvis、听记三个任务 |
| Todo | TodoView | 区分 Agent Todo、Project TODO、Session Todo |
| Models/Catalog/Providers/Config | ModelsView | 保留三层子路由，显示配置来源和覆盖范围 |
| Insights | InsightsView | 按 Agent/Project/Session 筛选 |
| Memory | MemoryView | 按 Agent/Project/Session/User scope |
| Tasks/Cron | TasksView | 绑定 Agent，Project 可选，显示 Execution Session |
| Skills | SkillsView | 显示 source/scope/activation/version/status |
| Settings | SettingsView | 系统配置与 Agent 配置分开 |
| FileExplorer/Artifacts | 文件与产物 | 纳入 Workspace workbench |
| Git/Diff | Changes/Diff | 按 Session、子 Session、Git 来源区分 |
| Mobile /m | 全局壳与移动端原则 | 保留上下文条和核心会话能力 |

覆盖判断：当前已有页面没有被遗漏；但有些功能在现有实现中仍是只读/壳或能力不完整，例如 Cron 创建运行、代码编辑器、完整 Diff、可见终端和通用浏览器。UX.md 记录的是目标交互，不把这些页面描述成已经完成。

## 37. D4 决策：Todo 归属 Agent，Project 为可选绑定

已确认 Todo 的唯一长期 owner 是 Agent；单条 Todo 可选绑定一个 Project。Project 页面只展示 Agent Todo 的 project 筛选结果，不维护第二份 Project Todo，也不自动双写。

```text
Agent
└── Todo
    ├── 通用任务（projectId = null）
    ├── Cornfield 任务（projectId = cornfield）
    └── DTC 任务（projectId = dtc）
```

建议字段：

```ts
interface AgentTodo {
  id: string;
  agentId: string;              // 必填，唯一 owner
  projectId?: string;           // 可选绑定
  title: string;
  notes?: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  dueAt?: number;
  reminders?: TodoReminder[];
  sessionRefs: string[];
  source: 'agent' | 'user' | 'schedule' | 'session';
  createdAt: number;
  updatedAt: number;
}
```

关系语义：
- Todo 表示待完成的长期工作；
- Session 是推进 Todo 的一次工作记录；
- Session 结束不自动完成 Todo；
- Schedule 可以触发 Todo 相关 Session，但不是 Todo 本身；
- Project 只是 Todo 的业务上下文，不拥有 Todo。

现有 `project-todo` skill 的职责需要后续调整为 Agent Todo 管理，并保留 Project 绑定筛选；现有根 `TODO.md` 的历史内容迁移前必须先确定归属 Agent，不能直接复制给多个 Agent。Markdown 还是结构化存储另行决策，本次不迁移文件。

## 38. 复用优先复核：删除重复底座

重新审查后，当前方案中下列能力已经存在，不应新建平行实现：

| 目标能力 | 现有实现 | 后续正确做法 |
|---|---|---|
| Session Todo | `todo-write.ts`、todo controller、会话 UI | 原样复用，仅在 UX 中继续显示于会话内部 |
| 进程内 subagent/task | `task/executor.ts`、`runSubprocess()`、concurrency limit | 保留为 Session 内部 Task，不升级为正式 Child Session |
| Session 持久化 | `session-manager.ts`、JSONL、parentSession 字段 | 扩展元数据，不新建第二套 session store |
| AgentDir 初始化 | `runAgentInit()`、`ensureAgentDir()`、`SKELETON_FILES`、`registerAgent()` | 增加 profile metadata/registry 接入，不新造 skeleton |
| 父子跨进程通信 | squad + intercom | 抽象 adapter，不新造 broker |
| 任务包状态机 | squad `.squad.json`/`state.json`/reconcile/gate | 泛化现有 schema，不新造独立 scheduler |
| 文件隔离 | squad worktree/shared-read/shared-write | 复用 isolation policy |
| Agent registry | coding-agent skeleton registry | Gateway 接入同一 registry，保留旧 agentDir fallback |

### Session 与 Task 的最终边界

```text
正式 Session
└── 独立会话记录和业务关系；Child Session 使用独立 cornfield 进程

Session 内部 Task
└── 当前 Session 内异步执行；可使用现有 runSubprocess/IRC；不进入 Session Tree
```

因此删除 `SessionProcessPolicy = in-process` 作为正式 Session 策略。保留：

```text
Child Session = isolated cornfield process
In-process Task = 现有 runSubprocess + IRC
```

### 修订后的工作包数量

原 15 个工作包过度拆分。复用优先后收敛为 **10 个工作包**：

```text
WP1 Agent/Project/Session/AgentTodo 契约
WP2 Agent Profile Registry + Gateway agentId 兼容解析
WP3 Agent init/skeleton 接入 Profile Registry
WP4 Default Agent 与 WorkspaceContext 解析
WP5 Squad Orchestration 泛化（复用 state/reconcile/gate）
WP6 Child Session Process Supervisor + intercom adapter
WP7 父子 Session 端到端闭环与恢复
WP8 首页快速会话/Session 工作台/多 Agent Session Tree
WP9 文件编辑/选区 ContextItem/Diff 工作流
WP10 Agent Todo UI、Skills/Memory/Schedule scope 和前端收口
```

其中不再单独创建：
- Session Todo 包；
- 独立 in-process Session runtime；
- 新 intercom broker；
- 新 Worker runtime；
- 新 Project Todo store；
- 新 AgentDir skeleton；
- 新 squad scheduler。

### 工作包依赖和并行

```text
WP1
├── WP2 ── WP3
├── WP4
└── WP5
WP5 + WP1
└── WP6
WP6
└── WP7
WP7
└── WP8
WP8
└── WP9
WP1 + WP2 + WP4 + existing project-todo
└── WP10
```

可用 squad 拆成三批：

- Squad A：WP1、WP2、WP3、WP4、WP5；WP2/WP5 在 WP1 后并行，WP3 依赖 WP2，WP4 依赖 WP1/WP2。
- Squad B：WP6、WP7；WP6 完成 contract 后 WP7 实现和验证。
- Squad C：WP8、WP9、WP10；WP8 是前端工作台基础，WP9 依赖 WP8，WP10 可在 WP1/WP2/WP4 完成后与 WP8 并行，但最终合体验证必须执行。

每批仍使用现有 squad-programming：`.squad.json`、`state.json`、intercom、worktree、gate、verifiedCommit、integration worktree 和 reconcile。