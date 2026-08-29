# 编辑器扩展 v1 方案（基于 A+B+C review 后的合成）

> 状态：**v1 草案（已通过功能需求 + 借鉴选择两层对齐）**
> 写作时间：2026-08-23
> 关系：取代 `03-architecture-draft.md` 的 v0 建议；3 份调研报告（A / B / C）作为输入材料继续保留
> 维护：本文件是决策门第 2 步的输出，等用户拍板后写 `v2-final.md`

---

## 0. Review（v0 阶段遗留问题）

### 0.1 v0 草案已被推翻但没归档

`03-architecture-draft.md` 是 v0 草案（"v0 草案（待 Task A 摸底 + Task B 痛点佐证后出 v1）"）。A/B/C 三家调研报告已完成，**v1 已在本文件中合成**。建议把 v0 文档加一行归档标记：

```
> 状态（追加 2026-08-23）：v0 已被本 v1 文件取代。OpenSumi 风格推荐仍然有效，但具体模块借鉴 + 时间账 + P3 评估以本 v1 为准。
```

### 0.2 三家口径不一致（v1 统一）

| 维度 | v0 草案 | v1 修正 |
|---|---|---|
| 借鉴选择 | OpenSumi vs Zed 二选一 | **主借鉴 OpenSumi + 按需借鉴 Zed**（25 模块细化） |
| 编辑器内核 | v0 不涉及 | **MVP Monaco，v2 评估自研** |
| Workspace | 单 workspace | **MVP 单 workspace，v2 评估 multi-root** |
| Git 实现 | 前端 spawn git | **前端 spawn git + 走 wire 5 命令**（fs_read/write + git_status/diff/log/show/branches） |
| 时间账 | 4-6 周 OpenSumi | **5-7 周 MVP，9-12 周 v1 全** |
| P3 评估 | 无 | **5 项明确 v2 评估** |
| IResource | 无 | **P0 必做** |
| ChatResponse 三态 | 无 | **P0 必做** |
| ACP retention | 无 | **P0 必做** |

### 0.3 C 草案内部矛盾

C 的"OpenSumi 风格 vs Zed 风格"二选一**已经过时**——B 报告揭示 OpenSumi 53 个模块里**大多数不借鉴**，Zed 也有大量不借鉴。v1 不再二选一，而是按"4 个功能需求"各自映射借鉴模块。

### 0.4 v0 漏掉的有用功能（v1 补回）

| 漏掉功能 | v1 状态 |
|---|---|
| Search / Find in Files | **P0**（natives.grep 已现成） |
| ⌘P Quick Open | **P0**（natives.fuzzyFind 已现成） |
| Terminal 集成 | **P0**（natives.pty + Shell 已现成） |
| Save conflict 解决策略 | **P0**（A 报告提的"editor 侧 vs agent 侧冲突"） |
| LSP writethrough 续接 | **P0**（fs_write 路径上必做） |
| Git push/fetch/pull | **P1**（v1 加 wire 3 命令） |
| Multi-root workspace | **P3 v2** |
| Crash recovery / Local history | **P1** |
| Code Actions / Quick Fix | **P1**（LSP 能力） |
| Markdown live preview | **P1**（natives.htmlToMarkdown） |
| Symbol Outline / Breadcrumbs | **P1**（LSP） |
| AI Inline Completions | **P2** |
| Extension API / 插件 | **显式拒绝**（不做插件市场） |
| GPUI native | **显式拒绝**（React 栈不兼容） |
| Wasm 扩展宿主 | **显式拒绝**（用户场景不需要） |
| 远程协作 / Collab | **显式拒绝**（不在 MVP 范围） |

---

## 1. 设计原则（沿用 v0 金句）

> "我希望所有底层和 cli 都是共用的，cli 和客户端，乃至 web 只是不同的前端展示方式。**改内核，大家都会跟着变化而不是分别修改**。"

