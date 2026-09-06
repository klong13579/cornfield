# 09: CLI/SDK 控制面入口与只读投影

**What to build:** 控制面的首个适配层：CLI/SDK 操作 + 只读状态投影（v1 不建视觉看板，UI 后续接入）。投影读 store，不直写 SQL：主列 triage/ready/claimed/running/review/accepted，异常过滤器覆盖 incomplete/blocked/approval/stale/rework。命令覆盖：来源同步、查看 triage/proposal/Task/TaskRun/Package 与 Main Worker 状态、确认 proposal、人工启动 Main Worker、回答 `waiting_user`、合并操作（合并仍为显式人工动作）。每类操作通过 domain 接口发出，状态机与存储层约束不被绕过。

**Blocked by:** 07（Main Worker 生命周期）, 08（恢复与 stale 检查）。

**Status:** ready-for-agent

- [ ] CLI/SDK 命令可完成“来源 → proposal → Task → 派发 → Main Worker → 验收 → 合并”主链路的人工操作
- [ ] 只读投影按主列 + 异常过滤器组织，可从 store 组装，不直写 SQL
- [ ] `waiting_user` 有明确的一级查看入口（非仅错误态）
- [ ] 合并为显式人工命令，Worker/Main Worker 无合并权限
- [ ] 命令层不绕过状态机与存储约束；每条命令对应集成测试
- [ ] 与既有欢迎页/`/todo` 入口的关系：不做替代，只新增控制面命令面
