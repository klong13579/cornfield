# 02 — OpenSumi & Zed 借鉴研究

调研日期：2026-08-23
调研范围：**仅**外部开源项目（OpenSumi / zed-industries/zed），不读 oh-my-pi 内部代码。
目的：在 oh-my-pi 已有"内核 only-one + 多前端 reactive 适配"原则下，决定前端编辑器扩展该从哪里搬什么。

> 标记约定：✓ 直接观测（带源 + 行号/章节锚）；⚠ 推断（带依据）；✗ 缺（需另行检索）。

---

## 1. OpenSumi 关键模块摘录

来源：opensumi.com 官方文档站（`https://opensumi.com/en/docs/...`）+ `github.com/opensumi/core` 源码 main 分支。

### 1.1 core-idea（架构总览）

- **核心抽象**：OpenSumi 是"前后端分离的 IDE 框架"，前端为 React + 自研 DI（`@opensumi/di`），后端为 Node.js；通过 RPC（WebSocket / Electron IPC，底层 JSON-RPC 2.0）做"前后端透明"通信。一个 IDE 实例分三个进程：Browser / Node / Extension。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/core-idea/` § "OpenSumi is positioned as an IDE framework"；§ "Module Layer and Dependencies"；§ "Dependency Injection"。
- **跟编辑器扩展相关的能力**：
  - 模块分 Core（`core-browser` / `core-node` / `monaco` / `main-layout`，不可热拔）vs Functional（其余 53 个，可热拔）。
  - Extension 系统是 VS Code 插件的"超集"——保留了 `main` 入口（VS Code 兼容），又加了 `browserMain`（Browser 扩展里能直接 export React 组件）和 `workerMain`（Web Worker 扩展）。
  - 每个模块结构固定 `src/{browser, node, common}` 三层，分别承担视图、Node 能力、共享契约。
  ✓ 同上 § "Module" / "Module Layer and Dependencies" / "Extension and API"。
- **借鉴点在哪**：oh-my-pi 已经有内核 only-one，**模块级前后端分层**这一原则（`browser/`、`node/`、`common/` 三层）可以照搬到 moa-extension / web-app 编辑器端的目录约定上；尤其是 `common/` 的契约层——把"前端能调的接口"都用 token 定义好，避免再写一遍 ts interface。

### 1.2 core-modules（模块分类）

- **核心抽象**：OpenSumi 总共 53 个 npm 包，每个包是一个 Module。Core 模块是 IDE 骨架（main-layout / core-browser / core-node / monaco），其余可插拔。Extension 模块依赖大部分功能模块；移掉 extension 模块就丧失全部扩展能力。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/core-modules/` § "Introduction to Core Modules"。
- **跟编辑器扩展相关的能力**：
  - **Core Browser/Node**：前端/后端 `ClientApp` / `ServerApp` 实例、Contribution 注册、RPC 连接初始化。**不能热拔**。
  - **Monaco**：包装 Monaco 的私有 API（OpenSumi 编辑器强依赖 Monaco 私有 API），给其他模块用作扩展点。
  - **File Service**：唯一默认文件服务实现；同时挂上 `MemoryFS` / `BrowserFS` 等适配点。
  - **Extension Manager**：唯一一个**能直接依赖 extension 模块**的模块——装、卸、启、停扩展都走它。
  - **Terminal-Next**：暴露 `TerminalNetworkContribution`，让你自己接 WebSocket/Socket 到后端 Shell。
- **借鉴点在哪**："Functional 模块可拔"是给上层集成用的；如果 oh-my-pi 的编辑器扩展走"嫁接"在已有 web-app 上，那 web-app 是不需要做模块可拔的——直接 new 一个 ClientApp 就行。**真正可借鉴的是 Module 命名层**——把每个能力放进一个独立 npm-style 包，让 IDE 主进程按需 `addProviders`。

### 1.3 connection（前后端通信层）

