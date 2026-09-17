# 全量问题清单（35 条）

> 从 `01-home.md`…`05-agents.md` 的「## 问题」小节机械提取（原文未改写，仅归类与排序）。
> 合计 **35 条**：P1×4 · P2×15 · P3×16。定级口径与风险提示见 `00-index.md`。

## 首页 `#/`（8 条：P2×4 / P3×4）

### 首页 1 · [P2]
- **现象**：中文输入法下在 composer 按 Enter 确认候选词会**直接把消息发出去**（未定稿的拼音/候选被当正文）。
- **证据**：`packages/web-app/src/pages/home/HomeView.tsx:236-238`；仓库内 grep `isComposing|compositionend` 无命中（同一模式也见 `packages/web-app/src/pages/workspace/ComposerBar.tsx:367`）。
- **根因**：`onKeyDown={e => { if (e.key === "Enter") send(); }}` 未排除 `e.nativeEvent.isComposing`（也未 `preventDefault`）。
- **建议**：改为 `if (e.key === "Enter" && !e.nativeEvent.isComposing) send();`。（本条为**静态代码判定**，headless 无法复现真实 IME，见「未验证与存疑」1。）

### 首页 2 · [P2]
- **现象**：区块标题「最近活跃」名不副实——展示的是**注册表前 3 个** agent，未按活跃度排序，且三张卡副标题**恒为「—」**。
- **证据**：`evidence/01-home/home.dom.txt:6-12`（Agent 选择器 7 个选项的完整顺序：default/hr/algorithm/me/dataAgent/sw/mcode）、`evidence/01-home/home.dom.txt:35-43`（最近活跃三卡正好是该顺序前 3 个，且副标题均跟「—」）、`evidence/01-home/home.controls.txt:24-26`（三卡文本 `«ddefault—»/«hhr—»/«aalgorithm—»`）；web-app 全仓 grep `lastAction` 仅出现在 `AgentDetailView.tsx:87,122` 与 `AgentsView.tsx:347`（都是展示，无排序）。
- **根因**：`packages/web-app/src/pages/home/HomeView.tsx:124` `const recent = view.agents.slice(0, 3);` 直接取注册表前 3 项，没有任何 recency 排序；`HomeView.tsx:308` 在 serve 未下发 `lastAction` 时渲染占位「—」。
- **建议**：按 `lastAction`（或 serve 的时间戳）倒序取前 N；无数据时把标题改成「最近注册」或隐藏该区块，别让「最近活跃」这个断言无据。

### 首页 3 · [P2]
- **现象**：390x844 视口下**左侧导航整体消失且无任何替代入口**（无汉堡/抽屉/底部 tab）。
- **证据**：`evidence/01-home/home-mobile.controls.txt:2-13`（12 个导航链接全部 `[0,0 0x0]`）、`evidence/01-home/home-mobile.png`（无侧栏、无汉堡，顶栏只有标题）。
- **根因**：`packages/web-app/src/layout/AppSidebar.tsx:21` `className="hidden w-[240px] … md:flex"`；`packages/web-app/src/layout/AppShell.tsx:20-34` 未提供 `<md` 的导航替代（`layout/` 目录 grep `md:hidden|hamburger|drawer` 无命中）。
- **建议**：给 `<md` 提供抽屉/汉堡（或底部 tab）。影响是**全站**，不止首页——移动端除首页自带链接外无法到达 /workspace、/settings 等。

### 首页 4 · [P2]
- **现象**：未连接态点「重试」后**页面无任何变化**，连接失败原因不上屏。
- **证据**：`evidence/01-home/home-disconnected.steps.txt:8-10`（点击后 2s，`main.innerText` 与点击前逐字相同）、`evidence/01-home/home-disconnected.console.txt:4-8`（5 次 `ERR_CONNECTION_REFUSED`）、`evidence/01-home/home-disconnected-after-retry.png`。
- **根因**：`packages/web-app/src/pages/home/HomeView.tsx:148-154` `onClick={() => void store.connect()}`——`void` 吞掉 `connect()` 的 rejection，失败既不写 `commandError` 也不改 UI；自动重连的失败只落 console。
- **建议**：重试加 pending 态，并在失败时把连接层原文（如「连接被拒绝：检查 WS URL」）上屏（复用既有 `view.commandError` 提示条）。

### 首页 5 · [P3]
- **现象**：390x844 视口下「最近活跃」三张卡不换行，第 3 张右缘超出视口被裁，且无可见横向滚动提示。
- **证据**：`evidence/01-home/home-mobile.controls.txt:24-26`（第 3 张 `[372,783 160x64]`，右缘 532 > 390）、`evidence/01-home/home-mobile.png`。
- **根因**：`packages/web-app/src/pages/home/HomeView.tsx:287` `<div className="flex gap-2.5">` 固定不换行 + 卡片 `min-w-[160px]`；外层 `HomeView.tsx:127` 为 `overflow-y-auto`（x 向计算为 auto，但无可见滚动条样式）。
- **建议**：`flex-wrap` 或横向可滚 + 明确滚动指示。

