# W3 数据线任务卡

你是并行开发三线之一的 W3（数据）。工作目录：/Users/sz-0203015357/Desktop/Narwal/oh-my-pi/.worktrees/hermes-fusion
分支：w3-data（从 hermes-fusion 切出）
总计划：docs/mock/HERMES_FUSION_PLAN.md（先通读）

## 你的独占文件
coding-agent/src/server/ coding-agent/src/commands/serve.ts pages/insights/ pages/memory/ pages/tasks/（新目录）

## 任务（按序）
- D1 serve get_stats 只读命令（0.5d）：import @oh-my-pi/stats 的 getDashboardStats()，命令形状对照 wire-server 现有 list_sessions 写法
- D2 InsightsPanel（1.5d）：period 切换 + 用量/费用/错误率卡 + 模型成本表（单价从 packages/ai/src/models.json 读）+ by-folder→agent 映射。消费 M1 注册表接口（interface PanelDef { id/title/icon/badge/mount }，注册进 panelRegistry）
- D3 Memory 投影（1d）：serve get_memory 只读命令（~/.omp/agent/memories/ + user.md）+ 三分区 panel（memory/user/project）
- D4 TasksPanel cron 壳（1.5d）：preset 体系（hourly/daily/weekdays/weekly/monthly/custom）+ 表达式实时预览 + 列表 + run watch 占位。规格抄 hermes panels.js:474-530（tmp/hermes-webui/static/panels.js）。数据层留接口，gateway 代理命令后续通
- D5 SkillsPanel（1d）：列表/搜索/分类折叠，启停 toggle UI 先行（B3 协议未到，toggle 渲染禁用态）
- F2 Playwright 冒烟（1d）：真实 serve 起服 → 连接 → prompt → 流式断言，进 web-app package.json test:ci

## 纪律
- serve 改动每卡跑 wire e2e 基线 6 条不回归
- 视觉基准 v8 mock 黑白；panel 数据禁止 mock，取不到就渲染空态
- 不动 web-app 的 state/components/layout
- 每卡 biome+tsgo 干净才提交；提交前 rebase hermes-fusion
