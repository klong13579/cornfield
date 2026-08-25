# 01 — 现状摸底：加前端编辑器扩展前要看清的能力

> 范围：仓库 `/Users/sz-0203015357/Desktop/Narwal/oh-my-pi` 内已有能力。  
> 读法：✓ 已确认（带文件:行号）/ ⚠ 推断（带依据）/ ✗ 缺（带「需要新建什么」）。  
> 目标：让「加编辑器扩展」决策时知道哪些能复用、哪些要新建、哪些要扩。

---

## 1. 前端壳

### 1.1 Electron 桌面壳 (packages/desktop)

- ✓ Sidecar 进程机制：Electron 启动时 `ensureSidecar` 把 `omp serve` 作为子进程拉起，监听 `127.0.0.1:7891`，注入 `OMP_SIDECAR=1` 环境变量用于进程识别；端口被占且不是我方时直接复用。固定端口 `SERVE_PORT = 7891`。  
  - `packages/desktop/src/sidecar.ts:13-17, 175-184`
- ✓ Sidecar 二进制解析优先级：env `OMP_BINARY` > 打包内嵌 `resourcesPath/omp-binary/omp` > `~/.local/bin/omp` > 开发 build `coding-agent/dist/omp` > PATH 回退。  
  - `packages/desktop/src/sidecar.ts:53-72`
- ✓ Electron ↔ sidecar 通信：sidecar 在 `7891` 起 WebSocket serve，**主进程序没有任何直连 IPC 到 sidecar**（不靠 stdio/HTTP），Electron 只负责把渲染层（web-app dist）作为 BrowserWindow 加载 + 维护托盘常驻 + electron-updater。  
  - `packages/desktop/src/main.ts:46-105`（`loadURL` / `loadFile`），`:75-77`（占位 HTML 内现写「连接 ws://127.0.0.1:7891/ws」）
- ✓ Electron 当前能挂的 UI：`BrowserWindow`（1200×800 占位 + 隐藏关闭 → 托盘常驻）+ `Tray`（显示/退出）+ `Menu`（托盘右键）。**没有 child window、没有 webview、没有扩展宿主。**  
  - `packages/desktop/src/main.ts:8-44, 107-118, 200-207`
- ✓ IPC channel 一览（renderer 侧由 `preload.ts` 通过 `contextBridge` 暴露 `window.api`）：只有 `sidecar:get-workspace-dir` / `sidecar:set-workspace-dir` / `app:*`（version+update）——**没有任何「插件/编辑器/文件浏览」IPC**。  
  - `packages/desktop/src/preload.ts:11-44`
- ⚠ 没有任何「宿主给宿主加载插件」的钩子。preload 是最小面，contextIsolation+sandbox+nodeIntegration=false 全锁死。要给编辑器开「文件读、原生菜单、shell spawn」必须扩 preload + ipcMain.handle。
- ⚠ 编辑器若要真"嫁接"到 Electron，最小新面是：preload 加 `window.api.editor.*`（fs_list/fs_read/fs_write 透传）+ 主进程起 `BrowserView` 或 child BrowserWindow 嵌入 web 应用页面（基于 React）。当前 web-app 是嵌进 Electron 的同一份渲染层，自然可以走「Web app 内嵌编辑器视图」。

### 1.2 Web 应用 (packages/web-app)

- ✓ `packages/web-app` 是 React + Vite + Tailwind + TypeScript 多页应用；通过 `PiClientAdapter` 包装 `pi-client`，连接 `ws://127.0.0.1:7891/ws`（electron 跑时由 sidecar 提供）。  
  - `packages/web-app/src/state/pi-client-adapter.ts:83-127`
- ✓ 连接默认配置硬编码 `ws://127.0.0.1:7891/ws`，token 走 localStorage 持久化（设置页可改）。  
  - `packages/web-app/src/state/pi-client-adapter.ts:91-93`
