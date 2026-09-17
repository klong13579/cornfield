# Todo 页（`#/todo`）功能诊断与改进建议

- **采集环境**：前端 dev server `http://127.0.0.1:4173`（本仓库 HEAD 源码 + HMR）；后端 `ws://127.0.0.1:7891/ws`（无 token）；本连接焦点 Agent = `default`（空板）。
- **采集器**：`<repo>/.worktrees/_diag-harness/collect.ts`（每次自带一个 headless Chrome，并行安全）。
- **证据目录**：`docs/web-app-functional-diagnosis-2026-09-17/evidence/03-todo/`。
- **代码引用**：均为本 worktree 同提交源码（与 dev server 同一份），行号对应该文件。
- **写用例纪律**：唯一一次真实写入是闭环（创建 → 编辑 → 延期 → 完成 → 删除），收尾后 `agent-todos.json` 回到 `{"version":1,"todos":{}}`，删除后的截图与基线截图 **md5 逐字节相同**。

## 页面与入口

- **路由**：`packages/web-app/src/router.tsx:120-128` 注册 panel `id:"todo"` / `group:"capability"` / `order:3` / `path:"/todo"` / `mount: () => TodoView`。路由表由 panel 注册表派生（`router.tsx:206-213`），外壳是 `AppShell`（左 `AppSidebar` + 顶 `AppTopbar`，本面板未声明 `customTopbar`，`router.tsx:120-128`）。
- **入口**：左侧导航「能力」组下的「Todo」链接（`evidence/03-todo/todo.controls.txt:8`，`«Todo»`）；亦可深链 `#/todo` 直达。
- **组件树**：`TodoView`（`pages/todo/TodoView.tsx:579-603`）→ `ScopeHeading`（只读的 owner / 来源说明）+ `AgentTodoBoard`（`TodoView.tsx:128`）。纯逻辑在 `pages/todo/agent-todo-logic.ts`（无 DOM，可单测）。
- **数据源**：读 `list_agent_todos`（`state/session-store.ts:1540-1545`），**缺省目标 = 本连接当前焦点 Agent**（`lib/pi-client-api.ts:593` 注释、`state/pi-client-adapter.ts:694-696` 组帧时不带 `sessionId`）；存储自称 `<agentDir>/.cornfield/agent-todos.json`（`TodoView.tsx:596`）。
- **写命令**：`set_agent_todo` / `delete_agent_todo`，同样带 `this.#activeAgentId`（`session-store.ts:1450-1463`）。

## 实测链路

