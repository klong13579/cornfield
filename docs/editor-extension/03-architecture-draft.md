# cornfield 编辑器扩展架构草案 v0

> 状态：**v0 草案（已归档）** —— 2026-08-23 已被 `topics/v1-synthesis.md` 取代
> 写作约束：不依赖源码细节，靠 OpenSumi/Zed 已知模式 + 上下文已确认事实
> 双版本并列：OpenSumi 风格（IDE 框架嫁接）vs Zed 风格（编辑器 fork 嫁接）
> 标档规则：✓ 已确认（带文件:行号）/ ⚠ 推断（依据说明）/ ✗ 缺（需补什么）

---

> **归档说明（2026-08-23）**：
> 1. v0 推荐"OpenSumi 风格"判断仍然有效，但**已被 v1 精细化**——主借鉴 OpenSumi + 按需借鉴 Zed（25 个模块）
> 2. v0 的"前端 spawn git + 不进内核"判断 v1 修正为"前端 spawn git + 走 wire 11 命令"
> 3. v0 的"MVP 4-6 周"判断 v1 修正为"5-7 周 MVP，9-12 周 v1 全"
> 4. v0 漏掉的功能：Search / Quick Open / Terminal / Save conflict / LSP writethrough / Crash recovery / Code Actions / Markdown preview / Symbol Outline 等已在 v1 补回
> 5. 取代文件：`topics/v1-synthesis.md`
> 6. 历史关联文档：`docs/omp-client-design.md`（已废弃 2026-08-21）、`docs/omp-client-zed-integration.md`（待拍板）

---

## 1. 设计原则（来自用户，金句）

> "我希望所有底层和 cli 都是共用的，cli 和客户端，乃至 web 只是不同的前端展示方式。**改内核，大家都会跟着变化而不是分别修改**。"

> 编辑器是"嫁接"不是"新建"——挂在已有前端或新建但复用全部内核。

落点：

- 编辑能力不是差异化，光标/buffer/textmate/LSP/lint/补全是红海。差异化在 agent 层（多 worker / 审批 / cron / 记忆 / 学习沉淀）。
- 编辑器作为前端，**worker = coding-agent 内核**，已存在的链路不改。Editor 改它能改的部分（光标、buffer、UI），不动 agent 主循环。
- 任何一版方案都必须满足：改 wire / client / coding-agent 内核，三个前端（CLI / 桌面 / 编辑器）受益，而不是反向。

---

## 2. 共同需求矩阵

4 个需求按用户视角 / 内核需求 / 前端需求 / 关键难点展开。

