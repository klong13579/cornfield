# WP1：Agent / Project / WorkspaceContext / Session / AgentTodo 契约

日期：2026-09-15
状态：已实现（契约层），等待 review
来源：`architecture-comparison-proma-diagnosis.md` §1 / §4 / §6 / §9 / §10 / §11 Phase 0 / §37 / §38

## 1. 交付边界

| 交付 | 位置 |
|---|---|
| 领域词表 + 权威存储表 + 读模型 | `packages/coding-agent/src/agent-domain/types.ts` |
| 非法关系校验（规则 + 校验函数） | `packages/coding-agent/src/agent-domain/relations.ts` |
| 公共出口 | `packages/coding-agent/src/agent-domain/index.ts` |
| 验证 | `packages/coding-agent/test/agent-domain.test.ts`（58 例） |

**只有契约**：没有存储、没有迁移、没有运行时、没有进程管理，也没有任何 `write`/`read` 磁盘的代码。§38 已存在的底座一个都不重建——Session Todo（`todo` 工具）、进程内 subagent（`runSubprocess` + IRC）、Session 持久化（JSONL / `AgentStorage`）、intercom broker、squad 状态机全部保持原样，本 WP 只声明它们与领域概念的关系。

## 2. 概念与权威来源（§11 Phase 0：标出 owner scope 和权威存储来源）

代码里的 `DOMAIN_AUTHORITY` 是这张表的可执行版本：`Record<DomainConcept, ConceptAuthority>`，新增概念不写 owner 与来源就编译不过。

| 概念 | owner scope | 今天的事实来源 | 状态 |
|---|---|---|---|
| Agent | client | `~/.cornfield/agent/registry.json`（name → path 薄索引）+ `<agentDir>/.cornfield/workspace.json`（schema v2 声明） | 已有 |
| AgentDir | external | 文件系统；Agent 的物理 home，不是业务概念 | 已有 |
| Project | client | 无；今天只隐含在 session 的 cwd / git toplevel 里 | **待建（WP4）** |
| WorkspaceContext | derived | 无，且**不应有**：按 (Agent, Project) 计算 | **待建（WP4）** |
| Session | agent | session JSONL header：default agent 在 `~/.cornfield/agent/sessions/<encoded-cwd>/by-date/`；registry agent 在 `<agentDir>/sessions/`（serve 写 by-date，gateway 写扁平 `<safeConvId>.jsonl`） | 已有 |
| Session 树 | session | 部分：`SessionHeader.parentSession` 存的父引用**类型不一致**（fork 写 session id，branch 写 session 文件路径，`SessionInfo` 按 `parentSessionPath` 读）；`agentId` / `depth` / `rootSessionId` 完全没有持久化 | **待建（WP7/WP8）** |
| Schedule | client | gateway scheduler：任务定义（`~/.cornfield/gateway-data/scheduler/tasks/` 下的 `.json5`，`SchedulerFileStore`）+ 运行态存储 | 已有（但只带 `agentDir`，不带 `agentId`） |
| Worker | derived | 无，且不应有：＝子 Session + 指派边 + 执行策略 | 不持久化（设计如此） |
| ContextItem | session | session JSONL 条目（file mention）+ session artifacts store | 已有 |
| AgentTodo | agent | 无；§37 明确 Markdown 板 / 结构化存储**尚未决策** | **待建（WP10）** |
| Session Todo | session | session JSONL：`todo` 工具结果 details + `user_todo_edit` 自定义条目，由 `../tools/todo-write.ts` 拥有 | 已有，原样复用 |
| Project TODO | client | `<projectRoot>/TODO.md`，由 `project-todo` skill 维护 | 已有 |

## 3. 定死的契约决定

1. **WorkspaceContext 是派生值，没有 id、没有声明文件。** 它的每个字段必须与派生来源一致（Agent 的 agentDir、Project 的 id 和 root），不一致就是它的错，不是调用方的错。
2. **Worker 不是实体。** `WorkerView = Pick<SessionNode, "sessionId" | "parentSessionId" | "delegationRole" | "objective" | "executionPolicy">`——用 `Pick` 保证它不可能与节点漂移。Worker 不落地成表、不重启第二套 runtime。
3. **正式 Session 只有一种执行策略。** `SessionExecutionPolicy = "isolated-process"`（单成员联合）。§38 已删除 `in-process` 作为 Session 策略；进程内工作仍是现有 subagent Task（`runSubprocess` + IRC），永不进入 Session 树。跨进程边界的数据用 `isSessionExecutionPolicy()` 收口。
4. **Session Todo 完全复用现有能力**——契约模块把 `TodoItem` / `TodoPhase` / `TodoStatus` 从 `../tools/todo-write.ts` **原样 type-only 转出**，不定义 `SessionTodo` 平行类型，也不提供任何 todo 存储函数。`test/agent-domain.test.ts` 里有出口面快照测试：往这个模块里塞 store/runtime 会直接测试失败。
5. **AgentTodo 归属 Agent**（§37 D4）：`agentId` 必填且唯一 owner，`projectId` 可选绑定；Project 不拥有 Todo。Session 是推进 Todo 的一次工作，**Session 结束不自动完成 Todo**；terminal 状态（`completed` / `cancelled`）不可重开。
6. **AgentTodo ≠ Project TODO ≠ Session Todo。** 一个文件不能同时是两种板子；`todo.board-collision` 规则在调用方同时声明两条路径时生效（存储未决策，所以现在不误报）。

## 4. 非法关系规则

`validateDomain(snapshot)` 跑全部规则；调用方只有局部视图时改用窄校验函数（`validateSessionTree` / `validateAgentTodos` / `validateSchedules` / `validateWorkspaceContexts` / `validateAgents` / `validateProjects` / `validateContextItems` / `validateTodoBoardPaths`）。

