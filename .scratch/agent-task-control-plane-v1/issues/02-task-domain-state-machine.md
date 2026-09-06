# 02: 任务控制面领域模型与状态机

**What to build:** 持久任务控制面的完整领域类型与合法状态转移表，作为后续存储、派发、Main Worker、CLI 各票的契约基础。覆盖 `Task`、`TaskRun`、`Verification`、`TaskPackage`、`MainWorker`、`TaskDependency`、`Proposal`、来源项与事件的类型定义；`TaskStatus`、`TaskRunStatus`、`VerificationStatus`、`MainWorkerStatus` 等 string-literal union；以及 `blocks`/`informs` 依赖语义。合法转移与 guard 集中在一处，适配层不得直接写状态字符串。本票交付纯逻辑：类型 + 状态机 + 事件契约，不涉及 SQLite 或进程。

**Blocked by:** None（可立即开始）。

**Status:** ready-for-agent

- [ ] 状态机覆盖功能定义 §6 正常流与全部异常状态（含 `incomplete`/`blocked`/`awaiting_approval`/`waiting_user`/`rework`/`paused`/`stale`/`rejected`/`cancelled`）
- [ ] `TaskRunStatus` 与 `TaskStatus` 分开，不坍缩为一类；`succeeded ≠ accepted` 的语义在类型上可表达
- [ ] `TaskPackage`/`MainWorker` 状态流覆盖 `queued → starting → decomposing → dispatching → supervising → package_review → package_accepted`（含 `waiting_user`/`failed`/`cancelled`）
- [ ] `rework` 回路：子 Task 可多次顺序 TaskRun，同一 Task 同时至多一个 active Run
- [ ] 每个实体事件契约（append-only）随状态机同票定义
- [ ] 合法/非法转移均有单元测试：`accepted`/`cancelled`/`rejected` 终态不可逆，`paused` 可恢复，`stale` 只标记不自动回收
- [ ] 领域词表与功能定义 §3/§4 一致（Task/TaskRun/Main Worker/Worker/Verification 等职责不混用）
