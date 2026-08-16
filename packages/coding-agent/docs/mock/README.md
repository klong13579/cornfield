# OMP 多端前端 — Mock 设计总览

> 产出日期：2026-08-16 · V3 重设计：2026-08-17
> 设计依据：`design-brief.md` · `multidevice-host.md` · `wire-types.ts` · `multidevice-ui.html`
> V3 方法：参考 `impeccable`（pbakaus）设计词汇与 `awesome-design-md`（Linear / Raycast）设计系统规范

---

## 一、功能层级树（信息架构）

```
OMP 多端前端
│
├── 1. 会话工作台 (Session Workspace)                          ← 一级导航
│   ├── 顶栏：连接状态、项目/分支、模型选择、thinking 级别、compact/新会话
│   ├── 转录区：消息流（用户/助手）、流式输出（打字机光标）、工具卡（三态）
│   ├── 输入区：消息输入、发送/停止按钮（原位替换）、Esc 中止、草稿保留
│   └── 右面板：会话状态（phase/model/token/队列）、重试/压缩开关、Todo 面板
│
├── 2. Agent 管理 (Agent Management)                           ← 一级导航
│   ├── 2.1 Agent 列表
│   │   ├── Agent 卡片网格（名称/角色/模型/状态/最近活跃/技能数/定时任务数）
│   │   ├── 筛选：全部/运行中/空闲/已停用 + 搜索
│   │   └── 快捷操作：进入会话/详情/暂停/启用
│   └── 2.2 Agent 详情
│       ├── Skills 管理：技能列表、启用/停用（toggle）、技能描述/版本
│       ├── 定时任务管理：cron 列表、新增/暂停/删除/立即运行/日志、最近运行状态
│       ├── 模型配置：provider/model/thinking 选择、token 用量与费用
│       └── 工具开关：按类别 toggle（read/write/bash/search/lsp/python/…）
│
├── 3. 会话记录 (Session Records)                              ← 一级导航
│   ├── 3.1 历史会话列表
│   │   ├── 表格：会话名称、Agent、时间、消息数、状态（已完成/已中止/出错）
│   │   ├── 筛选：按日期/Agent/状态 + 搜索
│   │   └── 操作：回放、导出 JSONL
│   └── 3.2 会话详情回放
│       ├── 回放控制栏：播放/暂停、快进/快退、速度选择（1x/2x/4x）
│       ├── 转录区：消息时间线、工具卡结果
│       └── 右面板：会话信息、消息时间线导航
│
├── 4. 语音 (Voice)                                            ← 一级导航
│   ├── 语音输入：麦克风按钮（录制/停止）、波形动画、实时转文字、发送为指令
│   ├── 语音播报：Agent 完成时朗读（toggle）、朗读速度、语音角色、静默时段
│   └── 语音偏好：语音唤醒、按键说话、VAD 自动断句、静音阈值
│
├── 5. Todo 面板 (Todo Panel)                                  ← 一级导航
│   ├── 按阶段分组（Investigation/Implementation/Documentation/…）
│   ├── 阶段进度条、任务 checkbox/添加/删除
│   └── 完成项自动归档（折叠/划线）
│
├── 6. 模型市场 (Model Marketplace)                            ← 一级导航
│   ├── 按 Provider 分组（Anthropic/Narwal Plan/Google/…）
│   ├── 模型卡片：名称/上下文窗口/价格/thinking 支持/描述
│   ├── 筛选：全部/支持 thinking/高上下文/最新
│   └── 操作：使用此模型（切换）、详情
│
├── 7. 设置 (Settings)                                         ← 一级导航
│   ├── 连接：状态、WS URL、Token、协议版本
│   ├── 主题：颜色主题/字体大小/消息密度
│   ├── 快捷键：Enter 发送/Shift+Enter 换行/Esc 中止/Cmd+M 模型
│   ├── 会话行为：自动压缩/自动重试/草稿保留
│   ├── 通知：Agent 完成/错误/定时任务
│   └── 危险操作：清除会话记录、重置设置
│
└── 8. 移动端精简视图 (Mobile)                                 ← 响应式入口
    ├── 会话工作台（手机版）：裁剪右面板 → 浮层面板、模型/thinking 快捷条
    ├── 工具卡默认折叠、触控优先（大按钮/语音入口）
    └── 发送/停止按钮原位替换
```

---

## 二、页面索引