1. **页面加载（基线）**：`#/todo` → WS 握手（`connected` / `hello` / `hello_ack`）→ 4 条读命令 `list_projects`(req_1) / `list_agent_todos`(req_2) / `git_changes`(req_3) / `get_state`(req_4)。`list_agent_todos` 出站帧为 `{"type":"list_agent_todos","id":"req_2"}`（**不带 `sessionId`**），回包 `{"agentId":"default","todos":[]}`（`evidence/03-todo/todo.ws.txt:5,13`）。板子渲染：标题 `owner default`、筛选 `全部 0`、空态 `default 还没有长期任务。上面加一条。`（`evidence/03-todo/todo.dom.txt:7,9,13`）。console 无 error、无失败请求（`evidence/03-todo/todo.console.txt`、`todo.network.txt`）。
2. **控件快照**：整页 17 个可交互控件（13 个侧栏导航链接 + 「全部 0」筛选钮 + 标题输入框 + Project 绑定 `<select>` + 「添加」钮），**没有任何 Agent 选择控件**（`evidence/03-todo/todo.controls.txt`）。
3. **写闭环（真实写入，一次跑完）**：填标题 → 点「添加」→ `set_agent_todo` 建条（serve 回盖 `createdAt/updatedAt`）；点「编辑」改备注 → `set_agent_todo`；点「延期」→「明天」→ `set_agent_todo`（`dueAt`）；点复选框 → `set_agent_todo`（`status: completed`）；点「删除」→ `delete_agent_todo` 回 `{"deleted":true}`。每一步的 DOM 断言均为 `true`，末步断言 `!includes('T3-diag-write-loop')` 为 `true`（`evidence/03-todo/write-loop.steps.txt:12-40`、`write-loop.ws.txt:19-28`）。清场后 `agent-todos.json = {"version":1,"todos":{}}`，删除态截图与基线截图 md5 同为 `701df4c4e78c098753dc2f24d59d8e13`。
4. **禁用态点击**：标题为空时点「添加」→ `step 2 失败：… click: Timeout 8000ms exceeded`，`ws.txt` 里**没有** `set_agent_todo` 出站帧，console 无 error，板子不变（`evidence/03-todo/disabled-click.steps.txt:3`、`disabled-click.ws.txt`、`disabled-click.console.txt`）。
5. **三态 + 未连接态**：
   - **加载中**（`todos === undefined`）：渲染 `读取 Todo 板…`（`TodoView.tsx:227-229`）。仅在挂载 / 换 Agent 作废后的一个 WS 往返窗口内可见，本地环境抓不到该帧 —— 未截到图。
   - **空**（`todos.length === 0`）：渲染 `` `${owner} 还没有长期任务。上面加一条。` ``（`TodoView.tsx:288`）—— **已复现**（基线）。
   - **读不出来**（`view.agentTodosError`）：渲染 `ErrorBox`「Todo 板读不出来」+「重试」（`TodoView.tsx:217-226`，错误由 `session-store.ts:1548-1554` 的 catch 写入）—— **未复现**，原因见「未验证与存疑」。
   - **未连接**（`!view.connected`）：整块板子被替换为 `未连接 serve —— 连接后读取该 Agent 的 Todo 板。`，控件只剩 13 个侧栏链接（`TodoView.tsx:214-216`；`evidence/03-todo/state-disconnected.dom.txt:9`、`state-disconnected.controls.txt`）—— **已复现**（把 `--ws` 换成打不通的 `ws://127.0.0.1:9/ws`）。
6. **Project 绑定与筛选桶**：`list_projects` 回 `{"projects":[]}`（`todo.ws.txt:12`），本环境**没有声明任何 Project**。于是：绑定 `<select>` 可用但只有 `通用（不绑 Project）` 一个选项（`todo.controls.txt:16`）；筛选桶只有 `全部 0`（`todo.dom.txt:9`）；计数 `0 未完成 · 0 已完成`。Project 桶与绑定选项需有已声明 Project 才能验，见「未验证与存疑」。

**三条已定位现象的结论**（逐条复现，非复述）：**(a) 复现** —— 页面无 Agent 切换器；(b) **复现** —— 禁用态与可用态视觉/光标全同，且点它无任何出站帧与报错；(c) **复现** —— 板子读写都跟本连接焦点 Agent，页面内无换 Agent 的入口。

## 问题

- [P1] **现象**：Todo 页**没有 Agent 切换器**，板子只跟本连接焦点 Agent；要换 Agent 必须离开本页（去首页 / 工作台顶栏的 `AgentSwitcher`）切完再回来。(a)+(c) 复现。 / **证据**：`evidence/03-todo/todo.controls.txt`（17 个控件里无任何 Agent 选择控件，唯一 `<select>` 是 Project 绑定 `通用（不绑 Project）`）；`evidence/03-todo/todo.dom.txt:7`（owner 只有只读文字 `owner default`）；`evidence/03-todo/todo.ws.txt:5,13`（`list_agent_todos` 出站帧不带 `sessionId`，回包 `agentId:"default"`）；`evidence/03-todo/write-loop.ws.txt:19,21,23,25`（每条 `set_agent_todo` 载荷 `agentId` 恒为 `default`、帧上无 `sessionId`）。 / **根因**：`packages/web-app/src/pages/todo/TodoView.tsx:581` 与 `:141` 的 `const owner = view.activeAgentId ?? "default"` 把 owner 做成**只读投影**；`TodoView` 全文件不 import `AgentSwitcher`（`layout/AgentSwitcher.tsx:21` 是唯一实现），而它只在 `pages/home/HomeView.tsx:170` 与 `pages/workspace/WorkspaceView.tsx:220` 挂载；`state/pi-client-adapter.ts:695` 组帧 `{ type: "list_agent_todos", ...(sessionId ? { sessionId } : {}) }`，缺省即焦点（`lib/pi-client-api.ts:593`）；写命令同样带 `#activeAgentId`（`session-store.ts:1452,1460`）。 / **建议**：在 `ScopeHeading` 的 owner 处挂同一个 `AgentSwitcher`（复用 `store.focusAgent`，切完由 `session-store.ts:905` 的 `agentId !== this.#agentTodoKey` 自动作废重读，无需新增刷新逻辑）；或在 capability 组页面的通用顶栏提供全局 Agent 选择，避免每个页面各自决定「板子归谁」。

