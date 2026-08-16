# V5 追加需求（优先级最高）

需求整合文档已生成：`docs/mock/requirements.md`（FR-1..FR-13）。你的任务是**把 V5 的四项新功能落地到 mock**（V4 基础上增量，不破坏既有页面与 V3 视觉系统）。

## 需求 1 · thinking-orbs 动效（FR-12）

来源：https://github.com/Jakubantalik/thinking-orbs（MIT，canvas 2D 点阵动效，9 状态，两种尺寸，自动深浅色，支持 reduced-motion）

落地方式：
- 去 npm 拉 `thinking-orbs` 包（`npm pack thinking-orbs` 或直接看 GitHub src/engine/），把 canvas 引擎提取成**单个原生 JS**（mock 是纯 HTML，不用 React 组件包装），内联进需要的页面（或做成共享 `docs/mock/orbs.js` 供各页 `<script src>` 引用）
- 状态映射：streaming → `composing`；工具执行 → `solving`；语音监听 → `listening`；连接中 → `connecting`；规划 → `shaping`；空闲/待命 → `breathing`
- 应用位置：Home 首屏问候区旁（breathing/working，64px）、会话工作台流式等待区（streaming 时在助手头像旁或输入区上，20-64px）、agent 卡片运行中状态（20px 内联）、Voice 页听/答过渡
- 尺寸两种都要用：聊天头像级 64 / 内联级 20

## 需求 2 · 内容预览（FR-10，mermaid / drawio / 网页）

会话工作台的转录区增强渲染（**不动消息权威数据，纯展示层**）：
- **mermaid**：助手消息中识别 ```mermaid 代码块 → 渲染成预览卡片。离线约束下允许两种做法任选：能内联一个最小 mermaid 渲染就内联；否则用「图表预览卡片」占位（卡片标题 + 示意几何图形 + 代码块可展开），注释注明正式版接 mermaid 库
- **drawio**：消息中的 .drawio 文件引用 → 示意图卡片（文件名 + 缩略占位 + 「打开查看」按钮）
- **网页链接**：转录中的 http(s) URL → 链接预览卡片（favicon（可内联小图标占位）+ 标题 + 摘要 + 「内嵌打开」切换 iframe 预览）
- 在 session-workspace.html 里加一段 mock 消息展示三种预览卡片（mermaid 流程图示例、drawio 文件、网页链接）

## 需求 3 · 钉钉机器人 → 用户建模（FR-11）

- **设置页（settings.html）**加「钉钉集成」区块：AppKey / AppSecret 输入框、连接状态（未配置/已配置/检测中）、「测试连接」按钮
- **Agent 详情（agent-detail.html）**加「用户画像」卡片：标签云（兴趣/关注点标签）、一句话摘要（「基于 128 条钉钉消息建模」）、更新按钮、一键清除（危险操作确认）
- mock 数据演示一个已建模的画像（如：标签「机器人/扫地机/日程/投融资」+ 摘要「关注研发效率与商业决策，偏好短句直接沟通」）—— 来源于你读过的 user profile 风格，但作为 mock 数据展示

## 需求 4 · Jarvis Voice（FR-13）

Voice 页（voice.html）升级为 **Jarvis 语音助手模式**（与现有语音输入/播报设置共存）：
- 模式切换：基础语音 / Jarvis 免提模式
- Jarvis 模式界面：中央大 orb（listening → shaping 动效）、唤醒词开关（如「Hey Jarvis」）、语音指令输入（STT 转写区 + 波形）、agent 执行 → TTS 播报答复（播报状态条 + 停止播报按钮）、多轮对话历史（本模式内的语音轮次记录）
- 会话工作台输入区加语音快捷按钮（🎤 图标，点击进 Voice/Jarvis）
- 交互演示：mock 里点「开始聆听」→ listening orb → 自动填入转写文本 → 发送 → 播报条出现

## 约束

- 延续 V3 token 系统；纯 HTML/CSS/原生 JS；离线可开
- 不破坏 V4 已完成的 Home 页、app-shell 框架、右上角手机预览
- 更新 README：页面索引补 Voice 的 Jarvis 模式说明 + 新节「5. 新功能（V5）：orbs/内容预览/钉钉建模/Jarvis」
- 完成后回复：四项各自落地位置 + orbs 状态映射表 + 钉钉建模数据流说明