- **核心抽象**：OpenSumi 把 Web/Electron 的通信差异封装在 `@opensumi/ide-connection`，底层是 JSON-RPC 2.0 + 长链（Web 用 WebSocket，Electron 用 IPC socket）。前端调用后端的方法就是一个 Proxy：`myBackService.$getSomeLocalData()` 被 Proxy 拦截 → 包成 `Request` → 后端把结果通过唯一 ID 回写。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/connection/` § "Basic Principle"（含 Proxy 伪代码）；§ "Channel"。
- **跟编辑器扩展相关的能力**：
  - **方法名 `$` 前缀**：所有后端 RPC 方法必须 `$` 起头，前端 DI 注入的是 Proxy（不是真实实现）。
  - **多窗口隔离**：每个 window 单独一条长链 + 单独一个 DI container；后端对前端是**无状态**的，不同连接严格隔离。
  - **Channel**：用于在广播/订阅场景下分发给特定长链（注意它不是 MQTT，是 OpenSumi 自己的轻量分发模型）。
- **借鉴点在哪**：oh-my-pi 已经有 pi-wire（已在 context 中确认），它是 WebSocket 双向通道——**完全对位 OpenSumi connection**。编辑器扩展里要新加 RPC 方法，最小增量是"在 pi-wire 上加一个 channel + 服务端实现 + 客户端 Proxy"。不要把 web-app 写成另一份 Electron IPC 通道。

### 1.4 editor（编辑器内核）

- **核心抽象**：OpenSumi 编辑器围绕 `WorkbenchEditorService`（全局唯一）。打开 URI 经历三步：① `IResourceProvider` 把 URI 解释成 `IResource`（name / icon / metadata），② `EditorComponentRegistry` 注册"打开方式"（`type: 'code' | 'diff' | 'component'`）+ React 组件，③ 根据用户选择（同一资源可有多种打开方式）渲染对应组件。
  ✓ `https://opensumi.com/en/docs/develop/module-apis/editor/` § "Basic Concept" / "Extend the Editor"；代码：`packages/editor/src/browser/workbench-editor.service.ts` ⚠未读源码(读的是文档，但文档里给了完整 type signature)。
- **跟编辑器扩展相关的能力**：
  - **`IResource` 模型**：把"能不能开在编辑器里"这件事抽象成一个接口——`{ supportsRevive, name, uri, icon, metadata, deleted }`。
  - **`IEditorOpenType`**：`{ type: 'code' | 'diff' | 'component', componentId?, title?, readonly?, weight? }`——同一个 URI 可以同时挂 Markdown 源码预览、富组件、Diff。
  - **`BrowserEditorContribution`**：4 个 hook 点——`registerResource`（注册 URI → IResource 转换器）、`registerEditorComponent`（注册打开方式 + 组件）、`registerEditorFeature`（拿到 Monaco editor 实例，可挂命令/装饰）、`onDidRestoreState`（恢复上次打开的 tab 组）。
  - **`WorkbenchEditorService` API**：`open / close / saveAll / closeAll / openUris / createUntitledResource` + 状态事件 `onActiveResourceChange` / `onCursorChange` / `onDidEditorGroupsChanged`。
- **借鉴点在哪**：oh-my-pi 不需要照搬 Monaco——它已经选好"轻量 + 自家 + 嫁接"。**借鉴 IResource 模型**：把"打开一个文件"从"前端 Promise fs.readFile"提升为"IResourceProvider: URI → ResourceData"——这样以后接 LSP / 远程 workspace / git blob 都不动 UI。`registerEditorFeature` 那种"拿到 editor 实例再注入"的钩子也很适合做"agent inline chat"。

### 1.5 VFS / FileService（虚拟文件系统）

- **核心抽象**：`IFileService` 是统一的文件操作门面（`getFileStat / resolveContent / setContent / updateContent / move / copy / createFile / createFolder / delete / access / onFilesChanged / watchFileChanges`）。后端 `registerProvider(scheme, FileSystemProvider)` 让每种 URI scheme 都能挂自己的 `FileSystemProvider`——磁盘是默认 provider，MemoryFS / BrowserFS / ShadowFS 都是同一个 scheme 的不同 provider。
  ✓ 源码 `packages/file-service/src/common/files.ts` L31 `IFileService extends IFileSystemWatcherServer`；L184 `registerProvider(scheme, provider)`；L236 `setWorkspaceRoots`；L271 `FileSystemProviderErrorCode`；源码 `packages/file-service/src/node/disk-file-system.provider.ts`（默认实现）。
- **跟编辑器扩展相关的能力**：
  - **Scheme 即 routing key**：`file://` 默认给磁盘 provider；`git://` 可以自己挂（git blob）；`sumi-workspace://` 是 OpenSumi 自己发明的 scheme（存 workspace 配置）。
  - **`ShadowFileSystemProvider`**（`packages/file-service/src/browser/shadow-file-system.provider.ts`，~2.3KB）：shadow 名字暗示"本地 shadow + 后端真盘"的双层模式——这是把 Browser 端模拟文件操作、后端落盘的能力封装出来，适合 web IDE 用。
  - **`onFilesChanged` / `watchFileChanges`**：内置 watcher，子模块用 `DebouncedDelay` 节流。
  - **`FileStat`**：统一的 stat 类型，返回单层 unresolved children——上层自己 lazy resolve。
- **借鉴点在哪**：oh-my-pi 的 web-app 现阶段是"前端直连 pi-client"的；**FileService 这种"按 scheme 分 provider"模型适合加多 backend**——以后想接 vfs.literal/vfs.remote 时不用动 UI。**完全照搬成本太高**（OpenSumi 自己有 hosted 子目录 + WatcherProcessManager 后端 watcher 进程，web-app 不需要），但 `IFileService` 接口形状可以"改造"成 web-app 的 thin wrapper：把 `fs.*` 包成 IFileService + 不实装 watcher（前端用 chokidar）。

### 1.6 Git / SCM（源码管理）

