# OMP 多端前端 · 需求整合文档（PRD）

> 2026-08-17 · 由历次需求沟通整合，是前端开发（P3）的唯一需求来源
> 关联：`multidevice-host.md`（架构方案）· `README.md`（mock 总览）· `redesign-brief.md`（V2 视觉）· `v4-brief.md`（V4 追加）· `v5-brief.md`（V5 追加）

---

## 1. 背景与目标

omp 是自研 Bun coding agent。目标：**一个 omp 同时支持 TUI / Web / PC 桌面 / Mobile 四端**，会话的权威快照 + 增量事件成为单一事实源，各端消费同一套语义。后端（`omp serve` WS 协议，P0/P1）已完成，前端（P3）待开发，本需求整合文档约束前端产品与交互。

## 2. 产品形态

| 端 | 形态 | 技术（已决策） |
|---|---|---|
| Web | 浏览器单页应用 | React + Vite |
| PC 桌面 | 桌面应用壳 | Electron（成熟优先；Tauri 为备选） |
| Mobile | 原生壳 / PWA | Capacitor 或 PWA（同一套 React 代码） |
| TUI | 终端 | 现有 InteractiveMode，不动 |

底座：`@oh-my-pi/pi-client`（P2）+ `@oh-my-pi/pi-wire`（协议类型包）。前端壳不写业务逻辑，只用 pi-client 连接本地 `omp serve`。

## 3. 页面与信息架构

```
OMP 前端
├── 0. Home 欢迎页（默认起始页）FR-9
├── 1. 会话工作台 FR-1
├── 2. Agent 管理（列表 / 详情）FR-2
├── 3. 会话记录（列表 / 回放）FR-3
├── 4. 语音（Voice）FR-4
├── 5. Todo 面板 FR-5
├── 6. 模型市场 FR-6
├── 7. 设置 / 连接 FR-7
└── 8. 移动端精简视图 FR-8
```

## 4. 功能需求

### FR-1 会话工作台（核心）
- 消息转录：用户/助手消息流；流式打字机（accent 圆头光标，1s 呼吸）；工具调用卡片（三态：运行中/完成/失败）
- 输入区：Enter 发送 / Shift+Enter 换行 / **Esc 中止**；发送↔停止**原位替换**（停止为红色，无确认）；草稿自动保留
- 顶栏：连接状态（connected/reconnecting/断线重连计数）、项目/分支、模型选择、thinking 级别切换、compact、新会话
- 右面板：会话状态（phase/model/token 水位/队列计数）、auto-retry/auto-compaction 开关、Todo
- **思考/等待动效**：streaming/tool 执行/规划阶段使用 thinking-orbs 动效（FR-12）
- **内容预览**：转录中的 mermaid / drawio / 网页链接支持渲染预览（FR-10）

### FR-2 Agent 管理（列表 + 详情）
- **Agent 列表**：卡片网格（名称/角色/模型/状态/最近活跃/技能数/定时任务数）；筛选（全部/运行中/空闲/已停用）+ 搜索；快捷操作（进入会话/详情/暂停/启用）
- **Agent 详情**（四个 tab）：
  - **Skills 管理**：技能列表、启用/停用 toggle、技能描述/版本
  - **定时任务管理（cron）**：cron 列表、新增/暂停/删除/立即运行、最近运行记录（成功✓/失败✗）、日志入口
  - **模型配置**：provider/model/thinking 选择、token 用量与费用
  - **工具开关**：按类别 toggle（read/write/bash/search/lsp/python/…）
- **钉钉机器人关联（FR-11）**：Agent 绑定的钉钉机器人，在详情页展示机器人信息（名称/头像/关联会话），配置状态提示

### FR-3 会话记录（Record）
- 历史会话列表：表格（会话名/Agent/时间/消息数/状态）；筛选（日期/Agent/状态）+ 搜索；操作（回放/导出 JSONL）
- 会话回放：播放/暂停、快进/快退、速度 1x/2x/4x、进度条 + Step 计数、右侧时间线导航

### FR-4 语音（Voice / record）
- **语音输入**：麦克风按钮（录制/停止）、波形动画、实时转文字、发送为指令（STT → prompt）
- **语音播报**：Agent 完成时朗读（toggle）、速度/角色/静默时段
- **VAD 偏好**：自动断句、静音阈值
- **Jarvis Voice（FR-13）**：全程语音助手形态 —— 唤醒词、语音提问/指令闭环（听 → 思考动效（listening/shaping orb）→ 播报答复）、免提模式、多轮语音对话

### FR-5 Todo 面板
按阶段分组（Investigation/Implementation/Documentation/…）、阶段进度条、任务 checkbox/添加/删除、完成自动归档（划线/半透明/折叠）

### FR-6 模型市场
按 Provider 分组（Anthropic/Narwal Plan/Google…）、模型卡片（名称/上下文/价格/thinking 支持/描述）、筛选（全部/支持 thinking/高上下文/最新）、「使用此模型」切换（set_model）

### FR-7 设置 / 连接
连接（状态/WS URL/Token/协议版本）、主题、快捷键、会话行为（自动压缩/自动重试/草稿保留）、通知、危险操作（二次确认）

### FR-8 移动端精简视图
- 右面板 → 底部浮层；模型/thinking → 横向快捷条；工具卡默认折叠；触控优先（40px+ 按钮 + 语音入口）
- 保留 Esc 中止；viewport max-width 430 居中