### 首页 6 · [P3]
- **现象**：未连接态「刷新项目列表」按钮**仍可点**，点击后界面无任何可见变化。
- **证据**：`evidence/01-home/home-disconnected.controls.txt:20`（该按钮未标 `DISABLED`）。
- **根因**：`packages/web-app/src/components/ProjectContext.tsx:148-158` 只要传了 `onRefresh` 就渲染刷新钮（首页恒传）；未连接时 `packages/web-app/src/state/session-store.ts:1264-1292` 把错误写进 `#projectsError`，但 `packages/web-app/src/lib/project-read-model.ts:55` 先判 `!connected` 返回 `disconnected`——错误文案被「未连接」态盖住，于是点击无可见结果。
- **建议**：未连接时禁用刷新钮（与其它禁用态一致），或让 `projectsError` 在 disconnected 态也透出。

### 首页 7 · [P3]
- **现象**：连接摘要行在无分支时留下空字段——DOM 文案为 `cf-ui-demo · · 7 agent 运行中 · 0 定时任务待执行`（连续两个分隔符），且未说明 `cf-ui-demo` 是仓库名还是工作目录。
- **证据**：`evidence/01-home/home.dom.txt:4`（视觉上两空格折叠成单个 `·`，见 `home.png`）。
- **根因**：`packages/web-app/src/pages/home/HomeView.tsx:141` `` `${view.env.repos} · ${view.env.branch} · …` `` 无条件拼接空字段。
- **建议**：`[repos, branch].filter(Boolean).join(" · ")`，或给两段加标签（仓库 / 分支）。

### 首页 8 · [P3]
- **现象**：未连接态 composer 的占位文案是「给**研发助手**发一条指令…」，指向一个注册表里并不存在的 agent。
- **证据**：`evidence/01-home/home-disconnected.controls.txt:17`（`ph="给研发助手发一条指令…"`）。
- **根因**：`packages/web-app/src/pages/home/HomeView.tsx:240` `` placeholder={agent ? `给 ${agent.name} 发一条指令…` : "给研发助手发一条指令…"} `` 的兜底写死一个具体名字。
- **建议**：兜底改中性文案（如「发一条指令…」），名字只从焦点 agent 取。

## 会话工作台 `#/workspace`（5 条：P1×1 / P2×2 / P3×2）

### 会话工作台 1 · [P1]
- **现象**：在输入框（textarea）粘贴图片**完全无反应**——不生成附件、不改草稿、不报错；这是「看起来能粘贴但没反应」。
- **证据**：`evidence/02-workspace/misc.steps.txt` step 3（textarea 的 React props：`onPaste:"undefined"`，`onChange/onInput/onKeyDown` 均为 function）与 step 5（派发含 `image/png` File 的合成 paste → `valueAfter:""`、`fileInputFiles:0`）；`evidence/02-workspace/misc.png`；源码 `packages/web-app/src/pages/workspace/ComposerBar.tsx:413-431`（textarea 只挂了 `onChange`/`onInput`/`onKeyDown`，无 `onPaste`）、`ComposerBar.tsx:177-190`（唯一入图路径 `onPickImages`）、`ComposerBar.tsx:516-523`（`accept="image/*"` 的隐藏 file input）。
- **根因**：入图只有「附件按钮 → 文件选择器」一条通道；textarea 未接 `onPaste`，也没有从 `clipboardData` 提取 `image/*` 的代码——浏览器对 textarea 的默认粘贴只处理文本，图片被静默丢弃。
- **建议**：给 textarea 加 `onPaste`，从 `e.clipboardData.items` 过滤 `item.type.startsWith("image/")` → `getAsFile()` → 复用 `onPickImages` 的 FileReader→base64 逻辑（抽成 `addImageFiles(files)`）；仅在确实取到图片时才 `preventDefault()`，纯文本粘贴保持默认不动。

