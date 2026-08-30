# 编辑器扩展

> 状态：设计

本文汇总编辑器扩展的现状摸底、外部借鉴（OpenSumi / Zed）与架构结论。现状部分基于仓库实测（✓ 已确认 / ⚠ 推断 / ✗ 缺），架构结论以 OpenSumi 风格为主推、Zed 按需借鉴。

## 1. 现状摸底：加前端编辑器扩展前要看清的能力

> 范围：仓库 `/Users/sz-0203015357/Desktop/Narwal/oh-my-pi` 内已有能力。
> 读法：✓ 已确认（带文件:行号）/ ⚠ 推断（带依据）/ ✗ 缺（带「需要新建什么」）。
> 目标：让「加编辑器扩展」决策时知道哪些能复用、哪些要新建、哪些要扩。

### 1.1 前端壳

#### Electron 桌面壳 (packages/desktop)

- ✓ Sidecar 进程机制：Electron 启动时 `ensureSidecar` 把 `cornfield serve` 作为子进程拉起，监听 `127.0.0.1:7891`，注入 `CORNFIELD_SIDECAR=1` 环境变量用于进程识别；端口被占且不是我方时直接复用。固定端口 `SERVE_PORT = 7891`。
  - `packages/desktop/src/sidecar.ts:13-17, 175-184`
- ✓ Sidecar 二进制解析优先级：env `CORNFIELD_BINARY` > 打包内嵌 `resourcesPath/cornfield-binary/cornfield` > `~/.local/bin/cornfield` > 开发 build `coding-agent/dist/cornfield` > PATH 回退。
  - `packages/desktop/src/sidecar.ts:53-72`
- ✓ Electron ↔ sidecar 通信：sidecar 在 `7891` 起 WebSocket serve，**主进程序没有任何直连 IPC 到 sidecar**（不靠 stdio/HTTP），Electron 只负责把渲染层（web-app dist）作为 BrowserWindow 加载 + 维护托盘常驻 + electron-updater。
  - `packages/desktop/src/main.ts:46-105`（`loadURL` / `loadFile`），`:75-77`（占位 HTML 内现写「连接 ws://127.0.0.1:7891/ws」）
- ✓ Electron 当前能挂的 UI：`BrowserWindow`（1200×800 占位 + 隐藏关闭 → 托盘常驻）+ `Tray`（显示/退出）+ `Menu`（托盘右键）。**没有 child window、没有 webview、没有扩展宿主。**
  - `packages/desktop/src/main.ts:8-44, 107-118, 200-207`
- ✓ IPC channel 一览（renderer 侧由 `preload.ts` 通过 `contextBridge` 暴露 `window.api`）：只有 `sidecar:get-workspace-dir` / `sidecar:set-workspace-dir` / `app:*`（version+update）——**没有任何「插件/编辑器/文件浏览」IPC**。
  - `packages/desktop/src/preload.ts:11-44`
- ⚠ 没有任何「宿主给宿主加载插件」的钩子。preload 是最小面，contextIsolation+sandbox+nodeIntegration=false 全锁死。要给编辑器开「文件读、原生菜单、shell spawn」必须扩 preload + ipcMain.handle。
- ⚠ 编辑器若要真"嫁接"到 Electron，最小新面是：preload 加 `window.api.editor.*`（fs_list/fs_read/fs_write 透传）+ 主进程起 `BrowserView` 或 child BrowserWindow 嵌入 web 应用页面（基于 React）。当前 web-app 是嵌进 Electron 的同一份渲染层，自然可以走「Web app 内嵌编辑器视图」。

#### Web 应用 (packages/web-app)

- ✓ `packages/web-app` 是 React + Vite + Tailwind + TypeScript 多页应用；通过 `ClientAdapter` 包装 `client`，连接 `ws://127.0.0.1:7891/ws`（electron 跑时由 sidecar 提供）。
  - `packages/web-app/src/state/client-adapter.ts:83-127`
- ✓ 连接默认配置硬编码 `ws://127.0.0.1:7891/ws`，token 走 localStorage 持久化（设置页可改）。
  - `packages/web-app/src/state/client-adapter.ts:91-93`
- ⚠ 已知路由/pages：`agents`、`home`、`insights`、`memory`、`models`、`records`、`settings`、`skills`、`tasks`、`todo`、`voice`、`workspace`。当前整体定位是 **agent 管理 + 会话回放 + 工具能力 + 设置**，偏 chat-style 与运维控制台；**无 IDE 无 monaco**。
- ✓ 已有的「只读文件视图」：`FileExplorer` 用 `fs_list`/`fs_read` 懒加载目录树 + 文本预览（不写、不 diff、不选中行操作）。
  - `packages/web-app/src/pages/workspace/FileExplorer.tsx:5, 59-180`
- ⚠ 因此现状：「文件树 + 预览」半套已有，「写/编辑/diff/git 操作按钮/git 集成/Agent assistant 板」全套没有。

### 1.2 协议层

#### wire

- ✓ 序列化：**纯 JSON 字符串**（`<frame>` → `ws.send(JSON.stringify(...))`）。无 MessagePack、无自定义二进制。
  - 协议格式：`ClientFrame` / `ServerFrame`，含 `hello/hello_ack/ping/pong/request/response/push` 六类。
  - `packages/wire/src/frames.ts:13-78`；`packages/client/src/client.ts:218, 266, 358`
- ✓ 传输：**WebSocket**（`WebSocketLike` 兼容浏览器/Bun/Node ws）。端点 `ws://host:port/ws`，hello 握手含 `version` + `token`。
  - `packages/wire/src/frames.ts:18-20`；`packages/client/src/client.ts:85-115`
- ✓ 协议版本：`MULTIDEVICE_PROTOCOL_VERSION = 1`，向后兼容语义：加 push 帧为可选，旧客户端忽略未知帧仍可工作。
  - `packages/wire/src/frames.ts:14-22`
- ✓ 主消息类型与 schema：
  - `ClientFrame = hello | request | ping | host_tool_result | host_tool_update`
  - `ServerFrame = hello_ack | hello_error | response | push | pong`
  - `WireCommand` = `MultiplexCommand` (prompt/abort/new_session/set_todos/set_host_tools/set_model/set_thinking/compact/branch/fork_from/undo_exchange/retry_from/get_messages/switch_session/list_agents...) ∪ `WireExtensionCommand` (subscribe/get_snapshot/attach/detach/list_sessions/get_session_messages/fs_list/fs_read/fs_read_image/gateway_status/get_stats/get_memory/get_skills/set_skill_enabled/set_model_disabled/inject_permission/permission_respond/record_transcribe/listen_list/list_commands/get_cron_tasks/get_cron_logs/cancel_queued...)
  - `WireServerEvent = server_snapshot | session_snapshot | progress | host_tool_call | host_tool_cancel | host_tools_changed | permission_request`
  - 位置：`packages/wire/src/commands.ts:30-200+`；`packages/wire/src/frames.ts:80-152`
- ✓ wire 设计严格只在「传输形状」层；零运行时依赖 coding-agent（`packages/wire/src/index.ts:1-15`）。命令面收录需要人 review 代码：`wire` 加 → coding-agent 端 wire-server 加。
- ✓ 错误码枚举 12 类（rate_limit/quota_exhausted/tool_limit_reached/cancelled/internal...）已结构化在 `WireErrorPayload`，前端可分类处理。
  - `packages/wire/src/frames.ts:118-142`

#### client

- ✓ 一个类：`Client`（不是函数也不是 hook）。构造接受 `{ url, token, webSocketCtor?, protocolVersion?, requestTimeoutMs?, reconnectBaseMs?, reconnectMaxMs?, heartbeatIntervalMs?, heartbeatTimeoutMs? }`。
  - `packages/client/src/client.ts:67-117`
- ✓ 公开 API：`connect()` / `request<T>(WireCommand): Promise<T>` / `subscribe(listener)` / `subscribeSnapshot(listener)` / `getCachedSnapshot(sessionId)` / `close()`。
  - `packages/client/src/client.ts:184-243`
- ✓ 内部能力：指数退避重连、心跳（30s ping/60s pong 超时）、session_snapshot 缓存、断线时 in-flight 立刻 reject。
- ✓ 错误分类 4 类（断线/超时/服务错/握手错）便于上层针对性处理。
  - `packages/client/src/errors.ts:14-58`
- ⚠ 已能调用后端：**任何在 `WireCommand` 中的命令**——包括已经支持的 `fs_list/fs_read/fs_read_image/get_messages/list_sessions/get_snapshot/...`。
  - 因此"加编辑器"前端读文件的 wire 通道已经现成；**不存在「后端不支持」的协议层缺口**，只缺前端 UI。

#### ACP mode

- ✓ ACP server 端在 `coding-agent/src/modes/acp/`，基于 `@agentclientprotocol/sdk` 的 `AgentSideConnection`。stdio ndJsonStream 接入（不是 WS）。
  - `packages/coding-agent/src/modes/acp/acp-mode.ts:5-15`