| 序号 | 页面名称 | 文件 | 功能层级 | 覆盖协议 |
|------|----------|------|----------|----------|
| 1 | 会话工作台 | `session-workspace.html` | 一级 · 会话工作台 | prompt, steer, abort, set_model, set_thinking_level, compact, set_todos, subscribe · session_snapshot, progress |
| 2 | Agent 列表 | `agent-list.html` | 一级 · Agent 管理 > 列表 | get_state, get_available_models, switch_session · server_snapshot |
| 3 | Agent 详情 | `agent-detail.html` | 一级 · Agent 管理 > 详情 | set_model, set_thinking_level, set_host_tools, get_snapshot |
| 4 | 会话记录 | `session-records.html` | 一级 · 会话记录 > 列表 | get_messages, get_session_stats, get_branch_messages |
| 5 | 会话回放 | `session-playback.html` | 一级 · 会话记录 > 详情 | get_snapshot, get_messages, get_branch_messages |
| 6 | 语音 | `voice.html` | 一级 · 语音 | prompt (语音转文字后发送) · session_snapshot |
| 7 | Todo 面板 | `todo-panel.html` | 一级 · Todo | set_todos, get_state |
| 8 | 模型市场 | `model-marketplace.html` | 一级 · 模型市场 | get_available_models, set_model, cycle_model, set_thinking_level |
| 9 | 设置 | `settings.html` | 一级 · 设置 | hello, set_auto_compaction, set_auto_retry, subscribe |
| 10 | 移动端 | `mobile-session.html` | 响应式 · 移动端会话 | prompt, steer, abort, get_snapshot · session_snapshot, progress |

---

## 三、UX 设计摘要

### 3.1 设计语言

延续 `multidevice-ui.html` 的深色主题视觉系统：

- **色彩系统**：`--bg: #0b0e14`（背景）、`--panel: #12161f`（面板）、`--border: #1e2530`（分割线）、`--text: #d7dde8`（正文）、`--muted: #7b8698`（辅助文字）、`--accent: #4f8cff`（强调色）
- **状态色**：`--green: #34d399`（成功/已完成）、`--amber: #fbbf24`（警告/运行中）、`--red: #f87171`（错误/失败/停止）
- **字体**：系统无衬线（PingFang SC）为正文，SF Mono/Menlo 为代码
- **圆角**：8px 统一（小控件 6px、卡片 10px、按钮 10px）

### 3.2 全局导航模式

- **左侧 56px 图标导航栏**：7 个一级入口 + 底部设置，当前页高亮为 accent 色
- **顶栏**：面包屑导航 + 页面级操作按钮，提供上下文定位
- **右面板**：会话工作台专属，280-300px，展示会话状态/重试/压缩/Todo
- **移动端**：无侧栏，顶栏精简为状态 + Agent 名 + 详情浮层入口

### 3.3 关键交互行为

#### 会话工作台
- **流式输出**：绿色打字机光标（`caret` blink 动画），`streaming` phase 时显示
- **停止按钮**：发送（accent 蓝）与停止（red 红）原位替换，Esc 键等效
- **工具卡三态**：
  - 运行中：amber 色 `badge.run` + 旋转 spinner
  - 完成：green 色 `badge.done` + 参数/结果展开
  - 失败：red 边框 `toolcard.error` + 重试按钮
- **工具卡展开/收起**：点击头部 toggle，结果默认折叠（overflow hidden），长内容可 hover 展开到 300px
- **模型/thinking 切换**：点击 chip 弹出下拉菜单，选中后即时反馈（不刷新页面）
- **输入区**：Enter 发送、Shift+Enter 换行、Esc 中止、草稿自动保留提示

#### Agent 管理
- **Agent 卡片**：网格布局（minmax 320px），hover 边框变 accent，显示名称/角色/模型/技能数/定时任务数/最近活跃
- **状态指示**：圆点（green 在线、amber 执行中、muted 已停用）
- **三态按钮**：进入会话（primary）、详情/暂停（secondary）、启用（停用态）
- **Agent 详情选项卡**：Skills/Cron/模型/工具 四个 tab，切换时保留各自滚动位置

#### 定时任务管理
- **Cron 项**：显示名称、schedule（monospace）、最近运行记录（绿色 ✓ 成功、红色 ✗ 失败）
- **操作**：暂停/立即运行/日志
- **新建流程**：点击按钮弹出表单（未在 mock 中展开，留给前端实现）