落点：
- 编辑器作为前端，**worker = coding-agent 内核**，已存在的链路不改。
- 改 wire / client / coding-agent 内核，CLI / 桌面 / web 受益，而不是反向。
- 编辑器差异化在 agent 层（多 worker / 审批 / cron / 记忆 / 学习沉淀），光标/buffer/textmate 是红海。
- **借鉴是为功能需求服务，不是为借鉴完整性**。

---

## 2. 4 个功能需求 ↔ 借鉴模块 ↔ 现状映射

### 2.1 功能 ① 项目选择

**用户场景**：打开一个本地目录作为 agent 工作根；切换已选目录；多个项目并存。

| 子能力 | 借鉴模块 | 来源 | 现状 | 工作量 |
|---|---|---|---|---|
| 打开本地目录 | IResource 模型 | OpenSumi P0 | ✗ 不具备（前端操作字符串路径） | 必建 |
| 切换目录 | `state.workspaceDir` 已存在 | cornfield | ✓ 已具备 | 0（接通 UI） |
| 文件选择对话框 | Electron `dialog.showOpenDialog` | cornfield | ✗ Electron preload 没暴露 | 加 `editor.openProject` IPC |
| 切换后 agent session cwd 跟着切 | `cornfield serve --cwd` 已支持 | cornfield | ✓ 已具备 | 0 |
| Multi-root workspace | WorkspaceData JSON | OpenSumi P3 | ✗ 单 workspace | v2 评估 |

### 2.2 功能 ② 文件编辑与预览

**用户场景**：编辑文件、看 diff、看大文件、自动保存、行级精度。

| 子能力 | 借鉴模块 | 来源 | 现状 | 工作量 |
|---|---|---|---|---|
| 编辑器视图 | Monaco 集成 | cornfield | ✗ 0 行编辑器代码 | 必建（`@monaco-editor/react`） |
| 文件读取 | `fs_read` wire | cornfield | ✓ 已具备 | 0 |
| 文件保存 | `fs_write` wire | cornfield | ✗ 不具备 | **必建**（new wire 命令） |
| 编辑透传 | `fs_edit` wire | cornfield | ✗ 不具备 | **必建**（透传 edit tool schema） |
| Diff 预览 | `fs_diff` wire | cornfield | ✗ 不具备 | **必建**（new wire 命令） |
| LSP 格式化/诊断 | `lspmux` 已现成 | cornfield | ✓ 已具备 | 0 |
| LSP writethrough 续接 | （自定义 fs_write 走 LSP） | cornfield | ⚠ 当前只走 edit tool 路径 | **必做**（fs_write 必须挂 LSP） |
| 大文件打开（>128KB） | chunked fs_read | cornfield | ✗ 当前 128KB 截断 | **v1 加 chunked** |
| 多打开方式 | IEditorOpenType | OpenSumi P1 | ✗ 只支持 text | 必建 |
| Save conflict（editor 侧 vs agent 侧） | 自定义冲突策略 | 设计 | ✗ 当前无 | **必建**（提示，不解决 OT/CRDT） |
| Crash recovery | Local history | 编辑器标配 | ✗ 不具备 | P1 |
| Inline blame + GotoNext/PrevChange | Zed UX | Zed P2 | ✗ 不具备 | P1（Monaco decorations） |
| BufferCodegen 回放 | Zed P1 | Zed | ✗ 不具备 | P1 |
| Markdown live preview | `htmlToMarkdown` | cornfield | ✓ 已具备 | P1（接通 UI） |
| Code Actions / Quick Fix | LSP 能力 | LSP | ✓ LSP 支持 | P1（接通 UI） |
| Symbol Outline / Breadcrumbs | LSP 能力 | LSP | ✓ LSP 支持 | P1 |
| Search / Find in Files | `natives.grep` | cornfield | ✓ 已具备 | **P0 必接** |
| ⌘P Quick Open | `natives.fuzzyFind` | cornfield | ✓ 已具备 | **P0 必接** |
| Symbol Search ⌘Shift+O | LSP 能力 | LSP | ✓ LSP 支持 | P1 |
| 自研编辑器内核 | display_map/items/element 分层 | Zed P3 | ✗ | v2 评估 |

### 2.3 功能 ③ Git 集成

