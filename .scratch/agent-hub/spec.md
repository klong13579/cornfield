# Spec: 数字员工中枢（Agent Hub）

> 状态：**ready-for-agent** · 日期：2026-09-01
> 父文档：`docs/client/agent-hub.md`（领域模型/已拍板项全量） · 架构图：`docs/archify/project-container.architecture.html` · mock：`tmp/agent-hub-all-pages-mock.html`
> 关联：本 spec 由 to-spec 技能合成，不发散、不 interview；领域词汇沿用 `docs/client/agent-hub.md` 术语表。

## Problem Statement

CornField 桌面端目前是"观察台"：欢迎页 + 一堆平级工具页（Records/Voice/Settings/Models/...），**没有一个以数字员工（agent）为中心的工作视图**。用户（公司 CEO）每天要管理多个业务 agent（hr/ops/...），但：

- agent 列表存在（`AgentsView`），但点进去是"档案 tab"，不是"这个员工今天在做什么"的工作台
- 任务（Task）、词条（TODO）、产物（Artifacts）、会话（Session）、定时任务（Cron）**分散在 6+ 个独立页面**，没有按 agent 聚合的入口
- serve 协议已有 agent 注册表（`list_agents`/`attach`/`detach`）和会话索引（`list_sessions` 带 agentId），但**会话元数据缺 projectId**、**Project 没有注册表实体**、**Task 没有独立持久层**——前端只能猜（encoded-cwd 分组），无法形成权威归属
- workspace.json 目前同时承担 Agent 声明和 Project 容器双重语义，多 agent 服务同一项目时会双真相

结果：agent 是"多个会话进程"而非"可管理的数字员工"；工作台无从建起。

## Solution

以 **agent 为核心模块**重构桌面端为"员工工作台（Agent Hub）"：

- **agent = 一等身份实体**（agentDir + mission + 独立记忆/技能/凭证）；`default` 只是第一个 agent（初始化路径差异，实体统一）
- **Project 独立注册表**：`list_projects`/`get_project`/`attach_project`；session 元数据写 projectId + agentId，serve 返回权威归属，前端不再猜路径
- **workspace.json = Agent 声明**（方案 A）：Project 级配置解耦到 project 注册表，消除双重容器语义
- **Task = 独立实体**（topic 文件承载），状态机 `queued → running → needs_review → done`（旁路 `blocked`）；任务包可选、验收 = criteria + evidence + verdict
- **7 tab 员工工作台**（任务/会话/记忆/技能/定时/产物/配置）作为 P1 的 UI 形态；**P0 只做纵切**（创建 agent → serve 发现 → attach → 权威归属 → 切换 project → gateway 绑定不破），验证模型成立再铺 UI
- **Cron 拆三实体**：CronDefinition（调度定义）/ ExecutionRun（单次执行）/ Task（业务工作）；定时触发默认创建 ExecutionRun 不建 Task，避免生命周期纠缠
- **ConnectorAccount 实体**：一个账号绑一个 agent（1:1），一个 agent 可被多账号绑（1:N）；gateway 权限只收紧不放宽

## User Stories

