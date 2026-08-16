# V4 追加需求（优先级最高，V3 README 完成后立即执行）

用户新增三项需求，全部要落地到 mock。先读本文件，再动工。

## 调研结论（可复用的行业模式）

欢迎页/起始页的行业标准（assistant-ui EmptyState 官方组件，被 OpenAI/ChatGPT 类产品广泛采用）：

```
EmptyState（居中、max-w 适中、flex-col、gap 7）
 ├── Greeting     ← 问候语（大标题，text-2xl，入场 fade-in + slide-up 500ms）
 ├── Suggestions  ← 3-5 个建议入口（pill 按钮，错峰入场：120ms + index*70ms 延迟）
 └── Composer     ← 输入框居中（最后入场，360ms 延迟；圆角胶囊，右侧 send 圆形按钮）
```

入场动画：全部 fade-in + slide-in-from-bottom，staggered（问候 → 建议 → 输入框），`motion-reduce` 关动画。
建议 pill：`rounded-full px-4 py-2 text-13px`，hover 上移 1px，active 缩放 0.96。
这个模式直接用于 V4 的 Home 页。

## 需求 1 · Home 欢迎页（新增首页，作为默认起始页）

`pages/home.html`：
- 问候语：时间感问候 + 使用者名字 —— `下午好，彭梦龙`（mock 数据；注释注明「名字未来来自 user profile，由 pi-client 提供」）
- 副标题一行（tertiary 色）：说明当前环境（项目/agent 状态摘要）
- 3-5 个建议入口（pill）：例如「检查今天的定时任务」「最近会话回顾」「语音记录一条指令」「切换模型」「打开 Agent 管理」—— 点击跳对应页面
- 居中 Composer（复用 EmptyState 模式）：输入直达会话工作台（模拟跳转 session-workspace.html）
- 次要区（下方小卡片）：最近活跃 agent（2-3 个，名字/状态/最近操作）
- 视觉：延续你 V3 定下的设计 token 系统，staggered 入场动画全套

## 需求 2 · 基础框架（可修改扩展）

- 所有页面统一 app-shell 结构：56px 图标侧栏（数据驱动：`.nav` 数组在每页顶部 `<script>` 里，加页面 = 数组加一项）+ 顶栏（面包屑/页面操作）+ 内容区
- **页面注册约定**：每页 HTML 头部注释块写清楚：页面名、路由路径（如 `#/home`）、导航分组、依赖的协议命令 —— 未来前端框架按这个注释块映射（「新页面 = 复制壳 + 注释块 + 导航数组 +1」）
- README 加一节「4. 前端框架映射」：说明 mock 结构 → 未来 React 组件/路由的对应关系（app-shell → Layout、页面注释块 → route config、nav 数组 → 菜单注册表）

## 需求 3 · 右上角手机版预览

- 每个桌面页面右上角加「预览手机」按钮（icon + 文字）
- 点击后：页面右侧滑出 **iPhone 模拟器面板**（375×812 设备框：圆角 40px、状态栏、home indicator；overlay 面板 + 阴影，可关闭）
- 模拟器内容：`iframe` 加载 `mobile-session.html`（同源文件，直接可用）—— 即「当前功能在手机上的样子」
- 交互：打开/关闭按钮、遮罩点击关闭、面板顶部显示「移动端预览 · 375×812」标签
- 桌面页与移动页已共用 V3 视觉系统，保证预览观感一致

## 约束

- 延续 V3 设计 token（你的 token 表为准），不得回退
- 纯 HTML + CSS + 原生 JS，离线可开，不引外部资源
- 更新 README：页面索引加 home 页 + 新增「4. 前端框架映射」节
- 完成后回复：三件事分别做了什么 + home 页一句话亮点 + 框架映射说明