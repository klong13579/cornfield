# 04: Desktop/Web 只读 Agent 工作台

**What to build:** 在现有 Desktop/Web 客户端中增加只读 Agent 工作台：用户可以浏览领域 Agent 列表并查看使命、状态、知识引用、绑定机器人和已发现群的上下文投影；工作台不提供编辑和高风险操作。

**Blocked by:** 03: 多领域 Agent 列表与详情 API

**Status:** ready-for-agent

- [ ] 用户可从工作台进入八个领域 Agent 的列表和详情视图。
- [ ] 详情展示 API 返回的使命、状态、知识引用、机器人及已发现群投影，并标识数据缺失或过期。
- [ ] API 错误、Agent 缺失和 robot-context 缺失时，界面给出可理解的失败状态，不显示伪造数据。
- [ ] 工作台不允许编辑 Agent 定义、知识、User Model、Task 或 DingTalk 绑定。
- [ ] 补充只读工作台的加载、空态、错误态和权限边界验证。
