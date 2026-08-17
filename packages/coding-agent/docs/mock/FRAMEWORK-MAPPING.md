# mock → React 组件映射表（P3 施工图）

> 前端开发（P3）按此表把 12 页 mock 转成 React 应用。
> 技术栈（已决策）：React + Vite · assistant-ui（转录/流式/工具卡底座）· shadcn/ui（面板/表单）· Tailwind · zustand（UI 状态）· thinking-orbs（动效，npm 包）

## 0. 通用映射原则

| mock 结构 | React 对应 | 说明 |
|---|---|---|
| 每页头部注释块（页面名/路由/协议） | route config（`createBrowserRouter` + 页面级 meta） | 注释块即路由注册表 |
| 56px 图标侧栏 `.nav` 数组 | `<AppSidebar items={nav}>`（菜单注册表，数据驱动） | 加页面 = 数组 +1 |
| 顶栏（面包屑/操作） | `<AppTopbar>`（Layout 内） | 页面通过 Outlet context 声明动作 |
| device 预览（右上角手机模拟器） | `<DevicePreview>`（iframe 包 mobile route） | dev 模式常驻，可关 |
| V3 亮色 token（CSS 变量） | CSS variables → Tailwind theme extend | token 一一对应迁移 |

## 1. 页面 × 组件映射

| mock 页面 | React 路由 | 核心组件（自研/复用） | 数据源 | 协议命令/事件 | 备注 |
|---|---|---|---|---|---|
| home | `/` | `HomeView`：`Greeting`（时间+名字）、`QuickSuggestions`（pill 组）、`Composer`、`RecentAgents`、`ThinkingOrb breathing` | user profile（pi-client 提供）+ server_snapshot | `get_snapshot` | 起始页；名字来自 user profile |
| session-workspace | `/workspace` | `Transcript`（assistant-ui）、`Message`、`ToolCard`（三态）、`Composer`（assistant-ui）、`StatusBar`、`SidePanel`（状态/Todo）、`ThinkingOrb composing/solving`、`ContentPreview`（mermaid/drawio/url） | session_snapshot（权威）+ progress（打字机） | prompt/steer/follow_up/abort/set_model/set_thinking_level/compact/set_todos + subscribe | 核心页，最先做 |
| agent-list | `/agents` | `AgentGrid`→`AgentCard`（状态点/徽标/orb working/数值）、`SegmentFilter`（工作区）、`SearchInput` | server_snapshot 扩展（多 agent 后）| get_available_models/get_state | 布局：卡片网格 |
| agent-detail | `/agents/:id` | `TabNav`（Skills/Cron/模型/工具/用户画像）、`SkillRow`（toggle）、`CronList`（schedule tag/运行记录）、`ModelSelect`、`ToolSwitchGroup`、`UserProfileCard`（标签云） | get_snapshot + 扩展（模型/工具/画像 API）| set_model/set_thinking_level/set_host_tools | 5 tab，滚动位置独立 |
| session-records | `/records` | `RecordsTable`、`FilterBar`（日期/Agent/状态）、`StatusBadge` | gateway/session 索引 API | get_messages/get_session_stats | 接入 gateway 日志源（钉钉会话） |
| session-playback | `/records/:id` | `PlaybackControls`（播放/速度/进度）、`TimelineNav`、`Transcript`（只读） | 快照重放（session JSONL）| get_snapshot/get_branch_messages | 纯前端重放 |
| voice | `/voice` | `JarvisMode`（大 orb 状态机/唤醒/波形/TTS 条/多轮记录）、`VoiceSettings`（播报/VAD） | Web Speech API + pi-client prompt | prompt | Jarvis=听→thinking→播报闭环 |
| todo-panel | `/todo` | `TodoPhaseGroup`（进度条）、`TodoItem` | session_snapshot.todoPhases | set_todos | |
| model-marketplace | `/models` | `ProviderGroup`、`ModelCard`、`ModelFilter` | get_available_models | get_available_models/set_model | |
| settings | `/settings` | `SettingsGroup`（连接/主题/快捷键/行为/通知/钉钉集成/危险）、`DingtalkConfig` | 本地配置 + gateway 状态 | hello/set_auto_compaction/set_auto_retry | 钉钉集成含 AppKey/Secret |
| mobile-session | `/m` 或同一路由响应式 | `MobileSessionView`（浮层面板/快捷条/折叠工具卡/语音按钮） | 同 workspace | 同 workspace | 与 workspace 同代码，breakpoint 裁剪 |