| 需求 | 用户视角 | 内核需求（coding-agent + wire + natives） | 前端需求（web-app / desktop / 编辑器） | 关键难点 |
|---|---|---|---|---|
| **1. 项目选择** | 打开一个本地目录（文件夹 / 工作空间）作为 agent 工作根；记忆 sessions/skills 与项目绑定 | `Default_sessionInfo().cwd` 已存在（`cornfield serve` 接受 `--cwd`，web-app 已有 `workspaceDir` 设置项）；`natives` 提供 `readdir`/`stat`/`fs-cache`（`packages/natives`）。⚠ 推断：`lspmux` 已为 LSP 多路复用，**项目可作为 LSP 工作根切换基线**（`packages/coding-agent/src/lsp/lspmux.ts:30` 起） | 工作空间选择 UI（最近列表 + 文件夹浏览器 + remote/SSH/容器化路径的 picker 占位）；状态上下文沿用 `client-adapter` 模式（`packages/web-app/src/state/client-adapter.ts`） | 内核已具备 `cwd` 概念，**项目 = cwd；不需要新建领域模型**。难点在前端：路径合法性提示（大目录/隐藏文件/权限）、最近列表持久化、与已存在的 `settings.worktreeUri` 字段的关系 |
| **2. 文件编辑与预览** | 在编辑器里改文件、diff、行内预览、自动保存、语言识别、撤销重做 | 编辑**操作**全部已存在：`read`/`write`/`edit`/`ast-edit`/`ast-grep`（`packages/coding-agent/src/tools/`）；文件 watcher / fs cache / 文件记录回放（`file-recorder.ts`、`fs-cache-invalidation.ts`）。⚠ 推断：buffer 模型、CRDT/OT、MIME/snippet 当前**不存在**——需要编辑器前端自己解决，不能 push 给内核 | Editor 内的 buffer / 选区 / IME / 渲染（Monaco / CodeMirror 6 / Surreal / GPUI）；与 worker 写作的同步通道（RPC） | **架构最大风险**：内核只接受 "整段读 / 整段写 / 点位 edit" 三类语义，编辑器本地的"局部乐观锁"是该前端独有的范畴。**需要在 worker 内建一个 `fs/diff/protocol` 通道**——v0 假设走 `wire` 的扩展位（`commands.ts` 加 `fileEditStream` 类），不让编辑语义渗入 coding-agent 主循环 |
| **3. Git 集成** | diff / status / branch / log / blame / commit / push / PR 创建 + agent 触发 | `gh` 工具已就位（`packages/coding-agent/src/tools/gh.ts` + `gh-renderer.ts` + `gh-format.ts`）；⚠ 推断：纯 Git CLI 抽象层当前**没有**——`bash` 工具能跑 `git`，但没有 typed Git ops。前端若想要"图形化 diff"必须自己 fork diff 渲染或借用 `git` CLI 输出 | Editor 内 git panel (vscode 风格: changes / graph / blame gutter)；commit/PR UI；agent 触发提交走 `gh` 工具 | 内核已有 `gh`，**缺 typed git ops 层**。要么前端直接 `spawn git`（干净、独立），要么给 `coding-agent/src/tools/` 加 `git` 工具集。**MVP 建议前者**（干净，避免内核瘦身） |
| **4. Agent assistant** | 侧栏 / 面板会话、inline edit、⌘K、审批卡、CRUD skill/todo/memory | 全部已有：ACP external agent 模式（`packages/coding-agent/src/modes/acp/`）、wire 双向帧协议、`ApprovalCard`、`ClarifyCard`、`FloatingCardHost`（`packages/web-app/src/render/`）、MCP（`packages/coding-agent/src/mcp/`）、skill/todo/memory 全部 tools | Editor 内 agent 面板 UI；inline diff / ⌘K hook；审批卡渲染（直接复用 web-app 卡片组件或 host 一个 WKWebView 跑 web-app） | 这是差异化战场。**不能"另起一套 agent UI"**——必须复用 web-app 已有组件（ApprovalCard 等已生产验证）。Editor 端工作是"在编辑器坐标系里挂一个 agent panel"，不是新建 agent UI 子项目 |

共性结论（适用于 §3 / §4 两版）：

- **内核 0 改动**应作为默认目标。任何超出 §2 表格内核列的能力（typed git ops、file edit streaming protocol）都要单独评估 ROI。
- **编辑器前端 ≠ web-app**：web-app 资产不能简单一锅端进编辑器（rendering 栈不同）；但 web-app 的**纯逻辑组件**（card state machine / markdown 渲染 / approval 流）可以搬运。
- **LSP 不重新发明**：`lspmux` 已经存在（`packages/coding-agent/src/lsp/lspmux.ts:30`），编辑器只接 LSP via lspmux 客户端，自己不当 LSP server。

---

## 3. OpenSumi 风格草案

> 思路：把 OpenSumi 当**IDE 框架**看待——vscode-style 工作空间、扩展协议、内置 Webview 渲染。**直接复用 web-app 资产**，编辑器 = "编辑器形态的 web-app"。

### 3.1 进程模型

```
┌─────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  Electron 主进程     │  │  cornfield serve sidecar   │  │  Renderer (Chromium) │
│  - app lifecycle    │  │  (worker = 内核)      │  │  - WKWebView/WebView │
│  - 多 BrowserWindow │◀─│  wire (WS @7891)  │─▶│  - 编辑器内核(JS)    │
│  - 上传/通知/截屏    │  │  natives(Rust)    │  │  - agent panel       │
└─────────────────────┘  └──────────────────────┘  └──────────────────────┘
                                  ▲
                                  │ wire (WS / wss)
                                  ▼
                            ┌──────────────┐
                            │  浏览器/web-app│  ← 同款渲染（同份代码）
                            └──────────────┘
```

**特点**：

- 编辑器内核 = **JS 进程内运行**（编辑器引擎不在独立进程）。简化部署，单 Electron app 单 sidecar。
- 浏览器/web-app 不需要新协议：现有 `client → wire`（web-app 已 `catalog:` 依赖）足以承担"远程编辑会话"。
- OpenSumi 风格的 Webview Extension 本质是 iframe + postMessage，几乎零边界。

