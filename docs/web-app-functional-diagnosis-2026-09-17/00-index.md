# web-app 功能诊断 · 索引与跨页共性问题

> 这一轮的对象：`packages/web-app`（CornField 多端前端），服务端为本仓库源码起的 `cornfield serve`。
> 执行方式：squad `squad-20260917-webapp-diag`，5 路并行（首页 / 会话工作台 / Todo / 设置 / Agent 总览），
> 每路自起 headless Chrome，共用同一套真环境。本文件由父（编排者）维护，各页正文在其同级 `NN-*.md`。

## 方法与判据（可复跑）

| 项 | 值 |
|---|---|
| 前端 | `http://127.0.0.1:4173` —— `packages/web-app` 的 **vite dev server**（cwd = 本仓库 `packages/web-app`，服务 HEAD 源码，非构建产物） |
| 后端 | `ws://127.0.0.1:7891/ws`（`bun packages/coding-agent/src/cli.ts serve`，无 token） |
| 采集器 | `.worktrees/_diag-harness/collect.ts`（每路自己 launch 一个 headless Chrome；产出 png / dom / **controls** / console / network / **WebSocket 帧** / 每步结果 / summary） |
| 视口 | 1440x900 + 390x844 各一遍 |

判据（两条，缺一不可）：

1. **「点了没反应」** = 该步记录为 `失败：… Timeout` **且** WebSocket 帧里没有对应出站命令。只有前者 = 选择器写错；只有后者 = 命令发了但界面没跟上。
2. **「禁用了但看不出来」** = `controls` 里该控件标 `DISABLED`，且截图/计算样式与可用态**无可见差异**。

## 跨页共性问题（父侧独立取证，非单页归属）

### X1 · `.cbtn` 没有禁用态样式 → 全站此类按钮「看着能点、点了没反应」【P1】

- `src/index.css`：`.btn:disabled{opacity:.5;cursor:not-allowed}`（244-247）、`.icon-btn:disabled{opacity:.4;cursor:not-allowed}`（765-768）、`.chip > select:disabled`（346-348）都在，**唯独 `.cbtn` 没有 `:disabled`**（`.cbtn` 块 610-629 只有 `:hover`/`:active`）。
- 实测（1440x900，Todo 页；两路独立取证，结论一致）：空标题时「添加」`disabled=true`，填入标题后 `disabled=false`，**静止态计算样式逐项相同**（`background rgba(0,0,0,0)` / `color rgba(24,24,27,0.5)` / `cursor: pointer` / `opacity: 1`，仅 `disabled` 布尔不同）；点击 `btn.click()` → **出站帧 0 → 0**、console 0 行、页面无提示。证据：`03-todo/write-loop.steps.txt:3,8`、`03-todo/disabled-click.steps.txt:3`、`03-todo/write-loop-add-disabled.png` vs `write-loop-add-enabled.png`。
- **口径更正**：父第一次读数里的 `background rgb(228,228,231)` 实际是**悬停态**背景（`.cbtn:hover` → `--color-surface-3` = `#e4e4e7`，`index.css:14,624`），不是静止态 —— 已按 T3 的静止态取值替换，两种读法都指向同一结论（禁用/可用无可见差异）。
- **更硬的一层根因（T3 找到，父未验前不知道）**：`.cbtn:hover`（`index.css:623-626`）与 `.cbtn:active`（627-628）**都没有 `:enabled` / `:not(:disabled)` 门** —— 所以禁用钮不但长得一样，还会响应悬停高亮与按压缩放，比“没样式”更容易骗人。
- 暴露面（父逐个核实「`.cbtn` + 同元素 `disabled`」，非“文件里出现过 cbtn”）：`pages/todo/TodoView.tsx:281`（添加）`:418`（收起）`:515`（取消）及多行写法的 `:342-343`（编辑）`:358-359`（延期）；`pages/workspace/SessionTree.tsx:243`（委派子会话）；`layout/ProjectSwitcher.tsx:214`（声明）`:236-237`（删除）；`pages/records/PlaybackView.tsx:164-167`（快退/快进）；`pages/memory/MemoryView.tsx:92-94`（重读记忆投影）。
- **同族变体（T4 在设置页找到，根因不在 `.cbtn`）**：钉钉 AppKey/AppSecret 输入框 `disabled` 但无可见禁用态（`evidence/04-settings/settings.controls.txt`）—— 同一个病（“禁用了但看不出来”），病因在输入框类样式上。修 `.cbtn` 时顺手把这一族一起收。
- **不在本条内的（父已核，防过度归因）**：`pages/workspace/ComposerBar.tsx` / `SessionSidebar.tsx` / `components/ProjectContext.tsx` 的 `.cbtn` 按扭**没有 `disabled` 属性**；工作台发送键反而是另一种形态：内联 `bg-accent` 样式、**无 disabled**，空草稿时靠 `send()` 的 `if (!text) return`（`ComposerBar.tsx:318`）静默返回 —— 属“启用外观 + 点了无事”，与 X1 不同源，但同属“无反应”家族，建议一并给禁用态或给提示。
- 建议：`index.css` 给 `.cbtn` 补 `:disabled`（与 `.btn` 对齐），并把 `.cbtn:hover` 收窄为 `:not(:disabled)`。