### 会话工作台 2 · [P2]
- **现象**：模型下拉把「当前」徽标**同时打在两条 `deepseek-v4-flash` 上**（ALIBABA-CODING-PLAN 组一条、另一条在 NARWAL-PLAN 组），并把 alibaba 组置顶；而本会话实际生效的是 `narwal-plan/deepseek-v4-flash`——用户无法判断当前真正在跑哪个。
- **证据**：`evidence/02-workspace/modelmenu.steps.txt` step 6（`rowCount:381`，`badgedRows:["deepseek-v4-flash 当前","deepseek-v4-flash 当前"]`）、step 4（菜单文本中「当前」出现 2 次）、step 5（组 `NARWAL-PLAN 111`）；`evidence/02-workspace/send.ws.txt:19`（`get_available_models` 首条 `id=deepseek-v4-flash` 的 `provider=alibaba-coding-plan`）对比 `send.ws.txt:22`（`get_state` 的 `model.provider=narwal-plan`）；源码 `packages/web-app/src/state/session-store.ts:1800`（view 只存 `snapshot.model?.id`，丢弃 provider）、`ComposerBar.tsx:38` 与 `ComposerBar.tsx:273`（`modelList.find(m => m.id === currentModelId)?.provider` 取首个匹配）、`ComposerBar.tsx:607-611`（`m.id === view.model` 即渲染「当前」）。
- **根因**：视图层只保留 model id，provider 靠「列表里第一个同 id 项」反推；同一 id 存在于多个 provider 时（本环境 `deepseek-v4-flash` 同时在 alibaba-coding-plan 与 narwal-plan 下），置顶组、按钮 ProviderLogo、「当前」徽标三处都可能指向错的 provider。
- **建议**：把 provider 一并放进 view（`get_state` 已返回 `model.provider`），徽标/置顶/logo 改用 `(provider, id)` 双键比对；下拉行点击本已带 provider（`store.setModel(m.id, m.provider)`，`ComposerBar.tsx:599`），保持一致即可。

### 会话工作台 3 · [P2]
- **现象**：顶栏 `compact` 按钮一点即向服务端发 `{"type":"compact"}`，触发**当前会话的上下文压缩**（不是视图折叠）；按钮无二次确认、无影响说明，且左侧紧邻「手机预览 / 收起右栏」两个纯 UI 开关、右侧是「新会话」，极易被当成同类视图按钮误点。
- **证据**：源码 `packages/web-app/src/pages/workspace/WorkspaceView.tsx:257-259`（`onClick={() => store.compact()}`）、`packages/web-app/src/state/session-store.ts:494-496`、`packages/web-app/src/state/pi-client-adapter.ts:256-258`（`this.#req({ type: "compact" })`）、服务端 `packages/coding-agent/src/server/wire-server.ts:2194`（`case "compact": await session.compact(...)`）；控件位置 `evidence/02-workspace/workspace.controls.txt`（`button [1290,8 66x31] «compact»`，同行还有 `«手机预览»/«展开右栏»/«新会话»`）。
- **根因**：「压缩上下文」被归进了顶栏的**视图操作区**，命名沿用内部术语 compact，缺确认与后果说明。
- **建议**：至少补 `title`/确认并说明「会压缩本会话上下文」；更稳的是把它移出视图操作区（放进会话操作/更多菜单），或直接改名为「压缩上下文」。

### 会话工作台 4 · [P3]
- **现象**：模型下拉把**全部可用模型一次性平铺**（本环境 381 行；单组 alibaba-coding-plan 252、narwal-plan 111），组内不折叠、无搜索/过滤，只能在 `max-h-[46vh]` 的滚动区里翻找。
- **证据**：`evidence/02-workspace/modelmenu.steps.txt` step 6（`rowCount:381`）、step 5（组计数）、step 4（菜单文本 7685 字符）；`evidence/02-workspace/toolbar-model-menu.png`、`modelmenu.png`；源码 `ComposerBar.tsx:583-616`（`max-h-[46vh] overflow-y-auto` + 对 `modelGroups` 全量 `map`，无过滤输入）。
- **根因**：下拉只做了「按 provider 分组 + 当前 provider 置顶 + 容器滚动」，没有任何筛选维度（无搜索框、组头不可折叠、无「仅当前 provider」）。
- **建议**：加按 id/provider 子串的过滤输入框；组头可折叠；或默认只展开当前 provider 组。

### 会话工作台 5 · [P3]
- **现象**：`WorkspaceView` 顶部注释与实现不符——注释声称右栏已被移除。
- **证据**：`packages/web-app/src/pages/workspace/WorkspaceView.tsx:141-144`（「右栏已按用户决策移除，对话区占满全宽」）对比 `WorkspaceView.tsx:305`（实际 `<RightPanel collapsed={!ui.rightPanelOpen} />`）与 `RightPanel.tsx` 全文件。
- **根因**：右栏恢复后未回填注释。
- **建议**：按当前实现改写该注释（右栏存在、默认折叠、由顶栏按钮切换），避免下一个读者据此删错代码。

## Todo `#/todo`（5 条：P1×2 / P2×1 / P3×2）

