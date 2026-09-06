# Agent 持久任务控制面 v1 — Tickets

Feature slug: `agent-task-control-plane-v1`

依据设计文档（v1.1 Main Worker 编排模型）：

- `docs/agent-task-control-plane-v1.md`（功能定义）
- `docs/agent-task-control-plane-v1-implementation.md`（实现规格）

依赖关系：01 与 02 相互独立、可并行；03 起为线性主链，见下表 Blocked by（表格是依赖的唯一真源）。

| # | 票 | Blocked by |
|---|---|---|
| 01 | default Agent workspace 固定与幂等初始化 | None |
| 02 | 任务控制面领域模型与状态机 | None |
| 03 | SQLite 持久层 | 01, 02 |
| 04 | TODO/topic → triage 幂等同步 | 01, 03 |
| 05 | Organizer proposal → 原子 Task Package 创建 | 04 |
| 06 | 手动派发与独立 TaskRun 进程桥 | 05 |
| 07 | Main Worker 生命周期与验收回路 | 06 |
| 08 | 恢复与 stale 检查 | 06, 07 |
| 09 | CLI/SDK 控制面入口与只读投影 | 07, 08 |