- [P1] **现象**：标题为空时「添加」按钮 `disabled`，但**外观、光标与可用态完全相同**；即使悬停也与可用态无差别（仍出现悬停高亮），点它没有任何反应（无出站帧、无 console 报错）。父报告的 `background:rgb(228,228,231)` 与本次静止态读数 `rgba(0,0,0,0)` 不矛盾 —— 那是**悬停态**背景（`.cbtn:hover` 取 `--color-surface-3` = `#e4e4e7` = `rgb(228,228,231)`，`index.css:14,624`）；两种读法都证明禁用/可用**无可见差异**。(b) 复现。 / **证据**：`evidence/03-todo/write-loop.steps.txt:3`（禁用态 `{"disabled":true,"bg":"rgba(0, 0, 0, 0)","color":"rgba(24, 24, 27, 0.5)","cursor":"pointer","opacity":"1"}`）与 `:8`（可用态逐项相同，仅 `disabled:false`）；`evidence/03-todo/write-loop-add-disabled.png`（md5 `701df4c4…`）vs `write-loop-add-enabled.png`（md5 `55e8d18d…`），视觉模型判定两张的「添加」钮**都是可用外观**，唯一差异在输入框内容；`evidence/03-todo/todo.controls.txt:17`（`button button DISABLED [1228,279 42x31] «添加»`）；`evidence/03-todo/disabled-click.steps.txt:3`（`click: Timeout 8000ms exceeded`）＋ `disabled-click.ws.txt`（无 `set_agent_todo` 出站帧）＋ `disabled-click.console.txt`（无 error）。 / **根因**：`pages/todo/TodoView.tsx:281` 用 `className="cbtn"` + `disabled={busy || title.trim() === ""}`，而 `src/index.css:610-629` 的 `.cbtn` **没有 `:disabled` 规则**，且 `:hover`（`index.css:623-626`）与 `:active`（`index.css:627-628`）都**不带 `:enabled` 门** —— 禁用钮照样是 `cursor: pointer`、照样有悬停高亮与按压缩放。文件里已有的禁用样式 `.btn:disabled`（`index.css:244-247`，`opacity:.5 / not-allowed`）与 `.icon-btn:disabled`（`index.css:765-769`）都不作用于 `.cbtn`；**同一页**的 Project 绑定 `<select>` 反而用了 `disabled:opacity-60`（`TodoView.tsx:271`），说明禁用态的表达在页内不统一。 / **建议**：给 `.cbtn` 补 `:disabled { opacity:.5; cursor:not-allowed; }` 并把 `:hover` / `:active` 限定为 `:not(:disabled)`（或统一改用已有的 `.btn` 类）；同时把「为什么点不了」明说（如 `title`/`aria-disabled` 提示「先填标题」，或空标题时把「添加」换成不可点的说明性文字）。

- [P2] **现象**：每条 Todo 的行内操作（编辑 / 延期 / 状态 / 删除）**静止态完全不可见**（`opacity:0`），只有鼠标悬停或键盘焦点进入才显形；用户扫一遍板子看不到这些操作存在。 / **证据**：`evidence/03-todo/write-loop-write-created.png`（视觉模型：行内可见文本仅 `T3-diag-write-loop` / `未开始` / `中` / `通用` / `来源 user`，**没有任何 `编辑`/`延期`/`开始`/`取消`/`删除` 按钮可见**），而同一次运行里这些按钮随后都能点中（`evidence/03-todo/write-loop.steps.txt:18,25,37` 分别为 `click @button=编辑` / `click @button=延期` / `click button[aria-label^='删除 …']`，均为 `→ ok`）。 / **根因**：`pages/todo/TodoView.tsx:339` 操作组 `className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"` —— 默认透明，仅靠 `group-hover` / `focus-within` 揭示。 / **建议**：至少给删除以外的操作留一个常显的锚（例如常显「⋯」更多菜单，或低对比度常显 + 悬停增强）；触屏 / 键盘用户在无 hover 场景下不应依赖悬停才能发现「能删」。

