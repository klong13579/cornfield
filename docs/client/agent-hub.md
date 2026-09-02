# 数字员工中枢（Agent Hub）：Agent · 项目 · 任务 · 会话

> 状态：**设计（待拍板）** · 日期：2026-09-01
> 场景来源：grilling 会话（2026-08-30 → 09-01）逐项拍板 + 行业对照（Codex Project / Copilot issue-agent / Jules Task / Hermes kanban）
> 关联：`desktop.md`（功能盘点）、`editor-extension.md`（编辑器需求 1「项目选择」）、`agent/multi-agent-orchestration.md`（kanban 编排）、`multidevice.md`（P3 会话注册表）、`gateway/agent-bridge.md`（agentDir 布局）
> 前身：`project-container.md`（2026-08-30 立项稿，本项目吸收了其结论并翻转为以 agent 为核心）

## 0. 一句话

以 **agent（数字员工）为核心模块**：agent 是一等身份实体（agentDir + mission + 独立记忆/技能/凭证）；**项目是它服务的容器**，**任务是它承接的工作单元**，**会话是执行痕迹**。`default` agent 不是另一类东西——它只是第一个 agent（初始化路径差异，实体模型完全统一）。

## 1. 领域模型

### 1.1 Agent（核心一等实体）

```
Agent = {
  id             // 稳定标识（name / account id）
  kind           // 类别（元数据，仅 UI 分组，内核不分派差异，见 §1.1a）
  agentDir       // 身份根：mission/AGENTS/TOOLS/config.yml/SYSTEM.md/skills/evolution/cron/sessions/knowledge/user.md
  displayName    // 界面名
  contexts[]     // 服务过的项目（AgentContext，见 §1.2）
  budget         // 可选：任务执行预算上限
}
```

- **配置在文件中，不在进程中**（`agent-bridge.md` §6.3 原则 1）：备份 agentDir = 完整恢复数字员工
- **物理隔离 = 安全隔离**（原则 2）：session/cron/技能按 agent 分隔
- **身份跟着 agent 走**：agent 跨项目服务，记忆/技能/凭证不随项目换
- 运行时进程内还有 `main / sub / advisor` 三态（`registry/agent-registry.ts:45`）——那是 agent **树的组织方式**，不是产品层的类别，两者不冲突（产品层 = 数字员工，进程层 = 会话树）

#### 1.1a default agent 与其他 agent：统一实体，分化初始化

| 维度 | default agent | registry agent（其他） |
|---|---|---|
| 身份 | 无独立 agentDir，= serve 启动进程的默认会话（P1 语义） | 独立 agentDir + mission/AGENTS/TOOLS（完整数字员工身份） |
| 注册 | 启动即建、立即 attach（`wire-server.ts:218`） | 从 `~/.cornfield/agent/registry.json` 读元数据，attach 时 lazy 实例化 |
| 工作根 | cwd = serve 启动目录 git 根 | agentDir 本体 |
| session 目录 | `~/.cornfield/agent/sessions/<encoded-cwd>/by-date/` | `<agentDir>/sessions/` |
| 配置根 | 全局 `Settings.init({cwd})` | 独立 `Settings.create({cwd: agentDir, agentDir})`（per-agent config.yml） |
| 记忆/凭证 | 全局 auth.db / 全局记忆 | 独立 agentDir 内隔离 |

**决策（2026-09-01 拍板）**：`default` 保留为第一个 agent 的特殊初始化（serve 启动即有会话，UI 打开就能用），但**实体与 registry agent 统一**：default = agentDir = 全局目录、身份名 `default`（UI 可改名立档）；后续"创建 agent"（`desktop.md` §3.4 需求）走同一套模型。**默认 vs 其他 = 初始化路径差异，不是两类实体。**

### 1.2 AgentContext（agent × 项目：N:M，任务指派为连接器）

```
AgentContext = { projectId, role, preferred, lastActive }   // agent 侧记录
Project.preferredAgents[]                                   // 项目侧：建议名单，不约束
Task.assignee = agentId                                     // 真正的连接点
```

