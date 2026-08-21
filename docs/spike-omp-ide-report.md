# OMP webapp IDE — Spike 选轨报告（2026-08-21）

执行：4 个 spike 全部实码完成（SPIKE 4 → 1 → 2 → 3），时间盒内取证。

## 假设判定总览

| 假设 | 判定 | 证据 |
|---|---|---|
| H1 OpenSumi 集成形态 | **同路由子应用不成立 → 独立 bundle + iframe**（GLM F1 判对） | SPIKE 1：OpenSumi 构建为独立 bundle（154 chunks + webview + worker），iframe 嵌入宿主 10 次重挂宿主稳定，无 React/Tailwind 冲突（bundle 隔离） |
| H2 面板驱动编辑器 | **成立（2.26.8）—— 全链路实测定通**：contribution 面板 → DI 拿 WorkbenchEditorService → open 文件 → setSelection → getSelection → executeEdits → 读回验证。GLM F6 修正：面板必须进 contribution 体系（不是外部 overlay），但该路径可行 | SPIKE 2 终验：浏览器端 `open → group 有编辑器 → setSelection L1:1-4 → executeEdits 已应用 → 读回首行 SPIKE2-AGENT-EDIT ✓ 链路全部通过` |
| H3 协议扩写面 | **可行，半天级** | SPIKE 4：pi-wire 加 fs_write/fs_watch（fs_event 推送），实测写文件 19B/嵌套路径/递归事件流/退订全通（macOS；Linux 的 fs.watch recursive 缺口需 chokidar） |
| H4 Monaco 直配 80/20 | **部分成立**：形态验证极轻（150 行全通），但完整 IDE 能力（终端/git/扩展生态/MD 预览）全部要自建 | SPIKE 3：vite + @monaco-editor/react 垂直切片（树/打开/选区/diff）全通，零框架冲突、秒级 dev |

## 两轨实测数据

| 维度 | OpenSumi 轨（2.26.8 lite 模板） | Monaco 直配轨 |
|---|---|---|
| 集成 | 独立 bundle + iframe（已验证） | 直接进 webapp（同 bundle 无冲突） |
| 构建 | webpack，需 `--openssl-legacy-provider`（Node 25 环境），9MB bundle，全量构建分钟级 | vite 原生，秒级 HMR |
| 垂直切片成本 | **完成（攻坑后）**：view 注册 + DI 编辑器操作全链路（见下方"坑的答案"） | **完成（~150 行）**：文件树/打开/选区/diff |
| 编辑器能力 | Monaco 内核 + 全套（终端/git/调试/搜索/MD 预览/扩展生态/ai-native） | 仅 Monaco 内核；终端/git/diff/MD 预览自建 |
| 学习成本 | OpenSumi DI/模块/contribution 体系（实测踩 5+ 轮坑） | 零（React + Monaco 常识） |
| 框架锁定 | 中（模块图依赖） | 无（@monaco-editor/react 可换） |
| 与 agent 挂点 | 面板 = contribution 内嵌（组件代码复用，DI/生命周期归 OpenSumi） | 面板 = webapp React 组件，直接复用现有会话 UI/pi-wire |
| 风险 | 维护依赖蚂蚁节奏；注册 API 坑多 | 功能自建工作量；Monaco 无扩展生态 |

## 坑的答案（SPIKE 2 收尾实测的 3 个关键知识）

1. **view 注册**：`@Domain(ClientAppContribution)` + `@Autowired(ComponentRegistry)` 属性注入在 2.26.8 lite 崩（阶段/时序问题）——**正确姿势 = `@Domain(ClientAppContribution, ComponentContribution)` + `registerComponent(registry)` 方法参数注入**（DI 自动传 registry 实例）+ options 必须带 `containerId`（= slot modules 引用的 key，view.id 独立）。
2. **slot 引用**：layoutConfig `SlotLocation.right.modules` 引用的是**容器 key**（同 `register(key, view, {containerId: key})` 的 key），不是 view id。
3. **编辑器 token**：`IEditorService` 在 2.26.8 **不存在**（import 为 undefined → DI 报 `Cannot find Provider of undefined`）。正确 token = **`WorkbenchEditorService`**（`open(uri)` → `IOpenResourceResult.group`）+ monaco 实例 = `group.currentEditor.monacoEditor`（setSelection/getSelection/executeEdits 直接可用）。`EditorCollectionService` 提供 currentEditor/listEditors/createCodeEditor。

## 建议：Monaco 直配轨先行（Phase 1），OpenSumi 留作 Phase 2 升级路径

理由（基于 spike 数据，非纸面）：
1. **形态验证优先**：monaco 轨 1-2 天出可用的东西（mock 形态 = 文件树 + 编辑 + 选区 + diff + agent 面板），零框架锁定——验证"编辑器 + agent 对话"假设的成本最低
2. **OpenSumi 轨的坑已实测**：contribution 体系有学习成本且注册 API 在 2.26.8 有崩点；iframe 集成可行但跨 iframe 通信是日常摩擦。这些成本应推迟到"确认需要完整 IDE"之后付
3. **升级路径清晰**：OpenSumi 独立 bundle + iframe 已验证可行——若 Phase 1 验证发现需要终端/git 面板/VS Code 扩展生态，换轨不推翻架构（worker 协议层 SPIKE 4 已就绪，两边共用）
4. **Phase 1 交付物**：webapp 顶部全局切换（控制台 ⇄ IDE）+ Monaco 轨（文件树/编辑器/选区→agent 面板/diff 展示/接受）+ fs_write/fs_watch 协议（SPIKE 4 产物）

## 待办/风险账本追加

- [ ] SPIKE 4 产物入 main（fs_write/fs_watch + fs_event 帧，已在 spike-omp-ide 分支 f362a2d471）
- [ ] Linux 递归 watch 缺口：chokidar 或 Bun.watch 类型补齐（macOS/Windows 现可用 fs.watch recursive）
- [ ] worker 发现/生命周期（F4）：Phase 1 限定"已注册 worker"，`omp serve --register` 留 Phase 2
- [ ] 双写者冲突（F5）：agent 编辑独立 undo 组 + dirty buffer 提示（Monaco API 原生支持，比 OpenSumi 好处理）
- [ ] OpenSumi 若 Phase 2 启用：onStart/ComponentRegistry 注入坑记档，面板按官方扩展样板走