- ⚠ 已知路由/pages：`agents`、`home`、`insights`、`memory`、`models`、`records`、`settings`、`skills`、`tasks`、`todo`、`voice`、`workspace`。当前整体定位是 **agent 管理 + 会话回放 + 工具能力 + 设置**，偏 chat-style 与运维控制台；**无 IDE 无 monaco**。
- ✓ 已有的「只读文件视图」：`FileExplorer` 用 `fs_list`/`fs_read` 懒加载目录树 + 文本预览（不写、不 diff、不选中行操作）。  
  - `packages/web-app/src/pages/workspace/FileExplorer.tsx:5, 59-180`
- ⚠ 因此现状：「文件树 + 预览」半套已有，「写/编辑/diff/git 操作按钮/git 集成/Agent assistant 板」全套没有。

---

## 2. 协议层

### 2.1 pi-wire

- ✓ 序列化：**纯 JSON 字符串**（`<frame>` → `ws.send(JSON.stringify(...))`）。无 MessagePack、无自定义二进制。  
  - 协议格式：`ClientFrame` / `ServerFrame`，含 `hello/hello_ack/ping/pong/request/response/push` 六类。  
  - `packages/pi-wire/src/frames.ts:13-78`；`packages/pi-client/src/client.ts:218, 266, 358`
- ✓ 传输：**WebSocket**（`PiWebSocketLike` 兼容浏览器/Bun/Node ws）。端点 `ws://host:port/ws`，hello 握手含 `version` + `token`。  
  - `packages/pi-wire/src/frames.ts:18-20`；`packages/pi-client/src/client.ts:85-115`
- ✓ 协议版本：`MULTIDEVICE_PROTOCOL_VERSION = 1`，向后兼容语义：加 push 帧为可选，旧客户端忽略未知帧仍可工作。  
  - `packages/pi-wire/src/frames.ts:14-22`
- ✓ 主消息类型与 schema：
  - `ClientFrame = hello | request | ping | host_tool_result | host_tool_update`
  - `ServerFrame = hello_ack | hello_error | response | push | pong`
  - `WireCommand` = `MultiplexCommand` (prompt/abort/new_session/set_todos/set_host_tools/set_model/set_thinking/compact/branch/fork_from/undo_exchange/retry_from/get_messages/switch_session/list_agents...) ∪ `WireExtensionCommand` (subscribe/get_snapshot/attach/detach/list_sessions/get_session_messages/fs_list/fs_read/fs_read_image/gateway_status/get_stats/get_memory/get_skills/set_skill_enabled/set_model_disabled/inject_permission/permission_respond/record_transcribe/listen_list/list_commands/get_cron_tasks/get_cron_logs/cancel_queued...)
  - `WireServerEvent = server_snapshot | session_snapshot | progress | host_tool_call | host_tool_cancel | host_tools_changed | permission_request`
  - 位置：`packages/pi-wire/src/commands.ts:30-200+`；`packages/pi-wire/src/frames.ts:80-152`
- ✓ wire 设计严格只在「传输形状」层；零运行时依赖 coding-agent（`packages/pi-wire/src/index.ts:1-15`）。命令面收录需要人 review 代码：`pi-wire` 加 → coding-agent 端 wire-server 加。
- ✓ 错误码枚举 12 类（rate_limit/quota_exhausted/tool_limit_reached/cancelled/internal...）已结构化在 `WireErrorPayload`，前端可分类处理。  
  - `packages/pi-wire/src/frames.ts:118-142`

### 2.2 pi-client

- ✓ 一个类：`PiClient`（不是函数也不是 hook）。构造接受 `{ url, token, webSocketCtor?, protocolVersion?, requestTimeoutMs?, reconnectBaseMs?, reconnectMaxMs?, heartbeatIntervalMs?, heartbeatTimeoutMs? }`。  
  - `packages/pi-client/src/client.ts:67-117`