### 3.2 协议层

| 维度 | 选型 | 来源 |
|---|---|---|
| 传输 | WebSocket（与现有 wire 一致），新加 `app-level channels` | `packages/wire/src/frames.ts` |
| 序列化 | 现有 JSON（wire 已定义）| 同上 |
| 消息模型 | request/response（id 关联）+ subscribe（事件流），与现有 wire 命令重合 | 已存在的 snapshot cache、subscribe-across-reconnect |
| 文件编辑通道 | **新增**：`fileEditStream { sessionId, op: "open"\|"change"\|"close" }` —— 在 wire 扩展位加 enum，不侵入已存在协议 | ⚠ 推断，v1 时上 gitnexus check |
| Git ops | 通过 `gh` + `bash`（现有工具），**不**新增 git 工具集 | `packages/coding-agent/src/tools/gh.ts` |

### 3.3 前端分层

```
┌──────────────────────────────────────────────────────┐
│  宿主壳 (Electron BrowserWindow)                       │
│  ├─ preload.ts 暴露 IPC（FS 访问范围、native menu、env）│
│  └─ main.ts 管多窗口 / 通知 / sidecar 生命周期         │
├──────────────────────────────────────────────────────┤
│  适配层 (OpenSumi-style IDE 框架)                       │
│  ├─ Workbench 容器（layout: sidebar/panel/editor area）│
│  ├─ Extension host (extension slot + contribution)    │
│  └─ IPC ↔ client（与 web-app 同款）                 │
├──────────────────────────────────────────────────────┤
│  UI 组件层                                              │
│  ├─ Tree View (文件树)                                  │
│  ├─ Editor Pane (Monaco 或 CodeMirror 6 — 纯 JS)      │
│  ├─ Webview 容器 (渲染 CornField 卡片 / 审批)                 │
│  └─ Side Panel / Activity Bar / Status Bar            │
├──────────────────────────────────────────────────────┤
│  编辑器内核 (JS)                                        │
│  ├─ Document/FileModel (= LSP TextDocument sync)       │
│  ├─ Monaco / CM6 instance                              │
│  ├─ 装饰层 (diff / inline edit 指示)                    │
│  └─ LSP client (经 lspmux)                             │
└──────────────────────────────────────────────────────┘
```

### 3.4 模块归属

| 改动对象 | 内容 | 理由 |
|---|---|---|
| **新建** `packages/editor-extension` | OpenSumi-style workbench 框架、extension slot、布局引擎 | 不污染 `web-app`，编辑器是独立前端 |
| **扩展** `packages/desktop` | 加 "IDE 模式" 菜单项 / 多窗口 / dev URL 指向 editor-extension dev server | `desktop/main.ts:50` 已支持 `CORNFIELD_DESKTOP_DEV_URL`（✓ 已确认） |
| **不扩** `packages/web-app` | 渲染层复用 web-app 资产，但不在 web-app 包内编辑器化 | 避免 web-app 变成编辑器壳 |
| **只读** `packages/coding-agent` | ACP mode + 现有 tools 不动；新增可选 `fileEditStream` 走 `wire` 扩展位 | 内核稳定 |
| **复用** `packages/wire` / `packages/client` | 加 wire 命令 / 客户端订阅类型；web-app 升级时同步受益 | 与金句一致 |

### 3.5 嫁接到 cornfield 哪里

```
desktop (Electron) ──┐
                     ├── spawn ──> cornfield serve (worker)
                     │               │
                     ▼               ▼
              editor-extension ──> client (WS) ──> wire
                                                ▲
                                                │ 同一协议
                                                │
                                web-app (现存) ──┘
```

- **入口位置**：现 `desktop` 的桌面壳内，开新窗口（File → Open Folder → Project）走 editor-extension。
- **workspace state**：与现 web-app 共享同一 `~/.cornfield/agent/registry.json` 工作目录字段（已确认 ✓）。
- **无缝切换**：右上角加 "切换到 Agent" → 关闭 IDE 窗口，打开 web-app 窗口；两窗口共享同一 worker（sidecar 不退出）。

### 3.6 MVP 切分