1. 作为 CEO，我想在首页看到一个"员工卡"列表（每个业务 agent 一张卡：身份 + 服务项目池 + 在跑任务），这样我能一眼看到数字员工团队的全貌
2. 作为 CEO，我想点开任意员工卡进入它的工作台，这样我能看到该 agent 的任务/会话/记忆/技能/定时/产物/配置全部上下文
3. 作为 CEO，我想在工作台「任务」tab 里看到该 agent 承接的所有任务（含 topic 文件投影 + 状态 + 包进度），这样我能追踪工作完成度而不是只看到会话记录
4. 作为 CEO，我想创建新 agent 并立即在 serve 中发现、attach、开始对话，这样"招新数字员工"是条完整链路
5. 作为 agent，当我被指派任务（assignee 指向我），任务在我工作台的任务 tab 可见，这样我能知道排队等我干什么
6. 作为 CEO，我想把任务指派给空闲 agent，这样我能把工作分给对的人
7. 作为 CEO，我想看到任务状态机（queued/running/needs_review/done/blocked）而不是只靠会话猜测进度，这样我知道该催谁
8. 作为 CEO，我想创建带任务包的任务（2-8 个子任务，进度 = 完成数/N），这样宏观状态之外还有微观进度
9. 作为验证者，我想对任务逐条验收（criteria + evidence + verdict），不通过打回 running，通过才 done，这样执行/验证分离
10. 作为 CEO，我想在会话列表看到权威的 projectId + agentId 归属（不再猜路径），这样我能在多 agent 多项目下找到任何一段历史
11. 作为 CEO，我想切换 serve 的项目而不重启服务，这样我能快速在不同项目工作区之间移动
12. 作为用户，我希望 default agent（serve 启动 cwd）经过一次性迁移后与新建 agent 实体统一，这样旧会话不丢、新模型生效
13. 作为 CEO，我想在工作台「定时」tab 看到该 agent 的 cron 列表与运行记录（ExecutionRun），这样我知道什么预约了什么、执行得怎样
14. 作为调度员，我希望 cron 触发创建 ExecutionRun 而非 Task，这样例行执行不会污染任务看板
15. 作为 CEO，我想看到该 agent 的产物 gallery（按 agent 聚合），这样我能找到数字员工产出的文件/图片/文档
16. 作为用户，我想在「配置」tab 内联查看/编辑 agent 的模型/工具/技能/项目关联/通道绑定，这样 agent 配置不再散落在 serve/gateway 两套设置入口
17. 作为 CEO，我想知道某个 agent 被哪些 IM 账号绑定（ConnectorAccount），这样我能看出钉钉/飞书入口从属于哪个数字员工
18. 作为渠道管理员，我希望绑定失效（agentDir 被删）时通道账号显示错误态而非静默，这样问题不会被埋住
19. 作为网关，我希望对同一 agent 的权限只收紧不放宽，这样通道误配不会放大 agent 权限
20. 作为 agent 执行者，我完成任务后进入 needs_review 停留态等人类验收，这样我不会自作主张宣告完成
21. 作为 CEO，我希望旧版 CLI 在未迁移会话上继续可读，这样迁移不对存量用户造成破坏
22. 作为 CEO，我想在工作台看到 default 与新建 agent 一致的实体模型，这样"default 特殊"不会泄漏到产品层
23. 作为用户，我希望重复执行迁移/重复创建 agent 是幂等的（agentDir 已存在/workspace.json 缺失都有明确行为），这样操作不会踩坏状态
24. 作为用户，我希望 serve 重启后 agent 能恢复（attach 前状态可查），这样工作台不会因重启失忆

## Implementation Decisions

- **Agent 实体化（现状已具备主体）**：`list_agents`/`attach`/`detach` 已实现，attach 时 lazy 实例化；`AgentsView` + `AgentDetailView`（6 tab：skills/dingtalk/model/tools/profile/files/prompts）已存在。**P0 不重做这些**，只补 agentContext 元数据（服务过的项目/角色）。
- **Project 注册表（最大新增）**：新概念、无前身。`list_projects`/`get_project`/`attach_project` 三个 wire 命令 + project 注册表存储（稳定 projectId = git root hash 或显式生成）。session 元数据写入 projectId。单根 P0，多 root P2。
- **session 元数据扩展**：会话头写入 projectId + agentId 权威归属；`list_sessions` 返回权威投影（前端不再猜 encoded-cwd 分组）。
- **workspace.json = Agent 声明（方案 A）**：现有 `agentDir/.cornfield/workspace.json`（type:"agent"）保持为 Agent workspace declaration；**不把 Project 级配置写进 agentDir**；Project 的 instructions/memory/skills 移到 project 注册表条目，多 agent 服务同一项目时共享一份。
- **Task 实体（新持久层）**：topic 文件 + frontmatter；状态机 `queued → running → needs_review → done`（`blocked` 旁路）；类型 = code/business/general（scheduled 不作为任务类型，见 Cron 拆分）；assignee（agentId）为连接器；`agentId=null` 由调度器从候选范围（Project.preferredAgents 推荐不约束）选取；任务包可选（数字进度必填）；验收 = criteria + evidence + verdict，needs_review 停留态，不通过打回 running。
- **Cron 三实体拆分**：CronDefinition（调度定义，scheduler.db）/ ExecutionRun（单次执行：runId/cronId/startedAt/status/logs/cost/deliveryResult，幂等键 = cronId + scheduledAt）/ Task（业务工作）。触发默认只建 ExecutionRun；cron 声明业务目标时才提升 Task；test-run 产生正式 run（带 marker）；投递失败 ≠ 任务失败。
- **ConnectorAccount 实体**：一账号绑一 agent（1:1），一 agent 可被多账号绑（1:N）；凭证只在 gateway.json；权限合并 = agent 允许 ∩ channel denied（gateway 只收紧不放宽）；绑定失效显式错误态。
- **default 迁移**：一次性 + 幂等（migration marker）+ 备份（registry.json/workspace.json 快照）+ 回滚 + 旧版 CLI 兼容；default 永久存在，改名只改 displayName。
- **7 tab 工作台**：任务/会话/记忆/技能/定时/产物/配置。**P0 只做 UI 壳**（导航 + 空状态 + 复用现有 tab 组件），不做全功能闭环；任务 tab 缺省加载 default agent 任务。
- **前端 project 切换**：顶栏项目 chip 从只读标签升级为选择器（最近列表 + 文件夹浏览器），切换不重启 serve（P0 验收项）。
- **CLI 关系不变**：`agent` 管档案、`serve` 上前台、`gateway` 走通道，共享 agentDir 身份。
- **logger 硬约束**：`cornfield agent` 命令现有的 console.log/error 输出层须在 P0 前改用 centralized logger（`~/.cornfield/logs/` 轮转）或可测试的 CLI service；这是仓库硬约束（TUI 渲染/测试可观测性），不是可选项。