- **核心抽象**：模块名是 `scm`（不是 `git`）——意图是"独立于 git 的源码管理抽象"。核心接口：`ISCMProvider`（一个仓库 = 一个 provider）→ `ISCMRepository`（含 input box：commit message）→ `ISCMResource`（一个 file）→ `ISCMResourceGroup`（staged / unstaged）。前端 `SCMService.registerSCMProvider(provider)` 是注入点。
  ✓ 源码 `packages/scm/src/common/scm.ts` L108 `ISCMProvider` / L95 `ISCMRepository` / L77 `ISCMResource`；`packages/scm/src/browser/scm.contribution.ts` L27 `@Domain(ClientAppContribution, ..., MainLayoutContribution, ...)` 六个 Contribution 合一。
- **跟编辑器扩展相关的能力**：
  - **`registerSCMProvider`**：可以同时注册多个 provider（同时管多个 git 仓库、不止 git——可挂 svn / 自家 VCS）。
  - **`DirtyDiffWorkbenchController`**（同文件 L20）：在编辑器里高亮 inline dirty 改动 + 上下条跳转（`GOTO_NEXT_CHANGE` / `GOTO_PREVIOUS_CHANGE`）+ 切换 side-by-side / inline（`TOGGLE_DIFF_SIDE_BY_SIDE`）。
  - **`SCMBadgeController` + `SCMStatusBarController`**：状态栏徽章显示当前 repo 状态。
  - **`MainLayoutContribution`** 把 SCM 注册成一个左下角 tab（`scmContainerId`），优先级 8，自带快捷键 `ctrlcmd+shift+g`。
  - **`StatusBarCommands` / `acceptInputCommand`**：commit 框提交按钮和状态栏命令。
  - **Extension 集成点**：`extensionsPointService.appendExtensionPoint(['browserViews', 'properties'], ...)`，意味着扩展可以往 SCM View 注入 React 组件——和 Editor 加新打开方式类似。
- **借鉴点在哪**：`registerSCMProvider` 这种"前端一个 provider、后端一个 git 进程"的抽象很值，**改造**：把 git 命令调子进程做成"agent/piercer"，前端只持有 ISCMProvider 视图对象（dirty / diff 显示）；agent 想要 AI git 摘要/生成 commit message 时复用 OpenSumi 那套 `acceptInputCommand` + slash 命令的对接方式。

### 1.7 Workspace（工作区）

- **核心抽象**：`WorkspaceData` 是一个 JSON 文档——`{ folders: [{path, name?}], settings?: {} }`。磁盘上叫 `*.sumi-workspace`，**相对路径自动转换**：写时 relative、读时 absolute（核心逻辑在 `packages/workspace/src/browser/workspace-data.ts` L57 `transformToRelative` / L91 `transformToAbsolute`）。
  ✓ 源码 `packages/workspace/src/browser/workspace-data.ts` L7 `workspaceSchema` / L31 `is(data)` / L46 `buildWorkspaceData`。
- **跟编辑器扩展相关的能力**：
  - **`WorkspaceService`**（`packages/workspace/src/browser/workspace-service.ts`，24KB）：管 `workspace / _roots / setWorkspace / updateWorkspace` + `whenReady: Deferred<void>`——**全部异步，用 Deferred 解 race condition**。
  - **`UNTITLED_WORKSPACE` + `WORKSPACE_USER_STORAGE_FOLDER_NAME`**：未保存工作区 / 用户态存储位置。
  - **`WorkspacePreferences`**：每个 workspace 自带 preferences，跟个人 globals 区分。
  - **`init()` / `initFileServiceExclude()`**：初始化分两步，先 init 后 exclude（exclude 影响 FileService watcher 范围）。
- **借鉴点在哪**：oh-my-pi 现在的 web-app 是单 workspace 模式——**借鉴 WorkspaceData JSON 这个 schema**，**改造**：写一份 `mcode-workspace.json`，让用户能"一次选多个 repo + 各自 settings"，Web 端渲染时按 folder 渲染 file tree；**值不值得**：用户已经在用"管多个子业务领域 agent"，多 workspace 是刚需。

### 1.8 AI Inline Chat / Chat Panel

- **核心抽象**：`ai-native` 模块（自 OpenSumi 3.0）用一个 `AiNativeContribution` 把"AI 都能干啥"做成统一注册点；后端抽 `BaseAIBackService<Req,Resp>` + `IAIBackService` 接口让用户自接模型；**前后端用 `AIBackSerivcePath` 这种 token 注入**，前端拿到的是 Proxy。
  ✓ `https://opensumi.com/en/docs/integrate/module-usage/ai-native-module/` § "Overview" / "How to Use" / "Contribution"。