- **agent 与项目不互相持有**：Project 表不存 agent 外键，Agent 表不存 project 外键
- 关系只发生在**任务派发那一刻**（`Task.assignee`），和行业一致（Jules 任务绑 repo、Befall agent claim issue、Copilot assign issue → agent）
- `preferredAgents[]` 是 UI 建议池（项目页展示"常驻数字员工"），不是归属约束
- 类别（agent / project 的）**不约束能派谁**，只影响"默认推荐谁"（实际执行边界会模糊，如"推进官网改版"既是业务又是代码）

### 1.3 Project（服务对象 / 容器）

```
Project = {
  id            // 稳定标识（git 根 hash 或显式生成）
  name          // 短名（git 仓库名 / 用户命名）
  roots[]       // 一个或多个文件夹（主 root = 工作目录）
  repo          // 主 git 仓库（branch / status / diff 相对它）
  instructions  // 项目级指令（跨会话生效）
  memory        // 项目级记忆分区（memory protocol 第三区，已存在）
  skills        // 项目级技能开关
  budget        // 可选：任务预算上限
  tasks[]       // 挂载的任务
  preferredAgents[]  // 建议名单（不约束）
}
```

- **类别 = 一等字段，仅元数据/UI 分组**（代码 / 业务 / 公司 / 产品 / 文档），内核不做分派差异（拍板 2026-09-01）
- **Project ≠ 目录**：目录只是 `roots`；CLI 单目录退化为 1 project = 1 root
- **多 root 延后**：P0 单根（= 现 `resolveServeProjectRoot` 升级），多根 P2
- **任务 → 项目强制 1:N**（无主任务归默认项目）
- **workspace.json 定位（review 收敛，2026-09-01）：方案 A —— Agent 声明**
  - 现有事实：`agentDir/.cornfield/workspace.json`、`type:"agent"`、含 projectRoot + knowledge/memory/skills/sessions 路径（`skeleton/workspace.ts`）——它本质是 **Agent 的 workspace declaration**，不是 Project 注册表
  - 决策：**workspace.json = Agent 声明**（顺着现状收敛，零迁移）；Project 必须有独立注册机制（见 §2 项目注册表）；Project 的 instructions/memory/skills/projectRoot 权威性从 workspace.json 解耦到 project 注册表，避免 Agent/Project 双重容器语义
  - 后果：往后不把 Project 级配置写进 agentDir；多 agent 服务同一项目时项目级 memory/skills 是共享的注册表条目（不是各 agentDir 各自一份）

### 1.4 Task（工作单元：task ≠ session）

```
Task = {
  id
  projectId      // 强制归属；无项目 = 无任务（归默认项目）
  type           // 元数据：code / business / general（产物/验收视图按 type 分化；scheduled 不再作为任务类型，见 §1.7 Cron 拆分）
  title          // 一句话目标
  goal           // 详细目标 / 验收标准
  agentId        // 指派（assignee）；null = 调度器决定
  status         // queued → running → needs_review → done；旁路 blocked
  pack[]?        // 可选任务包（子任务清单，进度 = 完成数/N）
  acceptance[]   // [{ criteria, evidence, verdict }]
  sessions[]     // 弱关联的执行痕迹（不绑架任务）
  cost           // token / 金额（预算内）
}
```

拍板汇总（2026-09-01）：
- **任务 = 独立实体（topic 文件承载），核心是功能完成度**；会话只是弱关联执行痕迹，任务状态机独立于会话状态
- **两把尺子**：状态机（宏观）+ 包勾选 完成数/N（微观，有包才显示百分比，无包不造假数）
- **needs_review 停留态**：做完 → 等验收 → 全过 → done；不通过打回 running 续改
- **验收 = criteria 逐条 + evidence + verdict**，接独立验证者（`topics/independent-verifier.md`）执行/验证分离 + 人终审
- **任务包可选**：人定义主干（2-8 子任务），agent 执行时细化，但包级清单以人为准；"方向 → 包 → 部分完成"渐进形态受支持
- **调度规则（review 补齐）**：`agentId = null` 的决策点 = 创建时确定候选范围（`Project.preferredAgents` 只作推荐，不作为资格约束），执行时由调度器从候选选空闲 agent；agent 不在线/无权限/预算不足时任务留在 queued 并标注原因；不自动重赛；失败换 agent 是显式操作（打回 queued 后人工重派）

### 1.5 Session（执行痕迹）

