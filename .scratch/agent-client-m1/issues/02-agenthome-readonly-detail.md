# 02: AgentHome 只读详情加载

**What to build:** 从 AgentHome 的声明和已有上下文生成统一的只读 Agent Detail，展示身份、使命、知识引用、渠道投影和运行状态；当声明缺失、路径无效或内容不合法时，客户端必须明确报告问题，而不是返回看似完整的详情。

**Blocked by:** 01: Agent Registry 元数据扩展

**Status:** ready-for-agent

- [ ] Agent Detail 能区分 Registry 索引信息与 AgentHome 真源信息。
- [ ] 能读取身份/使命、知识路径引用、渠道与机器人上下文投影，并保留缺失项的可解释状态。
- [ ] 无效 JSON、不可读文件、越界路径和缺失 AgentHome 均返回结构化错误，不伪造成功。
- [ ] 读取过程不修改 AgentHome、知识库或 Registry，不改变现有 Session 启动行为。
- [ ] 为完整、旧版、缺失和非法 AgentHome 场景补充针对性测试。