## 2. 共享组件清单

| 组件 | mock 出处 | 说明 |
|---|---|---|
| `ToolCard` | session-workspace | 三态（run/done/fail）+ 参数/结果展开 + retry；伴 move 到 @oh-my-pi 前端包 |
| `Composer` | home + workspace + mobile | assistant-ui `EmptyStateComposer`/输入区；send↔stop 原位替换 |
| `ThinkingOrb` | 4 页 | 直接用 npm `thinking-orbs`（引擎原型已提取 orbs.js） |
| `ContentPreview` | workspace | mermaid/drawio/url 三卡 |
| `StatusDot` / `StatusBadge` | agent-list/records | 状态视觉唯一出口 |
| `DevicePreview` | 全部桌面页 | 375×812 iframe |
| `UserProfileCard` | agent-detail | 标签云 + 摘要 + 清除 |
| `CronDisplay` | agent-detail | schedule tag + 运行记录 |
| `SegmentFilter` / `SearchInput` | agent-list/records | 筛选标准件 |

## 3. 状态管理

- **会话权威数据**：`pi-client` 快照缓存（唯一权威源，跨页共享）
- **UI 状态**：zustand store（连接状态/预览开关/筛选条件/草稿）
- **progress**：仅流式 UI 内联使用，不进 store（防「进度被当状态」）
- 页面切换不重拉快照：pi-client session 单例，页面只读缓存 + 订阅

## 4. 建议目录骨架

```
src/
  router.tsx                  # 路由 + 页面 meta（来自 mock 注释块）
  layout/ AppShell / AppSidebar / AppTopbar / DevicePreview
  pages/ home / workspace / agents / agent-detail / records / playback / voice / todo / models / settings / mobile
  components/ ToolCard / Composer / ThinkingOrb / ContentPreview / StatusDot / CronDisplay / UserProfileCard ...
  state/ connection.ts / ui-store.ts
  lib/ wire-dto.ts            # 协议类型（pi-wire）→ 前端类型适配
```
---

## 十、现状与规划差异（2026-08-18 同步）

> 本映射表规划时假设的技术栈与实际实现存在差异，以下为当前（P4 后）准确状态。

### 技术栈

| 规划（§0） | 实际（packages/web-app/package.json） | 说明 |
|---|---|---|
| assistant-ui（Transcript/Composer/markdown） | 手写 `MessageRow` / `ComposerBar` / `MarkdownLite`（markdown 子集：段落/行内 code/fenced block/加粗/链接） | 未引入 assistant-ui。原因：转录流式/工具卡三态与助手微件形态高度定制，手写可控且无版本耦合；代价是富文本能力缺口（表格/嵌套列表/图片渲染需自维护）与加粗级工资 |
| shadcn/ui（Switch/Select/Tabs/Button） | 手写 CSS 类（`toggle`/`select`/`tab`/`btn`/`chip`/`badge`） | 无障碍基础（键盘/焦点/role）自维护（biome a11y 规则已覆盖大部分） |
| zustand（状态管理） | 原生 `useSyncExternalStore` store（`state/ui-store.ts` / `session-store.ts`） | 功能等价（订阅/快照/局部更新），无依赖；不引入 zustand 的决策已定 |
| thinking-orbs | ✅ 已引入 `thinking-orbs@0.3.1`（FR-12 实装） | Orb 组件封装，size 归一 20/64，theme light |

### 组件归属差异

- `ToolCard` 仍内联在 `packages/web-app/src/components/`，未按规划抽到 @oh-my-pi 前端包（无跨包复用需求，未抽）。
- `ContentPreview`（mermaid/drawio/web 三卡）：当前为死代码（`setContentPreview` 无生产者），本轮清理保留但未接线；真实预览待消息内容块（mermaid 源码/URL）识别接入。
- 新增 `MobileSideSheet`（移动端右栏浮层）、`DevicePreview` 面板——规划未列，按 FR-8 落地。

### 数据层差异

- `lib/pi-client-api.ts` 是 web-app 内部契约（业务方法层）；`state/pi-client-adapter.ts` 将 `@oh-my-pi/pi-client`（request 命令面）适配到该契约。规划中的 `state/connection.ts` 已并入 adapter/session-store。
- mock 数据源（fallback-models / MOCK_RECORDS 等）已全部清除，数据来自 serve 真命令；剩余"骨架展示"（skills/cron/画像）标注后端缺口 B3-B7。