### Todo 1 · [P1]
- **现象**：Todo 页**没有 Agent 切换器**，板子只跟本连接焦点 Agent；要换 Agent 必须离开本页（去首页 / 工作台顶栏的 `AgentSwitcher`）切完再回来。(a)+(c) 复现。
- **证据**：`evidence/03-todo/todo.controls.txt`（17 个控件里无任何 Agent 选择控件，唯一 `<select>` 是 Project 绑定 `通用（不绑 Project）`）；`evidence/03-todo/todo.dom.txt:7`（owner 只有只读文字 `owner default`）；`evidence/03-todo/todo.ws.txt:5,13`（`list_agent_todos` 出站帧不带 `sessionId`，回包 `agentId:"default"`）；`evidence/03-todo/write-loop.ws.txt:19,21,23,25`（每条 `set_agent_todo` 载荷 `agentId` 恒为 `default`、帧上无 `sessionId`）。
- **根因**：`packages/web-app/src/pages/todo/TodoView.tsx:581` 与 `:141` 的 `const owner = view.activeAgentId ?? "default"` 把 owner 做成**只读投影**；`TodoView` 全文件不 import `AgentSwitcher`（`layout/AgentSwitcher.tsx:21` 是唯一实现），而它只在 `pages/home/HomeView.tsx:170` 与 `pages/workspace/WorkspaceView.tsx:220` 挂载；`state/pi-client-adapter.ts:695` 组帧 `{ type: "list_agent_todos", ...(sessionId ? { sessionId } : {}) }`，缺省即焦点（`lib/pi-client-api.ts:593`）；写命令同样带 `#activeAgentId`（`session-store.ts:1452,1460`）。
- **建议**：在 `ScopeHeading` 的 owner 处挂同一个 `AgentSwitcher`（复用 `store.focusAgent`，切完由 `session-store.ts:905` 的 `agentId !== this.#agentTodoKey` 自动作废重读，无需新增刷新逻辑）；或在 capability 组页面的通用顶栏提供全局 Agent 选择，避免每个页面各自决定「板子归谁」。

### Todo 2 · [P1]
- **现象**：标题为空时「添加」按钮 `disabled`，但**外观、光标与可用态完全相同**；即使悬停也与可用态无差别（仍出现悬停高亮），点它没有任何反应（无出站帧、无 console 报错）。父报告的 `background:rgb(228,228,231)` 与本次静止态读数 `rgba(0,0,0,0)` 不矛盾 —— 那是**悬停态**背景（`.cbtn:hover` 取 `--color-surface-3` = `#e4e4e7` = `rgb(228,228,231)`，`index.css:14,624`）；两种读法都证明禁用/可用**无可见差异**。(b) 复现。
- **证据**：`evidence/03-todo/write-loop.steps.txt:3`（禁用态 `{"disabled":true,"bg":"rgba(0, 0, 0, 0)","color":"rgba(24, 24, 27, 0.5)","cursor":"pointer","opacity":"1"}`）与 `:8`（可用态逐项相同，仅 `disabled:false`）；`evidence/03-todo/write-loop-add-disabled.png`（md5 `701df4c4…`）vs `write-loop-add-enabled.png`（md5 `55e8d18d…`），视觉模型判定两张的「添加」钮**都是可用外观**，唯一差异在输入框内容；`evidence/03-todo/todo.controls.txt:17`（`button button DISABLED [1228,279 42x31] «添加»`）；`evidence/03-todo/disabled-click.steps.txt:3`（`click: Timeout 8000ms exceeded`）＋ `disabled-click.ws.txt`（无 `set_agent_todo` 出站帧）＋ `disabled-click.console.txt`（无 error）。
- **根因**：`pages/todo/TodoView.tsx:281` 用 `className="cbtn"` + `disabled={busy || title.trim() === ""}`，而 `src/index.css:610-629` 的 `.cbtn` **没有 `:disabled` 规则**，且 `:hover`（`index.css:623-626`）与 `:active`（`index.css:627-628`）都**不带 `:enabled` 门** —— 禁用钮照样是 `cursor: pointer`、照样有悬停高亮与按压缩放。文件里已有的禁用样式 `.btn:disabled`（`index.css:244-247`，`opacity:.5 / not-allowed`）与 `.icon-btn:disabled`（`index.css:765-769`）都不作用于 `.cbtn`；**同一页**的 Project 绑定 `<select>` 反而用了 `disabled:opacity-60`（`TodoView.tsx:271`），说明禁用态的表达在页内不统一。
- **建议**：给 `.cbtn` 补 `:disabled { opacity:.5; cursor:not-allowed; }` 并把 `:hover` / `:active` 限定为 `:not(:disabled)`（或统一改用已有的 `.btn` 类）；同时把「为什么点不了」明说（如 `title`/`aria-disabled` 提示「先填标题」，或空标题时把「添加」换成不可点的说明性文字）。