- 会话 JSONL 持久化（CLI / gateway 两套目录各有约定，见 AGENTS.md §gateway-session-logs）
- 任务页可看会话回放，但**任务不依赖会话存在**；`continue = resume 原会话`（上下文不丢，Codex/Claude 路线），换方向/换 agent 才是显式新会话

### 1.6 Connector（连接器：agent 的 IM 入口）

agent 的对话入口不只是 serve 的前台界面，还有 IM 通道（钉钉/飞书/Slack/微信）。行业普遍有 connector 概念（Claude Channels / MCP connectors / open-connector 的 provider 目录），但我们需要的与 open-connector（单向 SaaS 动作网关）不同——**我们是双向 IM 通道**（收消息 → agent → 回消息）。

**领域模型（2026-09-01 拍板）**：

```
Channel（通道层，gateway 内）＝ BaseChannel 抽象 + ChannelRegistry 注册表（已存在，channels/）
   ├── DingTalkChannel（已实现，双向：收事件 + 发卡片/审批）
   ├── FeishuChannel（未来：BaseChannel 子类）
   └── SlackChannel / WeChat（同一抽象，新增通道 = 写一个子类 + 插注册表）

绑定（gateway.json『接线』，不迁移到 agentDir）
   channels.<type>.accounts.<name>.agentDir ──→ 某 agentDir　// 唯一绑定点
   channels.<type>.accounts.<name>.enabled/deniedTools   　// 通道级权限（现状已对，不迁）

Agent 侧：不需要 channels.json —— agent 被谁绑定是 gateway 的接线，不是 agent 档案
```

拍板要点：
- **连接属于 gateway（通道层），不属于 agent**：gateway.json 定义「钉钉账号存在」，agentDir 只是被绑定的一方（一个 bot 对很多人）
- **配置不迁入 agentDir**：早期讨论的 `channels.json` 方案有循环依赖问题（agentDir 是 serve 配置根，gateway 启动读 gateway.json → agentDir，加载顺序会乱），放弃。绑定保持在 `accounts.<name>`（现状已是正确模型）
- **通道可绑定同一 agentDir 多次**：一个 agent 身份可同时挂钉钉 + 飞书（通道只是入口，agent 仍是唯一身份）；同样一个通道账号背后只有一个 agentDir
- **open-connector 的定位（借鉴不替代）**：它的 dingtalk/slack provider 只有 `send_*` 单向动作，是我们的**工具连接层**（agent → 外部 SaaS 工具）的参考，不是 IM 通道层——IM 通道用我们已有的 `channels/` 抽象扩展

**ConnectorAccount 实体（review 问题 5 采纳）**——Channel 是平台抽象，关系/配置对象是 Account 级，两者分开：

```
ConnectorAccount = {
  accountId        // 账号唯一标识（gateway.json accounts.<name>）
  channelId        // 所属通道类型（dingtalk / feishu / slack）
  agentDir/agentId // 绑定的 agent（唯一绑定点）
  credentialRef    // 凭证引用（gateway.json；不写 agentDir）
  enabled          // 接入开关
  deniedTools      // 通道级权限 overlay
  routing          // inbound 会话路由 + outbound 投递目标
}
```

规则：
- **一个账号绑定一个 agent（1:1），一个 agent 可被多个账号绑定（1:N）**；同一 agent 多账号时 session 按 `accountId` 区分（`<agentDir>/sessions/` 已按 convId 分文件）
- 凭证只在 gateway.json（敏感），运行时读 gate 不落 agentDir
- 权限合并规则：**gateway 只能收紧不能放宽**（agent 允许的 ∩ channel denied = 生效面）；`enabled` 是通道状态不是 agent 状态
- 绑定目标（agentDir）失效时：账号显示错误态，不静默，wire 错误码明确

### 1.7 Cron（定时任务）：拆 CronDefinition / ExecutionRun / Task（review 收敛）

- **定时任务是 gateway 的组件**（`SchedulerEngine`，croner + SchedulerDbStorage，gateway 内嵌）
- **管理接口走 wire**：`cron.create/update/delete/test-run` 都是 wire 命令（gateway :7892 POST /wire 直连，serve :7891 也可转发），前端经 wire 调用
- **执行是 agent 本体**：到点 gateway 经 AgentBridge 拉起 agent 进程（`taskType: "agent"`），用 agentDir 身份干活，结果经绑定的 channel 投递
- 员工工作台「定时」tab = gateway scheduler 的 wire 视图（列出该 agent 的 cron，test-run 已通；cron 写操作在 P1 接 wire 命令）

