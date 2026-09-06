# 04: TODO/topic → triage 幂等同步

**What to build:** 来源同步器把 default Agent workspace 的 `TODO.md` 与 `topics/` 内容映射为持久控制面的 triage 候选项：每个来源项（一条 TODO 或一个 Topic）幂等生成且仅生成唯一候选项，来源文本变化时更新候选项标题/内容并推进 revision，来源删除不静默丢弃已有候选项。同步过程中不启动模型、不 claim、不创建 ready Task，也不重写用户来源文件。来源 revision 变化时按规则打 `needs_review` 标记，供后续人工/整理流程处理。

**Blocked by:** 01（来源路径位于 `~/cf-workspace`）, 03（写入 store）。

**Status:** ready-for-agent

- [ ] 同一来源项重复同步只产生唯一 triage 候选项（幂等）
- [ ] 来源项身份使用稳定 ID，不以标题/路径/hash 当身份
- [ ] TODO.md 与 topics/ 均被纳入；来源解析遵循项目既有 project-todo 纪律，不整体重写用户文件
- [ ] 同步绝不启动模型、不 claim、不自动创建 ready Task
- [ ] 来源内容变化 → revision 递增并打 `needs_review`；来源删除 → 候选项不被静默丢弃
- [ ] 覆盖幂等、revision 变化、来源删除三类场景的测试