- **阶段 1（最小可用，4-6 周）**：
  - 建 `packages/editor-extension`（Vite + React + TS）
  - 集成 Monaco editor、单 DocumentModel、跟 worker 的 `file.read`/`file.write` 走 wire
  - 文件树 + 简单 Git status（`git status --porcelain` spawn，不进内核）
  - 现有 web-app 资产（卡片 / markdown / agent 视图）作为 iframe / webview 嵌入工作台侧栏
- **阶段 2（Agent 增强 + 协作，3-4 周）**：
  - 加 LSP via lspmux（rust-analyzer 优先）
  - inline diff / ⌘K 接入 worker edit 工具
  - 多窗口 / 项目并行（已存在的 sidecar 复用模式扩到多实例）
- **阶段 3（数字员工差异化，B 路线对接）+2 周**：
  - 审批卡渲染（直接挂 web-app `<ApprovalCard>`）
  - cron / 多 agent 视觉化（与 web-app `pages/agents` 同款 iframe）

---

## 4. Zed 风格草案

> 思路：把 Zed 当**编辑器 fork 的容器**看待。Zed fork = CornField edit 子模块，宿主由 AppKit/Tauri/Electron 之一持有，**worker 还是 worker**。

### 4.1 进程模型

```
┌──────────────────────────────────────────────────────────┐
│  原生壳 (macOS AppKit + contentView / Tauri / Electron)   │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │  WKWebView    │  │  GPUIView     │  │  NSStatusItem   │ │
│  │  (CornField 面板)   │  │  (编辑器)     │  │  (托盘)         │ │
│  │  web-app      │  │  Zed fork     │  │                 │ │
│  └──────┬───────┘  └──────┬───────┘  └─────────────────┘ │
│         │                  │                              │
│         │  wire (WS)    │  ACP / MCP / wire         │
│         ▼                  ▼                              │
│    ┌──────────────────────────────────────────┐          │
│    │  cornfield serve (worker sidecar, 已实现)        │          │
│    │  现有 25+ tools / sessions / memory       │          │
│    └──────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────┘
```

**特点**：