#### 会话记录与回放
- **列表表格**：按时间倒序，hover 高亮行，状态 badge 区分 已完成/已中止/出错
- **筛选联动**：日期/Agent/状态三个维度 + 搜索
- **回放控制**：播放/暂停、快进/快退、速度 1x/2x/4x、进度条、Step 计数
- **时间线导航**：右侧 timeline 竖向导航，点击跳转到对应消息

#### 语音
- **录制按钮**：120px 圆形，点击切换录制/停止，录制时 pulse 动画 + wave 波纹
- **实时转文字**：转录区显示识别结果，active 态变亮
- **发送为指令**：转文字后点击发送 → 调用 `prompt` 命令
- **语音播报**：Agent 完成时朗读（toggle）、速度/角色/静默时段下拉选择
- **VAD 偏好**：自动断句、静音阈值

#### Todo 面板
- **按阶段分组**：每个 phase 有进度条（完成比例）和完成计数
- **任务项**：checkbox + 文字 + 元数据（完成时间），done 态划线 + 半透明
- **添加**：dashed 边框输入框，失焦或回车确认

#### 模型市场
- **按 Provider 分组**：Anthropic、Narwal Plan、Google（按实际配置动态生成）
- **模型卡片**：名称、上下文窗口、价格、thinking 支持（tag 列表）、描述
- **当前模型**：accent 边框 + 右上角 badge
- **切换**：点击"使用此模型" → 调用 `set_model` 命令

#### 设置
- **分组布局**：连接/主题/快捷键/会话行为/通知/危险操作，每组标题 + 分割线
- **Toggle**：42x24px 滑动开关，accnet 色 on 态
- **快捷键**：`kbd` 标签展示，monospace
- **危险操作**：红色按钮，需要二次确认

#### 移动端
- **裁剪策略**：右面板（Todo/状态详情）变为从底部弹出的浮层面板（overlay）
- **模型/thinking**：缩为可横向滚动的快捷条（quickbar）
- **工具卡**：默认折叠，点击展开参数和结果
- **触控优先**：大按钮（40px 以上）、语音输入快捷入口（🎤 按钮）
- **viewport**：max-width 430px，居中显示，禁止缩放

### 3.4 状态设计（四态）

| 状态 | 视觉表现 | 触发条件 |
|------|----------|----------|
| **Loading** | spinner 旋转动画、骨架屏占位（灰色条） | 初始快照拉取、模型列表加载 |
| **Empty** | 居中图标 + 说明文字 | 无 Agent、无会话、无 Todo |
| **Error** | red 色文字 + 错误信息 + 重试按钮 | 连接断开、命令失败、工具调用出错 |
| **Streaming** | 打字机光标 blink、工具卡 spinner、发送→停止按钮替换 | LLM 流式输出中 |

### 3.5 协议映射摘要

前端通过 WebSocket 与 `omp serve` 通信，协议为 JSON 帧（`MULTIDEVICE_PROTOCOL_VERSION = 1`）：

- **握手**：`hello { version, token }` → `hello_ack { connectionId }` 或 `hello_error`
- **请求/响应**：`request { id, command }` → `response { id, ok, result/error }`
- **服务端推送**：`push { event: session_snapshot | progress }`
- **权威快照**：`session_snapshot` 包含 sessionId、model、thinkingLevel、messages、todoPhases、phase、activeToolNames 等完整 UI 重建所需字段
- **进度事件**：`progress` 事件（message_update 等）仅用于 UI 提示（打字机效果），不得归约为权威状态

前端可用的 25 条命令（`MultiplexCommand`）覆盖：prompt、steer、follow_up、abort、abort_and_prompt、new_session、get_state、set_todos、set_host_tools、set_model、cycle_model、get_available_models、set_thinking_level、cycle_thinking_level、compact、set_auto_compaction、set_auto_retry、abort_retry、get_session_stats、switch_session、branch、get_branch_messages、get_last_assistant_text、set_session_name、get_messages。

新增 5 条多端专属命令：subscribe、unsubscribe、get_snapshot、attach、detach。

### 3.6 移动端取舍

