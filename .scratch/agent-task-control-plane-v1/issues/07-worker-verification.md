# 07: Main Worker 生命周期与验收回路

**What to build:** Topic Package 级 Main Worker 的完整生命周期与子 Task 验收回路。`startMainWorker(packageId)` 是人工/Lead 显式命令，创建一个独立 Main Worker Session/进程（每 Package 至多一个，不可自动启动）。Main Worker 读取已确认 Package 快照，分解/派发子 Task、按依赖调度子 Worker、监督其 TaskRun、处理 `waiting_user`/`blocked`。子 Task 提交交付报告后，Main Worker 检查 Task 快照、报告、changed files、验证证据、diff 与会话事件决定 `accepted`；不通过则生成结构化 findings/requiredChanges、将子 Task 打回 `rework` 并安排新 TaskRun（不修改已确认的 Package 契约、不新建 Task）。Verifier 是 Main Worker 可调用的证据提供者，不是独立验收责任人。Package 全部 required 子 Task accepted 后 Main Worker 汇总进入 `package_review` → `package_accepted`，此时才显示“可合并”，合并仍需人工显式确认。Main Worker 遇关键不确定性必须进入 `waiting_user`，不得自行猜测继续。

**Blocked by:** 06（派发与 TaskRun 进程桥）。

**Status:** ready-for-agent

- [ ] `startMainWorker` 为人工显式命令，每 Package 至多一个 Main Worker/独立 Session；未收到命令不得启动
- [ ] Main Worker 状态流转覆盖 decomposing/dispatching/supervising/package_review/package_accepted 与 waiting_user/failed/cancelled
- [ ] Main Worker 按依赖调度子 Worker，监听 TaskRun 状态；子 Task 验收决定 `accepted` 或打回 `rework`
- [ ] 打回产生结构化 findings/requiredChanges，追加新 TaskRun；不修改已确认 Package 契约、不新建 Task、不代人工合并
- [ ] `waiting_user` 是可恢复的正常协作状态，不是执行失败；人工回答后可继续
- [ ] 普通代码 Task 验收必须有独立验证证据，子 Worker 自验不直接等于通过
- [ ] Package 汇总与合并门槛：全部 required 子 Task accepted + Main Worker 汇总后才允许人工合并
- [ ] 测试覆盖：Main Worker 生命周期、派发、监督、waiting_user、accepted/rework、Package 汇总与拒绝路径