- ✓ 公开 API：`connect()` / `request<T>(WireCommand): Promise<T>` / `subscribe(listener)` / `subscribeSnapshot(listener)` / `getCachedSnapshot(sessionId)` / `close()`。  
  - `packages/pi-client/src/client.ts:184-243`
- ✓ 内部能力：指数退避重连、心跳（30s ping/60s pong 超时）、session_snapshot 缓存、断线时 in-flight 立刻 reject。
- ✓ 错误分类 4 类（断线/超时/服务错/握手错）便于上层针对性处理。  
  - `packages/pi-client/src/errors.ts:14-58`
- ⚠ 已能调用后端：**任何在 `WireCommand` 中的命令**——包括已经支持的 `fs_list/fs_read/fs_read_image/get_messages/list_sessions/get_snapshot/...`。  
  - 因此"加编辑器"前端读文件的 wire 通道已经现成；**不存在「后端不支持」的协议层缺口**，只缺前端 UI。

### 2.3 ACP mode

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
  - `extMethod`（非标扩展：omp/sessions/listAll、omp/projects/list、omp/chats/byCwd、omp/usage、omp/extensions、omp/extensions/toggle 等）— `acp-agent.ts:431-507`
- ⚠ **没有 read/edit/runShell/listFiles 类工具调用能力。** ACP 是「会话控制 + LLM 交互」通道，不是 IDE 通道：编辑器需要的 file ops 不能挂 ACP。
- ✓ schema 位置：`@agentclientprotocol/sdk`（外部 npm 包）+ `acp-agent.ts` 中具体方法签名。
- ⚠ 编辑器要走 ACP 也只能复用 prompt/cancel + session 管理能力，**不要尝试把 fs_read/fs_write 挂到 ACP**——那是另一码事（既有 pi-wire 已经能直供）。

---

## 3. 内核抽象

### 3.1 agent runtime (packages/agent)

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

### 3.2 natives + pi-natives

- ✓ Rust crate：21 个 mod，`pi-natives/src/lib.rs:24-45`。JS 侧由 `packages/natives/native/index.d.ts`（1208 行自动生成）暴露。
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
  这意味着编辑器若要"原生内存 mapped file""fast file ops"——现有 pi-natives 不够，要新加。
- ⚠ grep/glob/ast-grep/ast-edit 都是文件级扫描，**不是面向单文件交互的文本操作 API**（无 cursor-based edits、无 incremental file watcher）。
- ⚠ 不暴露 JS 的：`appearance::detect_appearance / start` (mac internal fn)、`ps` (util 内)、`prof` 内部、`tokens` 中 tiktoken encoder init、`utils.rs` 通用工具——这些仅供 Rust 内部使用。

### 3.3 工具层覆盖度（重要一行一览）

