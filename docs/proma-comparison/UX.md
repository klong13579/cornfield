# Cornfield Agent-first UX 设计

版本：v0.1  |  状态：诊断后的目标交互方案

## 0. 设计核心

```text
Agent（谁在工作）
  → Project / WorkspaceContext（在哪个业务上下文工作）
    → Session（正在做什么）
      → Context Items（引用什么）
        → Child Sessions（如何并行）
```

用户永远能看到当前上下文：

```text
[Agent] / [Project] / [Session]
```

`AgentDir` 是内部存储实现，不作为一级用户导航。

## 1. 全局应用壳

```text
AppShell
├── AgentSwitcher（当前 Agent）
├── ProjectSwitcher（当前 Project）
├── QuickActions（新会话、委派、搜索、语音）
├── PrimaryNav
├── MainContent
└── GlobalStatus（连接、进程、待处理、更新）
```

桌面布局：左侧导航 240px，中间主内容，Workspace 页面可打开右侧工作区和底部终端。移动端使用抽屉，不隐藏当前 Agent/Project/Session 上下文。

## 2. 一级信息架构

### 工作

- 首页 `/`
- 当前工作台 `/workspace`
- 会话记录 `/records`

### Agent

- Agent 总览 `/agents`
- Agent 详情 `/agents/:id`
- 项目绑定
- 会话树

### 能力

- 模型 `/models`
- Skills `/skills`
- Memory `/memory`
- Todo `/todo`
- 语音 `/voice`

### 系统

- 定时任务 `/tasks`
- 用量 `/insights`
- 诊断 `/records/.../diagnosis`
- 设置 `/settings`

导航显示任务分组，不再把 12 个 panel 作为同权重图标平铺。`PanelDef` 是唯一导航元数据来源；迁移完成后删除 `PAGE_META`。

## 3. 首页 HomeView

目标：快速开始工作，不承担完整 Agent 管理。

区域：

1. 当前 Agent 卡片：身份、状态、默认模型、正在运行的 Session；
2. 项目快捷入口：最近项目、绑定项目、新建/绑定项目；
3. 继续工作：最近 Session、未带回结果、失败任务；
4. 今日：Agent Todo、Schedule 执行异常、需用户确认的权限；
5. Composer：默认使用当前 Agent，可显式切换 Agent/Project。

空态：没有 Agent 时引导创建/选择；没有 Project 时允许无项目会话，但明确文件工具不可用或使用临时目录。

## 4. Agent 总览 AgentsView

目标：管理长期数字员工，而不是查看一次会话。

列表卡片：

- 名称、身份、描述、启用状态；
- AgentDir 不直接展示路径，只显示存储健康；
- 默认模型和模型健康；
- 服务项目数量；
- 运行中/等待中 Session 数；
- Skills 和 Memory 健康度；
- 最近活动和定时任务异常。

筛选：启用/停用、运行状态、最近活动、项目。操作：打开详情、新建 Session、绑定 Project、设置为全局默认 Agent。

## 5. Agent 详情 AgentDetailView

顶部固定：Agent 名称、身份、状态、启用/停用、全局默认标记。

Tab：

```text
概览 | 项目 | 当前工作 | 会话树 | Skills | Memory | 定时任务 | 配置
```

### 概览

显示当前有效模型、权限摘要、最近 Session、待处理结果、错误和资源使用。

### 项目

显示 AgentProjectBinding：项目、角色、权限模式、项目默认状态、最近工作。允许绑定/解绑，但解绑需提示现有 Session 的处理方式。

### 配置

分身份、模型、工具权限、默认 thinking、记忆策略和通知策略；显示配置来源：Agent / Project / Session override。

## 6. Project / WorkspaceContext

Project 不是一个额外的孤立一级页面，而是当前 Agent 的服务对象和上下文切换器。

```text
WorkspaceContext
├── Agent profile
├── Project root/files
├── Project instructions
├── effective Skills
├── effective MCP
├── effective Memory
├── permission intersection
└── current Session
```

切换 Agent 或 Project 时必须显示变更摘要：模型、权限、Skills、Memory 和文件根目录。不得静默切换。

Project 面板区域：项目根、Git 分支/worktree、绑定 Agents、该 Agent 绑定本项目的 Todo 筛选、Project Skills、项目规则、最近 Sessions。