- **跟编辑器扩展相关的能力**：
  - **8 个注册点**（`registerInlineChatFeature` / `registerChatFeature` / `registerChatRender` / `registerResolveConflictFeature` / `registerRenameProvider` / `registerProblemFixFeature` / `registerIntelligentCompletionFeature`）：每个对应一个 AI 能力。
  - **`IInlineChatFeatureRegistry`**：
    - `registerEditorInlineChat({id, name, title, renderType, codeAction}, {execute, providerDiffPreviewStrategy})`——选中代码 → 浮出 inline chat 按钮。
    - `registerTerminalInlineChat`——terminal 也能聊。
  - **`IChatFeatureRegistry`**：注册 chat 面板 welcome message + slash command（如 `/explain` / `/comment`）。
  - **`ChatResponse` 三态**：`ReplyResponse / ErrorResponse / CancelResponse`——**把"取消"做成第一等公民**，而不是 success 子类型。
  - **`providerDiffPreviewStrategy`**：inline chat 里**改完代码不是直接 patch，先在 diff 编辑器里给你看**，确认后才 apply。OpenSumi 这里特意把 diff preview 抽成 callback，留给上层接 git / review workflow。
  - **`IEditorInlineChatHandler.execute`**：在 click 按钮瞬间直接执行的同步路径（"按钮触发 → 立即消失 → 不进 diff 预览"）。
- **借鉴点在哪**：这部分是**和 oh-my-pi 已有 ACP 模式直接相关的——OpenSumi 自己也加了 ACP**（`packages/ai-native/CONTEXT.md` 是 Agentic Layout 规范，强制走 ACP Agent）。结论：① **`registerInlineChatFeature` 这种"AI capability 是注册点、不是固定面板"** 必须照搬——不要把"加个 capability"做成改源码；② **`ChatResponse` 三态** 的统一 error 处理 = oh-my-pi 的 `ACPThreadEvent` 也应有三态——查 ACP spec 里 `cancel / error / success` 是否和它对齐。

---

## 2. Zed 关键模块摘录

来源：`https://github.com/zed-industries/zed` main 分支；DeepWiki `deepwiki.com/zed-industries/zed`；`docs.rs/gpui`。

### 2.1 crates/editor/src/editor.rs

- **核心抽象**：12647 行的 `editor.rs` 是 Editor 类的 home，但渲染/事件分到子模块：`element`（渲染）/ `display_map`（坐标映射、fold、soft wrap、tab markup、inlay）/ `items`（Editor as Panel item / 自承载多 buffer）/ `selection` / `mouse_context_menu`。`Element` 那一层（`crates/editor/src/element.rs`，~509KB）才是真正给 GPUI 渲染的。
  ✓ `crates/editor/src/editor.rs` top doc-comment L1-L8："This is the place where everything editor-related is stored (data-wise) and displayed (ui-wise). The main point of interest in this crate is [`Editor`] type... [`element`] — the place where all rendering happens. [`display_map`] - chunks up text..."；L29-L57 模块声明。
- **跟编辑器扩展相关的能力**：
  - **`Editor` 不同 flavor**：单行 / 多行 / 固定高度——同一个 `Editor` struct 通过参数切换（不在不同 struct 上复制代码）。
  - **`pub mod items`**：把 Editor 嵌入 Workspace 的"item 协议"——拖出/拖入 tab 是同一套语义；`pub use items::MAX_TAB_TITLE_LEN` 等公共契约都从这里 export。
  - **Vim 模式外挂**：注释"L37 If you're looking to improve Vim mode, you should check out Vim crate that wraps Editor and overrides its behavior"——**用 wrapper 模式扩展**，不污染 Editor 主体。
  - **`display_map::FoldPlaceholder` / `HighlightKey` / `SemanticTokenHighlight`**：渲染无关的逻辑抽出独立模块。display_map 把"逻辑字符坐标 ↔ 显示行"分开。
- **借鉴点在哪**：**`Editor` 主类 + 子模块分层 = 不直接抄 Zed**，但"Editor 拆 element / display_map / items"的分层思想可用到 oh-my-pi 的 `web-app/src/components/Editor/`——`Editor.tsx`（react facade）/ `displayMap.ts`（文本→渲染行映射）/ `itembl.ts`（与 workspace tab 协议）。

### 2.2 worktree（`crates/worktree/src/worktree.rs`）

- **核心抽象**：7707 行的 `worktree.rs` 把"文件系统扫描"做成增量 snapshot。`LocalSnapshot` 内嵌 `SumTree<Entry>`（`sum_tree` crate），**任何 path 变化（git status / mtime / 内容）都触发 SumTree 的局部更新**，访问是 O(log n)。Snapshot 是一次性 immutable 视图——所有上层读 snapshot 是 lock-free 的。
  ✓ L250 `pub struct LocalSnapshot`；L3795 `pub struct File { worktree: Entity<Worktree>, path: Arc<RelPath>, disk_state: DiskState, entry_id: Option<ProjectEntryId>, is_local, is_private }`；L3953 `pub struct Entry`。