- ✓ 暴露 ACP 能力清单（`AcpAgent implements Agent`，方法集）：
  - `initialize`（协议版本、agentInfo、authMethods、agentCapabilities：loadSession / mcpCapabilities.http+sse / promptCapabilities.embeddedContext+image / sessionCapabilities.list+fork+resume+close）— `acp-agent.ts:189-222`
  - `authenticate` — `acp-agent.ts:225-227`
  - `newSession` — `acp-agent.ts:229-240`
  - `loadSession` — `acp-agent.ts:242-253`
  - `listSessions`（分页 50/cursor）— `acp-agent.ts:255-269`
  - `resumeSession` / `unstable_forkSession` / `closeSession` — `acp-agent.ts:272-305`
  - `setSessionMode`（仅支持 "default"，拒绝其他）— `acp-agent.ts:306-315`
  - `setSessionConfigOption`（mode/model/thinking）— `acp-agent.ts:318-349`
  - `unstable_setSessionModel` — `acp-agent.ts:351-361`
  - `prompt`（核心）+ `cancel` — `acp-agent.ts:364-429`
  - `extMethod`（非标扩展：cornfield/sessions/listAll、cornfield/projects/list、cornfield/chats/byCwd、cornfield/usage、cornfield/extensions、cornfield/extensions/toggle 等）— `acp-agent.ts:431-507`
- ⚠ **没有 read/edit/runShell/listFiles 类工具调用能力。** ACP 是「会话控制 + LLM 交互」通道，不是 IDE 通道：编辑器需要的 file ops 不能挂 ACP。
- ✓ schema 位置：`@agentclientprotocol/sdk`（外部 npm 包）+ `acp-agent.ts` 中具体方法签名。
- ⚠ 编辑器要走 ACP 也只能复用 prompt/cancel + session 管理能力，**不要尝试把 fs_read/fs_write 挂到 ACP**——那是另一码事（既有 wire 已经能直供）。

### 1.3 内核抽象

#### agent runtime (packages/agent)

- ✓ 核心抽象：`Agent` class（不是 Session/Task/工具总线）。
  - `subscribe(fn)` 订阅 AgentEvent；`emitExternalEvent` 注入外源事件。
  - `prompt(message, options?)` / `steer(m)` / `followUp(m)` / `abort()`。
  - `setModel/setThinkingLevel/setSystemPrompt/setSteeringMode/setFollowUpMode`。
  - 工具注册走 `tools: AgentTool<any>[]` 在 `AgentState` 里维护（不是显式 register API）。
  - `packages/agent/src/agent.ts:443-680`；状态：`AgentState` `packages/agent/src/types.ts:233-243`
- ✓ `AgentEvent` 流：`message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_end` ——这是前端把 streaming 流式写 UI 的入口。
  - `packages/agent/src/types.ts:335+`
- ✓ 工具接口 `AgentTool<TParameters, TDetails, TTheme>`：`name/label/description/parameters/nonAbortable/concurrency/strict/intent/execute/renderCall/renderResult`。所有现有工具（read/write/edit/bash/lsp/find/search/ast-grep/ast-edit/...）都实现这一形态。
  - `packages/agent/src/types.ts:283-322`
- ✓ 可被前端消费的钩子：`subscribe` + `emitExternalEvent` + 状态 `state` getter。**但 `Agent` 是内存对像，与 coding-agent 内部 AgentSession/registry 不是一回事**；web-app 走 wire 不直接持有 Agent class。
- ⚠ 单 `Agent` 对 UI 友好，但下游真实运行时是 `AgentSession`（在 coding-agent/src/session/agent-session.ts 里）——前端看到的是 wire snapshot，不是 class。要在前端拿到 session 的"工具列表/系统提示/会话元"，需要 wire 已有 `get_state`/`get_snapshot`/`get_available_models` 等。

#### natives（Rust N-API）

- ✓ Rust crate：21 个 mod，`natives/src/lib.rs:24-45`。JS 侧由 `packages/natives/native/index.d.ts`（1208 行自动生成）暴露。
- ✓ N-API 已直接暴露的方法分块（grep `\[napi\]` 统计）：
  - `clipboard`：`copyToClipboard(text)` / `readImageFromClipboard()` → `ClipboardImage`（PNG bytes）— `clipboard.rs:48-65`
  - `grep`：`search(content, options)` / `has_match(...)` / `grep(...)`（ripgrep 封装，content 级）— `grep.rs:1466-1538`
  - `glob`：`glob(pattern, path, cb)`（支持 gitignore + 缓存）— `glob.rs:219-220`
  - `fd` / `fuzzyFind`：`fuzzyFind(options)` async，NAPI Promise — `fd.rs:226-227`
  - `fs_cache`：`invalidateFsScanCache(path?)` — `fs_cache.rs:400-401`（其余是辅助 fn，不暴露 JS）
  - `text`：`wrapTextWithAnsi` / `truncateToWidth` / `sliceWithWidth` / `extractSegments` / `sanitizeText` / `visibleWidth` — `text.rs:792,807,1071,1236,1272,1356`
  - `highlight`：`highlightCode(code, lang?, colors)` / `supportsLanguage(lang)` / `getSupportedLanguages()` — `highlight.rs:358-465`
  - `html`：`htmlToMarkdown(html, options)` — `html.rs:23-24`
  - `image`：`PhotonImage.parse(bytes)` / `.width` / `.height` / `.encode(fmt,q)` async / `.resize(w,h,filter)` / 顶层 `encodeSixel(...)` — `image.rs:62-127`
  - `ast`：`astGrep(options)` async / `astEdit(options)` async — `ast.rs:569-726`
  - `shell`：`new Shell(options?)` + `.run(opts, onChunk)` + `.abort()`；顶层 `executeShell(opts, onChunk)` — `shell.rs:170-357`
  - `pty`：`new PtySession()` + `.start/writ/resize/kill` — `pty.rs:98-171`
  - `prof`：`getWorkProfile(seconds)` — `prof.rs:224-225`
  - `power (macOS)`：`MacOSPowerAssertion.start/stop` — `power.rs:160-195`
  - `appearance (macOS)`：`detectMacOSAppearance()` / `MacAppearanceObserver.start(cb)` — `appearance.rs:396-446`
  - `keys`：`matchesKittySequence` / `parseKey` / `matchesLegacySequence` / `matchesKey` / `parseKittySequence` — `keys.rs:300-409`
  - `tokens`：`countTokens(input: string | string[], encoding?)`（默认 `o200k_base`）— 见 d.ts
  - `audio`：`AudioCapture(sampleRate, cb).stop` / `AudioPlayback(sampleRate).write/setGain/end/stop` / `AudioVoiceSession.startCapture/writePlayback/clearPlayback/endPlayback/stop` — `audio.rs:308-420` + `audio_vpio.rs:26-441`
  - `imageTask` async：`PhotonImage.parse/resize/encode` 都是 worker 线程跑（`#[napi]` + `task::Promise`）
  - `task`：内部 `blocking<T,F>` / `future<T,Fut>` 包装器（不是 `#[napi]`导出）— `task.rs:299-345`
- ⚠ **没有任何「原生 git 操作」「原生 fs_write/append」「原生 diff」的 N-API**。所有文件写都走 TS/Bun（write tool 用 `Bun.write`，edit tool 用内部 diff + writethrough → LSP）。
  这意味着编辑器若要"原生内存 mapped file""fast file ops"——现有 natives 不够，要新加。
- ⚠ grep/glob/ast-grep/ast-edit 都是文件级扫描，**不是面向单文件交互的文本操作 API**（无 cursor-based edits、无 incremental file watcher）。
- ⚠ 不暴露 JS 的：`appearance::detect_appearance / start` (mac internal fn)、`ps` (util 内)、`prof` 内部、`tokens` 中 tiktoken encoder init、`utils.rs` 通用工具——这些仅供 Rust 内部使用。

#### 工具层覆盖度（重要一行一览）

| Tool | 文件 | name | 形态 | 前端直调？ |
|---|---|---|---|---|
| read | `tools/read.ts` | `ReadTool` | TSchema `path/sel/timeout`；流式读 + 行号/hashline + archive/sqlite 透明 + URL 抓取 + 图像识别；LSP writethrough | ⚠ 不直接；通过 `session` + `dispatch`（前端的 `get_snapshot` 拿了 agent tool register 表），wire 没暴露「调用 read tool」 |
| write | `tools/write.ts` | `WriteTool` | TSchema `path/content`；Bun.write；archive/sqlite 适配；LSP writethrough；plan-mode guard；hashline strip | ⚠ 不直接；wire 已能 `fs_read`/`fs_read_image`，**`fs_write` 还没有 wire 命令** |
| edit | `edit/index.ts` | `EditTool` | 多模：replace/patch/apply_patch/hashline/atom/vim；LSP writethrough + 模糊匹配；并发 exclusive + nonAbortable | ⚠ 不直接；同上 `fs_write` 缺 |
| find | `tools/find.ts` | `FindTool` | TSchema + 后端走 `natives.glob/fs_cache` | ⚠ 不直接；`fs_list` wire 提供更通用的 workspace 树，不绑定 cwd |
| search | `tools/search.ts` | `SearchTool` | ripgrep 包装（`grep.rs`） | ⚠ 不直接 |
| ast-grep | `tools/ast-grep.ts` | `AstGrepTool` | `natives.astGrep(options)` | ⚠ 不直接 |
| ast-edit | `tools/ast-edit.ts` | `AstEditTool` | `natives.astEdit(options)`；并发 exclusive | ⚠ 不直接 |
| bash | `tools/bash.ts` | `BashTool` | TSchema command + timeout + run-in-background | ⚠ 不直接；wire 没「shell 调用」命令 |
| lsp | `lsp/index.ts` | `LspTool` | diagnostics/format/definition/... | ⚠ 不直接 |
| github | `tools/gh.ts` + `discovery/github.ts` | `GithubTool.createIf` | gh CLI 包装 | ⚠ 不直接 |
| hub | `tools/hub.ts` | `HubTool.createIf` | cross-session 调度 | ⚠ 不直接 |
| git | `commit/agentic/tools/*` + `autoresearch/git.ts` + `modes/components/status-line/git-utils.ts` | 多个内部 helper | status/diff/overview/file-diff/hunk — 全部给 TUI/agent 用 | ⚠ 不直接 |
| 其它 | ask/calculator/checkpoint/debug/identity/inspect_image/job/list_models/notebook/python/recipe/render_mermaid/report_tool_issue/resolve/review/search-tool-bm25/ssh/switch_model/task/todo_write/vim/web_search/yield/image-gen/... | 见 `tools/index.ts:84-115` | 28 个 tool + 5 个 hidden | ⚠ 不直接 |