- [P3] **现象**：Project 绑定的**范围与禁用原因只写在 `title`（悬停提示）里**，正文不可见；registry 读不出来导致 `<select>` 被禁用时，用户看到的只是一个变淡的下拉，看不到原因。 / **证据**：`pages/todo/TodoView.tsx:272`（`title={bindingPickerHint(registry, view.agentTodoProjectIds, bindable.length)}`）与 `:76-88`（四种情况「未约束/已约束/读不出来/还没读到」各有一句话，但只进 `title`）；`:270`（`disabled={registry.state !== "loaded"}`）。 `evidence/03-todo/todo.controls.txt:16` 显示该 `<select>` 的实际文案只有 `通用（不绑 Project）`。 / **根因**：说明性文案挂在原生 `title` 上，属被动、不可扫读、触屏不可达的位置；禁用态的可见表达依赖 Tailwind 的 `disabled:opacity-60`（`TodoView.tsx:271`），但原因文本没有随状态下沉到正文。 / **建议**：把 `bindingPickerHint` 的结果渲染为选择器旁的常显小字（读不出来时用 danger 色），与 `ErrorBox` 同一套「读不到 ≠ 没有」的纪律在本页保持一致。

- [P3] **现象**：板子标题用 Agent **id**（`owner default`）而非其余页面统一的 Agent **name**；且本页不共用全应用的焦点解析器 `activeAgentIdOf`，而是 `view.activeAgentId ?? "default"` 硬编码兜底。在当前单 Agent 环境里两者恰好都解析为 `default`（**未观察到分歧**），属潜在不一致而非已复现缺陷。 / **证据**：`evidence/03-todo/owner-probe.steps.txt:3`（侧栏「当前 AGENT」=`default`，Todo 标题 `owner default`，两者当前一致）；代码 `pages/todo/TodoView.tsx:141,581`（`?? "default"`）对比 `state/agent-context.ts:25-32`（`activeAgentIdOf`：显式焦点 > 列表 active > attached > 首个）与 `layout/AppSidebar.tsx:43,53`（同源解析、显示 `agent.name`）。 / **根因**：焦点 Agent 的解析有两个来源 —— `agent-context` 的共用解析器（首页 / 工作台 / 侧栏 / 右栏）与 Todo 页的自定义 `?? "default"`。前者考虑 `view.agents`，后者在 `view.activeAgentId` 为空时**无条件返回 `default`**；当列表里的 active/attached 不是 `default` 时，本页会报出一个与侧栏不同的 owner（本例未触发）。 / **建议**：本页改用 `activeAgentIdOf(view)`（与 `HomeView`/`WorkspaceView` 同源），并在标题里显示 `activeAgentOf(view)?.name ?? id`，把「id 是存储归属、name 是展示名」的分工固定下来。

## 未验证与存疑

