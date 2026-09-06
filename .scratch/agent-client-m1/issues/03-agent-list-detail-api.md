# 03: 多领域 Agent 列表与详情 API

**What to build:** 提供客户端只读的 Agent 列表和详情入口，能够稳定展示首批 coding、HR、算法、软件、数据分析、机电结构、产品、融资 Agent，并把 stale、缺失、重复和配置错误表达为可诊断结果。

**Blocked by:** 02: AgentHome 只读详情加载

**Status:** ready-for-agent

- [ ] 列表覆盖已注册和可发现的领域 Agent，并使用稳定、可预测的排序。
- [ ] 详情入口返回统一 Agent Detail；不存在、过期或配置错误的 Agent 有明确错误类别和上下文。
- [ ] 列表和详情均为只读，不写知识、不写 User Model、不修改 Task、不发送 DingTalk 消息。
- [ ] API 复用 Registry 与 AgentHome 读取结果，不另建一套 Agent 定义真源。
- [ ] 覆盖八个领域、空列表、重复索引、stale 路径和单个 Agent 读取失败时的测试。