- 编辑器进程（Rust 原生，Zed fork）独立，崩了不影响 agent 控制台。
- 与 `omp-client-zed-integration.md` (B') 已定稿的"原生壳 + GPUIView 深嵌"思路兼容。
- 浏览器/web-app 侧旁路，并行存在。

### 4.2 协议层

| 维度 | 选型 | 来源 |
|---|---|---|
| 传输 | 编辑器 ↔ worker：ACP + MCP（已上线）+ wire（OOP web-app 走） ；壳 ↔ 编辑器：原生 channel | `packages/coding-agent/src/modes/acp/acp-mode.ts:13` 起（✓ 已确认） |
| 文件编辑通道 | 编辑器本地 buffer ↔ worker 的语义对账：worker 的 `read`/`write`/`edit` 工具 + 编辑器本地"未保存改动"通过 `fs-edit-protocol`（Zed 风格自定义 pipe） | ⚠ 推断 |
| Git ops | 同 OpenSumi 风格：worker `gh` + bash（不新增 git 工具） |  |

### 4.3 前端分层

```
┌──────────────────────────────────────────────────────┐
│  原生壳 (AppKit)                                       │
│  ├─ NSWindow.contentView                              │
│  ├─ Mode Switch (顶部 [Agent|IDE] 切换)               │
│  ├─ Worker Sidecar Manager                            │
├──────────────────────────────────────────────────────┤
│  CornField 控制台 view (WKWebView → web-app)                 │
│  └─ web-app 资产零修改                                       │
├──────────────────────────────────────────────────────┤
│  GPUIView 编辑器 view (Zed fork)                       │
│  ├─ Project Panel (文件树)                             │
│  ├─ Editor Pane (Zed 编辑核心)                         │
│  ├─ Agent Panel (Zed 原生 + CornField 面板共存)              │
│  ├─ Terminal / Git Panel                              │
│  └─ Keymap / Theme                                    │
└──────────────────────────────────────────────────────┘
```

### 4.4 模块归属

| 改动对象 | 内容 | 理由 |
|---|---|---|
| **新建** `repos/zomp` (Zed fork，外部 repo) | 改 `WindowOptions` 支持 embedded mode、`zed/src/main.rs:126` 入口支持外部 host、加 CornField 品牌/bundle id | `brush-vendored` 已先例（独立 repo，运行时 spawn 接入） |
| **不扩** `packages/coding-agent` | ACP 入口已就位（✓ 已确认 `modes/acp/`）；不引入 Rust 编译关系 | 内核稳定 |
| **不扩** `packages/desktop` | 短期内不依赖；Zed fork 走独立壳脚本启动 | 与 `omp-client-design.md` 已废弃项保持距离（避免双重路径） |
| **不扩** `packages/web-app` | 不污染 web-app；Zed 侧是 Rust / GPUI 视角 | 渲染栈异构 |
| **复用** `packages/wire` / `packages/client` | Zed fork 接 client 的 TS 实现（或自己 port 到 Rust，⚠ 推断短期不现实） | ⚠ v1 评估：port client 到 Rust 成本 |

### 4.5 嫁接到 cornfield 哪里

- **入口位置**：Zomp 原生 app，从 dock 启动；`Open Folder` 走 Zed 项目面板原有逻辑。
- **worker 通信**：Zed fork 通过 ACP 把 CornField worker 注册为 agent panel（Zed 原生 ACP 支持）；
  Zed 内编辑器对文件的所有操作走 Zed 本地 buffer；commit/push/inline edit 通过 worker 触发。
- **无缝切换**：Zomp app 顶部模式切换（已在 `omp-client-zed-integration.md:30` 定稿 ✓）——Agent 模式 = WKWebView(web-app) / IDE 模式 = GPUIView(Zed fork)。

### 4.6 MVP 切分

- **阶段 1（P0 spike，1-2 周）**：
  - 裸 AppKit + GPUIView 嵌入验证（功耗/first responder/绘制）
  - Zed workspace 能打开
- **阶段 2（P1 Zomp 壳，2-4 周）**：
  - embedded mode 稳定 + brand + worker sidecar 拉起
  - CornField worker 注册为 Zed ACP agent
- **阶段 3（P2 CornField 面板，2-3 周）**：
  - WKWebView 侧栏 + 顶部模式切换
  - 接 wire 进行卡片 / 状态同步
- **阶段 4（P3 CornField 差异化定制，3-5 周）**：
  - CornField 侧栏扩展（fork 内）——审批/cron/多 agent 视觉
  - ⌘K inline edit 挂点

---

## 5. 双版对比

| 维度 | OpenSumi 风格 | Zed 风格 | 我的推荐 | 理由 |
|---|---|---|---|---|
| **进程复杂度** | 1 进程（Electron）+ 1 sidecar；编辑器 JS 跑在 renderer | 2 进程（原生壳 + GPUI 进程）+ 1 sidecar；fork 独立构建 | OpenSumi | 单进程部署/调试都更简单；团队 JS 为主无需补 Rust 人力 |
| **协议耦合度** | 低：纯走现有 wire，extension 走 webview iframe | 中：ACP（已上线） + MCP（已上线） + 自定义 fs-edit-protocol（⚠ 新增） + wire port（⚠ Rust port 成本） | OpenSumi | 新增协议面越少越好；内核 0 改动才是金句本意 |
| **编辑器内核选择** | Monaco (Battle-tested) 或 CodeMirror 6 (小、轻)；都纯 JS、MIT | Zed 原生（GPUI、Rust、Apache/GPL-3.0） | OpenSumi | 编辑光标/buffer 不是差异化，不值得为它背 fork 维护账 |
| **扩展性** | webview + 自定义 contribution，纯 web 生态（vscode extension API 风格） | Zed extension API（Rust + WASM）；扩展机制成熟但需要 Rust 写扩展 | OpenSumi | 50 人团队主导 web，扩展成本 CornField 团队可消化；Rust 扩展团队门槛高 |
| **跟 cornfield 现状契合度** | 极高：现有 `desktop` + `web-app` 资产直接复用；`CORNFIELD_DESKTOP_DEV_URL` 已支持多窗口入口（✓ 已确认 `desktop/main.ts:50`） | 中：需新建 `repos/zomp`（类比 brush-vendored），双 Cargo workspace 双 release pipeline；已有 `omp-client-zed-integration.md` 作为前置文档但**未被产品采用** | OpenSumi | 一致性：omp-client-design.md 2026-08-21 标"已废弃"——避免在尚未拍板的位置再次深入 |
| **MVP 成本** | 4-6 周（1 资深 web）| 8-10 周（1-2 资深 Rust + 部分 web）；P0 spike 还需 1-2 周验证可行性 | OpenSumi | 时间/人力账差 2 倍；web-app 已有 agent 卡片、MCP、agent UI 资产 |
| **长期演化** | 路径平滑：从 web-app 内 iframe → 抽出独立 extension → 演进为完整 IDE 形态（OpenSumi/Code-OSS 都走过这条路） | 起点即重 fork：`gpui` 上游主分支日更，季度 rebase 账 +1，GPL-3.0 合规复审账 +1 | OpenSumi | 风险账更小，**演化路径是"渐进"，不是"先冲一把"** |

---

## 6. 我的推荐

**OpenSumi 风格作为主推**。理由：(1) 跟现有 `desktop` + `web-app` 资产契合度最高，`CORNFIELD_DESKTOP_DEV_URL` 这个口子已经留好了；(2) 编辑器内核（Monaco/CM6）不背 fork 维护账——光标/buffer/LSP 是红海，不是 CornField 差异化位面；(3) 内核 0 改动严格满足用户"改内核大家跟着变"原则；(4) MVP 时间/人力账短一倍以上。

**可混搭点**（保留 Zed 优势的子项）：

1. **顶部模式切换**：OpenSumi 风格只在 Electron 窗口内布局（侧栏 + 主区 + 面板），不强行分窗口；如果未来团队想要 macOS 原生体验，再单独评估"原生壳 + WKWebView + 工作台"组合。
2. **LSP 复用 lspmux**：两版都用，不带 fork 包袱。
3. **审批 / 卡片渲染**：直接 host web-app fragment（iframe 化）而非自写一套，跨前端一致。
4. **Zed 风格仅在 Phase 4+ 探索**：如发现 web-app iframe 体验差到必须换栈，再评估 Zed fork 的 P0 spike——届时已有了 runner。

不推荐 Zed 风格为主推的核心理由：**编辑体验不是差异化，差异化在 agent**——为编辑器背 fork 账是性价比最低的选择。

---

## 7. v0 之后的下一步

1. **Task A 摸底（推荐并行）**：
   - `packages/desktop/src/sidecar.ts` 完整进程模型 + 多实例可行性
   - `packages/wire/src/commands.ts` 现有扩展位 + 命名空间策略
   - `packages/coding-agent/src/tools/{read,write,edit,bash}` 已经覆盖 vs 编辑器需要的差距清单
   - `packages/coding-agent/src/lsp/lspmux.ts` 客户端协议（影响编辑器怎么接 LSP）

2. **Task B 用户痛点佐证（并行）**：
   - 把"项目选择 / 文件编辑 / Git / Agent" 4 块对应的 web-app 现状摸清：哪些已可用 / 哪些已不可用 / 用户具体被卡在哪
   - 现有 `~/.cornfield/agent/registry.json` 工作目录管理 + workspace state 字段

3. **v1 合成**：基于 A + B 出 v1 草案，定 (a) `packages/editor-extension` 包结构与依赖 (b) `wire` 扩展位命名规范 (c) MVP 阶段 1 真实工作量。

4. **决策门（v1 出后）**：
   - v1 必须明确 §3.6 vs §4.6 哪一套最终开工的判断标准
   - 任何时候选 Zed 风格，必须先做 P0 spike（1-2 周 GPUIView 嵌入验证）才能进 P1

---

## 附录 A：v0 标档说明

| 符号 | 含义 |
|---|---|
| ✓ 已确认 | 来自上下文/源码直接验证（如 `desktop/main.ts:50` 引用 `CORNFIELD_DESKTOP_DEV_URL`） |
| ⚠ 推断 | 基于已知模式推测（如"lspmux 已为多工作空间准备"未在源码内逐字确认） |
| ✗ 缺 | v1 必须补（v0 阶段明确不依赖 A/B，但标记给主 session 留意） |

## 附录 B：与已有文档的关系

- `docs/omp-client-design.md`（状态：已废弃，2026-08-21）——历史提案 A：Tauri + Zed 窗口级。本草案 §4 Zed 风格的部分元素与之有继承但**不重复**，主推不沿用。
- `docs/omp-client-zed-integration.md`（状态：方案待拍板，2026-08-21）——B': 原生壳 + GPUIView 深嵌。Zed 风格如展开需复用此文档的阶段计划；OpenSumi 风格与此文档无直接耦合。
- `docs/omp-client-zed-integration.spec.md` ——上述文档的 spec 细化；当前不动。

v0 草案结束，等待主 session 用 Task A / Task B 结果合成 v1。