### X2 · 页面级 Agent 归属只跟「本连接焦点」，多数页面没有切换入口【P1】

- `AgentSwitcher` 只挂 `pages/home/HomeView.tsx:170` 与 `pages/workspace/WorkspaceView.tsx:220`。
- 其余面板（Todo / Memory / Skills / 记录 …）读 `activeAgentIdOf(view)`，页面上换不了人；Todo 页实测 `owner default`，板子由 `list_agent_todos`（不带点名 = 焦点 agent）决定。
- 建议：把 Agent 选择器提到 `AppShell` 的通用顶栏（`layout/AppTopbar.tsx` 目前只有标题），或在读取 Agent 域数据的面板各挂一个轻量选择器。

### X3 · 对话窗口粘贴图片无处理【P1】

- `pages/workspace/ComposerBar.tsx`：附件只有 `<input type="file" accept="image/*" multiple>`（517-523）+ `onPickImages` → base64 → `prompt.images`；**全文无 paste 处理**，textarea 的 `onKeyDown`（342-430）只处理 Enter/Shift+Enter/Esc/slash 菜单。
- 建议：抽一个 `File → ImageContentDto` 函数给两条入口共用；paste 仅在剪贴板含 `image/*` 时 `preventDefault`，纯文本粘贴保持默认行为。

### X4 · 窄屏（<768px）在非工作台页面**无法导航**【P1】

- `layout/AppSidebar.tsx:21`：主侧栏 `hidden … md:flex` —— <768px `display:none`；唯一的抽屉开关在 `pages/workspace/WorkspaceView.tsx:205-210`（`cbtn lg:hidden` + `setMobileNav`），抽屉本体是 `SessionSidebar`（会话侧栏，不是主导航）。
- 实测（390x844，`#/`）：`nav[aria-label="主导航"]` → `display: none`、宽 0；全页匹配 `导航|菜单|menu` 的可点元素 → **0 个**。
- 结论：手机上只要不在 `/workspace`，记录 / Agent / Skills / Memory / Todo / 模型 / 语音 / 定时任务 / 用量 / 设置 **一个都到不了**。
- 建议：把主导航抽屉开关提到 `AppShell`（所有面板共用），或窄屏给侧栏一个图标条形态。

## 每页摘要

| 页 | 正文 | 问题数 P0/P1/P2/P3 | 一句话结论 |
|---|---|---|---|
| 首页 `/` | `01-home.md` | 0 / 0 / 4 / 4 | 首屏干净无异常；问题集中在中文输入法边界（Enter 直发）、区块命名不实（「最近活跃」实为注册表前 3）、窄屏无导航、断连态无反馈 |
| 会话工作台 `/workspace` | `02-workspace.md` | 0 / 1 / 2 / 2 | 图片粘贴无通道（无反应也无报错）；模型下拉「当前」徽标同时打在两条模型上；**compact 一点即真发压缩命令（无确认、混在视图操作区）**；模型列表 381 行平铺；注释与实现不符 |
| Todo `/todo` | `03-todo.md` | 0 / 2 / 1 / 2 | 板子归属不可选（只能跟焦点 Agent）、禁用态不可辨、**行内操作靠 hover 触发（触屏不可达）** |
| 设置 `/settings` | `04-settings.md` | 0 / 0 / 5 / 3 | 状态行恒称 `connected`（无「已断开」分支）；**「保存并重连」会用空串覆盖已存 Token**（数据丢失）；主题区是静态占位；钉钉凭据输入框禁用但无可见禁用态；「检查更新」网页直开点了没反应 |
| Agent 总览 `/agents` | `05-agents.md` | 0 / 1 / 3 / 5 | **同一 agent 的「停用」在列表页（红·已停用）与详情页（绿·空闲）判定不一**；「运行中/空闲」实为连接焦点并集，不能读成进程状态；「工作区」分组失效（serve 不输出 `role`）；无 detach / 进程启停入口；卡片「定时任务」「最近活跃」是死字段；挂载即发 `list_agents` 与 WS 竞态产生 4 条带堆栈的 console warning |

> 行内「问题数」由父从各页正文统计（`- [P?]` 计数）；P0 = 阻断／数据风险，P1 = 功能不可达或误导，P2 = 体验/正确性缺陷，P3 = 打磨项。
>
> **定级张力（父保留 worker 原级，但显式提出）**：设置页「保存并重连」用空串覆盖已存 Token（`04-settings.md`，T4 定 P2）—— 按上口径属**数据丢失**，父认为应高于 P2（至少 P1）；同类还有工作台 compact 一点即真发压缩（T2 定 P2）。两条请按你的风险偏好重新定级，不要沿用原标。

## 已定位并复现的三条（用户报告，父已独立验证）

1. **Todo 页看不到每个 agent 的 todo** —— 结构性的，见 X2 及其 `03-todo.md`。
2. **Todo 页点「添加」没反应** —— 见 X1；空标题时按钮 `disabled` 且外观与可用态像素级相同，点击零帧、零提示、console 无报错。
3. **对话窗口不能粘贴图片** —— 见 X3。
