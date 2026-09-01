# 项目容器（Project）与 Coding Task 立项稿

> 状态：**设计（待拍板）** · 日期：2026-08-30
> 场景来源：客户端评审（2026-08-30）两项缺口 + 行业对照（Codex Project / Cursor Cloud Agent / Jules Task）
> 关联：`desktop.md`（功能盘点）、`editor-extension.md`（编辑器需求 1「项目选择」）、`agent/multi-agent-orchestration.md`（kanban 编排）、`multidevice.md`（P3 会话注册表）

## 0. 一句话

把当前"serve 进程的 cwd"升级为一级实体 **项目容器（Project）**：绑定仓库/文件夹，下挂会话与任务，携带项目级上下文（instructions / 记忆 / 技能 / 预算），产物走 Changes → diff → PR 闭环。**项目是客户端领域模型的地基，coding task 挂在其上**——没有项目，任务没有归属。

## 1. 现状 vs Codex Project vs 我们要做的

| 维度 | 现状（cornfield） | Codex Project（蓝本） | 我们要做的 |
|---|---|---|---|
| 实体 | 无。workspace = serve 启动 cwd，整个进程 = 一个 git 根 | Project 一等实体：chats + 文件夹 + instructions + sources | Project 一等实体：sessions + cwd(s) + instructions + tasks |
| 项目切换 | 重启 serve（sidecar setWorkspaceDir 后 spawn） | 不重启；并行 threads across projects | 不重启；serve 管多项目根，按项目 attach |
| 会话归属 | 前端从 sessionFile 路径猜（encoded-cwd） | chat 显式属于 project | serve 给权威归属（projectId 写 session 元数据） |
| 任务 | 无任务实体；只有 async job 快照（协议有，无 UI） | project 下线程即任务 | Coding Task = 项目内工作单元（见 §3） |
| 项目级上下文 | 无。AGENTS.md 只在 cwd 隐式发现 | project instructions 跨 chat 生效 | project config（instructions / 记忆 / 技能 / 预算）随项目走 |
| 产物审查 | fs_diff / git_* 协议已就绪，前端无 UI | review pane 跨 repo 看 changes | 右面板 Changes：diff 逐条 + 接受/回滚 + PR |
| 审批 | 组件齐、`inject_permission` 是 mock，未接真实管线 | 沙箱 + 用户审批 | 接 permission-gate 真实管线（并行任务之一） |
| 异步/并行 | 无并发概念（多 agent 编排设计未实现） | 后台多线程 | P2 接 kanban 编排（复用 `multi-agent-orchestration.md`） |

## 2. 设计：项目容器（Project）

### 2.1 领域模型

```
Project = {
  id            // 稳定标识（git 根 hash 或显式生成）
  name          // 短名（git 仓库名 / 用户命名）
  roots[]       // 一个或多个文件夹（主 root = 工作目录）
  repo          // 主 git 仓库（branch / status / diff 都相对它）
  instructions  // 项目级指令（跨会话生效，等价 AGENTS.md 注入）
  memory        // 项目级记忆分区（memory protocol 第三区，已存在）
  skills        // 项目级技能开关
  budget        // 可选：任务预算上限（token / 金额，防失控）
  sessions[]    // 权威归属的会话列表
  tasks[]       // 挂载的 coding task（见 §3）
}
```

设计要点：

- **Project ≠ 目录**：目录只是 `roots`。Project 是目录的"容器语义"——会话、任务、指令、记忆都挂它。CLI 单目录场景退化为 1 project = 1 root，不增加负担。
- **多 root 延后**：P0 支持单根（= 现 `resolveServeProjectRoot` 升级），多根（Codex 副文件夹）P2 再说。
- **身份域**：项目域（IDE/客户端）与公司域（gateway 钉钉）保持 `multidevice.md` 的分离，项目只在项目域存在。

### 2.2 serve 端（内核）

| 改动 | 内容 |
|---|---|
| serve 注册表 | 从"单 cwd"升级为"项目注册表"：`list_projects` / `get_project` / `attach_project(id)`；attach 时按项目 session 目录加载会话（`<agentDir>/sessions 按 projectId 分目录` 或 session JSONL 元数据记 projectId） |
| 会话归属 | session 元数据写入 projectId；`list_sessions` 返回权威归属，前端不再猜路径 |
| 命令面 | 新增 `get_workspace`（cwd / git root / branch / 项目配置）—— 有实体后才有元数据可读 |
| 项目切换 | `attach_project` 切换当前项目上下文（不改进程、不重启），session 按项目加载 |
| 兼容 | 无显式 projectId 的会话归 `default` 项目（= serve 启动 cwd），现有 CLI/TUI 零破坏 |

### 2.3 前端（web-app）

| 改动 | 内容 |
|---|---|
| 顶栏 chip | 从"只读标签"升级为项目选择器：最近列表 + 文件夹浏览器（复用 `editor-extension.md` 需求 1 的 UI 设计）+ 切换 |
| 会话侧栏 | 分组键从"前端猜路径"改为"serve 权威 projectId" |
| 右面板 Changes | `fs_diff` / `git_*` 相对当前 project 根；逐条 diff + 接受/回滚按钮（P1 with Tasks） |
| Agent 卡片 | `workspace` 字段不再用 role 顶替；agent 与项目的关系显式化 |

