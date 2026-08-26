# 09: 审批卡内嵌（IDE 内 agent 权限请求）

**What to build:** 让 IDE 内 agent 要权限时弹出审批卡，批/拒决策两端一致：OpenSumi 侧 requestPermission 处理器（已在）接到 04 发射的请求 → 渲染审批卡（复用 web-app ApprovalCard 组件）→ 决策（allow once / reject once / allow always）流回 agent；决策记录与 Agent 视图侧一致（同一审批策略）。

**Blocked by:** 04（requestPermission 发射）、05（壳骨架）

**Status:** ready-for-agent

**File scope:** packages/editor-extension（审批卡 UI + 决策路由，复用 web-app ApprovalCard）；对接 wire permission_respond（既有协议）。

- [ ] agent 触发需审批操作 → IDE 内弹出审批卡（复用 web-app 组件）
- [ ] allow/reject/always 决策正确流回 agent 并生效
- [ ] 审批策略（分层：必须人批/可配置放行）在 IDE 与 Agent 视图一致（同一 schema）
- [ ] 验收冒烟：真实 agent 会话请求权限 → 卡弹出 → 审批 → agent 继续

---
*来源：v3-architecture 阶段 B2；spec Implementation Decision #5 + User Story 15/22*
