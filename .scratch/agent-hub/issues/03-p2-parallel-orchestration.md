# 03: P2 — 多项目并行与编排（不等于 lazy attach）

**What to build:** 多 agent 在同一 serve 下服务多个项目并可并行执行大任务。完整执行语义：资源隔离 / 并发预算 / 文件锁 / 分支隔离 / 取消抢占 / 冲突检测 / judge 验收；kanban 编排接客户端看板 + 验收证据回填。用户可见效果：大任务被 orchestrator 拆 ≥2 worker 并行执行、各 worker 结果独立验收、看板实时反映进度。

**Blocked by:** 02: P1 — Task + 审查闭环（topic frontmatter + Changes + 验收）

**Status:** ready-for-agent

- [ ] 多项目并行注册表（= multidevice P3/P4 同层）
- [ ] 并发执行语义：资源隔离 / 并发预算 / 文件锁 / 分支隔离
- [ ] 取消抢占 / 冲突检测
- [ ] judge 验收（执行/验证分离，接 `topics/independent-verifier.md`）
- [ ] kanban 编排 + 验收证据回填
- [ ] 大任务被 orchestrator 拆 ≥2 worker 并行执行 + 各自验收

⚠ 注意：现有 lazy attach 只解决按需加载 AgentSession，**不等于**并行执行正确性。