- **读不出来（`agentTodosError`）态未复现**。触发它需要让 `list_agent_todos` 报错（存储损坏 / 版本不符，见 `lib/pi-client-api.ts:592`）。当前 serve 已把该 Agent 的 todo store 读入内存并按写命令持久化，因此**只改盘上的 `agent-todos.json` 不会让下一次读报错**；可靠触发需要重启 serve —— 这是硬约束禁止的（`SIGKILL` / 非优雅重启会丢在途消息）。故该态只做了静态审查：`TodoView.tsx:217-226` 渲染 `ErrorBox`「Todo 板读不出来」+ 重试（`store.refreshAgentTodos()`，`session-store.ts:1439-1441`），并明确不显示空态。**待验证点**：ErrorBox 在真实损坏数据下的文案与重试是否恢复到最新状态。
- **加载中态未截到图**。`读取 Todo 板…`（`TodoView.tsx:227-229`）只在挂载 / 换 Agent 作废后（`#invalidateAgentTodos` 把 `view.agentTodos` 清空，`session-store.ts:1526-1537`）到响应回来之间出现；本地 WS 往返在毫秒级，采集器的 `--wait` 最小时已越过该窗口。**待验证点**：换 Agent 时该态是否可见、是否有骨架/防跳变处理。
- **Project 绑定与筛选桶只验到了「无 Project」分支**。本环境 `list_projects` 回 `{"projects":[]}`，因此无法验证：绑定下拉里出现多个 Project 的排序与命名；筛选桶里出现「通用」与各 Project 桶时的计数、`warning`（绑定了一个 registry 里查不到的 Project，`agent-todo-logic.ts:127-138`）与「查不到 / 读不出来」两种红标是否如注释所说互不顶替。**存疑**：`filterOptionsOf`（`agent-todo-logic.ts:170-191`）只给「板上实际出现过」的 Project 建桶，若一条绑了 Project 的任务被删光，该桶即消失 —— 与「上次筛选桶被 `useEffect` 重置为全部」（`TodoView.tsx:151-153`）的交互是否会让用户「筛选中桶凭空消失」，未实测。
- **`AgentTodoBoard` 与 `TodoView` 各自独立计算 owner**（`TodoView.tsx:141` 与 `:581`），两处 `?? "default"` 是同一份逻辑的两个副本。当前一致，但任何一处改动都需要同步另一处 —— 属维护风险，非当前缺陷。
- **`crypto.randomUUID()` 生成 id、客户端传 `createdAt/updatedAt: 0`**（`TodoView.tsx:193,200-201`）：实测 serve 已用真实时间戳回盖（`write-loop.ws.txt:20`），该分工正确；此处仅记录已核对。
- **键盘可达性未系统实测**：`Enter` 在标题框触发 `add()`（`TodoView.tsx:260-262`），空标题时 `add()` 直接 return（`:190-191`），即在空标题下按 Enter 也是静默无反应 —— 与问题 (b) 同类，未单独出证据。

## 复跑步骤

前置：dev server 已在 `4173`、后端 ws 在 `7891`（**不要自己起进程**）；每条命令自带 Chrome，可并行。

```bash
REPO=/Users/sz-0203015357/Desktop/Narwal/cornfield
OUT=$REPO/.worktrees/squad-webapp-diag-t3/docs/web-app-functional-diagnosis-2026-09-17/evidence/03-todo

# 0) 前置检查：前端 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/

# 1) 基线：空板 / 控件快照 / console / ws 帧（无步骤）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/todo' --out $OUT --name todo --view 1440x900

# 2) 禁用态 vs 可用态 + 写闭环（创建→编辑→延期→完成→删除；自动清场）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/todo' --out $OUT --name write-loop --view 1440x900 --steps $OUT/steps-write-loop.json

# 3) 禁用态点击（判据：Timeout 且 ws.txt 无 set_agent_todo 出站帧）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/todo' --out $OUT --name disabled-click --view 1440x900 --steps $OUT/steps-disabled-click.json

# 4) 未连接态（把 ws 换成打不通的端口）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/todo' --out $OUT --name state-disconnected --view 1440x900 --ws ws://127.0.0.1:9/ws --wait 2500

# 5) 侧栏 canonical owner vs 本页 owner 对照
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/todo' --out $OUT --name owner-probe --view 1440x900 --steps $OUT/steps-owner-probe.json
```

读证据（判据与本次一致）：

- 「点了没反应」= `.steps.txt` 该步 `失败：… Timeout` **且** `.ws.txt` 无对应出站帧（本次：`disabled-click.steps.txt:3` + `disabled-click.ws.txt`）。
- 「禁用了但看不出来」= `.controls.txt` 标 `DISABLED` **且** 截图与可用态无可辨差异（本次：`todo.controls.txt:17` + `write-loop-add-disabled.png` vs `write-loop-add-enabled.png`）。
- 写闭环清场验证：`/Users/sz-0203015357/.cornfield/agents/default/.cornfield/agent-todos.json` 应为 `{"version":1,"todos":{}}`；删除后的 `write-loop-write-deleted.png` 与基线 `todo.png` md5 应同为 `701df4c4e78c098753dc2f24d59d8e13`。

> 注意：步骤 2/3 会对焦点 Agent（`default`）的**真实** Todo 板写入；步骤 2 自带删除收尾。若中途失败导致残留，按标题前缀 `T3-diag-write-loop` 在页面上删除即可。
