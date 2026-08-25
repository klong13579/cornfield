# omp-client-ide B 包工作包规划（B0 拆票）

> 状态：B0 拆票完成（2026-08-26）。A 包（IDE 客户端补齐 7 项）已闭环并验证。
> 依赖文档：`docs/editor-extension/topics/v2-requirements.md`（D1-D16）、`v3-architecture.md`（阶段 A/B/C）。
> 本文件是 README"后续包承接"的落地拆票：5 个产品级功能包，串行实施（共享 wire schema 与 agent 配置）。

## 实施顺序与依赖

```
B3 员工 agent 4 目标引擎（平台侧能力，无依赖）
  └→ B1 L1 域 agent（依赖 B3 的目标机制域化）
       └→ B2 CEO 工作台（依赖 B1 的域战报产出）
B4 追溯台（依赖 session 记录，仅读，独立）
B5 阶段 C 单壳收敛（需用户逐页三态拍板，阻塞项）
```

## B3 员工个人 agent 4 目标引擎（D9）

**目标**：每人一个个人 agent，4 个确定性目标**常驻运行**（非按需响应）：
1. 钉钉 context：经钉钉获取本人 context（会话/文档/工作动态）
2. 知识库定期刷新：定期更新个人知识库，理解工作状态与意图
3. 画像保鲜：持续更新 mission 与 user.md（带质量准入，不能越改越乱）
4. 业务进展秒答：快速回答业务进展

**落点**：
- 平台侧：gateway scheduler（cron 任务：context 摄入 / 知识库刷新 / 画像保鲜）
- agent 配置：mission.md 注入 4 目标契约 + 质量准入规则
- 消费端：IDE"我的 agent"轻视图（已建，展示状态/知识库/画像/任务）

**依赖**：gateway cron（已有 `omp-gateway` scheduler）、钉钉连接器（已有 gateway 账号）、session 记录（已有）

**验收**：gateway 账号配置 4 目标 cron；运行一次摄入任务产出 context 摘要 + 知识库更新 + user.md 质量准入校验；秒答可经对话触发

## B1 L1 域 agent（D8/D10）

**目标**：每域一个域 agent，域的大脑：
- 4 目标域化（域 context / 域知识库 / 域 mission / 域业务进展）
- 域内协作发起（域级任务拉人 + 他们的 agent）
- 双模式：默认扁平（个人 agent 独立），域级任务才协作

**落点**：
- 平台侧：域注册（agentDir 分组：域 = agent 集合 + 共享域配置）
- wire 命令：`list_domains` / `domain_detail`（域 agent 列表/进展）
- 消费端：IDE 域管理视图（域负责人分域管理）+ 域协作发起入口

**依赖**：B3（4 目标机制）、agent 注册（已有 gateway 账号）

**验收**：域注册配置生效；IDE 能看到域列表 + 域内 agent；域级任务发起协作（拉人）

## B2 CEO 工作台第一屏（D11）

**目标**：分层下钻：
- 域级战报（每域一张卡：今日推进/产出/卡点；战报 = 域 agent 的 D4 目标产出）
- 跨域事项区（需 CEO 判断/协调：交期冲突、产出异常、资源协调——不是审批队列）
- 点进域 → 域内员工 agent 明细

**落点**：
- wire 命令：`domain_report`（战报数据契约）
- 消费端：IDE/Agent 视图的 CEO 工作台（战报卡 + 跨域事项 + 下钻）

**依赖**：B1（域战报数据）、跨域事项数据源（域 agent 上报）

**验收**：CEO 视角看到每域战报卡 + 跨域事项区；点域下钻到员工明细

## B4 追溯台（User Story 23）

**目标**：会话/工具调用/决策依据/学习沉淀回放——"敢放手"的底气

**落点**：
- wire 命令：`session_trace`（读取 session JSONL 结构化为回放事件流）
- 消费端：IDE 追溯台视图（时间线回放：消息/工具调用/决策依据）

**依赖**：session JSONL 记录（已有）、pi-wire session 命令（list_sessions 已有）

**验收**：选择会话 → 时间线回放（用户消息/agent 回复/工具调用/推理链）

## B5 阶段 C 单壳收敛（D14）

**目标**：web-app 12 页逐页三态（迁移/合并/归档）拍板后搬进壳，搬完退役

**落点**：web-app 12 页（agents/home/insights/memory/models/records/settings/skills/tasks/todo/voice/workspace）
三态清单（spec-implementation.md Further Notes 已有建议落点）：
- 迁移→落点：settings→设置面板；workspace→Agent 视图对话+预览；agents→域管理/我的 agent；memory→我的 agent；records→追溯台；skills→治理台；models→设置面；tasks→管理台；todo→轻面板；home→Agent 视图对话
- 待定：voice/insights（归档 or 迁移）

**阻塞**：需用户逐页三态拍板（本包不可直接开工）

**验收**：12 页能力盘点无一丢失或明确归档；web-app 退役后壳内功能等价

## wire schema 冲突约束

B1/B2/B4 都新增 wire 命令（list_domains/domain_detail/domain_report/session_trace）——
共享 `packages/pi-wire/src/commands.ts` + `shape-lock.test.ts`，**必须串行实施**，每次加命令后跑 pi-wire 契约测试。