**三实体拆分（review 建议 5 采纳）**——Cron 触发 ≠ Task，两者不合并：

```
CronDefinition = { id, agentDir, schedule, prompt, delivery, enabled }   // 调度定义：什么时候触发、触发什么（gateway scheduler 持久化）
ExecutionRun   = { runId, cronId, startedAt, status, logs, cost, deliveryResult }  // 一次实际执行：状态/日志/成本/投递结果（scheduler.db）
Task           = { …§1.4 }                                                   // 业务工作：需跟踪/验收/产物管理（topic 文件）
```

关系规则：
- **Cron 触发 → 创建 ExecutionRun（不默认创建 Task）**：重复触发对应多个 ExecutionRun，运行记录留在 scheduler.db，幂等键 = `cronId + scheduledAt`
- **Cron 是否创建 Task 是显式声明**：若 cron 的 prompt 声明了业务目标需要验收/产物（如"每日生成周报并发群"），执行完成后将 ExecutionRun 提升为 Task（或绑定既有 Task）；纯例行执行（健康检查）只留 ExecutionRun
- **test-run 产生正式 ExecutionRun**（带 marker，测试后 restore schedule，见 `test-run-marker.ts`），不算 Task
- **失败重试不产生新 Task**：重试 = 同 cronId 的新 ExecutionRun，原 run 标 failed
- **投递失败 ≠ 任务失败**：ExecutionRun.deliveryResult 独立记录投递结果（任务本体可能已完成），审计时分开看

### 1.8 权威存储与查询投影（review 建议 1 采纳）

**规范化实体只有 6 个**：Agent / Project / Task / Session / ConnectorAccount / CronDefinition。除此以外的数组一律是查询投影，**不允许成为第二套持久化真相**：

| 实体 | 主键 | 权威存储 | 生命周期 | 孤儿规则 |
|---|---|---|---|---|
| Agent | `agentId` | `agentDir/`（registry.json 索引）| 创建：`cornfield agent init`；删除：unregister | — |
| Project | `projectId` | project 注册表（新增，见 §2）| 创建：open/attach；删除：close | 无主任务归 default |
| Task | `taskId` | topic 文件 + frontmatter | 创建：人/agent；done/archive | 无项目 = 归 default |
| Session | `sessionFile` | JSONL | 随执行生灭；resume/fork | 无 agentId 归 default |
| ConnectorAccount | `accountId` | gateway.json `accounts.<name>` | 创建：gateway 接线 | 绑定 agentDir 失效须显式报错 |
| CronDefinition | `cronId` | scheduler.db | 创建/删除走 wire | 无绑定 agentDir 不执行 |

**投影表（不持久化，派生）**：

| 投影 | 来源 | 用途 |
|---|---|---|
| `Project.tasks[]` | 查 topic/任务注册表 | 项目页任务列表 |
| `Agent.contexts[]` | 查任务历史 + workspace.json | 员工工作台「项目池」 |
| `Task.sessions[]` | 查会话 JSONL 元数据 | 任务详情「会话痕迹」 |
| `Agent.artifacts[]` | 扫该 agent 会话产物目录 | 工作台「产物」tab |
| `Agent.projects[]` | 查任务历史 | 员工 roster 的项目列 |

### 1.9 default agent 迁移设计（review 建议 4 采纳）

**现状 → 目标映射**（一次迁移，绝不自动反复）：

```text
旧 serve cwd / git root      → default agent 的工作项目（projectRoot）
旧 CLI 默认会话              → default agent 的会话（迁 session 元数据）
全局 Settings.init({cwd})    → default agent 的 Settings（agentDir 化）
全局 auth.db / 全局记忆       → default agent 的记忆/凭证（不迁移，保持全局可共享）
session 路径迁移              → 首启扫描旧编码路径，生成 projectId 映射索引
```

