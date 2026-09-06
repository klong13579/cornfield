# 05: Organizer proposal → 原子 Task Package 创建

**What to build:** 从已确认的 triage 候选项出发的整理（organizing）与 proposal 生命周期：人工显式触发整理后，Organizer 基于来源项产出结构化 proposal（目标、范围、依赖、验收、风险与缺失信息），进入 `proposal_ready`。人工确认后 `acceptProposal` 在单事务内原子创建：一个 Task Package + 其唯一 Main Worker 记录 + 全部子 Task（留在 `draft`）+ 依赖边。任何一项校验失败则整体不创建（无部分创建）。Organizer 无 dispatch/start 权限；proposal 可被拒绝。Task 的验收标准（outcome/verifiers/evidence）在创建时即固化，执行前必须齐备。

**Blocked by:** 04（消费 triage 候选项）。

**Status:** ready-for-agent

- [ ] `startOrganization` 显式触发，走现有 subagent 机制 + proposal 输出 schema，产出 `organizing` 状态
- [ ] Organizer 产出含拆分、依赖、验收、风险与缺失信息的 proposal，无 dispatch/start 能力
- [ ] `acceptProposal` 单事务原子创建 Task Package + Main Worker 记录 + 全部子 Task + 依赖边；任一失败整体回滚
- [ ] 新 Task 初始为 `draft`（非 ready、不自动执行）
- [ ] 每个 Task 创建时完成契约齐备：outcome/verifiers/evidence 在成为 ready 前不可缺
- [ ] `rejectProposal` 将 proposal 置 `rejected`
- [ ] 测试覆盖：proposal 校验失败、原子创建成功/回滚、依赖边正确落库