> ⚠ 工具层覆盖度的关键结论：**所有工具都是「给 Agent 调」，不是「给前端调」**。前端能「读」+「读图」（wire `fs_read`/`fs_read_image`），但**写/编辑/diff/git/IDE bash 调用都没有 wire 命令面**——这是编辑器扩展第一道缺口。

### 1.4 编辑器扩展需要补的（✗ / ⚠ 项）

#### ✗ 必须新建的（前端 → wire / Agent 均要）

1. **`fs_write` wire 命令**：现在 wire 有 `fs_list/fs_read/fs_read_image` 三个文件读取，没有写。
   需要：`{ type: "fs_write", sessionId?, path, content }` + 路径越界检查与 write/read 一致（agentDir sandbox）。
2. **`fs_edit` 或 `edit` 透传 wire 命令**：精确编辑走既有 edit tool 的多模（replace/patch/hashline/atom）schema 是 TypeBox JSON；用 wire 命令面转发到 serve 端的 session + tool dispatcher 会比单文件字符串替换更稳（自带 LSP writethrough）。
3. **`fs_diff` wire 命令**（前后内容/lsp 化的 unified diff）：编辑器预览要给出 diff 视图；现有 `edit/.*renderer.ts` 已经能产 diff 输出，但要走 wire。
4. **`git_*` wire 命令集**（最小集）：
   - `git_status` (current branch + staged/unstaged/untracked 列表)
   - `git_diff` (working tree vs HEAD 或 staged)
   - `git_log` (n 条 commits + hash/author/msg)
   - `git_show` (单 commit 详情)
   - `git_branches` (local + remote + current)
   - 后端可以走 spawn `git`（与 `pkg spawn` 框架一致）或者把 `tool kit` 暴露——前者快、后者免重复实现 hygiene。
5. **前端 Monaco/CodeMirror 视图**：当前 0 行（grep tree 全仓不存在 monaco）。React + Vite 已就绪，装 `@monaco-editor/react` 即可。
6. **前端 Agent assistant 面板（已经隐式存在）**：右栏 + `@uiw/react-md-editor`/流式渲染 + steering/follow-up 按钮——已有 `ClientAdapter.prompt/abort/compact/forkFrom/undoExchange/retryFrom/setModel/setThinkingLevel/...`，**几乎全套命令已现成**，只需组件封装。
   - `packages/web-app/src/state/client-adapter.ts:151-220`
7. **Electron preload 扩展**：当前 `window.api` 只有 sidecar 和 update，要新增 `editor.openProject(path)` / `editor.getCwd()`（renderer 直接用 `fs_list`，但 Electron 模式要给一个快速路径 + native file dialog）。
   - `packages/desktop/src/preload.ts:1-44`

#### ⚠ 已存在但需要扩展的

1. ⚠ **`FileExplorer`（只读）→ 升级为编辑器**：已用 `fs_list/fs_read`，缺写/diff/git 操作按钮。
   - `packages/web-app/src/pages/workspace/FileExplorer.tsx:1-180`
2. ⚠ **wire 的 `fs_*` 命令当前限制 `128KB` 截断 + 路径 sandbox 锁 agentDir**：编辑器要打开大文件要扩展上限；要么走原生 `Bun.file().text()`（由 electron preload 开 bsd），要么 wire 引入 chunked fs_read。
   - `packages/wire/src/commands.ts` `fs_read`/`fs_read_image` 注释（128KB / 2MB 截断）
3. ⚠ **LSP writethrough**：已经在 `edit/index.ts`/`write.ts`/`createLspWritethrough` 路径上运转，但前端编辑器若直接调 `fs_write` 会绕开 LSP（漏格式化+诊断）；要么扩展 `fs_write` 内部走 LSP，要么在前端保留 "keep LSP formatting on save" 开关。
4. ⚠ **`Agent` `subscribe` + `emitExternalEvent`** 已存在，但 wire 层没有 expose 全套 `Agent` 对外事件（如 `tool_execution_start/end`、`message_update/delta`）—`WireServerEvent.progress` 是 server 侧 push。
   当前 web-app 订阅流其实 work (`push` → `session_snapshot` 缓存 + progress)，但 progress 内容是否齐全，要进一步读 serve 端实现确认。
5. ⚠ **`AcpAgent.prompt` 已经把 slash 命令 `/compact /help /model /clear /exit` 走本地分支**：编辑器要"固定命令时 unhook agent 直发"完全可走这套 prompt 路径。
   - `packages/coding-agent/src/modes/acp/acp-agent.ts:363-410`
6. ⚠ **host tools**：wire 已经支持 `set_host_tools` / `host_tool_call`（让 server 拿到 client 实现的 tool 并让 agent 调）——编辑器"自身的自定义工具"（如 `read_current_editor_selection`）可以挂这个机制给 agent 用，几乎不用写后端。
   - `packages/wire/src/frames.ts:87-115`；`packages/wire/src/commands.ts` `set_host_tools`
7. ⚠ **permission_request 协议已预留审批/澄清**：编辑器想做 "审批危险 write 之前弹出" 可以直接 wire `permission_request`，不必新写审批流。
   - `packages/wire/src/frames.ts:103-115`

#### ✗ 还需要新建（不在 wire 也不在 tool 内）

8. **多文件/多 step undo**：现有 `edit` 是文件级，未暴露会话级「重做步骤列表」给前端。ACP 有 fork/resume，但跳会话太重。
9. **大文件 streaming render**：Monaco 自带；wire `fs_read` 一次性，不支持 chunked read + line range streaming serving。
10. **native file watcher**：`fs_cache.invalidateFsScanCache` 是 Rust 侧 path invalidation，无 inotify/fsevents 实时 push——编辑器实时提示 dirty 需要 fs.watch 后端或前端 chokidar。

### 1.5 现状速读总结

- **内核干净**：`Agent` class（agent-core + agent-loop）+ 28 个 tool + wire JSON-over-WS + native 21 mod 都是稳定的「实现一次，全前端复用」的状态；编辑器扩展不需要重写内核。
- **协议已通**：wire JSON-over-WS 协议完整（v=1，向后兼容），client 已有重连+心跳+snapshot 缓存；编辑器前端只要写一个 `Client`-based adapter 就能复用 80% 命令面（prompt/abort/compact/fork/setModel/...）。
- **ACP 不能承载 IDE ops**：ACP 是「会话控制 + agent」通道，没有 file/read/edit/diff/git 命令面；编辑器必须直接走 wire，不走 ACP。
- **三处真实缺**：① 写/diff/git 类 wire 命令还没有（`fs_write`/`fs_edit`/`fs_diff`/`git_*` 一整套）；② Electron preload 没有任何 editor IPC；③ 前端 0 行编辑器代码（无 Monaco/CodeMirror，FileExplorer 只读）。把这三块补上即可在不重写内核的前提下嫁接编辑器。
- **最大复用面**：既有 `AgentTool` 接口统一所有读/写/编辑/Bash/LSP/AST 工具的 schema/result，流式事件通过 wire push 自然给到编辑器，无需新建 session 抽象。
- **LSP 是关键支柱**：write/edit 都已挂 `createLspWritethrough`，新 wire 写命令必须延续这条链路才不会破坏格式化+诊断回路。
- **macOS 跟 dev-shell 都有原生底子**：clipboard / fuzzy-find / glob / grep / highlight / ast-grep / ast-edit / PhotonImage / audio 都是 N-API 暴露的，可直接给编辑器复用（语法高亮、AST 重构、模糊搜索、剪贴板图、缩略图）。

## 2. 外部借鉴：OpenSumi 与 Zed

> 调研范围：**仅**外部开源项目（OpenSumi / zed-industries/zed），不读 cornfield 内部代码。
> 目的：在 cornfield 已有"内核 only-one + 多前端 reactive 适配"原则下，决定前端编辑器扩展该从哪里搬什么。
> 标记约定：✓ 直接观测（带源 + 行号/章节锚）/ ⚠ 推断（带依据）/ ✗ 缺（需另行检索）。

### 2.1 OpenSumi 关键模块摘录

来源：opensumi.com 官方文档站（`https://opensumi.com/en/docs/...`）+ `github.com/opensumi/core` 源码 main 分支。

#### core-idea（架构总览）

