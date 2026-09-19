# Changelog

## [Unreleased]

### Changed

- **会话侧栏按 Agent 折叠（默认全折叠）**（`src/pages/workspace/SessionSidebar.tsx`, `test/session-sidebar-collapse.test.ts`）：default 一个 Agent 就 800+ 个会话文件，之前进工作台是一次把 100 行全铺开。现在组头是折叠开关（`aria-expanded` + `aria-controls` 指到行容器，ChevronRight/ChevronDown），默认**全折叠**、折叠态不持久化（与「当前计划」条同款约定）；pin 过的行**搬**进一个恒展开的「置顶」组（不是复制 —— 否则折叠一上来就把 pin 的东西藏了，pin 等于废掉）；过滤时各组合并展开且组头退回纯标题（过滤已经剔掉了不命中的行，命中却藏在折叠里等于没命中；此刻点折叠没有意义，就不画那个按钮，但箭头照画，免得整个列表左移一档）。「当前会话」与「置顶」不给折叠位（当前会话恒 1 行；一个点了没用的箭头比没有它更坏），且「当前会话」永远排第一 —— 那一行是回实时的唯一入口，不许被置顶组顶下去。回归：`test/session-sidebar-collapse.test.ts`（拆 pin、默认折叠、三支展开规则、组头静态渲染、组序）。

- **会话工作台去掉「WebUI 会话 / CLI 会话」双源 tab，统一按 Agent 分组**（`src/pages/workspace/SessionSidebar.tsx`, `src/lib/records.ts`, `test/session-sidebar-groups.test.ts`, `test/session-sidebar-current-row.test.ts`）：那两个 tab 是按 `list_sessions[].source` 分的，而 serve 侧这个字段是按 agentId 判的（`source: m.id === "default" ? "cli" : "agent"`）—— 于是 `default` 这个正常注册、还能被 WebUI 聚焦建会话的 Agent，在**默认打开的**「WebUI 会话」tab 里一个组头都没有，它的会话全躺在另一个 tab 里；CLI 那个 tab 又按 `projectId` 分组，所以整个工作台里没有任何一个组头写着 default，用户看到的现象就是「default 的会话不显示」。现在只有一根轴：**谁在服务这条会话**（组头跟着组内最新一行，pin 置顶/时间倒序排过的行序不被重排；当前会话仍单独置顶，key 为 `current`，Agent 叫 current 也不会撞组）。行的副标题不再重复 Agent 名（它就是该行的组头），改放会话自己记下的 Project 显示名 + 条数 —— 归属没有丢，只是从分组轴退到行上（没记过就不写，不拿目录名冒充一个 Project）。`source` 字段与 serve 侧一行未改：用量页的「来源」行仍在读它。

- **工作台「当前计划」默认折叠，且几何与会话框对齐**（`src/pages/workspace/WorkspaceView.tsx`）：计划条此前恒展开，本会话跑出 14 条任务就一直占着输入区上方约 200px；现在默认折叠，表头留「完成 x/y · 放弃 n」的读数与展开入口（`aria-expanded` + `aria-controls`），折叠态由工作台持有、**不持久化**（每次进工作台都从折叠开始）。`phases` 之外的三种态（未连接 / 快照未到 / 确实没有计划）本来就只有一行文案，不给它们画折叠控件 —— 一个点了没用的箭头比没有它更坏。同时它的宽度从自成一档的 `max-w-[760px]` 收到与转录列同一段（外层 `px-6` + 内层 `max-w-[1100px]`）：1440 视口下左边缘曾比会话框窄 170px。回归：`src/pages/workspace/WorkspaceView.plan-strip.render.test.ts`（默认折叠那一眼 + 与 Transcript 同款几何）、`test/app-shell-nav.test.ts` 的「当前计划区域」（折叠/展开两态、表头是唯一入口、三种无计划态不画控件）。