| Tool | 文件 | name | 形态 | 前端直调？ |
|---|---|---|---|---|
| read | `tools/read.ts` | `ReadTool` | TSchema `path/sel/timeout`；流式读 + 行号/hashline + archive/sqlite 透明 + URL 抓取 + 图像识别；LSP writethrough | ⚠ 不直接；通过 `session` + `dispatch`（前端的 `get_snapshot` 拿了 agent tool register 表），wire 没暴露「调用 read tool」 |
| write | `tools/write.ts` | `WriteTool` | TSchema `path/content`；Bun.write；archive/sqlite 适配；LSP writethrough；plan-mode guard；hashline strip | ⚠ 不直接；wire 已能 `fs_read`/`fs_read_image`，**`fs_write` 还没有 wire 命令** |
| edit | `edit/index.ts` | `EditTool` | 多模：replace/patch/apply_patch/hashline/atom/vim；LSP writethrough + 模糊匹配；并发 exclusive + nonAbortable | ⚠ 不直接；同上 `fs_write` 缺 |
| find | `tools/find.ts` | `FindTool` | TSchema + 后端走 `pi-natives.glob/fs_cache` | ⚠ 不直接；`fs_list` wire 提供更通用的 workspace 树，不绑定 cwd |
| search | `tools/search.ts` | `SearchTool` | ripgrep 包装（`grep.rs`） | ⚠ 不直接 |
| ast-grep | `tools/ast-grep.ts` | `AstGrepTool` | `pi-natives.astGrep(options)` | ⚠ 不直接 |
| ast-edit | `tools/ast-edit.ts` | `AstEditTool` | `pi-natives.astEdit(options)`；并发 exclusive | ⚠ 不直接 |
| bash | `tools/bash.ts` | `BashTool` | TSchema command + timeout + run-in-background | ⚠ 不直接；wire 没「shell 调用」命令 |
| lsp | `lsp/index.ts` | `LspTool` | diagnostics/format/definition/... | ⚠ 不直接 |
| github | `tools/gh.ts` + `discovery/github.ts` | `GithubTool.createIf` | gh CLI 包装 | ⚠ 不直接 |
| hub | `tools/hub.ts` | `HubTool.createIf` | cross-session 调度 | ⚠ 不直接 |
| git | `commit/agentic/tools/*` + `autoresearch/git.ts` + `modes/components/status-line/git-utils.ts` | 多个内部 helper | status/diff/overview/file-diff/hunk — 全部给 TUI/agent 用 | ⚠ 不直接 |
| 其它 | ask/calculator/checkpoint/debug/identity/inspect_image/job/list_models/notebook/python/recipe/render_mermaid/report_tool_issue/resolve/review/search-tool-bm25/ssh/switch_model/task/todo_write/vim/web_search/yield/image-gen/... | 见 `tools/index.ts:84-115` | 28 个 tool + 5 个 hidden | ⚠ 不直接 |

> ⚠ 工具层覆盖度的关键结论：**所有工具都是「给 Agent 调」，不是「给前端调」**。前端能「读」+「读图」（wire `fs_read`/`fs_read_image`），但**写/编辑/diff/git/IDE bash 调用都没有 wire 命令面**——这是编辑器扩展第一道缺口。

---

## 4. 编辑器扩展需要补的（✗ / ⚠ 项）

### ✗ 必须新建的（前端 → wire / Agent 均要）

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
6. **前端 Agent assistant 面板（已经隐式存在）**：右栏 + `@uiw/react-md-editor`/流式渲染 + steering/follow-up 按钮——已有 `PiClientAdapter.prompt/abort/compact/forkFrom/undoExchange/retryFrom/setModel/setThinkingLevel/...`，**几乎全套命令已现成**，只需组件封装。  
   - `packages/web-app/src/state/pi-client-adapter.ts:151-220`
7. **Electron preload 扩展**：当前 `window.api` 只有 sidecar 和 update，要新增 `editor.openProject(path)` / `editor.getCwd()`（renderer 直接用 `fs_list`，但 Electron 模式要给一个快速路径 + native file dialog）。  
   - `packages/desktop/src/preload.ts:1-44`

### ⚠ 已存在但需要扩展的

1. ⚠ **`FileExplorer`（只读）→ 升级为编辑器**：已用 `fs_list/fs_read`，缺写/diff/git 操作按钮。  
   - `packages/web-app/src/pages/workspace/FileExplorer.tsx:1-180`
2. ⚠ **wire 的 `fs_*` 命令当前限制 `128KB` 截断 + 路径 sandbox 锁 agentDir**：编辑器要打开大文件要扩展上限；要么走原生 `Bun.file().text()`（由 electron preload 开 bsd），要么 wire 引入 chunked fs_read。  
   - `packages/pi-wire/src/commands.ts` `fs_read`/`fs_read_image` 注释（128KB / 2MB 截断）
