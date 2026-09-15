# Orchestration Record 契约

日期：2026-09-15
状态：设计契约（`architecture-comparison-proma-diagnosis.md` §11 Phase 1 / WP5 的产物，可编码）

> 本文只定义**契约**，不复制实现。参考实现是用户级 skill 的 `scripts/orchestration.ts`（位置与状态见 §9）。
> 上游诊断给出方向：**不要另造脱离 squad 的 Session Tree scheduler，把 squad 的任务包与状态模型提升为通用 Orchestration Record，squad 作为代码任务策略**（该文 §7、§38）。本文把那句话变成可判定的字段、词表、规则与边界。

## 1. 范围与三条硬不变量

**Orchestration Record（编排记录）**= 一组**单元**（unit）+ 记录级**并发上限**。单元是「一件被编排的工作」，记录是「一次编排的底账」。squad 的 `.squad.json`（任务包）与 `state.json`（账本）是它的一个**特化**：`subtasks` 就是 units，其余字段（`squadId` / `baseBranch` / `parent` / `workspaceId` / `assembly`）由代码策略自带。

三条硬不变量（违反即设计失败，不是实现细节）：

1. **不新建 scheduler / runtime。** 调度仍是「编排者按 reconcile 计划发放 GO + 用既有跨进程消息通道发指令」；内核只**算计划**，不起进程、不排队、不引入守护线程/守护进程，也不引入第二条消息通道。
2. **只有一份状态机。** 状态词表、转移矩阵、依赖/槽位调度、账本读写机制各只有一处定义；策略层**引用**，不重声明 —— 参考实现的历史里，同一规则各写一份真实漂移过（prose 一份、代码一份，改了一边没改另一边）。
3. **外部形状稳定。** 记录落到磁盘的字段、命令行动词、reconcile 计划 JSON、父子消息形状对所有策略一致；新增编排类型不得改动既有形状 —— 旧账本与旧任务包必须继续可执行。

## 2. 单元（unit）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | string | 是 | 记录内唯一；消息 dialect、依赖引用、命令行动词都用它寻址 |
| `deps` | string[] | 否 | **契约式依赖**的单元 id（先定接口/签名，双方基于契约独立开发）。顺序依赖（B 需要 A 的产物）不允许拆成依赖，必须合并为同一执行序列 |
| `status` | 状态词表 | 是 | 见 §3 |
| `updatedAt` | number | 是 | epoch ms，每次状态更新写入 —— 恢复时判断新鲜度的依据 |
| `note` | string | 否 | 人读备注（阻塞原因、取消原因、验收结论）。不设置时保留原值 |
| `acceptance` | 策略形状 | 否 | **验收绑定**槽位，见 §6。内核只认这个槽位存在，不解释内容 |

依赖的边界：`deps` 只允许表达**契约式**依赖。环、自指、引用不存在的 id 属于非法记录（生产者应在生成任务包时拒绝，而不是留给调度期死等）。

## 3. 状态（state）

单元状态词表（7 态），语义分三段启动 + 验收：

| 状态 | 含义 | 谁写入 |
|---|---|---|
| `assembled` | 单元已启动（进程/pane 在），准备检查尚未被编排者确认 | 集结阶段 |
| `started` | 准备检查通过（包已读 + 模型可用），**停在 GO 闸门**等开工 | 确认消息到达后 |
| `running` | 编排者已发 GO（幂等，可补发）——单元在实现中 | 发出 GO 后立即落账 |
| `blocked` | 单元上报阻塞/求助（`assembled`/`started`/`running` 均可达） | 上报后 |
| `reviewing` | 单元自报实现完成，等编排者跑 gate | 上报 `REVIEWING`/`COMPLETE` 后 |
| `complete` | **验收通过**（终态） | **只能由验收动作写入**（见 §6） |
| `failed` | 失败或取消（终态，`note` 记原因） | 上报/判死/取消 |

**终态**：`complete` / `failed`，不可逆。

关键区分（这条区分是「未验收的内容被当成交付」的唯一拦截点）：**消息层状态 ≠ 编排层状态**。单元回报 `COMPLETE` 落的是 `reviewing` —— 编排者还要跑 gate 并做验收；`complete` 由验收动作连同交付绑定一起写入。

## 4. 转移（transition）

| 当前 | 允许转移到 | 说明 |
|---|---|---|
| `assembled` | `started` / `blocked` / `failed` | 允许直转 `blocked`/`failed`：准备检查失败（缺 key、包不可读、进程死）就是首条上报，不允许会把落账卡死 |
| `started` | `running` / `blocked` / `reviewing` / `failed` | `→running` = GO 已发；`→reviewing` 是容错（编排者漏记 `running` 而单元已回报完成） |
| `running` | `blocked` / `reviewing` / `complete` / `failed` | 正常主链 |
| `blocked` | `started` / `running` / `reviewing` / `complete` / `failed` | 解除阻塞后可回到闸门或直接补发 GO |
| `reviewing` | `running` / `complete` / `failed` | `→running` = 打回继续干；不允许回 `started`（回闸门无意义） |
| `complete` | ∅ | 终态 |
| `failed` | ∅ | 终态 |

