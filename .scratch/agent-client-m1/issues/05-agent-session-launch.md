# 05: 从工作台启动已有 Session

**What to build:** 用户从 Agent 详情页启动一个已有的普通 Session，复用当前 Session 创建链并在工作台展示启动中、成功、取消和失败状态；该操作不创建常驻 Session，也不引入 Task Control Plane。

**Blocked by:** 03: 多领域 Agent 列表与详情 API；04: Desktop/Web 只读 Agent 工作台

**Status:** ready-for-agent

- [ ] 从详情页启动的 Session 使用所选 AgentHome 和现有创建流程，并能进入已存在的会话界面。
- [ ] 重复点击不会创建重复启动请求或多个意外 Session；启动状态可观察。
- [ ] 用户取消、创建失败、AgentHome 无效和权限拒绝都明确反馈，不显示成功假象。
- [ ] 启动过程不创建持久 Task、Collaboration Request 或新的长期 Agent。
- [ ] 补充启动成功、失败、取消和重复触发的端到端验证。
