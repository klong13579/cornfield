# Changelog

## [Unreleased]

### Changed

- **导航与外壳收口：面板注册表成为唯一元数据源**（`src/router.tsx`, `src/layout/panel-registry.ts`, `src/layout/AppShell.tsx`, `src/layout/AppTopbar.tsx`）: 删除 `PAGE_META` / `PageMeta` / `findPageMeta`（与 panelRegistry 平行的第二份 path→标题/分组表；其 `protocol` 字段从无消费者，是随时会说谎的死元数据）；路由表由注册表派生（path / element / children 同源），当前面板改为从路由匹配链的 `handle` 解析（`activePanelOf` / `panelHandle`），不再按 pathname 前缀猜——子路由（`/models/catalog`、`/records/:id`、`/m`）在自己的路由上声明归属，自带顶栏由注册表的 `customTopbar` 声明。同时解掉 router ↔ AppShell 的循环 import，并删掉不再做任何查表的 `PanelHost`（面板就是路由，内容区直接是 Outlet）。

### Added

- **工作台上下文控件：AgentSwitcher / ProjectSwitcher**（`src/layout/AgentSwitcher.tsx`, `src/layout/ProjectSwitcher.tsx`, `src/components/ProjectContext.tsx`, `src/pages/workspace/WorkspaceView.tsx`, `src/pages/home/HomeView.tsx`）: 首页内联的 Agent `<select>` 与工作台只读 Agent chip 收敛为同一件控件；Project 上下文由只读 chip 升级为可展开控件（原生 `<details>`，展开即见已声明清单 + 当前归属 + 重读），首页区块与工作台控件共用同一份清单（`ProjectList`）与同一份判据（`projectLabelOf`）。三种「没有」分开渲染：读不到 / 未声明 / 未归属，另加「焦点不在注册表」。控件只挂在工作台（与首页），不进入外壳。

### Fixed

- **未知深链落到框架开发者错误页**（`src/router.tsx`, `src/layout/NotFoundView.tsx`）: `#/<不存在的路径>` 之前由 React Router 默认 ErrorBoundary 接管（整页替换、无侧栏、开发者提示）。改为壳内兜底路由（`path: "*"`）：侧栏保留、可直接走开；未知路径也不冒充任何面板（顶栏标题位为空，而不是落回 Home）。
- **顶栏上下文条被挤成竖排字**（`src/pages/workspace/WorkspaceView.tsx`, `src/index.css`）: 顶栏是单行 flex，工作区路径 / 会话名 / 连接状态这些会变长的值之前没有截断也没有 `min-width: 0`，被挤窄时文字竖排（实测 chip 高 48px、连接状态高 57px，右侧「新会话」按钮被挤出外框）。改为可在 chip 内省略号截断（`.chip-truncate`）+ 控件与按钮 `shrink-0`，整行不再溢出。
- **焦点 Agent 不在注册表时把 uuid 当选项文字**（`src/layout/AgentSwitcher.tsx`）: serve 的焦点可能是 36 字符的会话 uuid（实测），当成 `<option>` 文字会把整个 chip 撑到 300px 并挤爆邻座。改为占位「焦点未注册」，原样 id 进 title 供排查。
- **切 Agent 的两半收敛到一处**（`src/state/session-store.ts`）: 新增 `focusAgent(agentId)`（attach + switch_session）；首页、Agent 管理页、Composer 的 agent 菜单不再各写一遍那两行——任何一处只改一半都会表现成「切过去了但回复不来」。

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