**用户场景**：看 status、看 diff、看 commit、看 blame、提交、push/fetch/pull。

| 子能力 | 借鉴模块 | 来源 | 现状 | 工作量 |
|---|---|---|---|---|
| Git status | `git_status` wire（前端 spawn git） | cornfield | ✗ 不具备 | **P0 必建** |
| Git diff | `git_diff` wire | cornfield | ✗ 不具备 | **P0 必建** |
| Git log | `git_log` wire | cornfield | ✗ 不具备 | **P0 必建** |
| Git show（单 commit） | `git_show` wire | cornfield | ✗ 不具备 | P0 必建 |
| Git branches | `git_branches` wire | cornfield | ✗ 不具备 | P0 必建 |
| Git blame | `git_blame` wire | cornfield | ✗ 不具备 | P1（v1 加） |
| Git commit | `git_commit` wire | cornfield | ✗ 不具备 | P1（v1 加） |
| Git push/fetch/pull | 3 个 wire 命令 | cornfield | ✗ | P1（v1 加） |
| 多 SCM provider | `registerSCMProvider` | OpenSumi P3 | ✗ | v2 评估（只支持 git） |
| Inline dirty diff | DirtyDiffWorkbenchController | OpenSumi P1 | ✗ | 改造（用 Monaco decorations） |
| Inline blame popover | Zed UX | Zed P2 | ✗ | P2 |
| GotoNext/PrevChange | Zed UX | Zed P2 | ✗ | P2 |

### 2.4 功能 ④ Agent assistant

**用户场景**：跟 agent 聊天让 agent 改文件、看 agent 改文件的 diff、agent 跑命令时看输出、agent 提问时审批、看历史对话。

| 子能力 | 借鉴模块 | 来源 | 现状 | 工作量 |
|---|---|---|---|---|
| Agent panel 渲染 | ClientAdapter 已现成 | cornfield | ✓ | 接通 UI（P0） |
| ACP retention（关掉再开会话还在） | Zed retention model | Zed P0 | ⚠ session list API 有，UI 没接 | **P0 必接** |
| ChatResponse 三态 | ReplyResponse / ErrorResponse / CancelResponse | OpenSumi P0 | ⚠ wire 协议有，前端没区分 | **P0 必做** |
| Agent 改文件回放 | BufferCodegen | Zed P1 | ✗ | P1 |
| mention @file:10-20 | Zed UX | Zed P1 | ✗ | P1 |
| AI Inline Chat 注册点 | `registerEditorInlineChat` | OpenSumi P0 | ✗ | **P0 必建**（加 capability 不改源码） |
| AI Inline Chat 状态机 | idle → running → streaming → applying/cancelled | Zed P1 | ✗ | P1 |
| permission_request UI 卡片 | wire 已现成 | cornfield | ⚠ 有帧没 UI 渲染 | **P0 必建** |
| 审批流（permission_request） | wire 已现成 | cornfield | ⚠ 有帧没 UI | **P0 必建** |
| ApprovalCard 复用 | web-app 已现成 | cornfield | ✓ | 接通 iframe / import |
| Streaming 渲染 | `WireServerEvent.progress` | cornfield | ✓ 已具备 | 0 |
| host_tools（编辑器自定义工具给 agent 调） | wire 已现成 | cornfield | ⚠ 有协议没接 UI | P1 |
| Store-per-concern 关注分离 | Store-per-concern | Zed P1 | ⚠ web-app state 平铺 | P1（拆 zustand） |
| selected_agent 切换 | ACP | Zed P2 | ⚠ ACP 有，UI 没接 | P2 |
| Capability allowlist | ExtensionCapability | Zed P3 | ✗ | v2 评估 |

### 2.5 功能 ⑤ Terminal 集成（v0 漏掉，P0 必做）

| 子能力 | 借鉴模块 | 来源 | 现状 | 工作量 |
|---|---|---|---|---|
| Terminal 标签 | `natives.pty` + `Shell` | cornfield | ✓ 已具备 | **P0 必接 UI** |
| Terminal 内跑命令 | 已具备 | cornfield | ✓ | 0 |
| Terminal inline chat | `registerTerminalInlineChat` | OpenSumi P2 | ✗ | P2 |