- **Prompts 源不再列 `TODO.md`**（`src/pages/agents/AgentDetailView.tsx`, `test/e2e/agent-dashboard.spec.ts`）：serve 侧 `AGENT_DIR_PROMPT_FILES` 把 `TODO.md` 移出 prompt 面（它退出注入流程，改为历史留档），清单随真源从 8 项变 7 项。前端照渲染 serve 给的清单，只改了一份独立核对用的字面量与一处已过时的注释。

### Added

- **会话右键快速改名**（`src/pages/workspace/SessionSidebar.tsx`, `src/lib/pi-client-api.ts`, `src/state/pi-client-adapter.ts`, `src/state/session-store.ts`, `test/session-rename.test.ts`, `test/pi-client-adapter-rename.test.ts`）：会话列表里一条会话的名字此前只能回 CLI 敲 `/rename`（而且只改得动当前那条）。现在行上右键弹 `role="menu"` 菜单（Esc / 点外部 / 滚动关闭，位置贴光标且夹在视口内），选「重命名」就地改名（Enter 提交 / Esc 取消 / 失焦取消，空名不发命令、输入框原地留着）。按身份分流：**当前会话**那一行走 `set_session_name`（它的 id 是附件地址），**历史会话**行走新增的 `rename_session`（按会话文件定位）；`sessionFile` 缺失时菜单项 disabled 并写出原因——不画一个点了没反应的项。成功后重跑侧栏既有那条 `listSessions` 读刷新列表（不另立列表状态），失败把 serve 原文落到侧栏错误条，不吞。真浏览器实测：右键 → 改名 → 盘上会话头 `title` 变了且 `titleSource: "user"`，其余行逐字未动。

- **右栏「产物」同时列出「agent 写出的文件」与「你贴进来的图」**（`src/pages/workspace/ArtifactsPanel.tsx`, `src/pages/workspace/ArtifactsPanel.render.test.ts`）：这本账此前只有一个来源（会话 JSONL 里 write / edit / puppeteer screenshot 写出的文件），而用户贴的图落在会话 artifacts 目录的 `uploads/`、**不来自任何工具调用** —— 于是它永远不出现在面板里。现在每条产物带 `source`（`agent` / `user`），行上各有标记（「我发的」/「agent」），点开仍旧走 `/preview`（那条路由没改：上传目录在 agentDir 这个根内）。空态文案随之改成「agent 写出的文件、以及你贴进来的图，都会出现在这里」。回归：`ArtifactsPanel.render.test.ts` 的「ArtifactRow 来源与类型标记」。

- **输入区附件显示缩略图，可单张移除**（`src/pages/workspace/ComposerBar.tsx`, `src/lib/format-size.ts`, `src/pages/workspace/ArtifactsPanel.tsx`, `src/pages/workspace/FileExplorer.tsx`）：粘贴/选中图片后此前只有回形针按钮上一个数字角标——用户认不出贴进来的是哪张、也撕不掉贴错的那一张。现在输入区（textarea 上方）直接渲染 48px 缩略图，每张带一个压在右上角的 ×，整组可「清空」；角标不再重复表达「有几张」。同时把 `reader.onerror` 从静默吞掉改为可见提示（读失败时角标不涨，用户会以为是自己没贴上去）。字节数写精确值（base64 按 3/4 折算后减 padding），显示在缩略图 title 上；`fmtSize` 从「产物面板 / 文件树各一份」收口成 `src/lib/format-size.ts` 一份（三处共用）。回归：`src/pages/workspace/ComposerBar.attachment-thumb.render.test.ts`（静态渲染 + 字节边界）、`test/e2e/composer-paste-image.spec.ts`（真浏览器合成 paste → 缩略图 → 单张移除，含 48×48 尺寸断言）。
- **项目文件夹选择：桌面壳原生选择器 + 本机用过的路径候选**（`src/components/PathField.tsx`, `src/lib/desktop-bridge.ts`, `src/lib/recent-paths.ts`, `src/layout/ProjectSwitcher.tsx`, `src/pages/settings/SettingsView.tsx`）：Project 声明面板的 root 与设置页的「工作目录」此前都是纯文本框，只能手打绝对路径（设计上要求的「文件夹浏览器」一直没做）。现在两处共用一个 `PathField`：有桌面壳时给「浏览…」按钮走系统原生选择器（**没有壳就不画这个按钮** —— 浏览器直开画一个点了没反应的按钮比没有它更坏），候选里挂本机用过的路径（datalist，仍可自由输入）；声明成功后才记，记的是 serve 回的那一份（root 已 `path.resolve` 过）而不是输入框里的原文。候选去重在产出那一方（`rootCandidates`：已声明项目的 root 在前、用过的在后），渲染层原样照画 —— 渲染层默默改掉给它的东西就是一次看不见的输入丢弃。`window.api` 的形状此前只写在 `SettingsView` 里，现在收口到 `lib/desktop-bridge.ts` 一处（含「没有壳」判定与 `directoryPicker()` 的接收者绑定）。取消选择不写回任何值；选择器失败把原文交回调用方唯一的错误界面（含旧壳没有该方法的报错）。回归：`test/recent-paths.test.ts`、`test/desktop-bridge.test.ts`、`test/path-field.render.test.ts`，以及 `test/app-shell-nav.test.ts` 的「Project 声明面板的 root 字段」（壳在/不在两态、候选合并与去重、选择器失败走面板错误通道）。