### Todo 3 · [P2]
- **现象**：每条 Todo 的行内操作（编辑 / 延期 / 状态 / 删除）**静止态完全不可见**（`opacity:0`），只有鼠标悬停或键盘焦点进入才显形；用户扫一遍板子看不到这些操作存在。
- **证据**：`evidence/03-todo/write-loop-write-created.png`（视觉模型：行内可见文本仅 `T3-diag-write-loop` / `未开始` / `中` / `通用` / `来源 user`，**没有任何 `编辑`/`延期`/`开始`/`取消`/`删除` 按钮可见**），而同一次运行里这些按钮随后都能点中（`evidence/03-todo/write-loop.steps.txt:18,25,37` 分别为 `click @button=编辑` / `click @button=延期` / `click button[aria-label^='删除 …']`，均为 `→ ok`）。
- **根因**：`pages/todo/TodoView.tsx:339` 操作组 `className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"` —— 默认透明，仅靠 `group-hover` / `focus-within` 揭示。
- **建议**：至少给删除以外的操作留一个常显的锚（例如常显「⋯」更多菜单，或低对比度常显 + 悬停增强）；触屏 / 键盘用户在无 hover 场景下不应依赖悬停才能发现「能删」。

### Todo 4 · [P3]
- **现象**：Project 绑定的**范围与禁用原因只写在 `title`（悬停提示）里**，正文不可见；registry 读不出来导致 `<select>` 被禁用时，用户看到的只是一个变淡的下拉，看不到原因。
- **证据**：`pages/todo/TodoView.tsx:272`（`title={bindingPickerHint(registry, view.agentTodoProjectIds, bindable.length)}`）与 `:76-88`（四种情况「未约束/已约束/读不出来/还没读到」各有一句话，但只进 `title`）；`:270`（`disabled={registry.state !== "loaded"}`）。 `evidence/03-todo/todo.controls.txt:16` 显示该 `<select>` 的实际文案只有 `通用（不绑 Project）`。
- **根因**：说明性文案挂在原生 `title` 上，属被动、不可扫读、触屏不可达的位置；禁用态的可见表达依赖 Tailwind 的 `disabled:opacity-60`（`TodoView.tsx:271`），但原因文本没有随状态下沉到正文。
- **建议**：把 `bindingPickerHint` 的结果渲染为选择器旁的常显小字（读不出来时用 danger 色），与 `ErrorBox` 同一套「读不到 ≠ 没有」的纪律在本页保持一致。

### Todo 5 · [P3]
- **现象**：板子标题用 Agent **id**（`owner default`）而非其余页面统一的 Agent **name**；且本页不共用全应用的焦点解析器 `activeAgentIdOf`，而是 `view.activeAgentId ?? "default"` 硬编码兜底。在当前单 Agent 环境里两者恰好都解析为 `default`（**未观察到分歧**），属潜在不一致而非已复现缺陷。
- **证据**：`evidence/03-todo/owner-probe.steps.txt:3`（侧栏「当前 AGENT」=`default`，Todo 标题 `owner default`，两者当前一致）；代码 `pages/todo/TodoView.tsx:141,581`（`?? "default"`）对比 `state/agent-context.ts:25-32`（`activeAgentIdOf`：显式焦点 > 列表 active > attached > 首个）与 `layout/AppSidebar.tsx:43,53`（同源解析、显示 `agent.name`）。
- **根因**：焦点 Agent 的解析有两个来源 —— `agent-context` 的共用解析器（首页 / 工作台 / 侧栏 / 右栏）与 Todo 页的自定义 `?? "default"`。前者考虑 `view.agents`，后者在 `view.activeAgentId` 为空时**无条件返回 `default`**；当列表里的 active/attached 不是 `default` 时，本页会报出一个与侧栏不同的 owner（本例未触发）。
- **建议**：本页改用 `activeAgentIdOf(view)`（与 `HomeView`/`WorkspaceView` 同源），并在标题里显示 `activeAgentOf(view)?.name ?? id`，把「id 是存储归属、name 是展示名」的分工固定下来。

## 设置 `#/settings`（8 条：P2×5 / P3×3）

### 设置 1 · [P2]
- **现象**：连接状态行永远显示 "connected"，没有「已断开」分支 /
- **证据**：`settings.dom.txt:5-6` 显示 `状态 → connected`；根因在 `packages/web-app/src/pages/settings/SettingsView.tsx:200-201` 的三元 `{view.reconnecting ? "重连中（指数退避）" : "connected"}` 把 `view.connected === false && !view.reconnecting`（初始未连 / 断线未进入重连）折叠进 "connected"，`conn-dot` 同步 `view.reconnecting ? "reconnecting" : ""`（同文件 200 行）导致断线时绿点也不变
- **根因**：状态渲染丢弃了 `view.connected`，只剩「重连中」与「connected」两态
- **建议**：改为三分支 `!view.connected ? (view.reconnecting ? "重连中（指数退避）" : "已断开") : "已连接"`，绿点加 warn 态。