- **核心抽象**：OpenSumi 是"前后端分离的 IDE 框架"，前端为 React + 自研 DI（`@opensumi/di`），后端为 Node.js；通过 RPC（WebSocket / Electron IPC，底层 JSON-RPC 2.0）做"前后端透明"通信。一个 IDE 实例分三个进程：Browser / Node / Extension。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/core-idea/` § "OpenSumi is positioned as an IDE framework"；§ "Module Layer and Dependencies"；§ "Dependency Injection"。
- **跟编辑器扩展相关的能力**：
  - 模块分 Core（`core-browser` / `core-node` / `monaco` / `main-layout`，不可热拔）vs Functional（其余 53 个，可热拔）。
  - Extension 系统是 VS Code 插件的"超集"——保留了 `main` 入口（VS Code 兼容），又加了 `browserMain`（Browser 扩展里能直接 export React 组件）和 `workerMain`（Web Worker 扩展）。
  - 每个模块结构固定 `src/{browser, node, common}` 三层，分别承担视图、Node 能力、共享契约。
  ✓ 同上 § "Module" / "Module Layer and Dependencies" / "Extension and API"。
- **借鉴点在哪**：cornfield 已经有内核 only-one，**模块级前后端分层**这一原则（`browser/`、`node/`、`common/` 三层）可以照搬到 moa-extension / web-app 编辑器端的目录约定上；尤其是 `common/` 的契约层——把"前端能调的接口"都用 token 定义好，避免再写一遍 ts interface。

#### core-modules（模块分类）

- **核心抽象**：OpenSumi 总共 53 个 npm 包，每个包是一个 Module。Core 模块是 IDE 骨架（main-layout / core-browser / core-node / monaco），其余可插拔。Extension 模块依赖大部分功能模块；移掉 extension 模块就丧失全部扩展能力。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/core-modules/` § "Introduction to Core Modules"。
- **跟编辑器扩展相关的能力**：
  - **Core Browser/Node**：前端/后端 `ClientApp` / `ServerApp` 实例、Contribution 注册、RPC 连接初始化。**不能热拔**。
  - **Monaco**：包装 Monaco 的私有 API（OpenSumi 编辑器强依赖 Monaco 私有 API），给其他模块用作扩展点。
  - **File Service**：唯一默认文件服务实现；同时挂上 `MemoryFS` / `BrowserFS` 等适配点。
  - **Extension Manager**：唯一一个**能直接依赖 extension 模块**的模块——装、卸、启、停扩展都走它。
  - **Terminal-Next**：暴露 `TerminalNetworkContribution`，让你自己接 WebSocket/Socket 到后端 Shell。
- **借鉴点在哪**："Functional 模块可拔"是给上层集成用的；如果 cornfield 的编辑器扩展走"嫁接"在已有 web-app 上，那 web-app 是不需要做模块可拔的——直接 new 一个 ClientApp 就行。**真正可借鉴的是 Module 命名层**——把每个能力放进一个独立 npm-style 包，让 IDE 主进程按需 `addProviders`。

#### connection（前后端通信层）

- **核心抽象**：OpenSumi 把 Web/Electron 的通信差异封装在 `@opensumi/ide-connection`，底层是 JSON-RPC 2.0 + 长链（Web 用 WebSocket，Electron 用 IPC socket）。前端调用后端的方法就是一个 Proxy：`myBackService.$getSomeLocalData()` 被 Proxy 拦截 → 包成 `Request` → 后端把结果通过唯一 ID 回写。
  ✓ `https://opensumi.com/en/docs/develop/basic-design/connection/` § "Basic Principle"（含 Proxy 伪代码）；§ "Channel"。
- **跟编辑器扩展相关的能力**：
  - **方法名 `$` 前缀**：所有后端 RPC 方法必须 `$` 起头，前端 DI 注入的是 Proxy（不是真实实现）。
  - **多窗口隔离**：每个 window 单独一条长链 + 单独一个 DI container；后端对前端是**无状态**的，不同连接严格隔离。
  - **Channel**：用于在广播/订阅场景下分发给特定长链（注意它不是 MQTT，是 OpenSumi 自己的轻量分发模型）。
- **借鉴点在哪**：cornfield 已经有 wire（已在 context 中确认），它是 WebSocket 双向通道——**完全对位 OpenSumi connection**。编辑器扩展里要新加 RPC 方法，最小增量是"在 wire 上加一个 channel + 服务端实现 + 客户端 Proxy"。不要把 web-app 写成另一份 Electron IPC 通道。

#### editor（编辑器内核）

- **核心抽象**：OpenSumi 编辑器围绕 `WorkbenchEditorService`（全局唯一）。打开 URI 经历三步：① `IResourceProvider` 把 URI 解释成 `IResource`（name / icon / metadata），② `EditorComponentRegistry` 注册"打开方式"（`type: 'code' | 'diff' | 'component'`）+ React 组件，③ 根据用户选择（同一资源可有多种打开方式）渲染对应组件。
  ✓ `https://opensumi.com/en/docs/develop/module-apis/editor/` § "Basic Concept" / "Extend the Editor"；代码：`packages/editor/src/browser/workbench-editor.service.ts` ⚠未读源码(读的是文档，但文档里给了完整 type signature)。
- **跟编辑器扩展相关的能力**：
  - **`IResource` 模型**：把"能不能开在编辑器里"这件事抽象成一个接口——`{ supportsRevive, name, uri, icon, metadata, deleted }`。
  - **`IEditorOpenType`**：`{ type: 'code' | 'diff' | 'component', componentId?, title?, readonly?, weight? }`——同一个 URI 可以同时挂 Markdown 源码预览、富组件、Diff。
  - **`BrowserEditorContribution`**：4 个 hook 点——`registerResource`（注册 URI → IResource 转换器）、`registerEditorComponent`（注册打开方式 + 组件）、`registerEditorFeature`（拿到 Monaco editor 实例，可挂命令/装饰）、`onDidRestoreState`（恢复上次打开的 tab 组）。
  - **`WorkbenchEditorService` API**：`open / close / saveAll / closeAll / openUris / createUntitledResource` + 状态事件 `onActiveResourceChange` / `onCursorChange` / `onDidEditorGroupsChanged`。
- **借鉴点在哪**：cornfield 不需要照搬 Monaco——它已经选好"轻量 + 自家 + 嫁接"。**借鉴 IResource 模型**：把"打开一个文件"从"前端 Promise fs.readFile"提升为"IResourceProvider: URI → ResourceData"——这样以后接 LSP / 远程 workspace / git blob 都不动 UI。`registerEditorFeature` 那种"拿到 editor 实例再注入"的钩子也很适合做"agent inline chat"。

#### VFS / FileService（虚拟文件系统）

- **核心抽象**：`IFileService` 是统一的文件操作门面（`getFileStat / resolveContent / setContent / updateContent / move / copy / createFile / createFolder / delete / access / onFilesChanged / watchFileChanges`）。后端 `registerProvider(scheme, FileSystemProvider)` 让每种 URI scheme 都能挂自己的 `FileSystemProvider`——磁盘是默认 provider，MemoryFS / BrowserFS / ShadowFS 都是同一个 scheme 的不同 provider。
  ✓ 源码 `packages/file-service/src/common/files.ts` L31 `IFileService extends IFileSystemWatcherServer`；L184 `registerProvider(scheme, provider)`；L236 `setWorkspaceRoots`；L271 `FileSystemProviderErrorCode`；源码 `packages/file-service/src/node/disk-file-system.provider.ts`（默认实现）。
- **跟编辑器扩展相关的能力**：
  - **Scheme 即 routing key**：`file://` 默认给磁盘 provider；`git://` 可以自己挂（git blob）；`sumi-workspace://` 是 OpenSumi 自己发明的 scheme（存 workspace 配置）。
  - **`ShadowFileSystemProvider`**（`packages/file-service/src/browser/shadow-file-system.provider.ts`，~2.3KB）：shadow 名字暗示"本地 shadow + 后端真盘"的双层模式——这是把 Browser 端模拟文件操作、后端落盘的能力封装出来，适合 web IDE 用。
  - **`onFilesChanged` / `watchFileChanges`**：内置 watcher，子模块用 `DebouncedDelay` 节流。
  - **`FileStat`**：统一的 stat 类型，返回单层 unresolved children——上层自己 lazy resolve。
- **借鉴点在哪**：cornfield 的 web-app 现阶段是"前端直连 client"的；**FileService 这种"按 scheme 分 provider"模型适合加多 backend**——以后想接 vfs.literal/vfs.remote 时不用动 UI。**完全照搬成本太高**（OpenSumi 自己有 hosted 子目录 + WatcherProcessManager 后端 watcher 进程，web-app 不需要），但 `IFileService` 接口形状可以"改造"成 web-app 的 thin wrapper：把 `fs.*` 包成 IFileService + 不实装 watcher（前端用 chokidar）。

#### Git / SCM（源码管理）

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

#### Workspace（工作区）

- **核心抽象**：`WorkspaceData` 是一个 JSON 文档——`{ folders: [{path, name?}], settings?: {} }`。磁盘上叫 `*.sumi-workspace`，**相对路径自动转换**：写时 relative、读时 absolute（核心逻辑在 `packages/workspace/src/browser/workspace-data.ts` L57 `transformToRelative` / L91 `transformToAbsolute`）。
  ✓ 源码 `packages/workspace/src/browser/workspace-data.ts` L7 `workspaceSchema` / L31 `is(data)` / L46 `buildWorkspaceData`。
