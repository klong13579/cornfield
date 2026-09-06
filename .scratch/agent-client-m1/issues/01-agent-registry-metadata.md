# 01: Agent Registry 元数据扩展

**What to build:** 在保持现有名称到路径索引职责的前提下，为客户端提供领域 Agent 的最小展示元数据，包括显示名、领域、生命周期/状态、使命引用、知识引用和渠道引用。Agent Registry 只保存索引和轻量缓存；AgentHome 仍是身份、规则、知识和运行上下文的真实来源。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 新旧 Registry 数据都能读取；缺少新字段的旧 Agent 使用明确的兼容默认值。
- [ ] 重复名称、过期路径和无效元数据不会静默覆盖或伪装成正常 Agent，并返回可解释状态。
- [ ] Registry 更新保持幂等，且不复制完整 Agent 定义、知识内容或权限策略。
- [ ] 现有 Agent init/list/show/validate 行为继续可用。
- [ ] 为新增元数据和兼容场景补充针对性测试。