- **分栏可拖拽：会话栏 / 右栏 / 主导航 / 右栏内部的文件分栏**（`src/lib/pane-resize.ts`, `src/layout/PaneDivider.tsx`, `src/layout/use-pane-layout.ts`, `src/state/ui-store.ts`, `src/layout/{AppShell,AppSidebar}.tsx`, `src/pages/workspace/{WorkspaceView,SessionSidebar,RightPanel,FileExplorer}.tsx`）：四处分栏此前都是写死的宽度（240 / 300 / 300 / 40%）。现在每处中间夹一条分隔条（`role="separator"` + aria 数值 + 键盘 ←→/↑↓、Shift 粗调、双击回默认），拖动实时改宽、松手才落盘（`cornfield.workspace.panes`），刷新还在。**偏好与渲染分开**：容器把偏好写成 CSS 变量、栏自己取用，窗口放不下时由 flex 按各栏下限收紧，而**被收紧的值不写回偏好**（不然窗口缩一次就把用户选的宽度永久改掉）；左右栏的拖拽上限是动态的（按内容列此刻的剩余空间现算、扣掉转录列下限），拖到极限不会把转录列压没。右栏内部那处上下分栏存**比例**而不是像素（它锚的是高度，存像素会在右栏换宽后失真）。拖拽中**不经过 React**（每帧只改容器上的 CSS 变量）：工作台流式输出时每次会话更新都会重渲染，靠 React state 承载拖拽中的宽度会被一次无关重渲染弹回偏好值；落盘发生在松手，那时 React 写回同一个值。分隔条自带 `z-index` —— 可抓范围向两侧各撑 4px，不抬层级时 DOM 上后出现的邻居会盖掉它一侧（实测那条 1px 的线上只有一半能按中，光标在另一半还会变回邻居的样式）。移动端与 `/m` 不参与（`<lg` 两侧栏是抽屉，没有可拖的分栏）。回归：`test/pane-resize.test.ts`（几何 / 拖拽会话 / 偏好读盘，含边界与坏数据）、`test/pane-divider.render.test.ts`（role / aria / 轴向）、`test/e2e/pane-resize.spec.ts`（真实指针：拖拽 + 刷新持久 + 键盘 ±16 / Shift 64 + 双击复位 + 拖到极限转录列仍有下限 + 主导航变宽时整块工作台跟着让位）。

### Fixed