- **跟编辑器扩展相关的能力**：
  - **`WorkspaceService`**（`packages/workspace/src/browser/workspace-service.ts`，24KB）：管 `workspace / _roots / setWorkspace / updateWorkspace` + `whenReady: Deferred<void>`——**全部异步，用 Deferred 解 race condition**。
  - **`UNTITLED_WORKSPACE` + `WORKSPACE_USER_STORAGE_FOLDER_NAME`**：未保存工作区 / 用户态存储位置。
  - **`WorkspacePreferences`**：每个 workspace 自带 preferences，跟个人 globals 区分。
  - **`init()` / `initFileServiceExclude()`**：初始化分两步，先 init 后 exclude（exclude 影响 FileService watcher 范围）。
- **借鉴点在哪**：cornfield 现在的 web-app 是单 workspace 模式——**借鉴 WorkspaceData JSON 这个 schema**，**改造**：写一份 `mcode-workspace.json`，让用户能"一次选多个 repo + 各自 settings"，Web 端渲染时按 folder 渲染 file tree；**值不值得**：用户已经在用"管多个子业务领域 agent"，多 workspace 是刚需。

#### AI Inline Chat / Chat Panel

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
- **借鉴点在哪**：这部分是**和 cornfield 已有 ACP 模式直接相关的——OpenSumi 自己也加了 ACP**（`packages/ai-native/CONTEXT.md` 是 Agentic Layout 规范，强制走 ACP Agent）。结论：① **`registerInlineChatFeature` 这种"AI capability 是注册点、不是固定面板"** 必须照搬——不要把"加个 capability"做成改源码；② **`ChatResponse` 三态** 的统一 error 处理 = cornfield 的 `ACPThreadEvent` 也应有三态——查 ACP spec 里 `cancel / error / success` 是否和它对齐。

### 2.2 Zed 关键模块摘录

来源：`https://github.com/zed-industries/zed` main 分支；DeepWiki `deepwiki.com/zed-industries/zed`；`docs.rs/gpui`。

#### crates/editor/src/editor.rs

- **核心抽象**：12647 行的 `editor.rs` 是 Editor 类的 home，但渲染/事件分到子模块：`element`（渲染）/ `display_map`（坐标映射、fold、soft wrap、tab markup、inlay）/ `items`（Editor as Panel item / 自承载多 buffer）/ `selection` / `mouse_context_menu`。`Element` 那一层（`crates/editor/src/element.rs`，~509KB）才是真正给 GPUI 渲染的。
  ✓ `crates/editor/src/editor.rs` top doc-comment L1-L8："This is the place where everything editor-related is stored (data-wise) and displayed (ui-wise). The main point of interest in this crate is [`Editor`] type... [`element`] — the place where all rendering happens. [`display_map`] - chunks up text..."；L29-L57 模块声明。
- **跟编辑器扩展相关的能力**：
  - **`Editor` 不同 flavor**：单行 / 多行 / 固定高度——同一个 `Editor` struct 通过参数切换（不在不同 struct 上复制代码）。
  - **`pub mod items`**：把 Editor 嵌入 Workspace 的"item 协议"——拖出/拖入 tab 是同一套语义；`pub use items::MAX_TAB_TITLE_LEN` 等公共契约都从这里 export。
  - **Vim 模式外挂**：注释"L37 If you're looking to improve Vim mode, you should check out Vim crate that wraps Editor and overrides its behavior"——**用 wrapper 模式扩展**，不污染 Editor 主体。
  - **`display_map::FoldPlaceholder` / `HighlightKey` / `SemanticTokenHighlight`**：渲染无关的逻辑抽出独立模块。display_map 把"逻辑字符坐标 ↔ 显示行"分开。
- **借鉴点在哪**：**`Editor` 主类 + 子模块分层 = 不直接抄 Zed**，但"Editor 拆 element / display_map / items"的分层思想可用到 cornfield 的 `web-app/src/components/Editor/`——`Editor.tsx`（react facade）/ `displayMap.ts`（文本→渲染行映射）/ `itembl.ts`（与 workspace tab 协议）。

#### worktree（`crates/worktree/src/worktree.rs`）

- **核心抽象**：7707 行的 `worktree.rs` 把"文件系统扫描"做成增量 snapshot。`LocalSnapshot` 内嵌 `SumTree<Entry>`（`sum_tree` crate），**任何 path 变化（git status / mtime / 内容）都触发 SumTree 的局部更新**，访问是 O(log n)。Snapshot 是一次性 immutable 视图——所有上层读 snapshot 是 lock-free 的。
  ✓ L250 `pub struct LocalSnapshot`；L3795 `pub struct File { worktree: Entity<Worktree>, path: Arc<RelPath>, disk_state: DiskState, entry_id: Option<ProjectEntryId>, is_local, is_private }`；L3953 `pub struct Entry`。
- **跟编辑器扩展相关的能力**：
  - **`Entry::GitTraversal` / `ChildEntriesGitIter` / `GitEntry`**：把 file tree 扫描和 git status **统一成一个迭代器**——读 tree 时自然带回 git 状态，不另开 channel。
  - **`Snapshot::Status<'a>(...)`**：每个路径都可以现查 stat / blame / mtime / is_deleted——snapshot 是真相之源。
  - **`RelPath`**（`util::rel_path`）：相对路径作为 first-class type，避免误绝对化。
  - **`ignore::IgnoreStack`**（同文件 + `mod ignore`）：gitignore + 本地 ignore + worktree 私有档 自动合并 stack。
  - **`ManifestTree`**（导出符号 L40）——把 `package.json` / `Cargo.toml` / `requirements.txt` 看作"项目骨架"，worktree 扫描时附带识别（典型 usage：在 layer 间区分 lib/app/config）。
- **借鉴点在哪**：cornfield 的 web-app 现在大概率每次重扫 directory——**借鉴 snapshot + SumTree 模型**收益巨大：编辑器一开几千文件就靠增量更新；不过代价是要写一套 custom SumTree 或用 ProseMirror 团队的 cot / immer 替代。**改造方向**：把 file tree 做成"前后端各持一份 state"——前端用 CustomTree + 增量，git status 通过 intercom channel 实时同步。**跳过** ManifestTree（用户场景里 CornField 还没到要识别项目骨架的程度）。

#### project（`crates/project/src/project.rs`）

- **核心抽象**：`Project` 是 6913 行的"调度者"——持有一组 `Entity<WorktreeStore>` / `Entity<BufferStore>` / `Entity<GitStore>` / `Entity<LspStore>` / `Entity<ImageStore>` 等独立 store。它**自己存的不多**，只做 store 间的协调 + RPC 派发。`ProjectClientState` (`Local` / `Shared` / `Collab`) 三态——前端用 Project 时不必关心它是不是在远程。
  ✓ L215-L256 `pub struct Project { ... git_store: Entity<GitStore>, worktree_store: Entity<WorktreeStore>, buffer_store: Entity<BufferStore>, lsp_store: Entity<LspStore>, ... }`。
- **跟编辑器扩展相关的能力**：
  - **42 个 mod**：agent_server_store / bookmark_store / buffer_store / git_store / lsp_store / project_search / task_store / terminals / prettier_store / debugger / context_server_store / image_store / color_extractor / connection_manager / manifest_tree / trusted_worktrees / toolchain_store / yarn / environment ——每个独立可测。
  - **`Project::git_diff_debouncer`**：debounce 400ms，统一一次算 diff。
  - **`downloading_files`**：单个 `(worktree_id, path)` 的下载状态哈希——专门管"异步下载未完成"的文件。
- **借鉴点在哪**：**这种 "Store-per-concern" 分层完全适配 cornfield**。web-app 当前可能是"一个大 action handler"，按 Store-per-concern 切后：① gitStore 单独走 client 的 git RPC，② lspStore 让 agent 注入 LSP proxy，③ taskStore 管 agent team 任务。**照搬**结构（store 是 Entity/Store 划分），**改造**实际实现（Zed 用 GPUI Entity，cornfield 用 React Context + zustand 即可）。

#### project_panel（`crates/project_panel/src/project_panel.rs`）

- **核心抽象**：ProjectPanel（左下角的 file tree）是个 7621 行的 `Panel` 子类型，关键数据是 `Entry` / `GitEntry` / `MarkdownPreviewView`——它**没有自己的 git status 缓存**，全部通过 project.read(cx).git_store / worktree 拉。
  ✓ L137 `pub struct ProjectPanel`；L6950 `impl Render for ProjectPanel`；L5668 `fn render_entry`；L6808 `fn render_sticky_entries`；L6350 `fn render_folder_elements`。
- **跟编辑器扩展相关的能力**：
  - **`render_entry_path_separator`**：路径分隔符 = 自定义 row layout（vs Material 一律箭头）。
  - **`render_sticky_entries`**：sticky 行——常用目录永久在顶部。
  - **Git 集成是从 Project 来**：它从不"自己调 git"——所有 git 数据走 `project.git_store`，这是好的关注分离。
  - **`entry_diagnostic_aware_icon_*` + `entry_git_aware_label_color`**（L20-L25 imports）：单文件、四种 decoration 源（git / diagnostic / file_icons / 文件夹），所有 decoration 通过 `items::` 模块的 helper 函数合并。
- **借鉴点在哪**：**改造**——Zed 的 ProjectPanel 体量太大（7621 行），不适合整体照搬；但**关注分离原则搬**：把 file tree 拆成 `<FileTree>` 组件 + `<FileTreeRow>` + `<EntryGitBadge>` + `<EntryDiagnosticBadge>`。每个 hook 拿数据通过 props（不直接读 store）。

#### agent_panel / inline_assistant