### FR-9 Home 欢迎页（默认起始页）
- 问候语：时间感 + **使用者名字**（mock 用「彭梦龙」占位；正式版从 user profile 由 pi-client 提供）
- 3-5 个建议入口（pill）：最近任务/定时任务检查/语音记录/模型切换/Agent 管理
- 居中 Composer：输入直达会话工作台
- 下方：最近活跃 Agent 卡片
- 错峰入场动画（问候 → 建议 pill → Composer，staggered 120ms + index*70ms / 360ms）
- 首屏动效：thinking-orbs（breathing/working）点缀，标志产品「随时待命」气质

### FR-10 内容预览（mermaid / drawio / 网页）
- 助手消息中识别并渲染：**mermaid 流程图/时序图**（轻量 mermaid 渲染）、**drawio 文件**（示意图卡片预览 + 打开查看）、**网页链接**（内嵌预览卡片：favicon/标题/摘要，可选 iframe 展开）
- 属于转录区的增强渲染，不动消息权威数据

### FR-11 钉钉机器人 → 用户建模
- 用户在设置中配置钉钉机器人（AppKey/Secret 等）后：
  - 前端展示机器人配置状态（未配置/已配置/检测中）
  - agent 详情显示关联机器人信息
  - **利用机器人消息（用户与机器人会话）对用户建模**：生成/更新用户画像（偏好/关注点/沟通风格），在 Agent 详情或设置页以「用户画像」卡片展示（标签云 + 摘要），并提示「基于 N 条钉钉消息」
  - 数据边界：建模结果本地存储，可一键清除

### FR-12 thinking-orbs 动效（统一 agent 状态语言）
- 引入 https://github.com/Jakubantalik/thinking-orbs（MIT，canvas 2D，9 状态，两种尺寸，自动深/浅色，reduced-motion 静态帧）
- 状态映射：streaming → `composing`/`working`；工具执行 → `solving`；语音监听 → `listening`；连接中 → `connecting`；规划 → `shaping`
- 应用位置：会话工作台流式区/等待态、agent 卡片运行中、Home 首屏、Jarvis voice 听/答过渡
- 性能：离屏暂停（IntersectionObserver）、共享时钟、DPR cap 2

### FR-13 Jarvis Voice（全程语音助手）
- 形态：语音优先的助手入口（可与文本会话并存）
- 能力：唤醒/按键说话 → STT → 发送指令 → agent 执行 → 播报关键结果（TTS）
- 与 FR-4 语音页合并为统一「Voice」模块：语音输入/播报/唤醒/VAD 为底层能力，Jarvis Voice 是其上的「语音对话模式」

## 5. 非功能需求

- 离线可演示：mock 全部本地 HTML/CSS/JS 自包含；正式版首屏到可用 < 2s（本地 serve 连接）
- 协议映射：命令面 25+5 条（见 wire-types.ts）；权威快照 session_snapshot / 进度 progress 分离，progress 不作为状态源
- 响应式：桌面全功能、移动端裁剪策略见 FR-8
- 可访问性：动效尊重 prefers-reduced-motion、键盘可操作、状态 aria-label
- 安全：token 仅存本地（不入库）；钉钉密钥不落前端日志

## 6. UX 设计原则（已评审采纳）

1. 生命周期状态可见：loading/empty/error/streaming 四态全覆盖，每个状态有可见表示 + 用户动作
2. 工具卡三态 = 用户审计轨迹
3. 发送↔停止原位替换、无确认；中断保留部分内容并标记
4. 思考/推理不默认展开（折叠面板，按需）
5. 视觉系统：深色三层背景 + 单一 accent（#5b8cff）+ 语义色克制；类型层级 11-24px；8px 间距系统；130-150ms 过渡（V3 token 表）

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | Home + 会话工作台（含 orbs 动效、内容预览）| 浏览器跑通 mock，可交互 |
| M2 | Agent 管理（skills/cron/钉钉建模）+ 设置 | 建/停 cron、技能开关、画像展示 |
| M3 | 会话记录回放 + Voice（含 Jarvis 模式）| 回放与语音闭环 |
| M4 | 移动端 + 手机预览联调 | 375px 视口可用 |
| M5 | 接入真实 pi-client + Electron/Capacitor 壳 | 真实 serve 端到端 |

## 8. 待确认

- [ ] 钉钉建模的「建模数据」具体字段与展示粒度（标签云 vs 结构化画像）
- [ ] mermaid 渲染体积（完整库 vs 子集）对离线包的影响
- [ ] Jarvis 语音引擎选型（系统 TTS vs 云端）

## 9. 窗口追加需求（V6，迭代中已确认）

- **亮色主题**：全站 token 白纸底（#f7f7f8 / #ffffff / 墨字 #18181b），语义色加深保证对比度；钉钉蓝 #3296fa 为唯一彩色点缀；README「亮色主题」token 对照。视觉路线不变（单色+语义色/hairline 分隔/SVG 图标）
- **Agent workspace 分节**：Agent 列表按研发工作区/运营工作区分节 + 顶部 seg 筛选；composer 的 agent 选择器同分组
- **CODING / WORKER 徽标**：CODING（终端图标+填充徽标，面向研发）、WORKER（公文包图标+描边徽标，面向运营职能），出现在 agent 卡片与 composer 选择器
- **会话工作台增强**：composer 工具栏、viz 标签页切换、转录区左右拖拽调整宽度（240-520px、双击复位、localStorage 持久化）