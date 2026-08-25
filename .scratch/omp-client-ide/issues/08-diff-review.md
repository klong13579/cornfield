# 08: diff 审阅（agent 改动的接受/拒绝）

**What to build:** 让研发在 IDE 里审 agent 对文件的实际改动：agent 会话内/后，改动以 diff 呈现，人可接受 / 拒绝 / 手动修改后接受（核心差异化，信任闭环）。基于 IDE 文件通路（06）的 fs_diff + 写路径实现。

**Blocked by:** 01（wire fs 写命令面）、05（壳骨架）——不依赖 06：diff 数据源 = wire fs_diff（01 已含）+ ACP 会话的改动记录（05 壳的 Agentic Chat View 自带 diff artifact 视图），接受/拒绝落地用 01 的写命令。

**Status:** ready-for-agent

**File scope:** packages/editor-extension（diff 视图 UI + 接受/拒绝/修改后接受交互）；消费 wire fs_diff/fs_write。

- [ ] agent 改文件后，IDE 内显示该文件 diff（改动上下文可见）
- [ ] 接受 → 改动落地；拒绝 → 还原；修改后接受 → 按用户编辑结果落地
- [ ] 冲突场景（agent 改后用户又改了）有明确提示，不静默覆盖
- [ ] 验收冒烟：真实 omp agent 会话改文件 → 审 → 批，全程可见

---
*来源：v3-architecture 阶段 B2；spec User Story 14；spike 端到端路径复用*