- **工作上下文按 Agent 绑定：改一个 Project 不再改到所有 Agent**（`src/lib/working-project.ts`, `src/lib/project-read-model.ts`, `src/state/session-store.ts`, `src/layout/ProjectSwitcher.tsx`, `test/working-project.test.ts`, `test/project-context.test.ts`, `test/new-session-agent-target.test.ts`, `test/app-shell-nav.test.ts`）：这个选择此前是**一个客户端级的字段**（与焦点无关），所以给一个 Agent 选完、切到别的 Agent 看到的还是它。现在它按 Agent 存（localStorage 一张 `agentId → projectId` 表，键不变；旧形状那条裸字符串不读 —— 一个「全局一格」的值猜不出该给哪个 Agent），每取一次快照按焦点解出有效值。**没手选过就用注册表兜底**：声明 `defaultAgentId = 这个 Agent` 的 Project（§10 解析链第 2 级，服务端早在用同一条关系），**恰好一个**才用；0 个 = 不指定，**多个 = 也不指定**（一个 Agent 服务多个项目是合法的，这时不替用户猜，面板把两个候选说出来、chip 的 title 说明为什么没自动绑）。兜底是算出来的**不落盘** —— 否则「手选过」与「注册表推出来的」再也分不开；选「不指定」会显式记下（`{"hr":""}`），否则会被兜底顶回来。跨 Agent 新建会话用**目标 Agent** 那条上下文（`newSession({ agentId })`），不是焦点那个 —— 拿焦点的项目建另一个 Agent 的会话，就是把两个 Agent 又缠在一起。有效值在 `getSnapshot()` 里派生并按 `#view` 的对象身份缓存：它必须**引用稳定**（每次返回新对象会让 `useSyncExternalStore` 无限渲染，实测 `Maximum update depth exceeded`）。回归：`test/working-project.test.ts`（表形状 / 旧形状作废 / 坏存储）、`test/project-context.test.ts` 的 `declaredDefaultProject`（one / none / ambiguous / unknown 四种，含「名单没读到 ≠ 没有」）、`test/new-session-agent-target.test.ts` 的「工作上下文：按 Agent 分」（隔离、刷新、恢复校验、兜底、多个不猜、显式不指定不被顶掉、跨 Agent 新建）、`test/app-shell-nav.test.ts` 的「两个 Project 都声明了这个 Agent」。

- **工作上下文（顶栏 chip 选的项目）落盘：刷新之后还在，恢复时按名单校验一次**（`src/lib/working-project.ts`, `src/state/session-store.ts`, `test/working-project.test.ts`, `test/new-session-agent-target.test.ts`）：这个选择此前只在内存里（`SessionStore.#workingProjectId`），刷新页面就悄悄退回「不指定」—— 用户看到的现象就是「选了 project 没地方保存」。现在它记在 localStorage（键 `cornfield:working-project`；存的是 **projectId** 而不是 root：归属的身份是 id，root 由存储归一），`setWorkingProject` 写、空串 = 忘掉那条。**恢复到的那一个要校验**：页面关着的那段时间里它可能已经被删，所以在第一次**真的读到一份名单**时（`#loadProjects`）判一次 —— 还在就留，不在就丢（连同存储）。两道门不校验且各有理由：名单读失败（「读不到」不是「没有」，拿一次失败的读取去删用户的选择是最坏的一种猜）与用户自己刚改过选择（那是决定，不是恢复）。会话内「选过但已不在注册表」的照实显示（`projectLabelOf`）没变。回归：`test/working-project.test.ts`（纯函数 + 存储 IO 的坏路径）、`test/new-session-agent-target.test.ts` 的「工作上下文落盘」（重建 store 仍在、名单里没有→丢、名单里有→留、读失败不删、用户改过不校验、选回不指定→忘掉）。