### 设置 2 · [P2]
- **现象**：「检查更新」按钮在网页直开下点了没反应 /
- **证据**：`settings-checkupdate.steps.txt` step 2 `click @button=检查更新 → ok`，但 `settings-checkupdate.ws.txt` 点击后无任何出站帧，step 4 eval 返回按钮文字仍为 `"检查更新"`（未进入「检查中…」）；根因 `packages/web-app/src/pages/settings/SettingsView.tsx:116-129` 的 `checkUpdateNow` 依赖 `window.api.app.checkUpdate`，网页直开无 `window.api` 时静默 `return`，而按钮渲染（216-223 行）不区分是否有壳，始终可点
- **根因**：更新流是 Electron 壳专属能力，网页直开仍渲染可点按钮且无降级
- **建议**：无 `window.api.app.checkUpdate` 时禁用并给说明，或整行隐藏（与桌面壳版本「—」一致）。

### 设置 3 · [P2]
- **现象**：主题区是静态占位，无任何可交互控件 /
- **证据**：`settings.controls.txt`（35 控件）主题区无任何 button/input，`settings.dom.txt:27-31` 仅文本「颜色主题 亮色（V6）」「消息密度 紧凑」；根因 `packages/web-app/src/pages/settings/SettingsView.tsx:336-350` 用 `<span>` 硬编码「亮色（V6）」芯片与「紧凑」，无 toggle/radio
- **根因**：主题与消息密度功能未实现，渲染成看起来像设置、实则不可交互的静态文本
- **建议**：接线真实主题切换，或标注「即将上线」占位。

### 设置 4 · [P2]
- **现象**：钉钉集成区 AppKey/AppSecret 输入框禁用但无可见禁用态 /
- **证据**：`settings.controls.txt:31-32` 标 `input DISABLED`；`packages/web-app/src/pages/settings/SettingsView.tsx:446-448`（AppKey）与 `456-458`（AppSecret）的 `className` 与可用输入框同款（`bg-surface-2 border-hairline`），无 `disabled:` 变体；`packages/web-app/src/index.css` 全文件只有 `.btn:disabled`（244-247）与 `.chip > select:disabled`（346）两处 disabled 规则，没有 `input:disabled`
- **根因**：禁用态靠 placeholder 文案（「（配置存本地 gateway.json，编辑待接入）」/「••••••」）而非视觉样式区分，用户不读 placeholder 就不知道不可编辑
- **建议**：给禁用输入框加 `disabled:opacity-60 disabled:cursor-not-allowed` 或统一 `input:disabled` 样式。

### 设置 5 · [P2]
- **现象**：「保存并重连」会用空串覆盖已保存的 Token /
- **证据**：`packages/web-app/src/pages/settings/SettingsView.tsx:42` `useState("")` 使 Token 字段永不回显；`saveConnection`（84 行 `store.reconfigure({ wsUrl: url, token: token.trim() })`）以空串提交，`saveServeConfig`（`packages/web-app/src/state/pi-client-adapter.ts:144-150`）把 `token:""` 写进 `cornfield.serve.connection`；实测 `settings-reconnect.steps.txt` step 9 显示 localStorage 写成 `{"wsUrl":"…","token":""}`
- **根因**：Token 输入框不回显 + 提交时直接用空 state，用户只改 WS URL 也会顺带清掉 token（本环境 serve 无 token，故「清空已存 token」属代码推断）
- **建议**：初值从 `loadServeConfig().token` 读取（可掩码显示），或「保存并重连」保留原 token 除非用户显式修改。

### 设置 6 · [P3]
- **现象**：快捷键表含未实现的「Cmd+M 切换模型（TODO）」 /
- **证据**：`settings.dom.txt:39-40`、`packages/web-app/src/pages/settings/SettingsView.tsx:359` 硬编码 `["Cmd+M", "切换模型（TODO）"]`
- **根因**：TODO 占位直接展示给用户
- **建议**：实现 Cmd+M 切换模型，或移除该行，避免承诺不可用快捷键。

### 设置 7 · [P3]
- **现象**：「测试连接（TODO）」与「重置设置」两个禁用按钮，禁用原因只藏在悬停 title 里 /
- **证据**：`settings.controls.txt:33、35` 标 `button DISABLED`；`packages/web-app/src/pages/settings/SettingsView.tsx:463-470`（测试连接，`title="P3 gateway 只读状态代理接入"`）与 `491-498`（重置设置，`title="重置逻辑待定…"`）仅有 `title`，无可见文案；`.btn:disabled { opacity:0.5 }`（`index.css:244-247`）给了透明度但没给「为什么禁用」
- **根因**：禁用原因未渲染成可见文本
- **建议**：按钮旁渲染原因，或去掉 disabled 改成点击后提示「尚未开放」，避免只有悬停才知道。