| 功能 | 桌面端 | 移动端 |
|------|--------|--------|
| 右侧面板（状态/Todo） | 固定 300px 侧栏 | 浮层面板（底部弹出） |
| 模型/thinking 切换 | 顶栏 chip 下拉 | 快捷条横向滚动 |
| 工具卡 | 默认展开参数和结果 | 默认折叠，点击展开 |
| 语音入口 | 独立页面 | 输入区快捷按钮 |
| 多页导航 | 左侧 56px 图标栏 | 无导航栏，从会话页返回 |
| 键盘快捷键 | 全量支持 | 保留 Esc 中止 |

---

## 四、V2 视觉设计系统

### 4.1 设计 Tokens（CSS 变量清单）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg-base` | `#0a0c10` | 最深层背景 |
| `--bg-raised` | `#11141b` | 面板/卡片背景 |
| `--bg-overlay` | `#171b24` | 浮层/输入框背景 |
| `--border` | `rgba(255,255,255,0.06)` | 1px 细边线 |
| `--border-strong` | `rgba(255,255,255,0.12)` | 强调边线 |
| `--text` | `#e8ecf4` | 主文字 |
| `--text-sec` | `rgba(232,236,244,0.62)` | 次要文字 |
| `--text-ter` | `rgba(232,236,244,0.38)` | 辅助/占位文字 |
| `--accent` | `#5b8cff` | 强调色（单一） |
| `--accent-hover` | `#6f9fff` | hover 变亮 8% |
| `--accent-active` | `#4a7af0` | active 变暗 |
| `--accent-dim` | `rgba(91,140,255,0.15)` | 强调色透明底 |
| `--success` | `#3ddb87` | 成功/完成 |
| `--warning` | `#f5a623` | 警告/运行中 |
| `--danger` | `#ff6b6b` | 错误/停止 |
| `--info` | `#5b8cff` | 信息（同 accent） |
| `--user-bg` | `#1a2030` | 用户气泡 |
| `--assistant-bg` | `#141824` | 助手气泡 |
| `--fs-xs` ~ `--fs-3xl` | 11/12/13/14/15/18/24px | 6 级字号阶梯 |
| `--fw-regular` ~ `--fw-bold` | 450/500/600/700 | 4 级字重 |
| `--mono` | SF Mono, Menlo | 代码/数据字体 |
| `--radius-sm/md/lg` | 6/8/12px | 圆角体系 |
| `--sp-1` ~ `--sp-6` | 4/8/12/16/24/32px | 间距系统 |
| `--ease` | 130ms ease | 过渡动效 |
| `--shadow-lg` | 0 8px 24px rgba(0,0,0,0.4) | 下拉/浮层阴影 |

### 4.2 排版

- **字号阶梯**：11/12/13/14/15/18/24px，行高 1.55
- **字重**：标题 600-700，正文 450，辅助 500
- **正文字体**：-apple-system / PingFang SC / Microsoft YaHei
- **代码字体**：SF Mono / Menlo，12-12.5px
- **letter-spacing**：小标签/徽标 uppercase 时 0.04-0.08em

### 4.3 色彩

- **三层深色背景**：base `#0a0c10` → raised `#11141b` → overlay `#171b24`
- **1px 细边线**：`rgba(255,255,255,0.06)`，强调用 `rgba(255,255,255,0.12)`
- **单一强调色**：`#5b8cff`，hover 变亮 8-10%（`#6f9fff`），active 变暗（`#4a7af0`）
- **语义色**：success `#3ddb87`、warning `#f5a623`、danger `#ff6b6b` —— 仅用于状态
- **文字三级**：primary `#e8ecf4` / secondary `rgba(232,236,244,0.62)` / tertiary `rgba(232,236,244,0.38)`

### 4.4 控件规格

| 控件 | 规格 |
|------|------|
| 按钮 primary | accent 实底，hover 变亮，active 变暗，34px 高，8px 圆角 |
| 按钮 secondary | raised 底 + 细边，hover 变亮 |
| 按钮 danger | danger 实底，hover 变亮 |
| 输入框 | overlay 底 + 1px 边，focus 时 accent 边框 + 3px accent-dim 光圈 |
| toggle | 44×24px，滑钮 18px，200ms 过渡，on 态 accent |
| chip | overlay 底 + 细边 + 箭头，hover accent 边框 |
| dropdown | overlay 底 + 强边 + 阴影 + 焦点项高亮 |
| badge | 10.5px，1px 边框，圆角 10px，语义色 + 透明底 |
| 工具卡 | 12px 头，mono 参数区深色底，结果 ✓/✗ 前缀，error 红边+淡红底 |
| 状态圆点 | 8px 圆 + 外发光，忙碌时呼吸动画 |
| streaming 光标 | accent 色圆头竖线（7×15px），1s 呼吸 |