规则：
- **一次性 + 幂等**：迁移只跑一次（写 migration marker）；重复执行无副作用
- **备份**：迁移前对 registry.json / workspace.json 做快照备份，失败可回滚
- **旧版 CLI 兼容**：未迁移的旧 session 继续可读；default agent 保持 serve 启动即时可用的语义
- **default 永久存在**：默认不删除；改名只改 displayName，`agentId` 稳定

## 2. 架构图

交互图：`docs/archify/agent-hub.architecture.html`（2026-09-01 版本：**agent 居中为核心**，项目/任务/会话/配置环绕；前身 `project-container.architecture.html` 已删除）

## 3. serve 端（内核）改动

| 改动 | 内容 |
|---|---|
| agent 注册表 | 从"单 cwd + registry.json 只读"升级为 **agent 实体注册表**：`list_agents` / `get_agent` / `attach_agent(id)`；default = 启动即 attach，其他 lazy attach（现状 P3 已具备，补 agentContext 元数据） |
| 项目注册表 | `list_projects` / `get_project` / `attach_project(id)`；session 元数据写 projectId，`list_sessions` 返回权威归属；**Project 是独立注册表条目（不是 workspace.json 或目录名推导）**，projectId 稳定（git root hash 或显式生成，P0 定案） |
| 会话归属 | 前端不再猜 encoded-cwd；serve 给权威 projectId + agentId |
| 命令面 | 新增 `get_agent_context`（服务过的项目/角色）；`fs_diff` / `git_*` 相对当前 project 根；cron CRUD 走 wire（gateway :7892 直连，serve 转发） |
| 兼容 | 无显式 projectId / agentId 的会话归 default（= serve 启动 cwd），现有 CLI/TUI 零破坏 |

**CLI 命令关系（serve vs agent vs gateway，2026-09-01 确认）**：

| 命令 | 角色 | 与 agent 的关系 |
|---|---|---|
| `cornfield agent` | 管理（人事部）：init/list/show/validate/register | 管理 agentDir 生命周期，前端「＋创建员工」直接调这条链路 |
| `cornfield serve` | 运行（上班打卡机）：把 agent 跑起来给多端连 | 启动时读 `agent` 命令管理的那批 agentDir，共享 registry.json |
| `cornfield-gateway` | 值班（IM 通道 + scheduler + bridge） | 读 gateway.json 的账号→agentDir 绑定，拉起 agent RPC 子进程 |

一句话：**`agent` 管档案，`serve` 上前台，`gateway` 走通道**——三者共享同一份 agentDir 身份，不存在两套配置。

**P0 依赖注意（review 问题 8）**：`cornfield agent` 命令当前仍用 `console.error/log`（违反 centralized logger 硬约束），P0「创建 agent」走该链路前需修正输出层或改用可测试的 CLI service。

## 4. 前端（web-app）改动

| 改动 | 内容 |
|---|---|
| **Agent 页为核心** | 左栏/首页以 agent 为纲：每个数字员工一张卡（身份 + 服务项目池 + 在跑任务 + 记忆/技能 + 配置入口），点开 = 该 agent 的工作台 |
| **首页 = default agent 入口** | 欢迎页保留（问候 + Composer + 建议），Composer 发给 default agent；右下「最近活跃」点员工卡 → 进入该员工中枢页（mock：`tmp/agent-hub-all-pages-mock.html`） |
| **侧栏保留任务页** | 侧栏保留独立「任务」入口，默认加载 default agent 的任务（Task = topic 文件，TODO.md 是入口投影） |
| **员工工作台 = 7 tab** | 任务 / 会话 / 记忆 / 技能 / 定时 / 产物 / 配置 —— 旧页面的功能按绑定度收编（/todo → 任务；/workspace+/records → 会话；/memory → 记忆；/skills → 技能；/tasks → 定时；产物 = agent 聚合视图；配置 = 档案） |
| **「配置」tab = agent 唯一管理入口（内联）** | 身份与项目（agentDir/workspace.json projectRoot）/ 能力（模型/工具/技能 toggle，读 config.yml）/ 通道绑定（只读展示该 agent 被哪些 bot 绑定 + 跳 gateway 编辑）—— 不再有 serve/gateway 两套配置入口 |
| 顶栏项目 chip | 从"只读标签"升级为项目选择器（最近列表 + 文件夹浏览器），切换不重启 serve |
| 会话侧栏 | 分组键改为 serve 权威 projectId（不再猜路径） |
| 任务列表/详情 | TODO.md 入口投影 + topic 状态聚合；详情 = 包/进度/验收/会话四区块（mock：`tmp/project-container-mock.html`） → 已并进员工工作台「任务」tab |
| 右面板 Changes | `fs_diff`/`git_*` 逐条 diff + 接受/回滚 + PR（P1 with Tasks） |
| Agent 卡片 `workspace` 字段 | 不再用 role 顶替；改为权威 project 归属 |
| 其余页面（Records/Voice/Settings/Models/Insights/Memory/Skills/Tasks） | 导航保留，功能收编后不重复实现；全局聚合视图（用量/模型）与服务无关的输入通道（语音）保持独立 |