### 2.6 功能 ⑥ 显式拒绝的功能（v1 文档化避免下次会话再问）

| 功能 | 拒绝理由 |
|---|---|
| Extension API / 插件市场 | cornfield 不做插件市场；用户场景不需要 |
| GPUI native 渲染 | React 栈不兼容 |
| Wasm 扩展宿主 | 用户场景不需要 Rust 扩展 |
| 远程协作 / Collab | MVP 范围不在此 |
| Vim mode | Zed wrapper 模式——v2 评估 |
| 自定义 Themes | MVP 默认主题——v2 评估 |
| Settings Sync 跨设备 | MVP 单机——v2 评估 |
| AI Inline Completions | Zed/Codeium 有；cornfield 当前不做——v2 评估 |

---

## 3. 借鉴模块完整列表（25 项）

### P0 必做（影响 MVP 核心体验 + v0 漏掉的有用功能）

| # | 借鉴模块 | 来源 | 用途 | 落点 |
|---|---|---|---|---|
| 1 | IResource 模型 | OpenSumi | "打开任何 URI 走同一接口" | editor-extension 新建 |
| 2 | AI Inline Chat 注册点 | OpenSumi | "加 capability 不改源码" | editor-extension 新建 |
| 3 | ChatResponse 三态 | OpenSumi | Reply/Error/Cancel 区分 | web-app + editor-extension |
| 4 | ACP retention 模型 | Zed | 关掉应用再开会话还在 | web-app 接通 UI |
| 5 | Search / Find in Files | cornfield native | 接通 `natives.grep` | web-app + editor-extension |
| 6 | ⌘P Quick Open | cornfield native | 接通 `natives.fuzzyFind` | web-app + editor-extension |
| 7 | Terminal 集成 | cornfield native | 接通 `natives.pty` + `Shell` | editor-extension 新建 terminal 标签 |
| 8 | Save conflict 解决策略 | 自定义 | editor 侧未保存 vs agent 改写 | editor-extension 新建 |
| 9 | LSP writethrough 续接 | cornfield 现成 | fs_write 走 LSP | coding-agent 扩展 |
| 10 | permission_request UI 卡片 | wire 已现成 | 审批危险 write | editor-extension 新建 |

### P1 v1 阶段（影响功能完成度）

| # | 借鉴模块 | 来源 | 用途 |
|---|---|---|---|
| 11 | 多打开方式 IEditorOpenType | OpenSumi | text/diff/preview 多方式 |
| 12 | AI Inline Chat 状态机 | Zed | agent 改文件过程追踪 |
| 13 | BufferCodegen 回放 | Zed | agent 改写编辑器内嵌 diff view |
| 14 | mention @file:10-20 | Zed | 精确引用文件行段 |
| 15 | Store-per-concern 关注分离 | Zed | zustand 按 store 拆分 |
| 16 | Git blame / commit / push/fetch/pull | cornfield 新加 wire | 5+3 个 wire 命令 |
| 17 | Crash recovery / Local history | 编辑器标配 | 自动保存每次改动历史 |
| 18 | Code Actions / Quick Fix | LSP 能力 | 接通 LSP UI |
| 19 | Symbol Outline / Breadcrumbs | LSP 能力 | 接通 LSP UI |
| 20 | Markdown live preview | `htmlToMarkdown` native | 接通 UI |
| 21 | Inline dirty diff | OpenSumi DirtyDiffWorkbenchController | Monaco decorations |
| 22 | host_tools（编辑器给 agent 提供工具） | wire 已现成 | 接通 UI |

### P2 v1.x 阶段（增强体验）

| # | 借鉴模块 | 来源 | 用途 |
|---|---|---|---|
| 23 | selected_agent 切换 | Zed ACP | 切换 agent 上下文 |
| 24 | Inline blame + GotoNext/PrevChange | Zed UX | 编辑器内嵌 blame + diff 导航 |
| 25 | AI Inline Completions | Zed/Codeium | 自动补全 |
| 26 | Terminal inline chat | OpenSumi registerTerminalInlineChat | terminal 内聊天 |

