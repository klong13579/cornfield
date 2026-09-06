# 08: 恢复与 stale 检查

**What to build:** 进程重启后的运行事实恢复与租约过期处理。TaskRun/session 引用在启动进程前先落库；进程启动/重启时扫描所有非终态 Run，结合 session 元数据与进程状态做 reconcile：可恢复的通过既有 session resume 路径重挂/续跑，缺失 transcript 或进程状态歧义的标记为 failed/stale 并追加事件、等待人工动作——绝不把进程退出码当成功证据。heartbeat 定期更新 active Run/claim 记录；lease 过期只把 Task 标 `stale`，提供 inspect/release/retry 命令，v1 不做自动回收。

**Blocked by:** 06（TaskRun/进程桥）, 07（Main Worker 会话）。

**Status:** ready-for-agent

- [ ] TaskRun/session 引用在 launch 前落库（崩溃后仍可定位运行事实）
- [ ] 启动时扫描非终态 Run 并 reconcile；恢复路径与错误分类符合实现规格 §10
- [ ] 进程退出码不被当作成功证据；transcript 缺失或状态歧义 → failed/stale + 事件 + 人工动作
- [ ] heartbeat 更新与 lease 过期标 `stale`；v1 无自动回收
- [ ] inspect/release/retry 命令可用且不绕过状态机
- [ ] 测试用真实临时目录 + 真实 SQLite，覆盖进程/session 恢复与歧义终态判定