## 5. 分期

### P0 — Agent 中轴纵切（review 建议 7 采纳：不做完整工作台）

**P0 = 一条可验证的纵切**，证明 agent 模型成立：

```text
创建 agent → serve 发现（registry）→ attach（lazy 或默认）
→ 权威归属：list_sessions 返回 agentId + projectId
→ 切换 project → 发起/恢复 session → gateway 绑定仍可工作
```

为此需要：

| 内容 | 依赖的已就绪件 |
|---|---|
| agent 实体化（default 统一 + AgentContext 元数据）| agent registry / registry.json |
| 项目注册表 + 权威归属（session 元数据写 projectId/agentId）| wire session store |
| 前端首页以 agent 为纲 + 员工工作台 UI 壳（**只壳不做全功能闭环**）| wire / permission-gate |
| 审批真实管线（inject_permission 接 agent-core，单独验收）| permission-gate |

**不承诺**：7 tab 工作台全功能、项目切换不重启 serve 的多 Project session factory（属 P1/P2）。

### P1 — Task + 审查闭环（逐子验收，不捆 bind）

按风险拆开验收，不把写操作和状态模型绑一起：

1. Task 创建 / 状态机 / 任务包 / 验收字段（topic frontmatter）
2. Session 与 Task 关联 / 产物记录
3. Changes 只读 diff（`fs_diff` / `git_*` 已就绪）
4. 单条接受 / 回滚（高风险写操作，单独验收）
5. PR 创建与失败恢复

### P2 — 并行与编排（不等于 lazy attach）

多项目并行注册表（= multidevice P3/P4 同层）+ 完整执行语义（资源隔离 / 并发预算 / 文件锁 / 分支隔离 / 取消抢占 / 冲突检测 / judge 验收）+ kanban 编排接客户端看板。**注意：现有 lazy attach 只解决按需加载 AgentSession，不等于并行执行正确性。**

## 6. Tradeoff 与备选

| 备选 | 取舍 | 结论 |
|---|---|---|
| **以项目为核心**（初版） | 项目作地基，agent 是执行者 —— 与你"希望以 agent 为核心模块"冲突 | ✗ 已翻转为 A |
| **A（采纳）：以 agent 为核心** | agent = 数字员工是公司资产，项目/任务/会话是其工作形态；符合现有进程模型（每个 agent 独立 RPC 子进程） | ✓ |
| B：一步到位多项目并行 | 撞 multidevice P3/P4 复杂度，工期翻倍 | ✗ 延后 P2 |
| C：任务 = 新会话类型 | 新造执行原语，会话/回放/compaction 全丢 | ✗ 否决（task ≠ session） |

**风险账**：
- serve agent 化与"default = 启动 cwd"语义：显式 agentId/projectId 缺省归 default，向后兼容（review 高风：default 迁移见 §1.9，须配迁移设计再动）
- Agent/Project 双重容器语义：workspace.json = Agent 声明（方案 A）+ Project 独立注册，配置/记忆/技能根不再双真相（review 高风险，已收 §1.3）
- 会话归属迁移（旧 encoded-cwd 路径）：首启索引迁移映射到 projectId（幂等 + 备份 + 回滚）
- Task/ExecutionRun 生命周期：Cron 触发默认不建 Task，重试/投递失败/审计分开（review 中高风险，已收 §1.7）
- agentDir 大文件同步：配置在文件中是资产，但多 agent 时同步/版本管理需规则（P1 补）
- 任务执行无 step 级 checkpoint：P1 用任务级心跳缓解（`multi-agent-orchestration.md` P1/P2）
- `cornfield agent` 命令用 console.log/error 违反 logger 硬约束：P0 前修输出层（review 问题 7）

