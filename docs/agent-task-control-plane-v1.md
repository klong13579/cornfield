# Agent 持久任务控制面 v1：功能定义

## 1. 目标

建立一个持久化 Agent 任务控制面，把研发事项从记录推进到可整理、可派发、可执行、可恢复、可验收、可追溯。

```text
TODO/topic → triage → proposal → Task → TaskRun → Verification → 人工合并 → 回写
```

Kanban 是控制协议的投影，不以视觉看板为第一目标。

## 2. v1 范围

纳入：

- 单 Git 仓库代码研发 Task
- TODO/topic 自动生成 triage 候选项
- 人工触发整理 Agent，生成 proposal
- 一次确认、批量生成 Task 集合
- Task 依赖（blocks / informs）
- v1 Task 固定绑定欢迎页当前 `default` Agent，由人/Lead 手动启动
- 独立 AgentSession 与进程执行
- 代码任务默认独立 worktree
- TaskRun 历史、结构化交付报告
- 独立 Verification
- 显式合并
- 失败、重试、暂停、取消、恢复
- 状态、事件和验收审计

不纳入：自动启动、自主抢单、自动 stale 回收、Task 级权限限制、多仓库 Task、自动合并、全业务任务、squad-programming 适配、视觉看板优先建设、替代现有 `/todo`。

## 3. 对象与关系

```text
TODO/topic → Proposal → Task[] → TaskRun[] → Verification[]
```

- TODO.md：人的入口和意图索引。
- Topic：长期背景、设计、决策、整体验收。
- Proposal：整理 Agent 的未确认建议。
- Task：可独立派发和验收的持久工作单元。
- TaskRun：一次具体执行及其事实。
- Agent：长期身份、指令、工具、记忆和运行配置；v1 先只支持 serve 自带的 `default` Agent。
- Worker：`default` Agent 为某个 TaskRun 启动的执行角色，不是独立配置主体。
- AgentSession/Process：TaskRun 的运行载体。
- Verification：独立验收记录。
- Event：状态和操作的审计事实。

## 4. 角色

Human/Lead 触发整理、审核提案、指定 Worker、启动/暂停/取消/重试、处理阻塞、验收后合并。

Organizer Agent 读取 TODO/topic，提出拆分、依赖、验收、风险和缺失信息；不得直接 ready、claim、启动或伪造决策。

Worker 在工作区执行 Task，汇报状态并提交结构化交付报告；不得自行 accepted 或合并。

Verifier 执行预配置检查并输出 passed/rejected。

## 5. 来源与整理流程

```text
TODO/topic 新增 → triage（不启动模型）
triage → 人/Lead 显式触发 Organizer → proposal_ready
proposal_ready → 人/Lead 整体确认 → 批量生成 Task
Task → preflight → ready / incomplete / blocked / awaiting_approval
```

一条 TODO/topic 可生成一个或多个 Task；Topic 不是 Task。裸 TODO 默认 triage，不自动执行。

## 6. 状态

正常流：

```text
triage → organizing → proposal_ready → draft → preflight → ready
→ claimed → running → review → accepted
```

异常状态：`incomplete`（定义缺失）、`blocked`（外部条件/依赖未满足）、`awaiting_approval`（等人工授权）、`rework`（验收拒绝）、`paused`（可恢复）、`stale`（claim/heartbeat 异常）、`rejected`（定义被否决）、`cancelled`（明确终止且不可恢复）。

硬规则：`TaskRun succeeded ≠ Task accepted`；Verification passed 才能 accepted；Verification rejected 进入 rework；只有 accepted 才解除 blocks 依赖。

## 7. Task 完成契约

```yaml
completion:
  outcome: []      # 要达到的结果
  verifiers: []    # 如何验证
  evidence: []     # 必须留下的事实
```

Task 必须绑定一个 Agent、一个仓库、优先级 P0/P1/P2/P3、来源 revision、执行快照、工作区策略和验收方式。v1 的 Agent 固定为欢迎页 `default`；不提供 Agent 选择器，也不设 Worker Profile 模型分层、deadline、Task 级工具/权限、network、budgetTokens。

## 8. 执行与生命周期

一个 Task 可有多个连续 TaskRun，同一时刻只能有一个 active Worker。失败或拒绝保留原 Task，追加新 Run；目标实质变化则关闭旧 Task、新建 Task。

```text
TaskRun: queued → starting → running → succeeded | failed | timeout | cancelled
Verification: unverified → verifying → passed | rejected
```

Worker 必须返回 `outcome`、`summary`、`changedFiles`、`artifacts`、验证尝试/结果、残余风险、阻塞和下一步。

ready 只表示规格完整且可派发，不表示自动执行。v1 固定由欢迎页 `default` Agent 手动启动：`agentId = default`，workspace/repository 使用当前 `cornfield serve` 的项目根。TaskRun 复用 default Agent 的现有设置和模型解析链，不新建模型配置文件，也不提供单次 Run 模型覆盖；只记录实际生效模型。claim 记录 `claimedBy/claimedAt/heartbeatAt/leaseUntil`；租约过期只标记 stale，v1 不自动回收。

## 9. 工作区和合并

```yaml
workspacePolicy: shared | worktree | none
```

代码修改默认 worktree；只读任务可 shared/read-only；外部业务任务不在 v1 执行。Worker 只改自己的工作区。Verifier 通过后由 Lead/人工显式合并，Worker 不得自行合并。

## 10. 依赖与版本

```yaml
dependencies:
  - taskId: task-...
    type: blocks | informs
```

Task 创建时保存 `sourceRevision`、`taskRevision` 和 `specSnapshot`。Topic 变化不静默覆盖运行中的 Task：未执行项重新预检，claimed/running 标记 `needs_review`，review 冻结核心契约。运行中修改必须走 change proposal、新 revision、新 Run。

## 11. 权威来源

```text
TODO/topic       意图与长期上下文
SQLite           Task、依赖、claim、状态
TaskRun JSONL    执行事件与输出事实
Verification     验收结论
UI/intercom      展示或事件通道，不是状态真源
```

使用稳定 ULID/UUID：`todoId/topicId/taskId/runId/verificationId`。

## 12. 验收标准

- 同一 TODO/topic 幂等生成唯一 triage 候选项。
- Organizer 只能生成 proposal；提案整体确认后才能批量生成 Task。
- 非法状态转移被拒绝；ready 不自动启动 Worker。
- 同一 Task 同时最多一个 active Worker，claim 可追溯。
- 每次执行都有独立 TaskRun，失败不覆盖历史。
- 进程重启可通过 Session/transcript 恢复；paused 可恢复，cancelled 不可恢复。
- 普通代码 Task 默认进入独立 Verification；Worker succeeded 不直接 accepted。
- 验收拒绝进入 rework；Worktree 在验收前不进入主分支。
- 通过验收且人工确认后才允许合并。
- 所有状态、执行、失败和验收证据可追溯。