### P3 v2 评估（暂不引）

| # | 借鉴模块 | 来源 | MVP 不引原因 | v2 触发 |
|---|---|---|---|---|
| 27 | WorkspaceData JSON（multi-root） | OpenSumi | MVP 单 workspace | 多仓库联动需求 |
| 28 | VFS / FileService 抽象 | OpenSumi | MVP 直走 chokidar | 远端/SSH/容器化 |
| 29 | registerSCMProvider 多 provider | OpenSumi | MVP 单 git | svn/perforce 需求 |
| 30 | editor.rs 内核分层 | Zed | MVP 用 Monaco | Monaco 不满足具体需求时 |
| 31 | ExtensionCapability allowlist | Zed | MVP 不做扩展系统 | 开始做扩展市场时 |

### 显式拒绝（不引并文档化拒绝理由）

| # | 功能 | 拒绝理由 |
|---|---|---|
| ✗ | Extension API / 插件市场 | cornfield 不做插件市场 |
| ✗ | GPUI native | React 栈不兼容 |
| ✗ | Wasm 扩展宿主 | 用户场景不需要 |
| ✗ | 远程协作 / Collab | 不在 MVP 范围 |
| ✗ | Vim mode | v2 评估 |
| ✗ | 自定义 Themes | v2 评估 |
| ✗ | Settings Sync | v2 评估 |

---

## 4. 现状盘点：CornField 已具备 / 部分具备 / 缺

### ✓ 已具备（直接复用）
- sidecar `ws://127.0.0.1:7891` 通信
- wire v1（JSON-over-WS，向后兼容）
- `Client` 类（重连+心跳+snapshot 缓存）
- `fs_list` / `fs_read` / `fs_read_image` wire 命令
- ACP mode（agent + sessions）
- `lspmux` 多工作空间复用
- `CORNFIELD_DESKTOP_DEV_URL` Electron 留口
- `natives` 21 模块（grep/fuzzyFind/highlight/ast/PhotonImage/Pty/Shell/clipboard/audio）
- `state.workspaceDir` / `state.worktreeUri` 字段
- `ApprovalCard` / `ClarifyCard` / `FloatingCardHost` web-app 组件
- `host_tools` / `set_host_tools` 协议
- `permission_request` / `permission_respond` 协议
- `WireServerEvent.progress` 流式推送
- `chokidar` web-app 已有

### ⚠ 部分具备（接通 UI）
- ACP retention（API 有，UI 没接）
- ChatResponse 三态（协议有，前端没区分渲染）
- session list UI（API 有，UI 没接）
- selected_agent（ACP 有，UI 没接）

### ✗ 不具备（必新建）
1. IResource 模型
2. AI Inline Chat 注册点
3. AI Inline Chat 状态机
4. BufferCodegen 回放
5. mention @file:10-20
6. IEditorOpenType
7. Store-per-concern（拆 zustand）
8. fs_write / fs_edit / fs_diff wire 命令
9. git_status / git_diff / git_log / git_show / git_branches wire 命令
10. chunked fs_read（128KB 大文件截断解决）
11. 多打开方式 text/diff/preview
12. Save conflict 解决策略
13. Crash recovery / Local history
14. Git blame / commit / push/fetch/pull wire 命令
15. Code Actions / Quick Fix UI
16. Symbol Outline / Breadcrumbs UI
17. Markdown live preview UI
18. Inline dirty diff
19. permission_request UI 卡片
20. Terminal 标签 UI
21. Search / Find in Files UI（虽然 native 已具备，但 web-app 没接通）
22. ⌘P Quick Open UI（同上）
23. Inline blame popover
25. GotoNext/PrevChange

**25 项 ✗ 缺**

---

## 5. 模块归属（最终版）