- **项目面板：保存钮与 root 同排，面板不再把保存钮推出屏幕**（`src/layout/ProjectSwitcher.tsx`, `test/app-shell-nav.test.ts`, `test/path-field.render.test.ts`）：把目录存成一个 Project 的那个钮此前写在 root 输入**下面**、隔着一行说明和一个「默认 Agent」选择框，而且还是无边框的低对比度 `cbtn` —— 用文件浏览器选完文件夹的人只会说「没有地方保存」。现在它是 `PathField` 的 `trailing`（与设置页「工作目录」同一处约定）、与 root 同排、用主按钮样式，文案从 wire 里的「声明」改成那个动作本身：「保存」。面板自身也受视口约束（`max-h-[calc(100vh-3.5rem)]` / `max-w-[calc(100vw-1rem)]` / `overflow-y-auto`）：此前固定 `w-[380px]` 且无高度上限的绝对定位，实测视口高 420px 时保存钮底边落在 422px、而 `scrollHeight` 就等于视口高（**滚不到**）。忙碌态一并改成按动作分格（`ProjectPanelState.busy: "save" | "delete" | null`）：一个布尔量会让没在跑的那个钮也说「保存中…」。回归：`test/app-shell-nav.test.ts` 的「Project 写面：保存 / 删除」（保存钮交在 `trailing` 上、面板的视口约束类名、两个钮各自的忙碌文案、点保存真的交动作）、`test/path-field.render.test.ts` 的「trailing 与输入、浏览钮同排」。

- **会话工作台：点别的会话进了回放之后，点顶上「当前会话」能回到实时**（`src/pages/workspace/SessionSidebar.tsx`, `src/state/session-store.ts`, `test/session-store-history-playback.test.ts`, `test/session-sidebar-current-row.test.ts`）：那一行的 `onClick` 此前是 `undefined`，根因是**视图里没有一个「正在回放」的事实** —— `sessionId` / `sessionName` 一直是实时那条（顶上那行就是拿它画的），`sessionFile` 两种态下都非空，所以「回到哪」无从说起。现在 `SessionView` 多一个 `historySessionFile`（打开历史会话时写入，**只由实时快照清空**），侧栏那一行据此变成回实时的入口（文案「回放中 · 点这里回到实时」）；动作走新增的 `SessionStore.returnToLiveSession()`：不在回放态时一个字节都不发，在回放态时重切一次焦点让 serve 推实时快照（视图整份由快照重建，不另写一套「擦除回放态」的逻辑）；失败把 serve 原文落到侧栏已有的错误横幅上，不假装回到了。

## [1.3.0] - 2026-09-17

### Changed

- **用量面板的 Project 匹配改用 pi-wire 的规则**（`src/pages/insights/insights-scope.ts`）：删掉本地那份 `matchProjectForPath`（与 serve 同算法的第二份），改为 `normalizePath` 词法归一后调 pi-wire 的 `pickDeepestRootIndex`。规则一份（pi-wire），归一化按侧不同且不可避免（serve = realpath，浏览器 = 词法；归一结果不同就可能命中不同，前端认不出的 symlink 路径仍是未归属，不猜）。`undefined` = registry 未读到 ≠ 未归属的语义不变。

- **导航与外壳收口：面板注册表成为唯一元数据源**（`src/router.tsx`, `src/layout/panel-registry.ts`, `src/layout/AppShell.tsx`, `src/layout/AppTopbar.tsx`）: 删除 `PAGE_META` / `PageMeta` / `findPageMeta`（与 panelRegistry 平行的第二份 path→标题/分组表；其 `protocol` 字段从无消费者，是随时会说谎的死元数据）；路由表由注册表派生（path / element / children 同源），当前面板改为从路由匹配链的 `handle` 解析（`activePanelOf` / `panelHandle`），不再按 pathname 前缀猜——子路由（`/models/catalog`、`/records/:id`、`/m`）在自己的路由上声明归属，自带顶栏由注册表的 `customTopbar` 声明。同时解掉 router ↔ AppShell 的循环 import，并删掉不再做任何查表的 `PanelHost`（面板就是路由，内容区直接是 Outlet）。
### Added