## Testing Decisions

- **唯一主 seam：serve WS 集成测试**（真 serve 子进程 + bun WS 客户端 + 临时 HOME + 预置 workspace.json/registry.json）。先例：`packages/coding-agent/test/wire-server-multi-agent.integration.test.ts`（多 agent 注册表/attach/switch/隔离）、`wire-server-list-sessions.integration.test.ts`（会话索引投影）、`wire-server-permission.integration.test.ts`（审批管线）。新行为一律经 wire 命令断言：`list_projects`/`attach_project`/`list_sessions` 权威归属/迁移幂等。
- **辅助 seam：web-app adapter 层测试**（`pi-client-adapter.test.ts` 模式）。只测 adapter 到 store 的映射（list_sessions 返回 → UI 分组键），不 mock 内部状态机。
- **好测试的标准**：只测外部行为（wire 往返 + 状态转换 + 迁移幂等），不测私有实现；覆盖边界——重复创建 agent、agentDir 已存在、workspace.json 缺失、registry 损坏、迁移重复执行、cron 触发重复、投递失败与任务失败分离。
- **不发 prompt**：测试全部用本地命令/预置文件，不触 LLM（沿用 multi-agent 集成测试的无计费原则）。

## Out of Scope

- 多 root Project（P2）
- 多项目并行执行语义（资源隔离/并发预算/文件锁/分支隔离/取消抢占/冲突检测/judge 验收，P2）
- Feishu/Slack/WeChat 通道实现（ConnectorAccount 模型先行，通道子类另立）
- open-connector 工具连接层（agent→SaaS 单向动作，独立专题）
- 完整 7 tab 工作台全功能闭环（P0 只壳，P1 逐 tab 深化）
- 产品命名定案（内部代号「Agent Hub」，公开命名另议）
- 任务执行 step 级 checkpoint（P1 用任务级心跳缓解）

## Further Notes

- 现状核查结论（2026-09-01）：agent 注册表、attach、AgentsView、AgentDetailView 6 tab、permission-gate、cron wire 视图、ArtifactsPanel、TodoView **已存在**；新增代码集中在 **Project 注册表（~400-600 LOC）+ Task 实体（~500-800）+ 迁移（~150-250）**，合计约 1,500-2,200 LOC，P0 纵切约 800-1200。
- 剩余待拍板：按 P0→P1 开工确认、产品命名、`tmp/agent-hub-all-pages-mock.html` 是否固定为 P0 原型。
- GPT-5.6 独立 review（`/tmp/agent-hub-review-gpt56.md`）结论"方向正确、尚缺开工级契约"，其 9 条改进已全部并入 `docs/client/agent-hub.md` 与本文档（workspace.json 方案 A、六实体+投影表、default 迁移设计、Cron 三拆分、ConnectorAccount、调度规则、P0 纵切、P1 分 5 步验收、logger 修复前置）。