3. ⚠ **LSP writethrough**：已经在 `edit/index.ts`/`write.ts`/`createLspWritethrough` 路径上运转，但前端编辑器若直接调 `fs_write` 会绕开 LSP（漏格式化+诊断）；要么扩展 `fs_write` 内部走 LSP，要么在前端保留 "keep LSP formatting on save" 开关。
4. ⚠ **`Agent` `subscribe` + `emitExternalEvent`** 已存在，但 wire 层没有 expose 全套 `Agent` 对外事件（如 `tool_execution_start/end`、`message_update/delta`）—`WireServerEvent.progress` 是 server 侧 push。  
   当前 web-app 订阅流其实 work (`push` → `session_snapshot` 缓存 + progress)，但 progress 内容是否齐全，要进一步读 serve 端实现确认。
5. ⚠ **`AcpAgent.prompt` 已经把 slash 命令 `/compact /help /model /clear /exit` 走本地分支**：编辑器要"固定命令时 unhook agent 直发"完全可走这套 prompt 路径。  
   - `packages/coding-agent/src/modes/acp/acp-agent.ts:363-410`
6. ⚠ **host tools**：wire 已经支持 `set_host_tools` / `host_tool_call`（让 server 拿到 client 实现的 tool 并让 agent 调）——编辑器"自身的自定义工具"（如 `read_current_editor_selection`）可以挂这个机制给 agent 用，几乎不用写后端。  
   - `packages/pi-wire/src/frames.ts:87-115`；`packages/pi-wire/src/commands.ts` `set_host_tools`
7. ⚠ **permission_request 协议已预留审批/澄清**：编辑器想做 "审批危险 write 之前弹出" 可以直接 wire `permission_request`，不必新写审批流。  
   - `packages/pi-wire/src/frames.ts:103-115`

### ✗ 还需要新建（不在 wire 也不在 tool 内）

8. **多文件/多 step undo**：现有 `edit` 是文件级，未暴露会话级「重做步骤列表」给前端。ACP 有 fork/resume，但跳会话太重。
9. **大文件 streaming render**：Monaco 自带；wire `fs_read` 一次性，不支持 chunked read + line range streaming serving。
10. **native file watcher**：`fs_cache.invalidateFsScanCache` 是 Rust 侧 path invalidation，无 inotify/fsevents 实时 push——编辑器实时提示 dirty 需要 fs.watch 后端或前端 chokidar。

---

## 5. 现状速读总结

- **内核干净**：`Agent` class（agent-core + agent-loop）+ 28 个 tool + wire JSON-over-WS + native 21 mod 都是稳定的「实现一次，全前端复用」的状态；编辑器扩展不需要重写内核。
- **协议已通**：wire JSON-over-WS 协议完整（v=1，向后兼容），pi-client 已有重连+心跳+snapshot 缓存；编辑器前端只要写一个 `PiClient`-based adapter 就能复用 80% 命令面（prompt/abort/compact/fork/setModel/...）。
- **ACP 不能承载 IDE ops**：ACP 是「会话控制 + agent」通道，没有 file/read/edit/diff/git 命令面；编辑器必须直接走 pi-wire，不走 ACP。
- **三处真实缺**：① 写/diff/git 类 wire 命令还没有（`fs_write`/`fs_edit`/`fs_diff`/`git_*` 一整套）；② Electron preload 没有任何 editor IPC；③ 前端 0 行编辑器代码（无 Monaco/CodeMirror，FileExplorer 只读）。把这三块补上即可在不重写内核的前提下嫁接编辑器。
- **最大复用面**：既有 `AgentTool` 接口统一所有读/写/编辑/Bash/LSP/AST 工具的 schema/result，流式事件通过 wire push 自然给到编辑器，无需新建 session 抽象。
- **LSP 是关键支柱**：write/edit 都已挂 `createLspWritethrough`，新 wire 写命令必须延续这条链路才不会破坏格式化+诊断回路。
- **macOS 跟 dev-shell 都有原生底子**：clipboard / fuzzy-find / glob / grep / highlight / ast-grep / ast-edit / PhotonImage / audio 都是 N-API 暴露的，可直接给编辑器复用（语法高亮、AST 重构、模糊搜索、剪贴板图、缩略图）。
