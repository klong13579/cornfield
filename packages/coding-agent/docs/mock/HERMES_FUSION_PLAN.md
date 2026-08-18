# 融合改造实施计划（hermes 形态 × OMP 数据层）

> 2026-08-18 rev2 · 基线更新：58d4ae3a9a（mock 清扫/agent 详情真数据/boot 预载/gateway 状态条已合入）
> ——原"111 行未提交"已被吸收提交；AgentDetailView B3/B6 假数据、HomeView 硬编码名字已被 0ea078e55a 清掉，验收门 §4 的 mock 残留项由此而来
> 策略：hermes 成熟实现能抄则抄（形态/交互/规格），数据层与协议层 100% 保留 OMP（快照权威模型）
> 执行方式：herdr 多 omp 并行，4 个工位 + 1 主线，文件所有权互斥

---

## 0. 前置：未提交改动处理

worktree 有 111 行未提交（wire-server +103 / pi-wire commands +10 / AgentsView +2，疑似上一个任务的半成品）。
**主线开工前先处理**：审查这批 diff → 提交或丢弃，保证三条并行线起点干净。

## 1. 工位划分（文件所有权互斥表）

| 工位 | 职责 | 独占目录/文件 | 禁触 |
|---|---|---|---|
| **W1 骨架** | rail panel 化 + 会话侧栏 + composer | `layout/` `router.tsx` `pages/workspace/` `index.css` `main.tsx` | state/ lib/ render/ serve |
| **W2 渲染** | markdown/mermaid 管线 + 转录区组件 | `components/` `render/`（新） | layout/ pages/ serve |
| **W3 数据** | serve 新命令 + Insights/Memory/cron panel | `coding-agent/src/server/` `coding-agent/src/commands/serve.ts` `pages/insights/` `pages/memory/` `pages/tasks/`（新） | web-app 的 state/components/layout |
| **主线** | 集成、验收、冲突仲裁、协议层（pi-wire/pi-client 若需动） | 合并协调 | 不直接写功能代码 |

依赖关系（唯一两条）：
- R1(markdown管线) → R3(Activity折叠)：W2 内部顺序
- S2(panel壳) → S4(composer重排)：W1 内部顺序
- ContextRing（W2 产出，第 1 天交付）→ S4 消费：跨线交付物，第一天结束前 W2 交出

## 2. 任务卡（18 张，量级含验证）

### 线 W1 骨架（6 张，约 7 人日）
- S1 pi-wire 类型内联（ThinkingLevel/ImageContent 两类型内联进 pi-wire，解除对 pi-agent-core/pi-ai 依赖）——0.5d 【主线做，一次性】
- S2 rail panel 化：router.tsx(155行) → PanelHost + 消费 M1 注册表接口；8 个现有页迁入 panel；navigate() 12 处改 panel 切换；**深链/前进后退方案**（Records→Playback 参数路由 `/records/:id` 改 panel 内状态 + history API，参照 OpenClaw 真路由做法）；DevicePreview 挂载方式重设计——3d
- S3 会话侧栏：pin/工作区分组/搜索/双源 tab（WebUI+CLI 会话）——1d
- S4 composer 中枢重排：hermes 布局 + context 环（消费 W2 的 ContextRing）+ queue 卡 + steer 指示 + agent 下拉增强（状态点+技能/定时计数，抄 hermes profile dropdown）+ 切换时 panel 数据重载——1.5d
- S5 右栏 Files/Artifacts 双 tab（Artifacts 先占位）——1d
- F1 黑白 zinc token 全站统一 + 响应式回归（<900px 抽屉/浮层）——1.5d

### 线 W2 渲染（6 张，约 6.5 人日）
- R1a markdown 管线 spike：空页验证 react-markdown+remark/rehype 插件链在 Tailwind 4 + Vite 6 下跑通（katex CSS/字体引入、preflight 与 highlight 样式冲突）；失败则降级 marked+DOMPurify 路线——0.5d
- R1b markdown 管线正式接入：替换并删除 MarkdownLite.tsx——1d
- R2 Mermaid.tsx：lazy dynamic import + 查看器（全屏/缩放，抄 ui.js:19522-2046 规格）+ 主题跟随——1d
- R3 ActivityFold.tsx：thinking+全部工具收一行（`Activity: N tools`），按 turn 持久化展开态（localStorage），失败徽标例外露出；重写 Transcript/ToolCard/ThinkingFold——1d
- R4 MsgActions：hover 操作条（copy 立即通；undo/regenerate/fork UI 先行等 wire 命令）——1d
- R5 ContextRing + QueueCard + SteerIndicator 三个小组件（**ContextRing 第 1 天交付给 W1**）——1d
- R6 ApprovalCard + ClarifyCard UI 壳（假数据渲染，协议到了通电）——1d