规则：

- **同状态重复设置是幂等的**（只刷新 `updatedAt`/`note`），不是错误 —— 恢复期重复落账必须无害。
- **非法转移被拒绝**，包括 `assembled → complete`、`started → complete`（GO 台账不能丢：确知已发过 GO 的恢复场景才可用显式 `force` 落账）、任何 `→ assembled`（不可回退）。
- **`force` 只跳过转移校验**，不跳过「状态值属于词表」「单元存在」这类校验；它只服务于编排者中断后的补记账。

## 5. 依赖与并发（deps + concurrency reconcile）

reconcile 是**唯一调度真源**：幂等纯函数，输入记录、输出计划。编排者每轮（收到消息后/间隙）跑一次；进程中断后重跑同一函数即从 `state.json` 重算计划，不依赖内存。

### 5.1 计划字段

| 字段 | 含义 | 编排者的动作 |
|---|---|---|
| `needConfirm` | `assembled`：准备检查未确认 | 发确认请求（非阻塞），有界轮询收 ACK → 落 `started` |
| `needGo` | `started` + deps 全 `complete` + 有空槽 | 发 GO（幂等可补发）→ **先发后记**落 `running` |
| `waitingDeps` | `started` 但依赖未全 `complete`（`blockedBy` 列出未完成的依赖 id，含未知 id） | 等依赖方终态，不动 |
| `waitingConcurrency` | deps 已满足但槽位满（按单元数组序排队） | 等槽位释放 |
| `unrunnable` | deps 中有 `failed`（`failedDeps` 列出） | 不可能开工 → 转用户拍板（重拆/放弃） |
| `inFlight` | `running` / `reviewing` | 占槽，等终态 |
| `blocked` | `blocked` | 占槽，等决策 |
| `terminal` | `complete` / `failed` | 无 |
| `maxConcurrency` / `freeSlots` | 生效上限与剩余槽位 | 无 |

### 5.2 并发槽位口径

- **占槽**：`running` / `reviewing` / `blocked` —— 进程还活着（或仍占着资源）的单元。
- **不占槽**：`assembled` / `started` —— 停在闸门空等，不耗模型配额。
- 上限解析优先级：**显式参数 > 记录字段 `maxConcurrency` > 默认 3**。默认 3 是资源保护（N 个隔离工作区同时构建会抢 CPU/磁盘；同 provider 多并发还会触发配额限流）。

### 5.3 恢复语义（崩溃安全）

- **幂等**：GO 可重复到达（重复无副作用，已在干活就继续、不重启任务）；reconcile 可反复跑。
- **先发后记**：先发 GO 消息再落 `running`。若在两步之间崩溃，恢复后 reconcile 仍报 `needGo` → 补发 GO（幂等），无死等窗口。反向（先记后发）会留下假 `running`，因此禁止。
- **超时 ≠ 死**：等待超时只说明本轮没等到回复，不说明对端没收到、更不说明它死了。禁止据此重发指令或判死；只有当**进程/终端层证据**显示异常时才落 `blocked`/`failed`。
- **指令可幂等取代**：改变决策（改范围、改模型、改验收口径、撤销 GO）时，新指令必须自带**决策名 + 版本 + 显式作废前一条**；只发新指令而不作废旧指令，会让队列里并存两条语义相反的指令。

## 6. 验收绑定（acceptance binding）

单元上的 `acceptance` 是「这份交付是在**什么**上被验过的」的凭证。

- **槽位在内核，形状由策略定义**：内核只要求「验收动作写入它、且写入与终态 `complete` 同批」，不解释其字段。
- **代码交付策略的绑定**：`{ verifiedCommit, pinnedBranch, verifiedAt }` —— 验收针对某个 **commit**（而非「某条分支」），并把交付**钉**到一个单元进程无法移动的分支上。
- 为什么必须钉：验收针对的是一个 commit，而合体按**分支名**（一个可移动的指针）。两者之间没有天然绑定，单元在验收后再提交一次，就是把「验过的内容」换成「没验过的内容」，且**没有任何告警**。合体前必须逐条比对「验收时的 commit」与「当前分支头」是否相等，被移动过就拒绝合体，要前移必须显式声明「重新验收」。
- 不变量：`complete` 与绑定**同批写入**（不存在「已验收但无绑定」的记录）；已 `failed` 的单元不可验收；重复验收必须显式指定前移，防止悄悄把验收挪到没验过的 commit 上。