- **「创建员工」：前端能建 agent**（`src/pages/agents/AgentsView.tsx`, `src/pages/agents/CreateAgentPanel.tsx`, `src/state/pi-client-adapter.ts`, `src/state/session-store.ts`, `test/e2e/agent-create.spec.ts`）：列表页筛选行右侧与空态各一个入口，开同一张行内表单（名字必填 / 可选目录 / 可选 mission 文件路径；idle 与 submitting / failed / 已存在四态分开）。提交走新的 `create_agent` 命令，serve 侧就是 `cornfield agent init` 同一条实现；失败显示服务端原文。同名再建是**增量**语义（补齐缺的骨架文件，不报错），面板用 `created` 把「新建」与「本来就在」两种成功分开说。空态文案改成指这个真入口（不再教人去 agents 目录里建）。

- **定时任务工作台按 Agent / Project / Session scope 展示**（`src/pages/tasks/TasksView.tsx`, `src/pages/tasks/task-scope.ts`, `src/pages/insights/*`, `src/pages/voice/recording-scope.ts`, `src/lib/pi-client-api.ts`, `src/state/*`）：任务列表默认只看当前焦点 Agent 的任务（身份匹配，或旧行的执行 home 与其相同），身份未解析/未绑定的行单独成组、不归到任何 Agent 名下，并在行上写明「不会执行」的原因；Agent 组带声明的 Project 绑定（未声明只说未声明，不编一个项目）；执行记录里的 `agentSessionPath` 与投递目标会话即 Session scope。用量页按 Agent / Project 汇总目录行（求和派生，口径在 UI 标注；多 Agent / 未归属单独成组，不并入任何 Agent），会话 scope 只展示可确认的事实。听记历史按写入时标下的 provenance 分桶（本会话 / 本 Agent / 本 Project / 其他 / **未标注**）——旧记录不会被归给当前 Agent。

- **定时任务写操作接通**（`src/pages/tasks/TasksView.tsx`, `src/state/{pi-client-adapter,session-store}.ts`）：创建 / 暂停启用 / 删除 / 试跑 / 改绑 Agent 全部经 gateway `POST /wire`（`cron_create` / `cron_update` / `cron_remove` / `cron_test_run`），失败原因（agentId 未注册、Agent home 不在、绑定的两个字段不一致、重名、未知 taskId）原样亮出，不再吞成「创建失败」。创建表单可选执行 Agent（缺省 = 当前焦点 Agent），创建时由网关解析并落盘 resolved agentId。

### Fixed

- **Prompts tab 不再自备一份会漂移的源清单**（`src/pages/agents/AgentDetailView.tsx`, `src/state/pi-client-adapter.ts`, `src/pages/agents/AgentDetailView.prompt-sources.render.test.ts`, `test/pi-client-adapter-prompt-sources.test.ts`）：前端硬编码的 7 项里，`.omp/SYSTEM.md` 是旧路径（实际是 `.cornfield/SYSTEM.md`），`AGENTS-personal.md` / `CONTEXT.md` 全仓只有它提过（根本不存在），而真正 always-on 的 `TOOLS.md` / `TODO.md` / `knowledge/external-workspaces.md` 反而没入口。现在读 serve 的 `get_agent_prompt_sources`（8 项真源），逐项标存在性：清单说不在 → 「该文件不存在」（不去读一个已知不存在的文件）；清单说在但读失败 → 「读取失败：<服务端原文>」；没点过 → 「未读」。换 agent 时整份回到加载中（不作旧答复上屏）。

- **gateway 请求不再写死 `127.0.0.1:7892`**（`src/state/pi-client-adapter.ts`, `test/pi-client-adapter-gateway-wire.test.ts`, e2e 各 spec）：浏览器读不到 `CORNFIELD_GATEWAY_WIRE_PORT`，所以这个端口由 **serve 在握手里报**（`hello_ack.gatewayWirePort`），前端照用；没拿到就快速报「gateway 端口未知：待 serve 上报」并**不发请求**（不回落到一个猜的端口），断开后作废。后果：用隔离 HOME 跑 e2e 时页面仍连真实运营中的 gateway 这件事结束了 —— 现在 e2e harness 把端口指到一个没人监听的口，并断言到 7892 的请求数为 0。