### 设置 8 · [P3]
- **现象**：「保存并重连」成功无反馈，失败才有提示 /
- **证据**：`packages/web-app/src/pages/settings/SettingsView.tsx:76-88` `saveConnection` 仅 `setSaveError`；对比工作目录 `saveWorkspaceDir` 有 `workspaceSaved` → 显示「已保存」（90-105 行、328 行）
- **根因**：连接保存成功路径缺反馈状态
- **建议**：加成功态提示（如「已保存并重连」）。

## Agent 总览 `#/agents`（9 条：P1×1 / P2×3 / P3×5）

### Agent 1 · [P1]
- **现象**：同一 agent 的「停用」状态在列表页与详情页不一致：mcode 列表页红点「已停用」，详情页绿点「空闲」。
- **证据**：`agents-list.dom.txt` 中 mcode 卡片为「钉钉已停用 / 已停用」；`agents-detail-mcode-dt.dom.txt` 头部为「空闲 · 最近活跃 —」。
- **根因**：列表页 `AgentCard` 用 `isAccountStopped(agent)`（gateway 账号 `enabled:false` 或不在运行账号表）把状态点覆盖成红色「已停用」（`packages/web-app/src/pages/agents/AgentsView.tsx:104-108`、`:293-309`）；详情页 `AgentDetailView` 头部只认 `agent.status`（serve 快照里 mcode 仍是 `idle`），**不套用** gateway 停用覆盖（`packages/web-app/src/pages/agents/AgentDetailView.tsx:84-87` 与 `statusText` `:248-261`）。两处对「停用」用了不同判定，且只在一处覆盖。
- **建议**：把 `isAccountStopped` 抽成共享函数，列表卡片与详情头部用同一份判定；详情页停用时状态点也应显示红色「已停用」，或至少与列表同文案。

### Agent 2 · [P2]
- **现象**：状态语义错位：「运行中 / 空闲」不是「进程是否在跑」，而是「是否有连接聚焦此 agent」，且是**全部连接的并集**。
- **证据**：`serve-active-union.txt` —— 探针把自己的连接 `switch_session` 到 hr 后，`list_agents` 返回 **default 与 hr 同时 `active=true`**；`agents-list.dom.txt` 汇总「1 运行中」，但 `agents-list.ws.txt`/探针显示 7 个 agent **全部 `attached=true`**（serve 启动即预挂载）。
- **根因**：serve 的 `activeAgentIds()` 对所有 `targets`（连接）取 `getActiveAgentId()` 求并集（`packages/coding-agent/src/server/wire-server.ts:349-357`），`buildSessionList` 据此设 `active`（`session-registry.ts:383`）；前端 `mapAgentEntry` 把 `active` → `"online"`、`attached` → `"idle"`（`packages/web-app/src/state/pi-client-adapter.ts:1543`）。而 `AgentInfoDto.active` 的注释写「本连接焦点 agent」与实现不符（`packages/pi-wire/src/results/agents.ts:23-24`）。
- **建议**：要么把汇总与文案改成「聚焦中」这类准确措辞，要么在 serve 侧区分「进程运行态」（attached）与「连接焦点态」（active），避免把「7 个 agent 都在跑」显示成「1 运行中」。

### Agent 3 · [P2]
- **现象**：「工作区」分组/筛选失效：serve 从不输出 `role` 字段，所有 agent 恒落入「默认工作区」。
- **证据**：探针/`serve-active-union.txt` 中 7 个 agent 条目均无 `role`；`agents-list.dom.txt` 汇总「1 工作区」、主体只有一个「默认工作区 · 7 agents」分组。
- **根因**：`buildSessionList` 组装的 entry 只有 id/name/active/attached/agentDir/skillCount/dingtalk/…，**没设 `role`**（`session-registry.ts:380-388`）；前端 `workspace: s.role ?? "默认工作区"`（`pi-client-adapter.ts:1541`）于是恒定兜底。`SessionListEntry.role` 在 wire 层声明为「workspace.json role」（`packages/pi-wire/src/frames.ts:86-87`）但 serve 不填。
- **建议**：`buildSessionList` 补 `role`（读 workspace.json 的 role，与 `loadAgentMetas` 同源）；否则该筛选 seg 与分组标题应降级为单一「全部」，避免给用户一个永远只有一桶的「工作区」假分组。

### Agent 4 · [P2]
- **现象**：没有 detach 入口，也没有 agent 进程的启停入口；唯一「启停」是钉钉 tab 的账号 `enabled` 开关（写 gateway.json，非 agent 进程）。
- **证据**：前端 `PiClient` 接口只有 `attach()` / `switchSession()`，无 `detach()`（`packages/web-app/src/lib/pi-client-api.ts:520-523`）；serve 有 `detach` 命令（`wire-server.ts:668-688`）但全前端无调用点；「会话」按钮走 `store.focusAgent` = attach + switch（`AgentsView.tsx:263-266`）；钉钉 tab 的「启用」开关 → `store.setGatewayAccount`（`AgentDetailView.tsx:362`）。
- **根因**：产品面未提供 detach / agent 进程启停入口；「启停」一词被钉钉账号开关借用，容易让人以为能停掉 agent 进程。
- **建议**：如需进程级启停，补 wire 命令与 UI 入口；否则把钉钉 tab 的「启停与身份」标题改为「钉钉账号启停」，与 agent 进程语义脱钩。