- **核心抽象**：两大块。① **`AgentPanel`** 是个全屏 panel（517KB）：持 `WeakEntity<Workspace>` / `Entity<Project>` / `Entity<ThreadStore>` / `Entity<AgentConnectionStore>` / `HashMap<ThreadId, Entity<ConversationView>>`——一个 panel 管 N 个 thread 视图。② **`InlineAssistant`** 是 Global：一个 global 实例 + `EditorInlineAssists`（per-editor 一组 pending assists） + `InlineAssist`（一个 inline assist 实例，含 `BufferCodegen` 状态机）。`InlineAssistant::init` 通过 `cx.set_global(InlineAssistant::new(fs, prompt_builder))` 注册。
  ✓ `crates/agent_ui/src/agent_panel.rs` L1153 `pub struct AgentPanel { workspace: WeakEntity<Workspace>, project: Entity<Project>, thread_store, connection_store, retained_threads: HashMap<ThreadId, Entity<ConversationView>>, selected_agent: Agent, ... }`；`crates/agent_ui/src/inline_assistant.rs` L87 `pub struct InlineAssistant`、L1635 `pub struct InlineAssist`。
- **跟编辑器扩展相关的能力**：
  - **ACP**：`use acp_thread::{AcpThread, AcpThreadEvent, MentionUri, ThreadStatus, line_range_suffix}`；`use agent_client_protocol::schema::v1 as acp`——Zed 的 agent 全部走 ACP v1 schema。**和 cornfield 完全对位**。
  - **`retained_threads: HashMap<ThreadId, Entity<ConversationView>>`**：不 GC——对话是 persistent 的，直到用户主动 archive（注意这一句"GIA-only-modelism"⚠推断：可能是 `OpenSumi Agentic Layout CONTEXT.md` L1-L11 里那段 `ACP Task Archive / Unarchive` 行为已被 Zed 实装）。
  - **`mentions` + `MentionUri`**：agent 输入框能 @文件/@符号；line_range_suffix（@file:10-20 行 range 后缀）。这是 inline chat 的必备 UX。
  - **`AgentSettings::UserAgentsMd` / `OpenGlobalAgentsMdRules` / `OpenProjectAgentsMdRules`**：用 markdown 文件配置 agent rules，分 global + project 两层——和 OpenSumi 的 `WorkspacePreferences` 是同一招。
  - **`inline_assistant.rs` L87-L100 Global**：`InlineAssistant` 是 Cx global，所有 editor 共享一个，EditorInlineAssists 是 per editor 的。这样全局可"中断当前所有 inline"。
  - **`BufferCodegen`**（`: buffer_codegen::BufferCodegen`）：把 inline edit 做成状态机（idle → running → streaming → applying / cancelled）。
- **借鉴点在哪**：**直接对位**——cornfield 已经有 ACP server，`AgentPanel`/`InlineAssistant`/`BufferCodegen` 三层直接照搬结构：① 顶层 panel = cornfield 的 chat panel（已有，但只是 web view，未做 conversation retention）；② `InlineAssistant` global = 不需要 new，看 cornfield 是否已经做了；③ `BufferCodegen` 状态机要**新加**——这是 cornfield 缺的能力。**改造** UI（react + tailwind），**照搬** ACP / retention model / mentions。

#### extensions system（`extension_host`）

- **核心抽象**：Zed 用 **Wasmtime component model + WIT**（WebAssembly Interface Type，wit-bindgen 自家导出）做插件宿主。扩展是编译成 wasm 的 Rust crate，宿主端用 `wasmtime::Engine` 编译并跑 `wit::Extension`。Capabilities（file ops / LSP / themes / slash commands / debug adapter / context server）通过 `CapabilityGranter` 显式允许。
  ✓ `crates/extension_host/src/wasm_host.rs` L46 `pub struct WasmHost { engine: Engine, release_channel: ReleaseChannel, http_client: Arc<dyn HttpClient>, node_runtime, proxy: Arc<ExtensionHostProxy>, fs, work_dir, granted_capabilities: Vec<ExtensionCapability>, ... }`；L77 `pub struct WasmExtension` 实现 `extension::Extension` trait。
- **跟编辑器扩展相关的能力**：
  - **`ExtensionCapability` 一等公民**：所有扩展能做的事都列出来（语言/LSP/grammar/theme/snippet/debug-adapter/context-server/slash-command/keyvalue-store）。不在列表里的 API 编译时过不了。
  - **WASI 集成**：`wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView}`——扩展能跑有限的 syscall。
  - **`granted_capabilities`**：settings.json 里细粒度 allowlist（PR #39472"Load granted extension capabilities from settings"）。
  - **`extension_builder`（separate crate）**：release 模式把扩展源码在用户机器上编译成 wasm——意味着扩展作者写 Rust，平台用同一条流水线。开发友好度极高，代价是首次安装慢。
  - **Moka cache（`moka::sync::Cache`）**：wasm component 在内存里缓存。
- **借鉴点在哪**：**cornfield 不适合照搬**——Wasmtime 那一套非常重（Rust 扩展 + 用户机编译 + WASI），而 cornfield "agent team 管公司业务"场景下用户不需要写 Rust 扩展。**能借鉴的只有两件事**：① **`ExtensionCapability` 显式 allowlist 的安全边界**——可以照搬到 cornfield 的 "agent 工具授权"——白名单 / 灰名单；② **`proxy + capability grant` 的设计模式**——任何需要权限的能力（如 写文件、读 git）显式通过 grantor，不直接持有 client。

#### GPUI（`crates/gpui/src/lib.rs`）

- **核心抽象**：GPUI 文档自己写明"hybrid immediate and retained mode, GPU accelerated"。三大块：
  1. **State**：所有 application state 都住在 `Entity<T>` 里（GPUI 拥有的智能指针，类似 `Rc<T>`），外界用 `cx.entity()` 拿引用，update 通过 `cx.spawn`/`cx.notify`/`cx.observe`。
  2. **View**（declarative）：一个 Entity 同时是 View 就 `impl Render`，GPUI 在每帧调 `render(&mut self, window, cx) → impl IntoElement`。Element 是树。
  3. **Element**（imperative）：低层 Element 自己控制 layout+ paint+ hit-testing——为了给"大列表 + 代码编辑器"那种需要自定义布局 / 高速合成的场景留口子。
  ✓ `https://docs.rs/gpui/latest/gpui/index.html` § "The Big Picture"。
- **跟编辑器扩展相关的能力**：
  - **`cx.spawn(async move ...)` + `cx.background_spawn`**：所有异步操作强类型+可被框架调度。
  - **`cx.observe(reader, observer)` / `cx.subscribe`**：stateful 反应式更新。
  - **`Action` 系统**：keybinding 不是 key→fn，而是 key→Action→handler——action 是 typed enum。
- **借鉴点在哪**：**GPUI 是 Rust-native，cornfield 是 React+TS**，没法照搬。**借鉴"三层思想"**：① "state 必须是 GPUI（框架）拥有"→ ① = 把 web-app 里的 zustand store 拆细，所有 mutable state 都只在 owner 里（react 用 zustand 满足）；② "Element + Render trait 分离"→ ② = 把 web-app 的 `<Editor>` 拆 `<Editor.View>`（react façade）+ `<EditorElement>`（直接拿 window 坐标画 canvas）；③ **跳过 Action 系统**——react 用 keydown handler 就够了，不需要 typed enum。

### 2.3 借鉴对照表（cornfield 视角）

