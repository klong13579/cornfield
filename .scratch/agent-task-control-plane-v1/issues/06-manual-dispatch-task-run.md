# 06: 手动派发与独立 TaskRun 进程桥

**What to build:** 人工驱动的派发与执行层。`ready` 只表示规格完整可派发，不自动执行；派发 API 全部为显式人工操作：assign、claim、startRun、pause、cancel、retry、resume。`startRun` 为子 Task 创建新 TaskRun，并以独立进程启动独立 AgentSession（复用现有 createAgentSession/discovery/持久化/事件协议，但不把进程内 TaskTool executor 当运行边界）；代码 Task 用创建时固化的 repository + base revision 建独立 worktree；Task 的 specSnapshot/taskPrompt/来源 revision/工作区策略经静态启动协议传入。TaskRun 结束后要求结构化交付报告（outcome/summary/changedFiles/artifacts/验证结果/残余风险/阻塞/下一步），自然语言“做完了”不构成完成报告。同一 Task 的 Run 串行接力，同一时刻仅一个 active Run。只记录实际生效模型，不做 Run 级模型覆盖。

**Blocked by:** 05（可派发的子 Task 由 Task Package 创建产生）。

**Status:** ready-for-agent

- [ ] dispatch 层只暴露显式人工操作；ready 不自动触发任何执行
- [ ] claim 记录 claimedBy/claimedAt/heartbeatAt/leaseUntil，防并发双抢
- [ ] startRun 创建新 TaskRun（attempt 递增）并启动独立进程 AgentSession；worktree 按固化的 repository + base revision 创建
- [ ] 同一 Task 同时至多一个 active Run；暂停/恢复/取消/重试语义符合状态机
- [ ] TaskRun 完成要求结构化交付报告字段齐全；缺失即不 accepted
- [ ] TaskRun 记录实际生效模型（复用 workspace 配置解析链，不新建模型配置、无 Run 级覆盖）
- [ ] 测试覆盖：并发 claim 单赢家、串行 Run 接力、报告校验、进程/session 引用落库