### 4.5 布局与间距

- **间距系统**：4/8/12/16/24/32px（`--sp-1` ~ `--sp-6`）
- **卡片**：12px 圆角，1px rgba 边，hover 边框微亮，16-20px 内边距
- **侧栏**：56px 图标导航，active 时 accent 背景 + 左侧 2px 指示条
- **顶栏**：44px 高，breadcrumb + 操作按钮
- **转录区**：最大宽 720px 居中（两栏右面板除外）
- **过渡**：130-150ms ease，只过渡 background/border/color/opacity/transform

### 4.6 动效

- **统一过渡**：`--ease: 130ms ease`
- **hover 提升**：卡片 `translateY(-1px)` + 边框变亮
- **streaming 光标**：1s 呼吸动画（opacity 1→0.3→1）
- **状态圆点**：在线/忙碌 6px 外发光，忙碌时 2s 脉冲
- **toggle**：200ms 滑钮过渡 + 微阴影
- **骨架屏**：灰色条占位（loading 态）
---

## 五、V3 设计系统（impeccable + awesome-design-md 指导）

V3 是参考 `impeccable`（设计词汇与质量地板）与 `awesome-design-md`（Linear / Raycast 设计规范）后的全面重设计。V2 的 token 体系保留为底色，V3 在此基础上做了五个方向的修正。

### 5.1 V3 改了什么（V2 → V3 对照）

| 问题（V2） | 修正（V3） | 依据 |
|---|---|---|
| 全部 emoji 当图标 | 内联 SVG 图标系统，1.5px 描边，统一线性风格 | impeccable craft-floor：禁止 unicode glyphs/emoji 当图标 |
| 工具卡 3px 彩色左边条 | 去掉左边条，hairline 边框 + 语义色只留在 badge | craft-floor：colored border-left above 1px 被禁 |
| 卡片套卡片（agent-detail） | 行式列表（row），hairline 分隔，无嵌套卡片 | craft-floor：cards are the lazy container, nested cards wrong |
| 页面标题 18px | 页面标题 32px/600/-0.8px 负字距，正文 14px | Linear typography：display 32-80px 负字距阶梯 |
| mono 到处当装饰 | mono 仅用于代码、ID、cron schedule、快捷键 | craft-floor：monospace as a costume for technical 被禁 |
| badge 带 1px 边框 | pill badge 去边框，透明语义色底 | Linear status-badge：surface-2 底 + pill 圆角 |
| 每个页面都长一个样 | 每页定义视觉主角（hero），其余克制 | impeccable bolder：one decisive move, quiet everything around |
| 助手消息套卡片容器 | 消息流平铺（Raycast 式），只给用户消息加气泡 | Raycast：界面退缩，内容为主角 |

### 5.2 V3 设计 Tokens

| Token | 值 | 用途 |
|-------|-----|------|
| `--canvas` | `#0a0b0e` | 页面背景（近黑带蓝调） |
| `--surface` | `#101216` | 面板/导航背景 |
| `--surface-2` | `#16181d` | 卡片/输入框/悬浮 |
| `--surface-3` | `#1c1f26` | 交互 hover 底 |
| `--hairline` | `rgba(255,255,255,0.07)` | 1px 分隔线 |
| `--hairline-strong` | `rgba(255,255,255,0.13)` | 强调边线/focus |
| `--ink` | `#f4f5f7` | 主文字 |
| `--ink-muted` | `#b8bcc5` | 次要文字 |
| `--ink-subtle` | `#7d828c` | 辅助文字 |
| `--ink-faint` | `#555a64` | 占位/禁用文字 |
| `--accent` | `#5e6ad2` | 单一强调色（Linear lavender） |
| `--accent-hover` | `#828fff` | hover 态 |
| `--accent-dim` | `rgba(94,106,210,0.14)` | 透明强调底 |
| `--success` | `#4cb782` | 成功 |
| `--warning` | `#e5a83b` | 警告 |
| `--danger` | `#e5484d` | 错误 |
| `--font` | SF Pro Text / PingFang SC | 正文 |
| `--mono` | SF Mono / Menlo | 代码/ID/快捷键 |

### 5.3 排版（V3）