- **Agent 详情的模型配置首屏不再空**（`src/pages/agents/AgentDetailView.tsx`, `src/pages/agents/ModelPicker.tsx`, `src/pages/agents/ModelPicker.render.test.ts`）：Provider 下拉此前写死 `anthropic` —— 它不在自己的选项里（React 受控 select 的 selectedIndex 直接是 -1），Model 下拉又被那个 provider 过滤成 **0 个 option**，于是首屏既选不了也看不到当前模型。现在 provider 由当前模型在真目录里反查（唯一命中才算知道，目录未到 / 不在可用列表 / 同名模型分属多 provider 都明说「未知」，不编一个出来），Model 下拉恒 ≥1 个选项，未连接 / 加载中 / 读取失败 / 确实没有四态分开。

- **右栏「读不到」不再渲染成「没有」**（`src/pages/workspace/ArtifactsPanel.tsx`, `ChangesPanel.tsx`, `RightPanel.tsx`, `src/pages/workspace/ArtifactsPanel.render.test.ts`, `test/session-git-changes-state.test.ts`）：产物 tab 在未连接时说「暂无产物」（把「读不到清单」说成「没有产物」），读取态从三档扩到五档（未连接 / 身份未挂载 / 加载中 / 已就绪 / 失败），并补上改动卡片「既没读到清单也没报错」这一支（此前那一帧只有组头、一句话都不说）。

- **用量页的两个轴都保留「未加载」态**（`src/pages/insights/insights-scope.ts`, `InsightsView.tsx`）：`FolderAttribution` 的 Agent/Project 两个轴改成带标签的三态（`known` / `unassigned` / `unknown`）——registry 未读到（`projects === undefined`）或会话索引未加载（`sessions === undefined`）时归属是 **unknown**，不再被归进「未归属」；分区表把「归属未知」单独成组并写明原因（“没读过名单”与“确实未归属”不再互相顶替）。Session scope 同理：「会话索引未加载」不再说成「该会话不在索引里」。

- **听记 scope 的 sessionFile 比较先做路径归一**（`src/pages/voice/recording-scope.ts`）：尾随分隔符 / 重复分隔符 / 反斜杠写法的同一个会话文件以前字面量比较不通过，会把本会话的录音判成「其他」；现在与 agentDir 用同一份归一规则。

## [1.1.1] - 2026-09-06

### Added

- **听记长录音：分帧上传 + 30 分钟上限 + 历史二次加工 + 回复回显 + 音频留档**（`src/pages/voice/ListenView.tsx`, `src/state/pi-client-adapter.ts`, `src/state/session-store.ts`, `src/lib/pi-client-api.ts`）: 录音上限 60s → 30 分钟；AudioContext 优先 16kHz 直采（省 2/3 内存与上传体积）；b64 超 12MB 自动切换 record_transcribe_begin/chunk/end 分帧上传（Bun WS 单帧 16MB 硬顶，实测 24MB 断连），转写中显示分帧上传进度；历史列表每行新增「纪要」「待办」按钮 + 原始录音回放（serve /listen-audio 静态路由）；发送 Agent 后新回复就地展示回显卡（含去工作台入口）。

## [1.1.0] - 2026-09-05

### Added

- **Agent 详情页钉钉 tab 显示所在群列表**（`src/pages/agents/AgentDetailView.tsx`）: DingtalkView 新增「所在群（钉钉）」section，展示群名/conversationId/最近活跃日期，每 15s 自动刷新。数据来自 gateway_status 的 groups 字段，按 channelId 过滤预留飞书扩展。

- **模型选择区快捷隐藏 Provider**（`src/pages/models/config/ModelSelectionSection.tsx`, `RuntimeConfigView.tsx`）: 选择器下方新增 Provider 隐藏 chips，两步确认（再点执行，4s 自动解除）写全局停用名单（复用 Provider 工作区的 setModelDisabled 链路，协议零改动）；隐藏后目录/选择器实时同步，恢复入口在 Provider 工作区。

### Changed

