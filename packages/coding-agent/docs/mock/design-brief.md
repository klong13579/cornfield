# 任务：omp 多端前端 —— 功能层级 + 多页 Mock + UX 设计

你是本项目的 UI/UX 设计师。请基于仓库既有资产，产出**完整的前端信息架构 + 多页 HTML mock + UX 设计方案**。

## 背景

omp 是一个终端 coding agent（Bun monorepo），正在做多端化改造：一个 omp 进程（`omp serve`）通过本地 WS 协议（快照 + 增量事件）服务 TUI / Web / PC 桌面 / Mobile。后端协议（P0/P1）已实现并在验证中，前端（P3）正要开工。**需要你先给出产品级的前端设计，用于前端团队按图开发。**

## 必读资产（都在仓库里）

1. `packages/coding-agent/docs/multidevice-host.md` — 多端架构方案（分层、阶段、决策、协议能力）
2. `packages/coding-agent/docs/multidevice-architecture.png` — 架构图
3. `packages/coding-agent/docs/mock/multidevice-ui.html` — 已有的一页会话主界面 mock（深色主题，请延续其视觉语言并超越）
4. `packages/coding-agent/src/server/wire-types.ts` — 协议命令面（前端能调什么：prompt/steer/follow_up/abort/set_model/set_thinking_level/compact/set_todos… + 快照/进度事件）

## 任务要求

### 1. 功能层级（信息架构）
按功能层级组织 OMP 前端的所有页面/视图：一级导航（哪些顶层页面）、每页的核心模块、模块内的关键交互。用树状结构表达。

### 2. 页面清单（至少 8 页 mock，HTML 单文件可交互/可静态展示）

必须覆盖：
- **会话工作台**（复用已有 mock 并增强：消息转录/流式/工具卡/输入区/状态栏）
- **Agent 管理**：agent 列表（每个 agent 卡片：模型/状态/最近活跃/快捷入口）
- **Agent 详情**：单 agent 配置 —— **Skills 管理**（技能列表、启用/停用、技能详情）、**定时任务管理**（cron 列表、新增/暂停/删除、最近运行记录）、模型配置、工具开关
- **Record / 会话记录**：历史会话列表（按日期/agent/状态筛选）、单会话详情回放（快照重放）、导出
- **Voice / 语音**：语音输入（说话 → 转文字发指令）、语音播报设置（agent 完成时朗读/静默）、语音偏好
- **连接/设置**：连接状态、token/URL、主题、快捷键
- **移动端精简视图**：会话工作台的手机版（状态 + 最近消息 + 输入）

其他功能（你自己权衡补充，例如：todo 面板、模型市场/切换、通知中心、多会话切换、帮助/新手引导）。

### 3. UX 设计方案
每个页面/关键交互给 UX 说明：
- 页面目标与用户任务
- 布局逻辑（为什么左转录右面板等）
- 关键交互的行为细节（流式时的停止、工具卡展开/收起、定时任务的创建流程、voice 的权限与反馈）
- 状态设计（loading/empty/error/streaming 四态）
- 移动端取舍（哪些功能裁剪、触控优先）

### 4. 产出位置
- 每页一个 HTML 自包含文件 → `packages/coding-agent/docs/mock/pages/<page-name>.html`
- 一份总览 `packages/coding-agent/docs/mock/README.md`（功能层级树 + 页面索引 + UX 设计摘要）
- 可以扩展已有 mock 的 CSS 视觉语言（深色、工具卡三态、stop 原位替换）

## 约束
- 输出中文
- 不要改仓库代码，只新增 docs/mock/ 下的文件
- HTML mock 用纯 HTML+CSS+少量原生 JS（不依赖框架），浏览器直接打开可用
- 每个页面顶部加注释说明：页面名、功能层级位置、覆盖的协议命令/事件