### Layer 4：编辑器扩展（新建）
- **新建** `packages/editor-extension`（Vite + React + TS）
- 借鉴模块落点：
  - IResource / IEditorOpenType / 多打开方式
  - AI Inline Chat 注册点 + 状态机
  - BufferCodegen 回放
  - mention @file:10-20
  - ⌘P Quick Open + Search UI
  - Terminal 标签
  - Save conflict 策略
  - Crash recovery
  - permission_request UI 卡片
  - Markdown live preview
  - Inline dirty diff / blame popover
  - GotoNext/PrevChange

### Layer 3：web-app 扩展
- **扩展** `packages/web-app`
  - `state.workspaceDir` 升级为 IResource-aware
  - session list UI 接通（Zed retention 模式）
  - ChatResponse 三态 UI 渲染
  - selected_agent 切换 UI
  - host_tools 接通（编辑器给 agent 提供工具）
  - Store-per-concern 拆分 zustand
  - Search / Find in Files UI
  - Code Actions / Quick Fix UI
  - Symbol Outline UI

### Layer 2：wire + natives 扩展
- **扩展** `packages/wire`（加新命令，不破协议）
  - fs_write / fs_edit / fs_diff
  - chunked fs_read
  - git_status / git_diff / git_log / git_show / git_branches / git_blame / git_commit / git_push / git_fetch / git_pull
- **扩展** `packages/client`（加客户端订阅类型，不破协议）
- **不扩** `packages/natives`（0 改动，21 模块够用）

### Layer 1：内核（不扩 / 1 处扩展）
- **不扩** `packages/agent` / `packages/ai`
- **不扩** Rust natives
- **1 处扩展** `packages/coding-agent`
  - LSP writethrough 续接（fs_write 路径）

---

## 6. 兼容架构（4 层硬约束）

```
┌────────────────────────────────────────────────────────┐
│  Layer 4: 编辑器扩展（new）                              │
│  packages/editor-extension (Vite+React+TS)              │
│  借鉴模块：编辑器相关全部（见 Layer 4 表）                  │
└────────────────────────────────────────────────────────┘
                          │
                          │ 同一份 ClientAdapter
                          ▼
┌────────────────────────────────────────────────────────┐
│  Layer 3: web-app (扩展)                                │
│  packages/web-app                                       │
│  ⚠ session list / 三态 / selected_agent / host_tools /  │
│    Store-per-concern / Search UI 接通                    │
└────────────────────────────────────────────────────────┘
                          │
                          │ wire (JSON-over-WS @ 7891)
                          ▼
┌────────────────────────────────────────────────────────┐
│  Layer 2: wire + natives (扩展)                       │
│  packages/wire (新加 wire 命令, 不破协议)             │
│  packages/natives (0 改动)                           │
│  packages/client (扩展类型, 不破协议)                 │
└────────────────────────────────────────────────────────┘
                          │
                          │ 同一份协议
                          ▼
┌────────────────────────────────────────────────────────┐
│  Layer 1: 内核 (1 处扩展)                                │
│  packages/coding-agent (LSP writethrough 必做)          │
│  packages/agent / packages/ai (0 改动)                  │
│  Rust natives (0 改动)                                  │
└────────────────────────────────────────────────────────┘
```

### 6 条硬约束

| # | 规则 | 反例 |
|---|---|---|
| ① | 借鉴必须挂前端 | IResource 不进 coding-agent |
| ② | wire 协议只加不破 | fs_write 走 `cmd: "fs.write"` 不重写 v2 |
| ③ | 改一处全跟随 | retention 在 web-app 实现，CLI 调 web-app 复用 |
| ④ | 内核 0 改动（除 LSP writethrough） | 不给"编辑器模式"加分支 |
| ⑤ | 新前端可挂载 | editor-extension 跟 web-app 平级 |
| ⑥ | 不为借鉴完整性而借鉴 | 为功能需求驱动 |

---

## 7. MVP 切分（5-7 周 MVP / 9-12 周 v1 全）

### 阶段 0：wire 新命令 + LSP writethrough（2-3 周）
- fs_write / fs_edit / fs_diff wire 命令
- chunked fs_read
- git_status / git_diff / git_log / git_show / git_branches wire 命令
- coding-agent LSP writethrough 续接
- 验收：ClientAdapter 能调这些 wire 命令并拿到正确结果；fs_write 后 LSP 不丢状态

