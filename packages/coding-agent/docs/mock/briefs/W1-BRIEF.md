# W1 骨架线任务卡

你是并行开发三线之一的 W1（骨架）。工作目录：/Users/sz-0203015357/Desktop/Narwal/oh-my-pi/.worktrees/hermes-fusion
分支：w1-shell（从 hermes-fusion 切出）
总计划：docs/mock/HERMES_FUSION_PLAN.md（先通读）

## 你的独占文件（其他线不碰，你也不碰它们的）
layout/ router.tsx pages/workspace/ index.css main.tsx pages/agents/（仅 S2c 搬迁期）

## 任务（按序）
- S2 rail panel 化（3d）：router.tsx → PanelHost，消费 M1 注册表接口（见下）；8 页迁入 panel；navigate() 12 处改 panel 切换；深链用 history API（参照 OpenClaw 真路由——panel 切换 pushState，前进后退可导航）；DevicePreview 挂载重设计
- S2c AgentDetailView 单独搬迁（1d）：~900 行，最大单体，从路由页改为详情弹层
- S3 会话侧栏（1d）：pin/工作区分组/搜索/双源 tab
- S4 composer 中枢（1.5d，等 ContextRing）：hermes 布局 + queue 卡 + steer 指示 + agent 下拉增强（状态点+技能/定时计数）
- S5 右栏 Files/Artifacts（1d）：注意 AgentDetailView 已有 filesystem browser，复用不要重写
- F1 黑白 zinc token 全站（1.5d）：docs/mock/v8-hermes-full.html 的 :root token 是唯一定稿

## M1 注册表接口（主线已定义，你消费）
interface PanelDef { id: string; title: string; icon: string; badge?: () => number | null; mount: () => React.ComponentType }
面板注册进 panelRegistry（Map<id, PanelDef>），PanelHost 按 rail 选中渲染。

## 纪律
- 视觉基准：v8-hermes-full.html（黑白）。形态抄 hermes，但数据必须走 useSession()/store，禁止 mock
- 每完成一张卡：biome + tsgo 干净才提交；commit 前跑 git rebase hermes-fusion 拿其他线更新
- 不动 state/ lib/ components/ render/ serve —— 那是别人的领地
