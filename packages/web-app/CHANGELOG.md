# Changelog

## [Unreleased]

### Changed

- **工作台「当前计划」默认折叠，且几何与会话框对齐**（`src/pages/workspace/WorkspaceView.tsx`）：计划条此前恒展开，本会话跑出 14 条任务就一直占着输入区上方约 200px；现在默认折叠，表头留「完成 x/y · 放弃 n」的读数与展开入口（`aria-expanded` + `aria-controls`），折叠态由工作台持有、**不持久化**（每次进工作台都从折叠开始）。`phases` 之外的三种态（未连接 / 快照未到 / 确实没有计划）本来就只有一行文案，不给它们画折叠控件 —— 一个点了没用的箭头比没有它更坏。同时它的宽度从自成一档的 `max-w-[760px]` 收到与转录列同一段（外层 `px-6` + 内层 `max-w-[1100px]`）：1440 视口下左边缘曾比会话框窄 170px。回归：`src/pages/workspace/WorkspaceView.plan-strip.render.test.ts`（默认折叠那一眼 + 与 Transcript 同款几何）、`test/app-shell-nav.test.ts` 的「当前计划区域」（折叠/展开两态、表头是唯一入口、三种无计划态不画控件）。

- **Prompts 源不再列 `TODO.md`**（`src/pages/agents/AgentDetailView.tsx`, `test/e2e/agent-dashboard.spec.ts`）：serve 侧 `AGENT_DIR_PROMPT_FILES` 把 `TODO.md` 移出 prompt 面（它退出注入流程，改为历史留档），清单随真源从 8 项变 7 项。前端照渲染 serve 给的清单，只改了一份独立核对用的字面量与一处已过时的注释。

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
