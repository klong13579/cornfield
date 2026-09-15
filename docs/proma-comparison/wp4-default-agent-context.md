# WP4：Default Agent 与 WorkspaceContext 解析

日期：2026-09-15
状态：已实现（解析 + 持久化 + SDK 接线），等待 review
来源：`architecture-comparison-proma-diagnosis.md` §1 / §4 / §10；WP1 契约 `wp1-agent-domain-contract.md`（§5 后续消费方：WP4 消费 `ProjectRecord.defaultAgentId` + `WorkspaceContext`）

## 1. 交付边界

| 交付 | 位置 |
|---|---|
| 解析策略（纯函数：链、候选校验、WorkspaceContext 派生、失败描述） | `packages/coding-agent/src/agent-domain/default-agent.ts` |
| Project 客户端级权威存储（WP1 权威表标记为「待建 WP4」） | `packages/coding-agent/src/agent-domain/project-store.ts` |
| Agent 目录投影（registry + `<agentDir>/.cornfield/workspace.json` → WP1 `AgentRecord`） | `packages/coding-agent/src/agent-domain/agent-directory.ts` |
| 会话侧组合（把上述三者 + 进程自身身份拼成一次解析；恢复读取 persisted 事实） | `packages/coding-agent/src/session/session-agent.ts` |
| 持久化（`SessionHeader.agentId` / `agentSource`，创建 + fork 写入） | `packages/coding-agent/src/session/session-manager.ts` |
| 接线（`createAgentSession` 解析并写入会话头；恢复时做漂移检查） | `packages/coding-agent/src/sdk.ts` |
| 验证 | `test/agent-domain-default-agent.test.ts`（纯策略）、`test/session-agent.test.ts`（组合 + 存储 + 头部）、`test/sdk-session-agent.test.ts`（真实工厂接线） |

不含：Schedule / Gateway 侧的调用接线（WP2 的 gateway 兼容层负责把 `account.agentId` / `account.agentDir` 变成这里的 `pinnedAgentId` / `processAgentDir`）；把「解析出的 Agent」应用到运行中的进程（config / model / skills / memory 跟随 Agent）——那是 WP3/WP8 的能力；任何 Agent 的启用/停用开关（registry 今天没有这个字段，WP2 的 profile registry 才是它的 owner）。

## 2. 解析链（§10）

```text
session.agentId > project.defaultAgentId > workspaceContext.defaultAgentId
  > user.globalDefaultAgentId > system bootstrap agent
```

两条容易做错的规则，代码里各由一条注释 + 测试钉住：

1. **声明即意图，不做降级。** 最具体的**已声明**候选获胜；如果它不能用（不存在 / 停用 / 模型不可用 / 权限不可用 / Project binding 越界），解析**失败**，绝不静默降级到更弱的声明。让一个会话跑在与声明不同的 Agent 上，正是 §4 警告的跨项目身份泄露（错的知识库、错的规则、错的记忆）。
2. **bootstrap 只在「谁都没声明」时使用。** 它是客户端给裸进程的自身身份（§10 的 system bootstrap），不是坏声明的兜底。

## 3. 候选校验（§10「存在、启用、模型可用、权限可用、Project binding 有效」）

`AgentCandidateFacts` 把 Agent 与两个能力判定一起传入：`modelAvailable` / `permissionAvailable` 是**三值**（`true` / `false` / `"unknown"`）。

- `false` → 拒绝该候选（这是「校验」真正起作用的地方）；
- `"unknown"` → 解析成功但把该能力放进结果的 `unverified`，**不当作通过**。

三值是有意的：本模块无法自己判断某个 Agent 的模型/权限是否可用（那属于 registry / config 层），用一个布尔值就必须撒谎。今天 `agent-directory` 一律给 `"unknown"`，所以 CLI 会在 debug 日志里看到 `unverified: [model, permission]`；WP2/WP3 接上真实探测后，这个字段自动收窄。

其他检查来自 WP1：`AgentRecord.enabled`（今天由「agentDir 是否存在」推导）、`projectIds` 是上限（缺省＝不受约束，空数组同样是上限，与 `relations.ts` 的 `agent.project-binding-violated` 读法一致）。

## 4. 持久化

`SessionHeader` 增加两个**可选**字段（不升 `CURRENT_SESSION_VERSION`）：

```ts
agentId?: AgentId;                 // 创建时解析、之后不再重算
agentSource?: DefaultAgentSource;  // 哪个 scope 定的，随 id 一起持久化
```

- 写入点：`SessionManager.create(..., agent)`（sdk 传入）；`fork` 与 `forkFrom` 把源会话的 Agent 顺延过去（fork 是同一份工作的延续，不重新解析）。
- 读回点：`readPersistedRef(header)`；恢复时**persisted 优先**，只在头部没有记录时才走 §10 链。
- 不加版本号的理由：字段是可选的，缺省与 v3 头部完全兼容；「缺省」在读取侧一律走显式解析（下面第 5 条），所以没有需要区分的行为分支。WP7/WP8 落 `depth` / `rootSessionId` 时再升版本更合适。
- 未 pin 的会话（如 `omp --session-dir X` 走 main.ts 建 manager 的路径）头部不带 Agent：这是「没记录」，不是「没有 Agent」，读取侧显式解析。

## 5. UI 无关性（§10「不得读取当前 UI 的隐式默认」）