## 7. 验收口径

- **P0（纵切）**：创建 agent → serve 发现 → attach → 权威归属（list_sessions 返回 agentId+projectId）→ 切换 project → 发起/恢复 session → gateway 绑定不破；重启后 agent 可恢复；重复创建/agentDir 已存在/有无 workspace.json 均明确行为；批准写操作走真实 permission-gate
- **P1**：Task 状态机/任务包/验收字段（frontmatter 生效）→ Session 关联/产物记录 → Changes 只读 diff → 单条接受/回滚 → PR，分 5 步验收；cron 写操作走 wire 命令
- **P2**：完整并行执行语义 + 大任务 orchestrator 拆 ≥2 worker 并行执行 + judge 验收

## 8. 已拍板项与待拍板项

**2026-09-01 已拍板（grilling 会话）：**

| 决策点 | 结论 |
|---|---|
| 项目类别 | 一等字段，仅元数据/UI 分组，内核不分派（代码/业务/公司/产品/文档） |
| 任务模型 | Task = 独立实体（≠ session），完成度为心；类型 = 元数据（code/business/scheduled/general） |
| 任务包 | 可选资产，数字进度必填 + 包勾选；无包不造假百分比 |
| 验收 | criteria + evidence + verdict；needs_review 停留态；不通过打回 running |
| 任务 × 项目 | 强制 1:N，无主归默认项目 |
| 项目 × agent | N:M，任务指派（assignee）为连接器；preferredAgents 只建议不约束 |
| 中心视角 | 以 agent 为核心模块（推翻初版以项目为核心） |
| default agent | 与其他 agent 实体统一，仅初始化路径差异 |
| 首页 | 保留欢迎页 = default agent 入口；点员工卡进中枢 |
| 侧栏 | 保留独立任务页，默认加载 default agent 任务 |
| 工作台 | 7 tab（任务/会话/记忆/技能/定时/产物/配置），收编旧页面功能 |
| 配置 tab | 内联编辑（模型/工具/技能/项目/通道绑定）—— agent 唯一管理入口 |
| gateway.json | 保持为通道接线（agentDir 指向 + 凭证 + 通道级权限），不迁移不新建 channels.json |
| Connector | 双向 IM 通道走 channel 抽象（DingTalk 已实现，Feishu/Slack = BaseChannel 子类）；open-connector 只借鉴为工具连接层（agent→SaaS 单向动作），不替代 IM 通道 |
| 定时任务 | gateway scheduler 组件；管理走 wire；执行是 agent 本体；结果经 channel 投递 |
| serve vs agent vs gateway | 人事管档案（agent）/ 前台运行（serve）/ 通道值班（gateway），共享同一份 agentDir |

**2026-09-01 review 采纳（GPT-5.6 独立 review，`/tmp/agent-hub-review-gpt56.md`）：**

| 改进点 | 落点 |
|---|---|
| workspace.json = Agent 声明（方案 A），Project 独立注册 | §1.3 |
| 规范化实体 6 个 + 投影表（数组不持久化） | §1.8 |
| default 迁移设计（一次性/幂等/备份/回滚/兼容） | §1.9 |
| Cron 拆 CronDefinition/ExecutionRun/Task（触发不默认建 Task） | §1.7 |
| ConnectorAccount 实体（1:1 绑定、权限只收紧不放宽） | §1.6 |
| Task.agentId=null 调度规则补齐 | §1.4 |
| P0 缩成纵切（不做 7 tab 全功能）；P1 分 5 步验收 | §5 |
| `cornfield agent` console.log 修 logger（P0 前） | §3 |
| P0 验收补边界（重启恢复/重复创建/registry 损坏/迁移失败） | §7 |

**待拍板：**

1. 文档即立项：是否按 P0 → P1 开工？（P2 单独评估）
2. 产品命名：内部代号「数字员工中枢 Agent Hub」；`agentId` / `projectId` 命令面命名沿用
3. 前端 mock（`tmp/agent-hub-all-pages-mock.html` v3）是否作为 P0 原型固定，进实现