| 编辑器能力 | OpenSumi 怎么做 | Zed 怎么做 | 借鉴程度 | 理由 |
|---|---|---|---|---|
| **前后端 RPC（file ops / git ops）** | connection 包 JSON-RPC + 长链 + Proxy，`$` 前缀方法（`packages/connection`、`docs/develop/basic-design/connection`） | wire 已经在 web-app 用了；Project 通过 store 装；不暴露 RPC 给外部——内部 rust 直接 call | **跳过** | cornfield 已经有 wire；不重新发明 RPC；uni*RPC 一份。 |
| **URI → 可打开资源** | `IResource` 模型（`{ supportsRevive, name, uri, icon, metadata, deleted }`）+ `IResourceProvider` | Project 把 `ProjectPath` + `WorktreeId` + `PathBuf` 当 typed handle；Editor 没抽象 IResource | **改造** | 从 `IResource` 抄形状（保留 `uri/icon/name/metadata`），Provider 注册用 web-app 的 zustand store；UI 自家 React。 |
| **编辑器内核**（open / close / save / tab 组） | `WorkbenchEditorService` 单例 + `EditorComponentRegistry` 注册多打开方式 | `Editor` struct 12647 行 + `display_map` + `items` 模块；`Element` 独立渲染层 | **改造** | 借鉴 IResource 多打开方式（比 Zed 强的地方），subsystem 分层学 Zed（item / display_map）；自己写轻量编辑器内核（不在 web-app 里塞 monaco）。 |
| **文件 / Git 状态增量** | FileService + WatcherProcessManager（后端 watcher 子进程）+ onFilesChanged 事件 | `Worktree` 内嵌 `SumTree<Entry>` 的 LocalSnapshot + 增量更新 + `GitTraversal` | **改造** | SumTree 思路抄，但用 immer / custom impl 别搬 sum_tree crate；Git 数据走 client 走子进程。**跳过** ManifestTree。 |
| **多仓库 / Workspace JSON** | `WorkspaceData` JSON + relative↔absolute 转换（`packages/workspace/src/browser/workspace-data.ts`） | `Worktree` 是单一集合（多 worktree 并存），没有 `WorkspaceData.json`；多 root 通过 `worktree_store` 装 | **改造** | 学 OpenSumi 的 `mcode-workspace.json` schema（`folders + settings`）。**不做** Zed 那种 client-server 多 Worktree（复杂且不需要）。 |
| **Git / SCM provider** | `registerSCMProvider(scheme, provider)` 多 provider + `ISCMResource` + dirty diff 高亮 + status bar badge | `git_store::GitStore` 独立 store + `DiffHunkDelegate`（`crates/editor/src/git/`）+ `InlineBlamePopover` + `GotoPrev/NextChange` | **改造** | 学 OpenSumi 的 provider 注册制（多个 git repo 同时挂）；学 Zed 的 dirty diff 在 editor 内嵌 + blame popover。UI 全部自家。 |
| **AI Inline Chat（编辑器内按钮）** | `IInlineChatFeatureRegistry.registerEditorInlineChat({id, name, renderType, codeAction}, {execute, providerDiffPreviewStrategy})`；`ChatResponse` 三态 | `InlineAssistant` Global + `EditorInlineAssists` + `InlineAssist` + `BufferCodegen` 状态机 + diff preview 是 default | **照搬** | 完全对位 cornfield 的 ACP 已有结构。三态 + diff preview 是必须照搬的。 |
| **AI Chat Panel（持久对话）** | `IChatFeatureRegistry.registerWelcome / registerSlashCommand` | `AgentPanel { thread_store, retained_threads: HashMap<ThreadId, Entity<ConversationView>>, selected_agent: Agent }` | **照搬** | retention model + Thread Id HashMap + selected_agent 三件套直接借鉴；mention（@file:10-20）必须照搬。 |
| **Agent 配置（rules）** | `WorkspacePreferences` 一层 | `AgentSettings::UserAgentsMd` + `OpenGlobalAgentsMdRules` + `OpenProjectAgentsMdRules` 两层（global + project） | **改造** | 学 Zed 双层（global + project），不全照搬 OpenSumi。 |
| **扩展安全边界** | `ClientAppContribution` 注册声明 | `ExtensionCapability` allowlist + `CapabilityGranter` + settings.json 细粒度 | **改造** | 给 cornfield agent tool 加 allowlist；不在 web-app 层做 wasm 扩展（用户场景不需要）。 |
| **前端渲染模型** | React + 自家 Monaco wrapper | GPUI 三层 Entity/View/Element + GPU 加速 + 120fps | **跳过** | 不抄 GPUI，React+tailwind 就够；但借鉴"render 分离 + state 分离 + element 低层开口"的层级思路（拆分 `<EditorFacade>.tsx` + `<EditorElement>.tsx`）。 |
| **VFS / File system provider 多 scheme** | `IFileService.registerProvider(scheme, FileSystemProvider)` —— file/git/sumi-workspace/各一组 | 无对应层（Zed 全本地，remote 通过 `remote::RemoteClient` 走另一条） | **改造** | 学 OpenSumi 多 scheme 分 provider；不照搬 watcher 子进程；浏览器端 chokidar 即可。 |
| **Vim 等"插件模式"** | Extension 系统就是 super-VSCode-plugin | "Vim crate that wraps Editor"——wrapper 不污染主体 | **改造** | 学 Zed 的 wrapper 模式：以后要做"编辑器命令面板""多光标模式"作为 EditorShell 子层 wrap，不污染 Editor 主体。 |

### 2.4 借鉴地图（5–10 行）

在 cornfield 已具备 `wire + client + ACP + coding-agent` 的前提下，前端编辑器扩展应挂在 web-app 上做"嫁接"，不重建内核：
1. **RPC**：跳过（wire 已对位 OpenSumi connection）。
2. **资源模型 IResource**：照搬抽象，Provider 注册用 zustand，UI 自家 React。
3. **Editor 内核**：改造——学 Zed 的 `display_map / items / element` 分层 + OpenSumi 的多打开方式，自己写轻量编辑器。
4. **File tree**：改造——学 Zed `Worktree` 的 SumTree 增量思想，掉底盘改 chokidar。
5. **Git / SCM**：改造——抄 OpenSumi `registerSCMProvider` 多 provider 注册（比 Zed GitStore 更适合 cornfield 场景）。
6. **AI Inline Chat**：照搬 OpenSumi `registerEditorInlineChat` + Zed `InlineAssistant` 的 `ChatResponse` 三态 + `providerDiffPreviewStrategy` preview-then-apply。
7. **Chat Panel**：照搬 Zed `AgentPanel` 的 `retained_threads + selected_agent` + mention（@file:10-20）+ rules 双层。
8. **Workspace JSON**：照搬 OpenSumi `WorkspaceData{ folders, settings }` schema；不做 Zed 远程多 Worktree。
9. **UI 分层与扩展安全**：学 GPUI 的 Entity/View/Element 三层（React 拆分 façade/element）+ OpenSumi/Zed 的 capability allowlist 给 agent tool 加白名单；不做 wasm 宿主。

## 3. 架构结论

### 3.1 设计原则（来自用户，金句）

> "我希望所有底层和 cli 都是共用的，cli 和客户端，乃至 web 只是不同的前端展示方式。**改内核，大家都会跟着变化而不是分别修改**。"

> 编辑器是"嫁接"不是"新建"——挂在已有前端或新建但复用全部内核。

落点：

- 编辑能力不是差异化，光标/buffer/textmate/LSP/lint/补全是红海。差异化在 agent 层（多 worker / 审批 / cron / 记忆 / 学习沉淀）。
- 编辑器作为前端，**worker = coding-agent 内核**，已存在的链路不改。Editor 改它能改的部分（光标、buffer、UI），不动 agent 主循环。
- 任何一版方案都必须满足：改 wire / client / coding-agent 内核，三个前端（CLI / 桌面 / 编辑器）受益，而不是反向。

### 3.2 共同需求矩阵

4 个需求按用户视角 / 内核需求 / 前端需求 / 关键难点展开。

| 需求 | 用户视角 | 内核需求（coding-agent + wire + natives） | 前端需求（web-app / desktop / 编辑器） | 关键难点 |
|---|---|---|---|---|
| **1. 项目选择** | 打开一个本地目录（文件夹 / 工作空间）作为 agent 工作根；记忆 sessions/skills 与项目绑定 | `Default_sessionInfo().cwd` 已存在（`cornfield serve` 接受 `--cwd`，web-app 已有 `workspaceDir` 设置项）；`natives` 提供 `readdir`/`stat`/`fs-cache`（`packages/natives`）。⚠ 推断：`lspmux` 已为 LSP 多路复用，**项目可作为 LSP 工作根切换基线**（`packages/coding-agent/src/lsp/lspmux.ts:30` 起） | 工作空间选择 UI（最近列表 + 文件夹浏览器 + remote/SSH/容器化路径的 picker 占位）；状态上下文沿用 `client-adapter` 模式（`packages/web-app/src/state/client-adapter.ts`） | 内核已具备 `cwd` 概念，**项目 = cwd；不需要新建领域模型**。难点在前端：路径合法性提示（大目录/隐藏文件/权限）、最近列表持久化、与已存在的 `settings.worktreeUri` 字段的关系 |
| **2. 文件编辑与预览** | 在编辑器里改文件、diff、行内预览、自动保存、语言识别、撤销重做 | 编辑**操作**全部已存在：`read`/`write`/`edit`/`ast-edit`/`ast-grep`（`packages/coding-agent/src/tools/`）；文件 watcher / fs cache / 文件记录回放（`file-recorder.ts`、`fs-cache-invalidation.ts`）。⚠ 推断：buffer 模型、CRDT/OT、MIME/snippet 当前**不存在**——需要编辑器前端自己解决，不能 push 给内核 | Editor 内的 buffer / 选区 / IME / 渲染（Monaco / CodeMirror 6 / Surreal / GPUI）；与 worker 写作的同步通道（RPC） | **架构最大风险**：内核只接受 "整段读 / 整段写 / 点位 edit" 三类语义，编辑器本地的"局部乐观锁"是该前端独有的范畴。**需要在 worker 内建一个 `fs/diff/protocol` 通道**——v0 假设走 `wire` 的扩展位（`commands.ts` 加 `fileEditStream` 类），不让编辑语义渗入 coding-agent 主循环 |
| **3. Git 集成** | diff / status / branch / log / blame / commit / push / PR 创建 + agent 触发 | `gh` 工具已就位（`packages/coding-agent/src/tools/gh.ts` + `gh-renderer.ts` + `gh-format.ts`）；⚠ 推断：纯 Git CLI 抽象层当前**没有**——`bash` 工具能跑 `git`，但没有 typed Git ops。前端若想要"图形化 diff"必须自己 fork diff 渲染或借用 `git` CLI 输出 | Editor 内 git panel (vscode 风格: changes / graph / blame gutter)；commit/PR UI；agent 触发提交走 `gh` 工具 | 内核已有 `gh`，**缺 typed git ops 层**。要么前端直接 `spawn git`（干净、独立），要么给 `coding-agent/src/tools/` 加 `git` 工具集。**MVP 建议前者**（干净，避免内核瘦身） |
| **4. Agent assistant** | 侧栏 / 面板会话、inline edit、⌘K、审批卡、CRUD skill/todo/memory | 全部已有：ACP external agent 模式（`packages/coding-agent/src/modes/acp/`）、wire 双向帧协议、`ApprovalCard`、`ClarifyCard`、`FloatingCardHost`（`packages/web-app/src/render/`）、MCP（`packages/coding-agent/src/mcp/`）、skill/todo/memory 全部 tools | Editor 内 agent 面板 UI；inline diff / ⌘K hook；审批卡渲染（直接复用 web-app 卡片组件或 host 一个 WKWebView 跑 web-app） | 这是差异化战场。**不能"另起一套 agent UI"**——必须复用 web-app 已有组件（ApprovalCard 等已生产验证）。Editor 端工作是"在编辑器坐标系里挂一个 agent panel"，不是新建 agent UI 子项目 |