## 7. WorkspaceView 当前工作台

```text
┌──────────────┬──────────────────────┬──────────────────────┐
│ Session Tree │ Conversation         │ Workbench            │
│              │                      │ Files                │
│ Root         │ Transcript           │ Changes              │
│ ├ Child A    │ Composer              │ Artifacts            │
│ └ Child B    │ Context references   │ Child sessions       │
│              │ Permission cards     │ Terminal / Browser   │
└──────────────┴──────────────────────┴──────────────────────┘
```

顶部上下文条：Agent / Project / Session、连接状态、进程健康、新建 Session、委派、紧凑模式。

主会话是决策中心；右侧是辅助工作区；底部终端是可选区域。右侧只注册真实能力，不为每条 Wire 命令建页面。

## 8. SessionSidebar / 会话树

同时支持时间列表和树视图：

```text
Root Session
├── Research: Proma editor
├── Review: Wire protocol
└── Implement: file editor
```

节点字段：标题、kind、目标、Agent、Project、状态、模型、进程健康、更新时间、结果是否可带回。

操作：打开、重命名、委派、继续、暂停、取消、重试、查看日志、带回结果。跨分支消息显示来源，但不改变 parentSessionId。

状态分别显示：

```text
任务状态：created/running/waiting/completed/failed/cancelled
进程状态：starting/healthy/crashed/stopped
结果状态：none/ready/brought_back
```

## 9. Conversation / Transcript / ComposerBar

消息支持的 ContextItem：文件、文件夹、选区、Diff、产物、历史 Session、子会话结果、终端输出、浏览器页面、Todo、Schedule。

每个引用显示：类型、标题、来源、scope、版本。用户可从右侧拖入、使用 @、选区后直接提问。

Composer 必须显示当前 Agent/Project/Session，支持：模型、thinking、权限模式、是否委派、附件和 Slash。不要把上下文直接拼成长文本而丢失来源。

## 10. 子会话交互

创建面板字段：

- 目标；
- 父 Session（默认当前）；
- Agent（默认当前，可授权切换）；
- Project；
- execution policy：in-process / isolated-process；
- 权限模式；
- 模型和预算；
- scope/files；
- 验收标准；
- 最大并发和依赖。

完成后显示：结果摘要、产物、改动、验证记录、进程日志。`result ready` 必须通过用户或主 Agent 的明确操作变成 `brought back`。

## 11. 文件 FileExplorer / Editor / Preview

```text
FileExplorer → Editor/Preview → 选区引用 → Agent 修改 → Changes/Diff → 保存
```

文件标签显示路径、来源、版本、未保存状态。编辑器支持代码和 Markdown；Markdown 可采用 CodeMirror + live preview 思路。

必须处理：加载中、权限错误、文件不存在、外部修改冲突、保存失败、大文件降级、只读文件。文件写入必须经过领域 client，不由组件直接拼 Wire command。

## 12. Changes / Diff

Changes 按来源分组：

```text
本 Session 改动 | 子 Session 改动 | Git working tree 改动
```

支持文件树、unified/split、跳转到文件、回滚/接受（需要权限）。大文件显示明确降级原因。Diff 页面必须能回到产生它的 Session 和 ContextItem。

## 13. ArtifactsPanel

显示当前 Session 产物：HTML、图片、Markdown、文本、报告。每个条目显示生成者 Session、时间、路径、版本和可带回状态。支持预览、全屏、复制引用、让当前 Agent 分析。

## 14. Terminal / Browser

### Terminal

区分用户终端和 Agent 终端；显示 Session、Project、cwd、命令、输出 sequence、中断、退出码和进程健康。用户终端可交互，Agent 终端默认只读观察。

### Browser

显示浏览器 Profile、授权范围、当前页面、来源 Session；登录态和跨 Project 使用必须明确授权。浏览器结果作为 ContextItem 引用，不自动把整页塞入主上下文。

## 15. Records / Playback / Diagnosis

### RecordsView

按 Agent、Project、Session kind、状态和时间筛选。列表标出主/子/定时 Session，支持打开树、回放、查看产物和验证记录。

### PlaybackView

按时间显示消息、工具调用、ContextItem、权限决策、子会话事件、进程事件和结果带回。可跳转到产生文件改动的轮次。

### DiagnosisReportView / DimensionReportsView

