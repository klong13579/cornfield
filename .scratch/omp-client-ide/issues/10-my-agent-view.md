# 10: 我的 agent 轻视图（Agent 视图起点）

**What to build:** 让员工在壳内看到自己的个人 agent：状态/知识库/画像/近期任务/对话入口（L0 员工价值，D12）。作为 Agent 视图的第一个自定义视图（角色注入骨架：员工角色默认激活），web-app 保留期间与 web-app 并存不冲突。

**Blocked by:** 05（壳骨架）

**Status:** ready-for-agent

**File scope:** packages/editor-extension（自定义视图注册到侧栏容器 + 角色注入）；消费 wire 既有会话/记忆/技能命令（get_memory/get_skills 等已存在）。

- [ ] 员工登录壳 → 侧栏出现"我的 agent"视图（状态/知识库/画像/任务/对话入口）
- [ ] 数据来自 omp 平台（非壳内独立存储）
- [ ] 与 web-app 并存期间数据一致（同一 sessions/记忆）

---
*来源：v3-architecture 阶段 B3；v2-requirements D12 + User Story 2-5*