- **跟编辑器扩展相关的能力**：
  - **`Entry::GitTraversal` / `ChildEntriesGitIter` / `GitEntry`**：把 file tree 扫描和 git status **统一成一个迭代器**——读 tree 时自然带回 git 状态，不另开 channel。
  - **`Snapshot::Status<'a>(...)`**：每个路径都可以现查 stat / blame / mtime / is_deleted——snapshot 是真相之源。
  - **`RelPath`**（`util::rel_path`）：相对路径作为 first-class type，避免误绝对化。
  - **`ignore::IgnoreStack`**（同文件 + `mod ignore`）：gitignore + 本地 ignore + worktree 私有档 自动合并 stack。
  - **`ManifestTree`**（导出符号 L40）——把 `package.json` / `Cargo.toml` / `requirements.txt` 看作"项目骨架"，worktree 扫描时附带识别（典型 usage：在 layer 间区分 lib/app/config）。
- **借鉴点在哪**：oh-my-pi 的 web-app 现在大概率每次重扫 directory——**借鉴 snapshot + SumTree 模型**收益巨大：编辑器一开几千文件就靠增量更新；不过代价是要写一套 custom SumTree 或用 ProseMirror 团队的 cot / immer 替代。**改造方向**：把 file tree 做成"前后端各持一份 state"——前端用 CustomTree + 增量，git status 通过 intercom channel 实时同步。**跳过** ManifestTree（用户场景里 Oh My Pi 还没到要识别项目骨架的程度）。

### 2.3 project（`crates/project/src/project.rs`）

- **核心抽象**：`Project` 是 6913 行的"调度者"——持有一组 `Entity<WorktreeStore>` / `Entity<BufferStore>` / `Entity<GitStore>` / `Entity<LspStore>` / `Entity<ImageStore>` 等独立 store。它**自己存的不多**，只做 store 间的协调 + RPC 派发。`ProjectClientState` (`Local` / `Shared` / `Collab`) 三态——前端用 Project 时不必关心它是不是在远程。
  ✓ L215-L256 `pub struct Project { ... git_store: Entity<GitStore>, worktree_store: Entity<WorktreeStore>, buffer_store: Entity<BufferStore>, lsp_store: Entity<LspStore>, ... }`。
- **跟编辑器扩展相关的能力**：
  - **42 个 mod**：agent_server_store / bookmark_store / buffer_store / git_store / lsp_store / project_search / task_store / terminals / prettier_store / debugger / context_server_store / image_store / color_extractor / connection_manager / manifest_tree / trusted_worktrees / toolchain_store / yarn / environment ——每个独立可测。
  - **`Project::git_diff_debouncer`**：debounce 400ms，统一一次算 diff。
  - **`downloading_files`**：单个 `(worktree_id, path)` 的下载状态哈希——专门管"异步下载未完成"的文件。
- **借鉴点在哪**：**这种 "Store-per-concern" 分层完全适配 oh-my-pi**。web-app 当前可能是"一个大 action handler"，按 Store-per-concern 切后：① gitStore 单独走 pi-client 的 git RPC，② lspStore 让 agent 注入 LSP proxy，③ taskStore 管 agent team 任务。**照搬**结构（store 是 Entity/Store 划分），**改造**实际实现（Zed 用 GPUI Entity，oh-my-pi 用 React Context + zustand 即可）。

### 2.4 project_panel（`crates/project_panel/src/project_panel.rs`）

- **核心抽象**：ProjectPanel（左下角的 file tree）是个 7621 行的 `Panel` 子类型，关键数据是 `Entry` / `GitEntry` / `MarkdownPreviewView`——它**没有自己的 git status 缓存**，全部通过 project.read(cx).git_store / worktree 拉。
  ✓ L137 `pub struct ProjectPanel`；L6950 `impl Render for ProjectPanel`；L5668 `fn render_entry`；L6808 `fn render_sticky_entries`；L6350 `fn render_folder_elements`。
- **跟编辑器扩展相关的能力**：
  - **`render_entry_path_separator`**：路径分隔符 = 自定义 row layout（vs Material 一律箭头）。
  - **`render_sticky_entries`**：sticky 行——常用目录永久在顶部。
  - **Git 集成是从 Project 来**：它从不"自己调 git"——所有 git 数据走 `project.git_store`，这是好的关注分离。
  - **`entry_diagnostic_aware_icon_*` + `entry_git_aware_label_color`**（L20-L25 imports）：单文件、四种 decoration 源（git / diagnostic / file_icons / 文件夹），所有 decoration 通过 `items::` 模块的 helper 函数合并。
- **借鉴点在哪**：**改造**——Zed 的 ProjectPanel 体量太大（7621 行），不适合整体照搬；但**关注分离原则搬**：把 file tree 拆成 `<FileTree>` 组件 + `<FileTreeRow>` + `<EntryGitBadge>` + `<EntryDiagnosticBadge>`。每个 hook 拿数据通过 props（不直接读 store）。

### 2.5 agent_panel / inline_assistant