### Agent 5 · [P3]
- **现象**：「已停用」筛选桶语义与卡片标签冲突：`AgentStatus."stopped"`（serve 未挂载）在卡片里渲染成「未挂载」，筛选按钮却标「已停用」。
- **证据**：`mapAgentEntry` 未 busy/active/attached 时给 `status:"stopped"`（`pi-client-adapter.ts:1543`）；`AgentCard.statusLabel` 没有 `agent.status === "stopped"` 分支，落到 else →「未挂载」（`AgentsView.tsx:301-309`）；筛选按钮「已停用」对应 `statusFilter === "stopped"`（`AgentsView.tsx:176-183`）。当前实测 7 个 agent 全部预挂载，`attached` 恒 true，此路径仅在预挂载失败时才可见。
- **根因**：两套「stopped」共用一个词——gateway 账号停用（红色「已停用」）与 serve 未挂载（灰色「未挂载」），筛选 UI 把它们并进同一个桶。
- **建议**：`AgentStatus` 的 `"stopped"` 改为 `"unmounted"` 或让卡片为它补一个明确的「未挂载」分支，筛选标签与卡片文案对齐。

### Agent 6 · [P3]
- **现象**：列表页挂载即发 `list_agents`，与 WS 连接竞态，产生 4 条带完整堆栈的 console warning（`PiDisconnectedError`）。
- **证据**：`agents-list.console.txt` 与 `agents-interact.console.txt` 各有 4 条 `Cannot send "list_agents": not open (status=connecting)` + 堆栈。
- **根因**：`AgentsView.tsx:67-69` 的 `useEffect` 挂载即 `store.fetchAgents()`，而此刻 WS 未 open，`listAgents()` 抛 `PiDisconnectedError`（`pi-client-adapter.ts:528-542` 的 catch 里 `console.warn`），session-store 侧又记一次。列表最终靠 `server_snapshot` 推送恢复，这轮 `list_agents` 是白发且刷屏。
- **建议**：`fetchAgents` 在 `view.connected` 就绪后再发（与详情页各 tab 的 `if (!view.connected) return` 同款守卫），或让 `listAgents` 在未连接时静默返回空而不是 warn。

### Agent 7 · [P3]
- **现象**：卡片 footer 的「定时任务」数量与「最近活跃」是死字段：serve 从不提供 `cronCount` / `lastAction`，永不渲染。
- **证据**：`mapAgentEntry` 未设 `cronCount` / `lastAction`（`pi-client-adapter.ts:1537-1552`），`SessionEntryLike` 也无这两字段（`:1520-1532`）；`agents-list.dom.txt` 卡片 footer 只有模型 + 「N 技能」，无「定时任务 / 最近活跃」。
- **根因**：`AgentsView.tsx:344-347` 渲染 `agent.cronCount` / `agent.lastAction`，但 wire 层没有数据源。
- **建议**：要么补 serve 侧的 cronCount/lastAction 字段，要么删掉这两行渲染，别留一个永远不出现的位。

### Agent 8 · [P3]
- **现象**：未知 agent 深链（`#/agents/does-not-exist`）降级可用，但模型徽标显示焦点 agent 的模型，可能误读为该 agent 存在且有模型。
- **证据**：`agents-unknown.dom.txt` 头部「未知 Agent」+ 模型徽标「deepseek-v4-flash」+「会话未注册」；`agents-unknown.console.txt` 报 `get_skills` unknown agent 但页面不崩。
- **根因**：`AgentDetailView.tsx:76` `currentModel = agent?.model ?? view.model ?? ""` —— 未知 agent 回落到 `view.model`（本连接焦点 default 的模型）。
- **建议**：未知 agent 时徽标显示「—」或不显示，不回落焦点模型。

### Agent 9 · [P3]
- **现象**：钉钉 tab 的「启用」「隐藏思考块」开关无文字态，on/off 仅靠 CSS 色块区分（[inference]，未做 on/off 截图对比）。
- **证据**：`agents-detail-mcode-dt.controls.txt` 两个 toggle 按钮的文本为空（`role="switch"` 无 aria-label 无文字）。
- **根因**：`AgentDetailView.tsx:409-415`、`:447-453` 的开关是 `className="toggle ${enabled ? "on" : ""}"` 的空按钮，状态不落文字。
- **建议**：开关加 `aria-label`（如「启用钉钉账号：开/关」）或相邻文本态，避免色弱/截图上无法判断。