共性结论（适用于两版方案）：

- **内核 0 改动**应作为默认目标。任何超出需求矩阵内核列的能力（typed git ops、file edit streaming protocol）都要单独评估 ROI。
- **编辑器前端 ≠ web-app**：web-app 资产不能简单一锅端进编辑器（rendering 栈不同）；但 web-app 的**纯逻辑组件**（card state machine / markdown 渲染 / approval 流）可以搬运。
- **LSP 不重新发明**：`lspmux` 已经存在（`packages/coding-agent/src/lsp/lspmux.ts:30`），编辑器只接 LSP via lspmux 客户端，自己不当 LSP server。

### 3.3 双版本对比与推荐

两版方案：OpenSumi 风格（IDE 框架嫁接）vs Zed 风格（编辑器 fork 嫁接）。

| 维度 | OpenSumi 风格 | Zed 风格 | 我的推荐 | 理由 |
|---|---|---|---|---|
| **进程复杂度** | 1 进程（Electron）+ 1 sidecar；编辑器 JS 跑在 renderer | 2 进程（原生壳 + GPUI 进程）+ 1 sidecar；fork 独立构建 | OpenSumi | 单进程部署/调试都更简单；团队 JS 为主无需补 Rust 人力 |
| **协议耦合度** | 低：纯走现有 wire，extension 走 webview iframe | 中：ACP（已上线） + MCP（已上线） + 自定义 fs-edit-protocol（⚠ 新增） + wire port（⚠ Rust port 成本） | OpenSumi | 新增协议面越少越好；内核 0 改动才是金句本意 |
| **编辑器内核选择** | Monaco (Battle-tested) 或 CodeMirror 6 (小、轻)；都纯 JS、MIT | Zed 原生（GPUI、Rust、Apache/GPL-3.0） | OpenSumi | 编辑光标/buffer 不是差异化，不值得为它背 fork 维护账 |
| **扩展性** | webview + 自定义 contribution，纯 web 生态（vscode extension API 风格） | Zed extension API（Rust + WASM）；扩展机制成熟但需要 Rust 写扩展 | OpenSumi | 50 人团队主导 web，扩展成本 CornField 团队可消化；Rust 扩展团队门槛高 |
| **跟 cornfield 现状契合度** | 极高：现有 `desktop` + `web-app` 资产直接复用；`CORNFIELD_DESKTOP_DEV_URL` 已支持多窗口入口（✓ 已确认 `desktop/main.ts:50`） | 中：需新建 `repos/zomp`（类比 brush-vendored），双 Cargo workspace 双 release pipeline | OpenSumi | 一致性：避免在尚未拍板的位置再次深入 |
| **MVP 人力成本** | 1 名资深 Web 工程师 | 1-2 名资深 Rust + 部分 Web；且需先做 P0 spike 验证 GPUIView 嵌入可行性 | OpenSumi | 时间/人力账差 2 倍；web-app 已有 agent 卡片、MCP、agent UI 资产 |
| **长期演化** | 路径平滑：从 web-app 内 iframe → 抽出独立 extension → 演进为完整 IDE 形态（OpenSumi/Code-OSS 都走过这条路） | 起点即重 fork：`gpui` 上游主分支日更，季度 rebase 账 +1，GPL-3.0 合规复审账 +1 | OpenSumi | 风险账更小，**演化路径是"渐进"，不是"先冲一把"** |

**推荐：OpenSumi 风格作为主推。** 理由：(1) 跟现有 `desktop` + `web-app` 资产契合度最高，`CORNFIELD_DESKTOP_DEV_URL` 这个口子已经留好了；(2) 编辑器内核（Monaco/CM6）不背 fork 维护账——光标/buffer/LSP 是红海，不是 CornField 差异化位面；(3) 内核 0 改动严格满足用户"改内核大家跟着变"原则；(4) MVP 时间/人力账短一倍以上。

**可混搭点**（保留 Zed 优势的子项）：

1. **顶部模式切换**：OpenSumi 风格只在 Electron 窗口内布局（侧栏 + 主区 + 面板），不强行分窗口；如果未来团队想要 macOS 原生体验，再单独评估"原生壳 + WKWebView + 工作台"组合。
2. **LSP 复用 lspmux**：两版都用，不带 fork 包袱。
3. **审批 / 卡片渲染**：直接 host web-app fragment（iframe 化）而非自写一套，跨前端一致。
4. **Zed 风格仅在 Phase 4+ 探索**：如发现 web-app iframe 体验差到必须换栈，再评估 Zed fork 的 P0 spike——届时已有了 runner。

不推荐 Zed 风格为主推的核心理由：**编辑体验不是差异化，差异化在 agent**——为编辑器背 fork 账是性价比最低的选择。

### 3.4 主推方案的架构骨架（OpenSumi 风格）

思路：把 OpenSumi 当**IDE 框架**看待——vscode-style 工作空间、扩展协议、内置 Webview 渲染。**直接复用 web-app 资产**，编辑器 = "编辑器形态的 web-app"。

#### 进程模型

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

特点：

- 编辑器内核 = **JS 进程内运行**（编辑器引擎不在独立进程）。简化部署，单 Electron app 单 sidecar。
- 浏览器/web-app 不需要新协议：现有 `client → wire`（web-app 已 `catalog:` 依赖）足以承担"远程编辑会话"。
- OpenSumi 风格的 Webview Extension 本质是 iframe + postMessage，几乎零边界。

#### 协议层选型

| 维度 | 选型 | 来源 |
|---|---|---|
| 传输 | WebSocket（与现有 wire 一致），新加 `app-level channels` | `packages/wire/src/frames.ts` |
| 序列化 | 现有 JSON（wire 已定义）| 同上 |
| 消息模型 | request/response（id 关联）+ subscribe（事件流），与现有 wire 命令重合 | 已存在的 snapshot cache、subscribe-across-reconnect |
| 文件编辑通道 | **新增**：`fileEditStream { sessionId, op: "open"\|"change"\|"close" }` —— 在 wire 扩展位加 enum，不侵入已存在协议 | ⚠ 推断，后续上 gitnexus check |
| Git ops | 通过 `gh` + `bash`（现有工具），**不**新增 git 工具集 | `packages/coding-agent/src/tools/gh.ts` |

> 注：v0 此处"不新增 git 工具集"的判断，后续 v1 修正为"前端 spawn git + 走 wire 命令面"——即 §1.4 缺口清单中的 `fs_write` / `fs_edit` / `fs_diff` / `git_*` 一整套 wire 命令（见 §3.5）。

#### 前端分层

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

#### 模块归属

| 改动对象 | 内容 | 理由 |
|---|---|---|
| **新建** `packages/editor-extension` | OpenSumi-style workbench 框架、extension slot、布局引擎 | 不污染 `web-app`，编辑器是独立前端 |
| **扩展** `packages/desktop` | 加 "IDE 模式" 菜单项 / 多窗口 / dev URL 指向 editor-extension dev server | `desktop/main.ts:50` 已支持 `CORNFIELD_DESKTOP_DEV_URL`（✓ 已确认） |
| **不扩** `packages/web-app` | 渲染层复用 web-app 资产，但不在 web-app 包内编辑器化 | 避免 web-app 变成编辑器壳 |
| **只读** `packages/coding-agent` | ACP mode + 现有 tools 不动；新增可选 `fileEditStream` 走 `wire` 扩展位 | 内核稳定 |
| **复用** `packages/wire` / `packages/client` | 加 wire 命令 / 客户端订阅类型；web-app 升级时同步受益 | 与金句一致 |

#### 嫁接到 cornfield 哪里

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

### 3.5 后续细化

- v0 草案已被 v1 合成稿（`topics/v1-synthesis.md`）取代并精细化：**主借鉴 OpenSumi + 按需借鉴 Zed**（v0 推荐判断仍有效）。
- 两处修正：(1) v0 的"前端 spawn git + 不进内核"判断修正为"前端 spawn git + 走 wire 命令面"——即 §1.4 的 `fs_write` / `fs_edit` / `fs_diff` / `git_*` wire 命令集；(2) v0 MVP 工期估算（4-6 周）修正为 5-7 周 MVP、9-12 周全量。
- v1 补回的功能缺口：Search / Quick Open / Terminal / Save conflict / LSP writethrough / Crash recovery / Code Actions / Markdown preview / Symbol Outline 等。
- 决策门：v1 必须明确 OpenSumi 风格 vs Zed 风格哪一套最终开工的判断标准；任何时候选 Zed 风格，必须先做 P0 spike（GPUIView 嵌入验证）才能进入后续阶段。
- 历史关联文档：`topics/cornfield-client-design.md`（历史提案 A：Tauri + Zed 窗口级，已废弃）与早期 Zed 集成思路（原生壳 + GPUIView 深嵌，方案待拍板）为 Zed 风格的前置探索，主推方案不沿用。