- **页面标题**：32px / 600 / letter-spacing -0.8px（编辑式排版，Linear display 阶梯的入口级）
- **正文**：14px / 400 / -0.05px，行高 1.6
- **辅助**：12-13px / `--ink-subtle`；占位与元数据 11px / `--ink-faint`
- **mono 使用纪律**：代码、会话 ID、cron schedule、快捷键、token 数字——除此之外不用
- **负字距**：标题 -0.8px → 正文 -0.05px → mono 0

### 5.4 每页视觉主角

| 页面 | 主角 | 克制对象 |
|------|------|----------|
| 会话工作台 | 消息流（720→680px 居中 + accent 呼吸光标） | 右栏、工具卡 |
| Agent 列表 | Agent 卡片（状态光点 + 17px 名称） | 筛选栏、标签 |
| Agent 详情 | 32px 大标题 + mono 模型 tag | 选项卡内容行式平铺 |
| 会话记录 | 行式会话列表（15px 名称 + 状态 badge） | 表格头、分页 |
| 会话回放 | 回放控制条（accent 实底播放键 + 进度球） | 转录、时间线 |
| 语音 | 录音球（SVG 麦克风 + 双层波纹扩散） | 设置面板 |
| 设置 | kbd 快捷键表 | 表单行 |
| 移动端 | 触控输入区（42px 按钮 + 浮层面板） | 快捷条 |
| Todo 面板 | 阶段进度细条（2px，完成变绿） | 任务行无边框 |
| 模型市场 | 当前模型 hero（accent 描边大区块） | 其他模型行式排列 |

### 5.5 图标系统

全部内联 SVG `<symbol>` 定义，1.5px stroke、round cap/join、18px 默认尺寸。侧栏 7 个图标 + 页面级工具图标（file/search/terminal/play/prev/next/mic/send/stop）。禁止 emoji 出现在 UI 组件中。

### 5.6 工具来源

- **impeccable**（`github.com/pbakaus/impeccable`）：设计词汇（bolder/quieter/layout/typeset/delight 等 38 个 reference）、craft-floor 质量地板（对比度、深度、间距、类型、动效、状态、浏览器表面、文案、覆盖率检查 + 禁止清单）
- **awesome-design-md**（`github.com/VoltAgent/awesome-design-md`）：74 个品牌设计系统 markdown 规范，本设计主要参照 `linear.app`（表面阶梯、单一 accent、hairline、排版负字距）与 `raycast`（工具感、kbd、界面退缩）
- 本地副本：`.omp/design-refs/impeccable`、`.omp/design-refs/awesome-design-md`

---

## 六、V4 追加（2026-08-17）

V4 在 V3 视觉系统之上新增：Home 欢迎页、app-shell 框架化、手机预览面板。

### 6.1 新增页面

| 序号 | 页面名称 | 文件 | 路由 | 说明 |
|------|----------|------|------|------|
| 0 | Home 欢迎页 | `home.html` | `#/home` | EmptyState 模式：Greeting → Suggestions → Composer + 最近活跃 Agent，staggered 入场动画 |

页面索引其余不变（见第二节），全部页面现在共 11 个。

### 6.2 前端框架映射

mock 的每页 HTML 结构 → 未来前端框架（React/Vue/Svelte 均可）的对应关系：

| Mock 结构 | 框架对应物 | 说明 |
|-----------|-----------|------|
| `<nav id="nav">` + `NAV` 数组 | Layout 组件 + 菜单注册表 | 侧栏导航数据驱动，加页面 = 数组加一项 |
| 页面头部注释块（页面名/路由路径/导航分组/协议命令） | Route config | 每页头部注释即路由声明，框架按此生成路由表 |
| `#topbar`（breadcrumb + 页面操作） | Page Header 组件 | 面包屑 + 右侧操作按钮，每页复用 |
| `#content` / `#stage` | Page 组件 | 页面主体内容区 |
| `#sidebar`（右栏） | Side Panel 组件 | 会话状态/Todo/配置等，桌面端固定，移动端浮层 |
| 手机预览面板 | DevicePreview 组件 | 375×812 iframe 嵌入 mobile-session，桌面页右上角触发 |
| CSS `:root` tokens | Theme provider / CSS variables | 全部页面共享同一组 design token |
| SVG `<symbol>` 图标 | Icon 组件库 | 内联 SVG defs → 独立 Icon 组件，按 name 引用 |