- **核心抽象**：两大块。① **`AgentPanel`** 是个全屏 panel（517KB）：持 `WeakEntity<Workspace>` / `Entity<Project>` / `Entity<ThreadStore>` / `Entity<AgentConnectionStore>` / `HashMap<ThreadId, Entity<ConversationView>>`——一个 panel 管 N 个 thread 视图。② **`InlineAssistant`** 是 Global：一个 global 实例 + `EditorInlineAssists`（per-editor 一组 pending assists） + `InlineAssist`（一个 inline assist 实例，含 `BufferCodegen` 状态机）。`InlineAssistant::init` 通过 `cx.set_global(InlineAssistant::new(fs, prompt_builder))` 注册。
  ✓ `crates/agent_ui/src/agent_panel.rs` L1153 `pub struct AgentPanel { workspace: WeakEntity<Workspace>, project: Entity<Project>, thread_store, connection_store, retained_threads: HashMap<ThreadId, Entity<ConversationView>>, selected_agent: Agent, ... }`；`crates/agent_ui/src/inline_assistant.rs` L87 `pub struct InlineAssistant`、L1635 `pub struct InlineAssist`。
- **跟编辑器扩展相关的能力**：
  - **ACP**：`use acp_thread::{AcpThread, AcpThreadEvent, MentionUri, ThreadStatus, line_range_suffix}`；`use agent_client_protocol::schema::v1 as acp`——Zed 的 agent 全部走 ACP v1 schema。**和 oh-my-pi 完全对位**。
  - **`retained_threads: HashMap<ThreadId, Entity<ConversationView>>`**：不 GC——对话是 persistent 的，直到用户主动 archive（注意这一句"GIA-only-modelism"⚠推断：可能是 `OpenSumi Agentic Layout CONTEXT.md` L1-L11 里那段 `ACP Task Archive / Unarchive` 行为已被 Zed 实装）。
  - **`mentions` + `MentionUri`**：agent 输入框能 @文件/@符号；line_range_suffix（@file:10-20 行 range 后缀）。这是 inline chat 的必备 UX。
  - **`AgentSettings::UserAgentsMd` / `OpenGlobalAgentsMdRules` / `OpenProjectAgentsMdRules`**：用 markdown 文件配置 agent rules，分 global + project 两层——和 OpenSumi 的 `WorkspacePreferences` 是同一招。
  - **`inline_assistant.rs` L87-L100 Global**：`InlineAssistant` 是 Cx global，所有 editor 共享一个，EditorInlineAssists 是 per editor 的。这样全局可"中断当前所有 inline"。
  - **`BufferCodegen`**（`: buffer_codegen::BufferCodegen`）：把 inline edit 做成状态机（idle → running → streaming → applying / cancelled）。
- **借鉴点在哪**：**直接对位**——oh-my-pi 已经有 ACP server，`AgentPanel`/`InlineAssistant`/`BufferCodegen` 三层直接照搬结构：① 顶层 panel = oh-my-pi 的 chat panel（已有，但只是 web view，未做 conversation retention）；② `InlineAssistant` global = 不需要 new，看 oh-my-pi 是否已经做了；③ `BufferCodegen` 状态机要**新加**——这是 oh-my-pi 缺的能力。**改造** UI（react + tailwind），**照搬** ACP / retention model / mentions。

### 2.6 extensions system（`extension_host`）

- **核心抽象**：Zed 用 **Wasmtime component model + WIT**（WebAssembly Interface Type，wit-bindgen 自家导出）做插件宿主。扩展是编译成 wasm 的 Rust crate，宿主端用 `wasmtime::Engine` 编译并跑 `wit::Extension`。Capabilities（file ops / LSP / themes / slash commands / debug adapter / context server）通过 `CapabilityGranter` 显式允许。
  ✓ `crates/extension_host/src/wasm_host.rs` L46 `pub struct WasmHost { engine: Engine, release_channel: ReleaseChannel, http_client: Arc<dyn HttpClient>, node_runtime, proxy: Arc<ExtensionHostProxy>, fs, work_dir, granted_capabilities: Vec<ExtensionCapability>, ... }`；L77 `pub struct WasmExtension` 实现 `extension::Extension` trait。
- **跟编辑器扩展相关的能力**：
  - **`ExtensionCapability` 一等公民**：所有扩展能做的事都列出来（语言/LSP/grammar/theme/snippet/debug-adapter/context-server/slash-command/keyvalue-store）。不在列表里的 API 编译时过不了。
  - **WASI 集成**：`wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView}`——扩展能跑有限的 syscall。
  - **`granted_capabilities`**：settings.json 里细粒度 allowlist（PR #39472"Load granted extension capabilities from settings"）。
  - **`extension_builder`（separate crate）**：release 模式把扩展源码在用户机器上编译成 wasm——意味着扩展作者写 Rust，平台用同一条流水线。开发友好度极高，代价是首次安装慢。
  - **Moka cache（`moka::sync::Cache`）**：wasm component 在内存里缓存。