- **高级配置键按 schema 分组**（`src/pages/models/config/scope-keys.ts`, `ScopeKeysSection.tsx`; 协议 `packages/pi-wire` `ConfigScopeKeyDto.uiTab` + wire-server 填充）: 高级键按 schema ui.tab 中文分组折叠（交互/编辑器/外观/模型/上下文/工具/Provider/任务，schema 未归类的 76 键归「基础与系统」），组内网格平铺、默认全收起。

- **Provider 工作区排序**（`src/pages/models/ProvidersView.tsx`）: 已连接 provider 置顶（稳定分组，组内保持服务端顺序），未接入/异常沉底。

- **逐键配置平铺矩阵**（`src/pages/models/config/ScopeKeysSection.tsx`）: 列表改为响应式网格（1-4 列，精选键与高级键同款紧凑卡片），一屏可见键数数倍提升。收起态只显示标签/键名 + 覆盖徽标 + 生效值；点击整卡展开编辑面板（保留完整三层取值、精选键中文说明、恢复继承、按 schema 类型的编辑控件）。

- **运行时配置编辑三化**（`src/pages/models/config/`）: ① 置顶键内联编辑器按 schema 真实类型渲染控件——5 个枚举键下拉（附当前值兑底项）、4 个布尔键真假下拉、3 个数字键数字输入，高级组仍为 JSON 编辑；② 模型候选仅列 available（角色编辑器原 datalist 喂全量 2874 项，改为 ModelCombobox 内部过滤）；③ 候选按 provider 分组（select 原生 optgroup + combobox 分组浮层，共享 model-options 纯函数）。combobox 保留自由输入（保存前校验闸门依赖输入目录外模型测禁存），键盘可达（↑↓/Enter/Esc）。

- **逐键配置人话化策展**（`src/pages/models/config/ScopeKeysSection.tsx`, `scope-keys.ts`）: 运行配置页不再全量平铺 267 个 schema 键。精选 12 个高频键置顶（思考档位/采样温度/自动压缩/压缩阈值/压缩策略/上下文自动升级/卡死检测/API 重试/回退回归/跟进模式/自动恢复/Python 工具模式），配中文人话标签与一句话说明；其余键全部进入「高级配置」折叠组（默认收起，展开后三层展示与编辑功能完整）。纯展示层策展，协议与 schema 不变。

### Added

- **模型市场升级为模型控制中心**（`src/pages/models/**`, `src/router.tsx`）: `/models` 重定向至 `/models/catalog`，三个独立工作区——模型目录（全量已知模型六态展示、搜索/筛选/真实排序、详情抽屉、会话临时切换、连通性测试）、Provider（OAuth/API Key/Base URL/本地端点接入、状态与掩码、单 Provider/全量目录刷新、断开依赖保护与强制断开二次确认）、运行配置（全局/项目作用域、逐键三层取值、恢复继承、角色级主模型与回退链编辑器：草稿 + 保存前 diff + 原子写入）；壳层顶部状态条与异常区（含「失效待修复」派生态，重新接入后自动恢复）。

### Fixed

- **新增角色的 diff 弹窗不展示写入内容**（`src/pages/models/config/role-editor.ts`）: computeRoutesDiff 对新增角色返回 primary/fallbacks = null，保存确认弹窗只显示「新增 默认 default」而看不到将写入的主模型与回退链，违背「写入前 diff 完整可见」契约。改为新增角色也展示 from=null 的字段变更（主模型：（无） → 实际值）。

- **断连态永久骨架屏**（`src/pages/models/ModelsView.tsx`）: 未连接时渲染明确断连提示与重试入口，不再无限骨架。
- **模型切换/停用恢复静默吞错**（`src/state/session-store.ts`, 各工作区）: 命令失败写入错误态并渲染可诊断 banner。
- **面包屑子路径误配**（`src/router.tsx`）: `findPageMeta` 改最长前缀匹配，子路由不再误落 home。
- **伪「最新」筛选删除**（模型目录）: 移除以列表前两项冒充最新模型的启发式，改真实发布时间排序（缺失数据排末尾并明示）。
