# Agent Client M1 — Tickets

Feature slug: `agent-client-m1`

M1 目标：在不改变现有 Agent、Session、Gateway 和钉钉行为的前提下，建立 Agent Registry/AgentHome 的只读客户端工作台。

| # | 票 | Blocked by |
|---|---|---|
| 01 | Agent Registry 元数据扩展 | None |
| 02 | AgentHome 只读详情加载 | 01 |
| 03 | 多领域 Agent 列表与详情 API | 02 |
| 04 | Desktop/Web 只读 Agent 工作台 | 03 |
| 05 | 从工作台启动已有 Session | 03, 04 |

本 milestone 不包含 User Model 写入、知识写入、DingTalk 自动发言、Observation、Task Control Plane、跨 Agent 协作或 agentDir 物理迁移。

总体架构：`docs/agent-client-architecture-v1.md`