### 6.3 手机预览

每个桌面页面右上角有「预览手机」按钮，点击右侧滑出 iPhone 模拟器面板（375×812 设备框：40px 圆角、状态栏、home indicator、iframe 加载 `mobile-session.html`）。遮罩点击或 Esc 关闭。

### 6.4 页面注册约定

新页面 = 复制壳 + 注释块 + NAV 数组加一项：

```html
<!--
页面名：XXX
功能层级位置：OMP 多端前端 > XXX
路由路径：#/xxx
导航分组：primary(N)
覆盖协议：cmd1, cmd2 · event1
-->
```

然后在每页 `<script>` 的 NAV 数组中加一项即可出现在侧栏。

---

## 七、V5 追加（2026-08-17）

V5 六项改动：composer 工具栏、主题换锌黑白、右栏可视化、布局文档 + 拖拽、workspace 管理、coding/worker 类型。

### 7.1 主题 V5（锌黑白 · 简约）

V3/V4 的蓝紫 accent 换为**单色锌灰 + 白 accent**（Raycast 式白 CTA 路线）：

| Token | V4 | V5 |
|-------|----|----|
| `--accent` | `#5e6ad2`（蓝紫） | `#f4f4f5`（近白） |
| `--accent-hover` | `#828fff` | `#ffffff` |
| `--accent-dim` | `rgba(94,106,210,0.14)` | `rgba(250,250,250,0.09)` |
| `--on-accent` | — | `#0a0a0b`（accent 底上的深字） |
| `--canvas` | `#0a0b0e` | `#09090b`（zinc-950） |
| `--ink-*` 四级 | 蓝调灰 | 纯灰（`rgba(250,250,250,*)`） |
| `--dingtalk`（新增） | — | `#3296fa`（钉钉品牌蓝，仅用于绑定标识） |

语义色微调成更哑光的绿/黄/红。全站 11 页已统一替换。

### 7.2 Composer 工具栏（需求 1）

工作台输入区升级为两行：上 textarea，下工具栏——**Agent 选择器**（头像 + 钉钉角标 + CODING/WORKER 徽标，下拉按工作区分组）、**附件上传**、**语音**、模型/thinking 快捷切换、发送/停止圆形按钮原位替换。

### 7.3 右栏在线可视化（需求 3）

右侧面板改 tab 结构：状态 / **可视化** / Todo。可视化 tab 含 token 速率实时柱状图（1.5s 刷新 mock 数据流）、活跃工具列表（运行时长）、命令输出预览流。

### 7.4 布局文档 + 拖拽（需求 4）

- 新增 **`LAYOUT.md`**：7 个功能区划分、尺寸约束表、拖拽行为、响应式规则、持久化约定
- 工作台右栏与内容区之间加 **5px 拖拽分隔条**：hover 反馈、col-resize 拖拽、clamp 240–520px、双击复位 300px、localStorage 持久化

### 7.5 Agent 工作区管理（需求 5）

Agent 列表页按**工作区分节**（研发工作区 / 运营工作区）+ 顶部 seg 筛选（全部 / 研发 / 运营）；composer 的 agent 下拉同样按工作区分组。

### 7.6 CODING / WORKER 类型区分（需求 6）

每个 agent 携带类型徽标：**CODING**（终端图标 + 填充样式，研发任务）/ **WORKER**（公文包图标 + 描边样式，运营职能任务）。绑定钉钉机器人的 agent 头像右下角显示钉钉 logo 角标（品牌蓝 `#3296fa`），会话状态区显示绑定状态。

---

## 八、亮色主题（2026-08-17）

V5 的深色锌灰被用户判为「看不清」，全站 11 页切换为**亮色单色主题**。设计路线不变（单色 + 语义色），只是反转为白底深墨：