诊断属于 Session/运行质量，不是 Agent 配置。显示输入、工具链、性能、推理、输出、元数据等维度，并链接原始 Session 和事件。

## 16. SkillsView

Agent 视角：全局 Skills、演化 Skills、质量分、版本、废弃状态。

Project 视角：当前有效 Skills、来源、覆盖规则、启用状态、加载失败原因。

```text
source: builtin/project/user/remote/evolved
scope: global/project/agent
activation: loaded/discoverable/blocked
status: enabled/disabled/deprecated/unavailable
```

远程 Skill 安装、项目绑定和 Agent 全局能力必须分开操作。

## 17. MemoryView

按 scope 分区：

```text
Agent identity/domain memory
Project memory
Session memory
User memory（只读投影）
```

每条记忆显示来源、适用范围、更新时间、证据和删除/纠正入口。跨 Project 的 Agent memory 不应默认展示为项目事实。

## 18. TodoView 与 TasksView

### Agent Todo

Todo 的唯一长期 owner 是当前 Agent；每条 Todo 可选绑定一个 Project。Todo 页面默认显示当前 Agent 的全部任务，并支持未绑定项目、按 Project、按 Session 筛选。字段包括 dueAt、priority、标签、提醒、来源、Session links 和状态。

### Project 绑定视图

Project 页面只展示同一批 Agent Todo 中 `projectId` 等于当前 Project 的筛选结果，不创建第二份 Project Todo，不自动双写。

### Session Todo

Session Todo 是当前 Session 的临时执行列表，不自动变成 Agent Todo；只有用户或 Agent 明确创建/关联时，才形成 Agent Todo。

### TasksView

定时任务绑定 Agent；Project 可选但一旦创建需持久化。执行时生成 Session，可关联 Agent Todo，但 Schedule 本身不是 Todo。


## 19. ModelsView

```text
模型目录 | Provider | 运行时配置
```

始终显示当前 Agent、Project 和 Session 的模型来源及覆盖链。修改模型前提示影响范围：仅本 Session、当前 Project 默认、还是 Agent 默认。

## 20. VoiceView

拆分三个明确任务：

```text
语音输入 | Jarvis 实时交互 | 听记/录音历史
```

语音生成的文本进入当前 Agent/Project/Session；不可把语音页面当作独立 Agent。显示录音权限、识别状态、发送目标和失败原因。

## 21. InsightsView

用量按 Agent、Project、Session 和模型筛选；显示 token、成本、执行时长、进程失败率、子会话数量。默认不把不同 Agent 的数据混成一个无来源总数。

## 22. SettingsView

分为：连接/sidecar、默认 Agent、默认 Project、模型策略、权限、通知、MCP、快捷键、更新。更新和桌面壳配置属于系统；Agent 配置应链接回 AgentDetail，不在这里复制一套表单。

## 23. 路由与模块映射

当前路由的迁移目标：

```text
/                         → Home
/workspace                → Workspace（主工作流）
/agents                   → Agent 总览
/agents/:id               → Agent 详情与项目/会话/能力
/records                  → Session 历史
/records/:id              → 回放
/records/.../diagnosis    → Session 诊断
/models/*                 → Agent/Project 模型配置
/skills                   → Agent/Project Skills
/memory                   → Agent/Project/Session Memory
/todo                     → 按 scope 分层的 Todo
/tasks                    → Agent-bound schedules
/insights                 → 统计
/settings                 → 系统设置
```

当前 `pages/` 不立即大迁移。功能稳定后再逐步建立：

```text
features/{agent,workspace,conversation,files,changes,collaboration,execution}/
```

## 24. 关键验收场景

1. 新建 Session：默认 Agent 解析来源可见，Project 可选，结果持久化；
2. Agent 跨 Project：配置、Skills、Memory 和权限变化可见；
3. 主会话委派子会话：树关系、独立进程、intercom 状态、失败和恢复均可见；
4. 子会话结果：ready 与 brought back 不混淆，重复带回不会重复注入；
5. 文件修改：选区引用、Diff、冲突、保存失败均可处理；
6. Todo：Agent、Project、Session 三种来源不混淆；
7. 定时任务：使用持久化 agentId，不读取当前 UI 默认 Agent；
8. 错误：服务不可用不能显示成空列表；
9. 移动端：上下文条始终显示 Agent/Project/Session，核心对话和状态可用。