- **借鉴点在哪**：**oh-my-pi 不适合照搬**——Wasmtime 那一套非常重（Rust 扩展 + 用户机编译 + WASI），而 oh-my-pi "agent team 管公司业务"场景下用户不需要写 Rust 扩展。**能借鉴的只有两件事**：① **`ExtensionCapability` 显式 allowlist 的安全边界**——可以照搬到 oh-my-pi 的 "agent 工具授权"——白名单 / 灰名单；② **`proxy + capability grant` 的设计模式**——任何需要权限的能力（如 写文件、读 git）显式通过 grantor，不直接持有 client。

### 2.7 GPUI（`crates/gpui/src/lib.rs`）

- **核心抽象**：GPUI 文档自己写明"hybrid immediate and retained mode, GPU accelerated"。三大块：
  1. **State**：所有 application state 都住在 `Entity<T>` 里（GPUI 拥有的智能指针，类似 `Rc<T>`），外界用 `cx.entity()` 拿引用，update 通过 `cx.spawn`/`cx.notify`/`cx.observe`。
  2. **View**（declarative）：一个 Entity 同时是 View 就 `impl Render`，GPUI 在每帧调 `render(&mut self, window, cx) → impl IntoElement`。Element 是树。
  3. **Element**（imperative）：低层 Element 自己控制 layout+ paint+ hit-testing——为了给"大列表 + 代码编辑器"那种需要自定义布局 / 高速合成的场景留口子。
  ✓ `https://docs.rs/gpui/latest/gpui/index.html` § "The Big Picture"。
- **跟编辑器扩展相关的能力**：
  - **`cx.spawn(async move ...)` + `cx.background_spawn`**：所有异步操作强类型+可被框架调度。
  - **`cx.observe(reader, observer)` / `cx.subscribe`**：stateful 反应式更新。
  - **`Action` 系统**：keybinding 不是 key→fn，而是 key→Action→handler——action 是 typed enum。
- **借鉴点在哪**：**GPUI 是 Rust-native，oh-my-pi 是 React+TS**，没法照搬。**借鉴"三层思想"**：① "state 必须是 GPUI（框架）拥有"→ ① = 把 web-app 里的 zustand store 拆细，所有 mutable state 都只在 owner 里（react 用 zustand 满足）；② "Element + Render trait 分离"→ ② = 把 web-app 的 `<Editor>` 拆 `<Editor.View>`（react façade）+ `<EditorElement>`（直接拿 window 坐标画 canvas）；③ **跳过 Action 系统**——react 用 keydown handler 就够了，不需要 typed enum。

---

## 3. 借鉴对照表（oh-my-pi 视角）