**失败模型**：snapshot 只声明事实。某个集合缺省＝"不存在"，不等于"未知"；父 session 不在 snapshot 时，只报父缺失，不再级联判断 depth / root / 父子 agent / 父子 project 一致性。返回的是数据不是布尔值——空数组只意味着"在声明的 snapshot 下没有发现违规"。

| rule | 断言的关系 |
|---|---|
| `snapshot.id-duplicated` | 同一集合里 id 唯一，否则没有唯一真源 |
| `agent.dir-not-absolute` | agentDir 是绝对路径 |
| `agent.dir-shared` | 一个 agentDir 只属于一个 Agent（按分隔符/尾斜杠归一后比较） |
| `agent.project-binding-violated` | Agent 声明的 `projectIds` 是上限，WorkspaceContext / AgentTodo 不得越界（§10"Project binding 有效"） |
| `project.root-not-absolute` | Project root 是绝对路径 |
| `project.default-agent-missing` / `-disabled` | Project 的 `defaultAgentId` 必须存在且启用（§10 候选检查） |
| `session.agent-missing` / `-disabled` | session 的 agent 在建会话时解析并持久化，不得隐式取 UI 选择（§10） |
| `session.project-missing` | session 绑定的 Project 存在 |
| `session.root-invalid` | 无父节点者必须是 well-formed root：`depth = 0`、`rootSessionId = 自身` |
| `session.parent-undeclared` | `kind = "child"` 必须有父 |
| `session.kind-mismatch` | 声明了父的节点 `kind` 必须是 `child` |
| `session.parent-missing` / `-self` | 父存在且不是自己 |
| `session.parent-agent-mismatch` | 父子同 Agent（Worker 不是第二个 Agent） |
| `session.parent-project-mismatch` | 父子同 Project（子会话不换业务上下文） |
| `session.depth-mismatch` | `depth = 父 depth + 1` |
| `session.root-mismatch` | 子与父的 `rootSessionId` 一致 |
| `session.cycle` | 父链必须终止于 root；canonical key 只由**环成员**构成（引入环的尾链不计入），所以同一个环只报一次，遍历有界不会挂死 |
| `session.delegated-root` | 带 `delegationRole` 的只能是子会话：Worker 永远是 child（§6） |
| `session.result-not-ready` | `resultBroughtBackAt` 必须先有 `resultRef`：ready 和 brought-back 是两件事（§6） |
| `workspace.agent-missing` / `-disabled` | WorkspaceContext 必须有有效 Agent |
| `workspace.agent-dir-mismatch` | context 的 agentDir ＝ Agent 的 home |
| `workspace.project-missing` | context 的 Project 存在 |
| `workspace.project-root-mismatch` | context 的 projectRoot ＝ Project 的 root |
| `workspace.project-undeclared` | 有 `projectRoot` 就必须有 `projectId`——文件系统路径不等于 Project（§4） |
| `schedule.agent-missing` / `-disabled` | Schedule 指向的 Agent 存在且启用 |
| `schedule.agent-unresolved` | Schedule 必须携带可持久化解析的 agent 引用（`agentId`，或能唯一解析到已注册 Agent 的 legacy `agentDir`）；**不得**在触发时回落到当前 UI 选择（§10） |
| `todo.agent-missing` / `-disabled` | Todo 的 owner Agent 存在且启用；`agentId` 缺失即"Project 拥有 Todo"，非法（§37） |
| `todo.project-missing` | Todo 绑定的 Project 存在 |
| `todo.session-ref-missing` | `sessionRefs` 指向的 session 存在 |
| `todo.session-ref-agent-mismatch` | 推进 Todo 的 session 属于同一 Agent（Agent 之间不得互相改任务） |
| `todo.session-ref-project-mismatch` | Todo 绑定了 Project 时，推进它的 session 必须在该 Project 内 |
| `todo.status-transition` | 生命周期合法；同态→同态视为幂等合法；terminal 不可重开 |
| `todo.board-collision` | Agent Todo 板与 Project TODO 不能是同一个文件（§9 禁止双写/模糊选择） |
| `context-item.owner-missing` | ContextItem 是 session 作用域的，owner session 必须存在 |

## 5. 后续消费方

- **WP2**（Agent Profile Registry + gateway `agentId` 兼容解析）：`AgentRecord` 是 registry + workspace 声明的投影；`ScheduleRecord.agentDir` 是 gateway 今天的形状（`ScheduledTask.agentDir`，替代已废弃的 `accountId`），legacy `accountId` 的映射属于 WP2 兼容层，不在本校验器里。
- **WP4**（Default Agent 与 WorkspaceContext 解析）：`ProjectRecord.defaultAgentId` + `WorkspaceContext` 是解析链的输入输出形状；`workspace.*` 规则是它的自检。
- **WP10**（Agent Todo UI / scope 收口）：`AgentTodo` 字段与 `todo.*` 规则即 §37 的落地形状。

## 6. 本 WP 不做

- 不建 Project / AgentTodo / session-tree 的存储（分别属 WP4 / WP10 / WP7-WP8）。
- 不迁移任何 TODO 文件，不决定 AgentTodo 是 Markdown 板还是结构化存储（§37 明确另行决策）。
- 不改 `todo` 工具、`project-todo` skill、gateway scheduler、session manager 的任何现有行为。

## 7. 引用路径

契约已加入 `packages/coding-agent/package.json` 的 exports：

```json
"./agent-domain":   "src/agent-domain/index.ts"   // barrel
"./agent-domain/*": "src/agent-domain/*.ts"       // 单文件
```

- 包内：相对路径 `../agent-domain`。
- 跨包：`@cornfield/coding-agent/agent-domain`（已在 packages/gateway 实测解析成功）。