## 7. 策略边界

| 层 | 拥有 | 权威实现（用户级 skill） |
|---|---|---|
| **编排内核**（策略无关） | 单元记录、状态词表与转移、deps+槽位 reconcile、账本读写机制、验收绑定槽位 | `scripts/orchestration.ts` |
| **代码交付策略** | 隔离方式（worktree / 只读共享 / 可写共享）、交付落点与分支、gate 校验命令、验收绑定的形状与钉法、合体方式、任务包 schema、模型档位与思考等级 | `scripts/squad-state.ts` / `bundle.ts` / `assembly.ts` / `integrate.ts` / `bootstrap.ts` |
| **消息 dialect**（父子通用） | 消息形状与「消息 → 状态」映射 | `scripts/protocol.ts` |

内核**不得出现**的词汇（出现即边界被侵蚀）：`worktree`、`branch`、`pane`、`herdr`、`isolation`、`git`、模型档位、gate 命令。这些是「代码交付」这一种策略的载荷。

**复用面（新策略必须复用，不许另起）**：

| 既有机制 | 提供什么 |
|---|---|
| 账本（`state.json` / 等价记录文件） | 权威底账；进程中断后的唯一恢复来源 |
| reconcile 计划 | 唯一调度真源（依赖 + 槽位 + 待确认/待开工/等待分流） |
| GO 闸门 | `started` 与 `running` 的分离：启动不耗配额，开工由编排者放行 |
| gate 校验 | 每个单元「什么算好」的可执行判据 + 验收前的独立验证 |
| 跨进程消息通道（intercom） | 父子进程通信：汇报、求助、指令 |
| 隔离与合体 | 并行编辑互不干扰；交付在验证区合体后才交接 |
| 验收绑定 + 合体前校验 | 保证合进来的是验过的那份内容 |

**新编排类型接入方式**：自带①记录字段（策略专有的落点/资源信息）②验收绑定的形状 ③执行单元的方式；其余（状态机、reconcile、dialect、恢复规则）直接复用。今天只有「代码交付」这一种策略在跑；内核的通用性当前由测试保证（用非代码形状的单元驱动状态机与 reconcile），**尚未由第二种生产策略证明** —— 这是已知空白，不是已完成项。

## 8. 明确的非目标

- **不新建 scheduler / runtime**（§1 不变量 1）；不引入守护进程、任务队列、第二条消息通道。
- **不做 in-process Session 运行时**：正式子会话 = 独立进程；同会话内的异步任务沿用既有进程内 Task 机制，不升级为正式记录单元（见诊断 §38）。
- **不新造 broker / AgentDir skeleton / Project Todo store / squad scheduler**。
- **不动外部形状**：既有账本、任务包、命令行动词、计划 JSON、消息 dialect 保持不变（破坏性变更需按版本策略推进，不是顺手改）。

## 9. 参考实现与验证

参考实现：用户级 skill 的 `scripts/orchestration.ts`（`~/.cornfield/agent/skills/squad-programming/`）。**不在本仓复制该 skill** —— 该 skill 自 2026-09-09 起为用户级资产，项目级副本已删除（本仓 `1c837a9cf3`），文档与脚本一律用 `skill://` 引用。

参考实现当前的落地状态（阅读时请先核对，别按记忆假定）：它在 `~/.cornfield` 仓的分支 `squad-agent-first-a-wave2-t4`（commit `a36d1f0`）上**待合并**；未合并前 live skill 目录里还没有这个文件。

已有的验证证据（针对该参考实现）：

- 状态机与 reconcile：既有账本测试全绿（205 条），新增内核契约测试 16 条，合计 **224 pass / 0 fail**；内核「不含策略词汇」由导出面 + 代码行两个方向断言。
- 类型层：静态检查（tsgo，含测试文件）零诊断。
- 真实执行的分支：集结校验 + dry-run（隔离工作区 / 只读共享两条路径）、账本全部命令行动词（含非法转移与无法识别消息的非零退出）、真实 git 仓上的验收（建钉死分支 + 记绑定）→ 合体前验收校验通过。
- 未验证的部分：第二种策略的端到端（尚无第二种生产策略）；这些属于后续工作包。

## 10. 与后续工作包的关系

- 本文是 **WP5** 的契约产物；WP6（子会话进程监管 + 消息适配）、WP7（父子会话端到端与恢复）应**复用**本文的单元/状态/reconcile/验收绑定，而不是各写一套。
- 若后续要在**本仓**落地编排记录的读写（例如网关或会话树管理读取任务包/账本），那是**适配层**（本仓代码）而非 skill 的复制；届时以本文为契约，并以用户级 skill 的实现为行为基准。
