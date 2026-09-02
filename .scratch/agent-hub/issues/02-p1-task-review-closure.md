# 02: P1 — Task + 审查闭环（topic frontmatter + Changes + 验收）

**What to build:** 任务成为一级实体并可被人类验收：用户在工作台创建任务（topic 文件）→ agent 执行 → 任务进入 needs_review 停留态 → 人类逐条验收（criteria + evidence + verdict）→ 全过 done / 不通过打回 running。任务包可选（数字进度必填）。右面板 Changes 支持逐条 diff 审阅、接受/回滚。用户可见效果：任务从"TODO.md 投影"升级为带状态机、包进度、验收证据的完整工作单元。

**Blocked by:** 01: P0 — Agent 中轴纵切（Project 注册表 + 权威归属）

**Status:** ready-for-agent

- [ ] Task 创建 / 状态机（queued → running → needs_review → done，旁路 blocked）
- [ ] 任务包 frontmatter + 数字进度（完成数/N，无包不造假百分比）
- [ ] 验收字段 criteria + evidence + verdict；needs_review 停留态，不通过打回 running
- [ ] Session 与 Task 弱关联（执行痕迹不绑架任务）；产物记录按 agent 聚合
- [ ] Changes 只读 diff（fs_diff / git_* 已就绪，接 UI）
- [ ] 单条接受 / 回滚（高危写操作，单独验收）
- [ ] PR 创建与失败恢复
- [ ] Agent 卡 `workspace` 字段改为权威 project 归属（不再用 role 顶替）
- [ ] cron 写操作走 wire 命令（create/update/delete/test-run；test-run 产生正式 ExecutionRun 带 marker）

验收顺序：Task 状态 → Session 关联 → 只读 diff → 接受/回滚 → PR，逐步验收，不捆 bind。