# OMP 多端前端 — Mock 设计总览

> 产出日期：2026-08-16
> 设计依据：`design-brief.md` · `multidevice-host.md` · `wire-types.ts` · `multidevice-ui.html`

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
| 会话回放 | 完整控制栏 + 时间线 | 裁剪为简单播放/暂停 |