### 主线硬卡（W3 前置）
- M1 panel 注册表接口：主线第 1 天交付 TS 接口 + 空实现（panel id/标题/图标/badge/挂载组件），W1/W3 双方向它对齐，消灭注册表并行冲突——0.5d

### 线 W3 数据（6 张，约 5.5 人日）
- D1 serve `get_stats` 只读命令：import @oh-my-pi/stats getDashboardStats——0.5d
- D2 InsightsPanel：period 切换 + 用量/费用/错误率卡 + 模型成本表（单价自 models.json）+ by-folder→agent 映射——1.5d
- D3 Memory 投影：serve `get_memory` 只读命令（memories/ + user.md）+ 三分区 panel——1d
- D4 TasksPanel(cron) 壳：preset 体系 + 表达式实时预览 + 列表 + run watch 占位（数据等 B6 gateway 代理）——1.5d
- D5 SkillsPanel：列表/搜索/分类折叠（抄 panels.js:4859）+ 启停 toggle（UI 先行，B3 协议到再通电）——1d
- F2 Playwright 冒烟 ×1（真实 serve 起服 → 连接 → prompt → 流式断言）进 web-app CI——1d

### 主线（穿插）
- 协调合并（每日每线至少一次 rebase 主分支）
- S1 类型内联（第 0.5 天，解锁 W3 对 pi-wire 的零依赖改动）
- pi-wire 错误码枚举草案（不阻塞任何线，与 W2 R6 对齐 code 列表）

## 3. 时序图（并行展开）

```
Day 1     W1: S2 开工            W2: R5(ContextRing 交付) → R1    W3: D1
Day 2-3   W1: S2 → S3            W2: R1 → R2                     W3: D2
Day 4-5   W1: S4(消费ContextRing) W2: R3                          W3: D2 → D3
Day 6-7   W1: S5                  W2: R4 → R6                     W3: D4
Day 8-9   W1: F1                  W2: 支援 R6/F2                  W3: D5 → F2
Day 3     ▶ checkpoint-1：骨架+管线可用版给用户过目（止损点：改方向成本最低）
Day 7     ▶ checkpoint-2：功能面完整版给用户过目（剩收尾）
Day 10    主线：集成验收（e2e 走查 11 panel + 响应式 + 冒烟）
```

三线并行总时长 ≈ **11 个工作日**（含 2 个 checkpoint 演示；单人串行 ≈ 21 天）。

## 4. 验收门（每张卡的定义）

- 通用：biome + tsgo 干净；`bun test packages/web-app`（若有）/ 对应 serve e2e 不回归
- **mock 残留零容忍**：`grep -rE "MOCK_|mock 数据|TODO.*占位" src/` 零命中（或显式白名单注释 `// mock-allowed: <reason>`）
- S2：8 个原页面全部可从 rail 到达，功能不丢（对照 requirements.md FR-1~9 逐条点检）；浏览器前进/后退在 panel 间正确导航（深链可分享）
- R1：含列表/表格/代码块/数学的混合 markdown 渲染正确；MarkdownLite 已删除
- R3：一个 30+ 工具调用的长会话转录可读，默认折叠，展开态刷新后保持
- D2：Insights 数字与 `omp stats --json` 一致
- F2：CI 上冒烟绿

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| W1 的 panel 化与 W3 新 panel 命名冲突 | 第 1 天主线定 panel 注册表接口（TS 类型），双方向它对齐 |
| 未提交的 111 行半成品 | 第 0 步处理，不进并行 |
| R3 折叠行设计判断偏差 | 第 4 天出可用版即给你过目（V8 mock 为基准，偏离需你点头） |
| serve e2e 因 W3 改动回归 | W3 每卡跑 wire e2e 6 条基线（P1 验收集） |
| herdr 并行下 worktree 单一 | 每工位用 `herdr` 独立 pane + 独立 branch（w1-shell / w2-render / w3-data），主线每日合并 |

## 6. 明确不做（本期）

审批协议层（agent-core 钩子）、Profiles panel、Kanban、Excalidraw、saved prompts、设置搜索、tab 排序、移动端键盘守卫、协议版本协商、Electron 壳。