| 编辑器能力 | OpenSumi 怎么做 | Zed 怎么做 | 借鉴程度 | 理由 |
|---|---|---|---|---|
| **前后端 RPC（file ops / git ops）** | connection 包 JSON-RPC + 长链 + Proxy，`$` 前缀方法（`packages/connection`、`docs/develop/basic-design/connection`） | pi-wire 已经在 web-app 用了；Project 通过 store 装；不暴露 RPC 给外部——内部 rust 直接 call | **跳过** | oh-my-pi 已经有 pi-wire；不重新发明 RPC；uni*RPC 一份。 |
| **URI → 可打开资源** | `IResource` 模型（`{ supportsRevive, name, uri, icon, metadata, deleted }`）+ `IResourceProvider` | Project 把 `ProjectPath` + `WorktreeId` + `PathBuf` 当 typed handle；Editor 没抽象 IResource | **改造** | 从 `IResource` 抄形状（保留 `uri/icon/name/metadata`），Provider 注册用 web-app 的 zustand store；UI 自家 React。 |
| **编辑器内核**（open / close / save / tab 组） | `WorkbenchEditorService` 单例 + `EditorComponentRegistry` 注册多打开方式 | `Editor` struct 12647 行 + `display_map` + `items` 模块；`Element` 独立渲染层 | **改造** | 借鉴 IResource 多打开方式（比 Zed 强的地方），subsystem 分层学 Zed（item / display_map）；自己写轻量编辑器内核（不在 web-app 里塞 monaco）。 |
| **文件 / Git 状态增量** | FileService + WatcherProcessManager（后端 watcher 子进程）+ onFilesChanged 事件 | `Worktree` 内嵌 `SumTree<Entry>` 的 LocalSnapshot + 增量更新 + `GitTraversal` | **改造** | SumTree 思路抄，但用 immer / custom impl 别搬 sum_tree crate；Git 数据走 pi-client 走子进程。**跳过** ManifestTree。 |
| **多仓库 / Workspace JSON** | `WorkspaceData` JSON + relative↔absolute 转换（`packages/workspace/src/browser/workspace-data.ts`） | `Worktree` 是单一集合（多 worktree 并存），没有 `WorkspaceData.json`；多 root 通过 `worktree_store` 装 | **改造** | 学 OpenSumi 的 `mcode-workspace.json` schema（`folders + settings`）。**不做** Zed 那种 client-server 多 Worktree（复杂且不需要）。 |
| **Git / SCM provider** | `registerSCMProvider(scheme, provider)` 多 provider + `ISCMResource` + dirty diff 高亮 + status bar badge | `git_store::GitStore` 独立 store + `DiffHunkDelegate`（`crates/editor/src/git/`）+ `InlineBlamePopover` + `GotoPrev/NextChange` | **改造** | 学 OpenSumi 的 provider 注册制（多个 git repo 同时挂）；学 Zed 的 dirty diff 在 editor 内嵌 + blame popover。UI 全部自家。 |
| **AI Inline Chat（编辑器内按钮）** | `IInlineChatFeatureRegistry.registerEditorInlineChat({id, name, renderType, codeAction}, {execute, providerDiffPreviewStrategy})`；`ChatResponse` 三态 | `InlineAssistant` Global + `EditorInlineAssists` + `InlineAssist` + `BufferCodegen` 状态机 + diff preview 是 default | **照搬** | 完全对位 oh-my-pi 的 ACP 已有结构。三态 + diff preview 是必须照搬的。 |
| **AI Chat Panel（持久对话）** | `IChatFeatureRegistry.registerWelcome / registerSlashCommand` | `AgentPanel { thread_store, retained_threads: HashMap<ThreadId, Entity<ConversationView>>, selected_agent: Agent }` | **照搬** | retention model + Thread Id HashMap + selected_agent 三件套直接借鉴；mention（@file:10-20）必须照搬。 |
| **Agent 配置（rules）** | `WorkspacePreferences` 一层 | `AgentSettings::UserAgentsMd` + `OpenGlobalAgentsMdRules` + `OpenProjectAgentsMdRules` 两层（global + project） | **改造** | 学 Zed 双层（global + project），不全照搬 OpenSumi。 |
| **扩展安全边界** | `ClientAppContribution` 注册声明 | `ExtensionCapability` allowlist + `CapabilityGranter` + settings.json 细粒度 | **改造** | 给 oh-my-pi agent tool 加 allowlist；不在 web-app 层做 wasm 扩展（用户场景不需要）。 |
| **前端渲染模型** | React + 自家 Monaco wrapper | GPUI 三层 Entity/View/Element + GPU 加速 + 120fps | **跳过** | 不抄 GPUI，React+tailwind 就够；但借鉴"render 分离 + state 分离 + element 低层开口"的层级思路（拆分 `<EditorFacade>.tsx` + `<EditorElement>.tsx`）。 |
| **VFS / File system provider 多 scheme** | `IFileService.registerProvider(scheme, FileSystemProvider)` —— file/git/sumi-workspace/各一组 | 无对应层（Zed 全本地，remote 通过 `remote::RemoteClient` 走另一条） | **改造** | 学 OpenSumi 多 scheme 分 provider；不照搬 watcher 子进程；浏览器端 chokidar 即可。 |
| **Vim 等"插件模式"** | Extension 系统就是 super-VSCode-plugin | "Vim crate that wraps Editor"——wrapper 不污染主体 | **改造** | 学 Zed 的 wrapper 模式：以后要做"编辑器命令面板""多光标模式"作为 EditorShell 子层 wrap，不污染 Editor 主体。 |

---

## 4. 借鉴地图（5–10 行）

在 oh-my-pi 已具备 `pi-wire + pi-client + ACP + coding-agent` 的前提下，前端编辑器扩展应挂在 web-app 上做"嫁接"，不重建内核：
1. **RPC**：跳过（pi-wire 已对位 OpenSumi connection）。
2. **资源模型 IResource**：照搬抽象，Provider 注册用 zustand，UI 自家 React。
3. **Editor 内核**：改造——学 Zed 的 `display_map / items / element` 分层 + OpenSumi 的多打开方式，自己写轻量编辑器。
4. **File tree**：改造——学 Zed `Worktree` 的 SumTree 增量思想，掉底盘改 chokidar。
5. **Git / SCM**：改造——抄 OpenSumi `registerSCMProvider` 多 provider 注册（比 Zed GitStore 更适合 oh-my-pi 场景）。
6. **AI Inline Chat**：照搬 OpenSumi `registerEditorInlineChat` + Zed `InlineAssistant` 的 `ChatResponse` 三态 + `providerDiffPreviewStrategy` preview-then-apply。
7. **Chat Panel**：照搬 Zed `AgentPanel` 的 `retained_threads + selected_agent` + mention（@file:10-20）+ rules 双层。
8. **Workspace JSON**：照搬 OpenSumi `WorkspaceData{ folders, settings }` schema；不做 Zed 远程多 Worktree。
9. **UI 分层与扩展安全**：学 GPUI 的 Entity/View/Element 三层（React 拆分 façade/element）+ OpenSumi/Zed 的 capability allowlist 给 agent tool 加白名单；不做 wasm 宿主。