| Token | 深色 V5 | 亮色 V6 |
|-------|---------|---------|
| `--canvas` | `#09090b` | `#f7f7f8` |
| `--surface` | `#101013` | `#ffffff` |
| `--surface-2` | `#18181b` | `#f0f0f2` |
| `--surface-3` | `#232327` | `#e6e6e9` |
| `--hairline` | `rgba(255,255,255,0.08)` | `rgba(24,24,27,0.09)` |
| `--hairline-strong` | `rgba(255,255,255,0.16)` | `rgba(24,24,27,0.18)` |
| `--ink` | `#fafafa` | `#18181b` |
| `--ink-muted` | `rgba(250,250,250,0.64)` | `rgba(24,24,27,0.66)` |
| `--ink-subtle` | `rgba(250,250,250,0.44)` | `rgba(24,24,27,0.5)` |
| `--ink-faint` | `rgba(250,250,250,0.28)` | `rgba(24,24,27,0.34)` |
| `--accent` | `#f4f4f5`（白） | `#18181b`（深墨） |
| `--accent-hover` | `#ffffff` | `#3a3a3f` |
| `--accent-dim` | `rgba(250,250,250,0.09)` | `rgba(24,24,27,0.08)` |
| `--on-accent` | `#0a0a0b` | `#fafafa` |
| `--success` | `#45b07a` | `#189a5c` |
| `--warning` | `#d9a03f` | `#b97c1e` |
| `--danger` | `#e05d5d` | `#d64545` |
| `--user-bg` | `#18181b` | `#ececee` |

硬编码修正：工具卡参数区底 `rgba(0,0,0,0.25)` → `rgba(24,24,27,0.05)`、阴影全面调浅（0.5→0.14 / 0.6→0.18）、用户/助手头像改为浅灰蓝 / 浅绿底。钉钉品牌蓝 `#3296fa` 保持不变。

---

## 九、V5 新功能（2026-08-17）

### 9.1 thinking-orbs 动效（FR-12）

引擎提取自 `thinking-orbs` v0.3.1（MIT，canvas 2D 点阵），拆成两个文件供各页 `<script src>` 引用：

| 文件 | 作用 |
|------|------|
| `docs/mock/orbs-engine.js` | 9 状态动画引擎（19KB，ESM 转全局脚本） |
| `docs/mock/orbs.js` | 包装层：`data-orb` 自动挂载 + `Orb.mount/setState` API |

**orbs 状态映射表**（wire phase → orb state）：

| 会话阶段 | orb 状态 | 尺寸 | 位置 |
|----------|----------|------|------|
| idle / 待命 | `breathing` | 64px | Home 问候区旁 |
| streaming / 流式输出 | `composing` | 20px | 工作台流式消息名称行 |
| executing_tool / 工具执行 | `solving` | 20px | （预留）工具卡头部 |
| listening / 语音监听 | `listening` | 64px | Voice Jarvis 模式 |
| connecting / 连接中 | `connecting` | 64px | （预留）连接状态 |
| planning / 规划 | `shaping` | 64px | Voice Jarvis 转写完成态 |
| agent 运行中 | `working` | 20px | Agent 列表卡片状态位 |

### 9.2 内容预览（FR-10）

工作台转录区新增三种预览卡片（不动消息权威数据，纯展示层）：

| 类型 | 触发 | 卡片内容 |
|------|------|----------|
| **mermaid** | ` ```mermaid ` 代码块 | 几何占位预览（节点 + 连线示意）+ 可展开源码 + 注释注明正式版接 mermaid 库 |
| **drawio** | `.drawio` 文件引用 | 文件名 + 缩略图标 + 「打开查看」按钮 |
| **网页链接** | `http(s)://` URL | favicon 占位 + 标题 + 摘要 + 「内嵌打开」iframe 预览切换 |

### 9.3 钉钉机器人 → 用户建模（FR-11）

**数据流**：钉钉机器人消息 → gateway session 日志 → 用户画像提取 → Agent 上下文注入

| 位置 | 内容 |
|------|------|
| 设置页 > 钉钉集成 | AppKey / AppSecret 输入、连接状态（已配置/检测中）、「测试连接」按钮、绑定 Agent 选择 |
| Agent 详情 > 用户画像 tab | 标签云（机器人/扫地机/日程/投融资/代码审查/架构设计）+ 一句话摘要 + 128 条消息来源标注 + 重新建模 / 导出 / 清除操作 |

### 9.4 Jarvis Voice（FR-13）

Voice 页升级为双模式：

| 模式 | 界面 |
|------|------|
| 基础语音 | 录音球 + 转写 + 发送为指令（原有） |
| Jarvis 免提 | 64px 大 orb（breathing → listening → shaping → composing → breathing）、唤醒词开关（Hey Jarvis）、STT 转写区、32 柱波形动画、TTS 播报条（含停止按钮）、多轮对话历史记录 |

工作台输入区已有语音快捷按钮（🎤 图标 → 跳 Voice 页）。