## 3. 设计：Coding Task

### 3.1 任务模型

```
Task = {
  id
  projectId      // 必须归属一个项目（无项目 = 无任务）
  title          // 一句话目标
  goal           // 详细目标 / 验收标准（= Codex Prompt.md 精神）
  agentId        // 指定 agent，或 null = 调度器决定
  status         // queued → running → needs_review → done；旁路 blocked
  sessionId      // 执行会话（任务 = 会话的持久化投影，不新造执行原语）
  diffs[]        // 产物：改动文件 + diff；needs_review 时呈现
  cost           // token / 金额（预算内）
  createdAt / completedAt
}
```

关键决策：**任务 = 会话的投影，不是新会话类型**。创建任务 = 开一个 `cwd=project.roots[0]`、mission=goal 的 AgentSession，状态机由会话事件归约（复用 multidevice `reducePhase` 模式）。会话持久化 / 回放 / compaction / 审批全部白拿。

### 3.2 生命周期与产物闭环

```
用户创建任务 → queued ──(agent 领取)──> running
                                        │ 跑完 / 到审批点
                                        ▼
                                needs_review ──(用户审 diff + 审批/回滚)──> done
                                        │ 失败 / 澄清
                                        ▼
                                     blocked ──(用户介入)──> running | done
```

- **审批嵌入**：`inject_permission` 从 mock 接真实 permission-gate（P0 并行项，独立存在 `desktop.md` §3.4）
- **diff 审查**：右面板 Changes = 任务的产物视图；接受 = 落盘，回滚 = `git_*` 反向
- **PR**：P1 末端自动建 PR（`gh` 工具已就位），P2 接 issue 派发（Jules 模式）

### 3.3 执行主体（按规模分级）

| 任务规模 | 执行体 | 依据 |
|---|---|---|
| 中小任务 | 单 agent 会话内 goal-mode loop（现有能力直接跑） | — |
| 大任务 / 并行 | kanban 编排（orchestrator 分解 → dispatcher spawn worker → judge 验收） | `multi-agent-orchestration.md` 已设计，P2 接 |
| 后台长任务 | async job 快照 UI（`get_async_job_snapshot` 已有协议，补前端视图） | `desktop.md` §3.4 |

## 4. 分期

| 阶段 | 内容 | 依赖的已就绪件 |
|---|---|---|
| **P0 — 项目容器最小集** | serve 项目注册表 + attach + 权威归属；前端项目选择器 + 侧栏权威分组；审批真实管线 | wire / permission-gate / agent registry |
| **P1 — Coding Task + 审查闭环** | 任务创建/列表/详情；右面板 Changes（diff 逐条 + 接受/回滚）；产物 gallery | `fs_diff` / `git_*` 协议已就绪；ArtifactsPanel 已有 |
| **P2 — 并行与编排** | 多项目并行注册表（= multidevice P3/P4 同层）；kanban 编排接客户端看板；多 root | 编排设计文档已定 |

## 5. Tradeoff 与备选

| 备选 | 取舍 | 结论 |
|---|---|---|
| **A：只做 task，不动 workspace** | 省事，但任务无归属实体，半年后必返工；分组继续靠前端猜路径 | ✗ 否决（地基不立，上层必塌） |
| **B：一步到位多项目并行** | 直接撞 multidevice P3/P4 的会话注册表复杂度，工期翻倍 | ✗ 否决（P0 单根 + attach 已覆盖 90% 场景） |
| **C（推荐）：P0 容器 → P1 任务 → P2 编排** | 每阶段产出可验收；P0 不碰会话注册表，P1 吃满已就绪协议 | ✓ 采纳 |

**风险账**：
- serve 项目化与"default agent = 启动 cwd"语义冲突 → 显式 projectId 缺省归 default，向后兼容
- 会话归属迁移（旧的 encoded-cwd 路径）→ 首启做一次索引迁移，映射到 projectId
- 任务执行无 step 级 checkpoint（编排层 P1/P2 已知问题，见 `multi-agent-orchestration.md` P1/P2）→ P1 用任务级心跳缓解

## 6. 验收口径

- **P0**：不重启 serve 切换项目；`list_sessions` 返回权威 projectId，前端侧栏按项目分组；批准一个写操作走真实 permission-gate
- **P1**：创建任务 → 会话执行 → 产物出现在 Changes → 逐条审 diff → 接受/回滚 → 任务 done，全链路在 web-app 完成
- **P2**：一个大任务被 orchestrator 拆成 ≥2 个 worker 并行执行并完成 judge 验收

## 7. 待拍板项

1. 文档即立项：是否按 P0 → P1 顺序开工？（P2 等 P0/P1 验收后单独评估）
2. 产品命名：内部代号建议「项目容器 Project」，沿用大小写规范（`projectId` / `projects` 命令面）