### 阶段 1：editor-extension 包骨架 + Monaco + Agent panel（3-4 周）
- 新建 `packages/editor-extension` (Vite + React + TS)
- 集成 Monaco
- IResource 模型 + 多打开方式
- Agent panel（接通 ClientAdapter）
- ⌘P Quick Open + Search / Find in Files（接通 natives）
- Terminal 标签（接通 natives.pty + Shell）
- permission_request UI 卡片
- Save conflict 策略（提示）
- ChatResponse 三态 UI
- ACP retention UI（接通 session list）
- Store-per-concern 拆分 zustand
- 验收：编辑器包能起；打开项目；改文件能保存；跟 agent 聊天；开 terminal

### 阶段 2：Git 集成 + Mention + Diff（2-3 周）
- git_blame / git_commit / git_push / git_fetch / git_pull wire 命令
- Git panel UI（status / diff / log / branches）
- Inline dirty diff
- Mention @file:10-20
- 验收：编辑器里能看到 git 状态；能 commit；能 mention 文件行段

### 阶段 3：差异化增强（2-3 周）
- AI Inline Chat 状态机
- BufferCodegen 回放
- Crash recovery / Local history
- Code Actions / Quick Fix（接通 LSP）
- Symbol Outline / Breadcrumbs（接通 LSP）
- Markdown live preview
- host_tools（编辑器给 agent 提供工具）
- selected_agent 切换 UI
- 验收：跟 agent 改文件全过程追踪；崩了能恢复；mention 行级引用

### 总账
- MVP（阶段 0 + 1）：**5-7 周**
- v1 全（0 + 1 + 2 + 3）：**9-12 周**

---

## 8. v1 决策门第 2 步待用户拍板的 5 件事

| # | 待定 | v1 推荐 | 备选 |
|---|---|---|---|
| 1 | 编辑器内核选型 | **MVP Monaco，v2 评估自研** | 直接自研内核（+6 周代价） |
| 2 | `fs_write` 路径走 LSP writethrough | **必做**（否则破坏现有 LSP 回路） | 不续接（接受格式丢失） |
| 3 | `git_*` 命令实现方式 | **前端 spawn git 子进程 + wire 11 命令** | 加进 `coding-agent/src/tools/` git 工具集 |
| 4 | `editor-extension` 是新 package 还是 web-app 子模块 | **新 package**（与 desktop/web-app 平级） | web-app 子模块（节省包构建，但耦合度高） |
| 5 | ACP 跟编辑器的关系 | **编辑器走 wire 直供**（ACP 无 file ops） | 强行走 ACP（不现实） |

---

## 9. 实施原则（沿用金句）

- **改内核大家跟着变**：fs_write/git_* wire 命令实现后，CLI 调 web-app 复用、桌面端调 web-app 复用、编辑器端调 web-app 复用——一处实现三处受益
- **内核 0 改动是默认目标**：超出表格内核列的能力（除 LSP writethrough 1 处）都要单独评估 ROI
- **前端 ≠ web-app**：web-app 资产不能简单一锅端进编辑器（rendering 栈不同）；但 web-app 的**纯逻辑组件**（ApprovalCard 等）可以搬运
- **LSP 不重新发明**：编辑器只接 LSP via lspmux 客户端，不当 LSP server

---

## 10. 文件归属

| 文件 | 状态 |
|---|---|
| `01-current-state.md` | A 报告，保留作为现状底 |
| `02-borrow-mapping.md` | B 报告，保留作为借鉴对照 |
| `03-architecture-draft.md` | v0 草案，**已归档**（追加归档标记） |
| `topics/v1-synthesis.md` | **本文件**：v1 方案合成 |
| `topics/v2-final.md` | **待创建**：用户拍板后写最终 v2 |

---

## 11. 维护

- 本文件由 v0 → v1 合成（2026-08-23）
- 用户拍板后写 `topics/v2-final.md` 锁版本
- 实施过程中如发现借鉴模块映射不对 / 时间账偏差，回写本文件