- `resolveSessionAgent` 的入参只有持久化事实：`cwd`、`processAgentDir`、`pinnedAgentId`、`sessionHeader`。**类型里没有「当前选中 Agent」这个通道**，所以 Schedule / gateway webhook / 恢复不可能顺手取到它。
- `test/session-agent.test.ts` 里有一条反证：session 头部记录 `hr`、而 Project store 声明默认 `sw` 时，恢复解析结果是 `hr`（persisted）——环境里的声明不会覆盖会话自己的事实。

## 6. 进程一致性（本 WP 的边界规则）

本模块只允许会话记录「这个进程实际所是」的 Agent：链路解析出的 Agent 必须与进程自身身份一致，否则抛 `agent-process-mismatch`（`SessionAgentError`，`failure.kind` 是机器可读的）。

理由：头部如果写 `agentId: "hr"` 而进程仍用客户端自己的 config / auth / model，那头部就是假话。把「按 Agent 起进程 / 按 Agent 装配 config」留给 WP3/WP8；在它落地之前，WP4 明确报错而不是写下不成立的记录。

进程自身身份的判定：`processAgentDir` 命中某个已注册 Agent → 就是它；否则是客户端的裸进程身份 `default`（= `omp serve` / 客户端 `agents.default` 约定），agentDir 取进程 config dir。

## 7. 各 scope 的权威来源

| scope | 今天的权威 | 状态 |
|---|---|---|
| session | 调用方 pin（`processAgentDir` 命中 / 显式 `pinnedAgentId`）+ 会话头持久化值 | 已有 |
| project | `~/.cornfield/agent/projects.json`（`ProjectRecord.defaultAgentId`） | **本 WP 新建** |
| workspace | 无：`WorkspaceDeclaration` 还没有 `defaultAgentId` 字段 | 待定（WP3 的 init/skeleton 接入 Profile Registry 时最自然） |
| user | 无：`config.yml` 里没有这个键，本 WP 没有改 `settings-schema.ts`（不在 scope） | pending |
| bootstrap | 进程自身身份（`default` / 命中注册表的 agentDir） | 已有 |

两个 pending 的 rung 已经实现且被测试覆盖（`default-agent.test.ts` 逐级下探），只是「谁来声明」还没有权威——接线时不需要改策略。

## 8. 失败模型

- 解析失败返回结构化 `AgentSelectionFailure`（`describeAgentSelectionFailure` 生成可执行的一句话），会话侧包成 `SessionAgentError` 抛出；`createAgentSession` 直接失败，不静默起一个别的 Agent。
- Project store 读取失败（损坏 JSON / 版本不符 / 条目形状不对）**是硬错误**，不是「没有 Project」：退化成空 store 会静默把解析降到更弱的声明，等于换个 Agent 起会话。
- 校验：`upsertProject` 拒绝两个 Project 声明同一个 root（一个 root 只能有一个业务上下文，否则 `defaultAgentId` 含义不唯一）。root 比较用 `resolveEquivalentPath`（symlink 归一到真实路径），但**存储保留用户声明的路径**（不改写用户给的路径）。

## 9. 测试覆盖（对应 ticket 勾选项）

| ticket 项 | 覆盖 |
|---|---|
| 解析顺序 | `default-agent.test.ts` 逐级下探 + 顺序常量断言 |
| 存在/启用/模型/权限/binding 校验 | 同上（unknown agent / disabled / capability false / unknown→unverified / 三种 binding 情形） |
| 创建后持久化 agentId + source | `session-agent.test.ts`（磁盘首行）、`sdk-session-agent.test.ts`（真实工厂 + `ensureOnDisk`）、fork 顺延 |
| Schedule/Gateway/恢复不读 UI | 入参无 UI 通道（结构保证）+ persisted 优先于环境声明的反证用例 |
| 无可用 Agent 明确报错 | `no-agent-declared` / `agent-unknown` / `agent-disabled` / `agent-process-mismatch` / `agent-session-conflict` |
| 无 Project / 有 Project / 禁用 Agent / 配置漂移 | 全部有独立用例（漂移＝恢复时 Agent 目录消失 → `agent-disabled`） |
| 派生 WorkspaceContext 合法性 | 生成的 context 直接喂 `validateWorkspaceContexts`（WP1 校验器）返回空 |

## 10. 后续（交给集成/下一个 WP）

1. `main.ts` 的 `--session-dir` 新建路径（`SessionManager.create` 未带 agent）——不在本 WP scope；接上 `resolveSessionAgent` 即可让这条路径也 pin。
2. `user.globalDefaultAgentId` 需要一个权威（`config.yml` 键或 WP2 profile registry），本 WP 没动 `settings-schema.ts`。
3. `workspaceContext.defaultAgentId` 需要 `WorkspaceDeclaration` 增加字段（WP3）。
4. WP2（Agent Profile Registry）应成为 `AgentRecord` 的 owner：本 WP 的 `agent-directory.ts` 是「现有 registry + workspace 声明」的投影，`enabled` / `projectIds` 是推导值，profile 落地后应改为读 profile。
5. gateway / scheduler 接入点：把 `account.agentId` / `ScheduledTask.agentDir` 映射成 `pinnedAgentId` / `processAgentDir`，不要读任何 UI 选择。
6. WP1 `types.ts` 中 `WorkspaceContext.modelConfigPath` 的注释写的是 `<agentDir>/.cornfield/config.yml`；实际 `Settings` 用的是 `<agentDir>/config.yml`，本 WP 按后者派生（注释待修，未改 WP1 文件以免与 T1 冲突）。
