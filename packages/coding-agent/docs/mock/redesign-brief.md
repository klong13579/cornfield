# 视觉重设计任务（V2）

上一版 10 页 mock（docs/mock/pages/*.html，deepseek-v4-pro 产出）功能与信息架构合格，但**视觉被用户判为「太丑」**。你的任务：**保留全部页面结构与功能覆盖，重做视觉系统**，让每一页达到现代一线产品（Vercel AI / Linear / Raycast / Claude.ai / Arc）的质感。

## 只改视觉，不动信息架构

- 10 个页面、功能层级树（docs/mock/README.md 第一节）、每页覆盖的协议命令 —— **全部保留**
- 重写每页的视觉呈现：整体重做 CSS 设计系统 + 各页布局细节
- 覆盖原文件（git 可回滚），控制在 `docs/mock/pages/*.html`

## 视觉设计规格（V2 设计系统）

### 排版（核心：明确的类型层级）
- 设计一个 6-7 级字号阶梯：11/12/13/14/15/18/24，行高 1.5-1.6
- 字重体系：450/500/600/700，标题用 600-700，正文 450
- 正文：-apple-system / PingFang SC；代码与数据：SF Mono/Menlo 12-12.5px
- `letter-spacing` 用于小标签/徽标（uppercase 时 0.04-0.08em）

### 色彩（克制、分层、单一强调色）
- 深色三层背景：base #0a0c10 → raised #11141b → overlay #171b24，1px rgba(255,255,255,0.06) 细边线
- 强调色单一：#5b8cff（或用更高级的蓝），hover 变亮 8-10%，active 变暗
- 语义色只给状态：success #3ddb87、warning #f5a623、danger #ff6b6b、info 蓝 —— 每页使用不超过需要
- 文字：primary #e8ecf4 / secondary rgba(232,236,244,0.62) / tertiary rgba(232,236,244,0.38)

### 控件（全规格化，拒绝浏览器默认感）
- 按钮：primary（accent 实底 + hover/active/disabled）、secondary（raised 底 + 细边）、ghost（透明 + hover 底）；高度 34px，圆角 8px，transition 130ms
- 输入框/textarea：raised 底、1px 边、focus 时 accent 边框 + 0 0 0 3px rgba(accent,0.15) 光圈
- toggle：44×24，滑钮 8px 圆角过渡，on 态 accent
- chip/select/dropdown：raised 底 + 细边 + 简单箭头；dropdown 有面板 + 阴影 + 焦点项高亮
- tooltip/空状态：居中几何插画（用 div 画，不用图片）+ 主/次文字

### 布局与间距（密度与呼吸感并存）
- 间距系统：4/8/12/16/24/32
- 卡片：圆角 12px、1px rgba 边、hover 边框微亮；大区块 16/20px 内边距
- 侧栏 56px 图标导航（icon 统一直线风格 18px 描边）+ 顶栏 40-44px
- 转录消息最大宽 720px 居中（两栏右面板除外），气泡与卡片靠左对齐留白合理
- hover 行/卡片的过渡 130-150ms ease，保证帧级顺滑（只过渡 background/border/color/opacity/transform）

### 签名感（以下是「不是默认模板」的关键）
- 顶栏/侧栏的焦点态：active 图标 accent + 左侧 2px 指示条
- streaming 光标：accent 色圆头竖线，1s 呼吸
- 工具卡三态视觉升级：头部 12px、参数区用等宽字体 + 更深的容器；成功结果的绿色前加「✓」图标；失败的红色用边框+淡红底
- 状态圆点：在线/忙碌/离线 用 8px 圆 + 外发光（忙碌时呼吸动画）
- 每个页面有一个「焦点区」（最核心组件）得到最精致的处理，其余克制

### 禁止
- 不用任何外部图片/字体 CDN（离线可开）
- 不用花哨渐变堆砌、不用霓虹色、不用 emoji 当图标
- 不做「另一个 Bootstrap 深色模板」—— 每个组件的间距/圆角/边框/阴影都要精心调过

## 交付
- 覆盖写 10 个页面（每页顶部注释更新为「V2 视觉重设计」）
- 更新 docs/mock/README.md：加一节「3.7 V2 视觉设计系统」描述新系统（排版/色彩/控件/间距/动效五表）
- 完成后回复：改动摘要 + 每页一句话视觉亮点 + 新的设计 token 表（CSS 变量清单）

先想清楚设计系统和 1-2 页（session-workspace、agent-detail）的视觉语言，再批量重写其余页面，保证全站一致性。