# OMP 桌面客户端 · Zed 深嵌集成 — 需求 Spec（本地）

> to-spec 产物（本地发布，非 issue tracker）· 2026-08-21
> 输入：`docs/omp-client-zed-integration.md`（实施蓝图）+ 全部源码验证（Zed main@10b2925e7c、gpui_macos 源码实证）
> 状态：**待用户确认 seams 与拍板项后转 ready-for-agent**

---

## Problem Statement

OMP 的 webapp（数字员工控制台 + agent 工作台）需要一个**程序员编辑器**作为原生体验的一等公民：程序员在代码里干活时，数字员工（agent）应该就在编辑器旁边，而不是切到浏览器。此前两条路径均被验证不适合直接投产：

1. **webapp 内嵌浏览器 IDE**（OpenSumi/Monaco + iframe，spike 已跑通）——形态验证过半，但完整 IDE 能力靠自建壳或 OpenSumi contribution 体系，编辑器体验远不如本地原生（终端/git/性能/快捷键），且浏览器沙箱与本地文件系统隔了一层。
2. **现有 Electron 壳**（`packages/desktop`，已投产：更新流/签名/dmg 打包/worker sidecar 全闭环）——Electron 窗口是 Chromium 独占，**无法单窗口内嵌原生编辑器视图**（GPUIView 嵌入需 hack，Electron 升级脆弱）。

用户决策：**直接做桌面客户端，把开源 Zed 深嵌进 OMP 客户端**（单窗口单 app，不是两个客户端），复用 OMP 现有全部资产（webapp / worker / agent 内核）。

## Solution

**Zomp**：fork Zed（GPL-3.0 接受，改动仅限 agent 挂点与窗口嵌入层，编辑核心零改动），作为 OMP 桌面的编辑器组件；OMP 用**原生壳**（AppKit 容器）承载两个常驻视图，顶部 `[Agent | IDE]` 切换：

- **Agent 模式（默认）**：整窗 = WKWebView 跑现有 `packages/web-app`（数字员工控制台，零重写）
- **IDE 模式**：整窗 = GPUIView（Zed fork 编辑器，NSView 嵌入原生壳 contentView）
- 两 view 常驻，切换 = hide/show swap（会话/编辑状态互不丢失）
- **worker sidecar**：`packages/desktop/src/sidecar.ts` 逻辑平搬到原生壳（spawn `omp serve` :7891）
- **更新链**：借用 Zed fork 自带 auto-update（改 endpoint），不重做 electron-builder 打包
- **agent 集成面**（由浅入深）：ACP external agent（已验收）→ MCP/context server → fork 内深挂点（⌘K/审批卡/侧栏）

**已证实的可行性依据**：
- `gpui_macos/src/window.rs:1009-1020`：GPUIView 是标准 NSView 子类，创建路径与 NSWindow 解耦 ⇒ 可挂宿主 view（B 的地基）
- 改动面集中：gpui embedded 模式（~200 行）+ `zed/src/main.rs:126` 启动触点（一处）+ 壳层

## User Stories

1. 作为程序员，我打开 OMP.app 即进入数字员工控制台（与现有 webapp 完全一致），零学习成本。
2. 作为程序员，我点击顶栏 `IDE`（或 ⌘2）即切换到完整 Zed 编辑器（文件树/tab/终端/git/调试），编辑器体验与原生 Zed 无差别。
3. 作为程序员，我在 IDE 里选中代码并唤起 agent（ACP 面板），agent 的对话、工具执行、diff 审阅在同一窗口内完成，不用切 App。
4. 作为程序员，切换 Agent/IDE 后两边状态保持（webapp 会话不丢、编辑器缓冲区/未提交改动不丢）。
5. 作为数字员工管理者，我在 Agent 模式里管理 agent/会话/技能/MCP/语音（现有 webapp 全部能力不因桌面包装而损失）。
6. 作为用户，OMP.app 是唯一的 dock 条目（单 app），Zed 不产生独立窗口/图标。
7. 作为用户，我看到一个统一状态栏：worker 在线、agent 在线数、git 分支（右侧依赖 IDE 模式打开项目）。
8. 作为用户，OMP.app 更新走实例化更新（下载进度/手动重启安装），与现有 desktop 更新体验一致。
9. 作为用户，深色/浅色主题在 Agent 与 IDE 模式间保持一致（webapp CSS 变量 ↔ Zed 主题映射）。
10. 作为程序员，IDE 模式无项目打开时显示欢迎视图（最近项目 + 打开文件夹），与 Cursor/Zed 行为一致。
11. 作为开发者，Zomp 的 fork 定制区（gpui embedded/启动触点/品牌）与上游保持可同步（季度 rebase 兼容）。
12. 作为 OMP 维护者，webapp 与 worker 的 CI/测试/发布链路不因桌面壳变化而破坏（壳改动隔离在 `packages/desktop` 替代产物内）。

## Seams（测试接缝，按优先级）

1. **P0 embedded spike（最高 seam，最先验证）**：裸 AppKit NSWindow + GPUIView 渲染 Zed workspace + 键盘事件 + **display link 功耗实测**（隐藏窗口空转帧）。验证失败项决定形态降级（A 窗口级）。
2. **view swap 生命周期**：Agent ⇄ IDE 切换 N 次后两边状态完整（webapp 会话、Zed 缓冲区）；切换耗时 < 300ms。
3. **sidecar 平搬连通**：原生壳 spawn `omp serve` → webapp pi-wire 连通（复用 SPIKE-4 的 ws 验证法）。
4. **ACP 挂点注册**：Zomp 内置 OMP ACP agent（agent_servers 配置）→ Zed agent 面板对话走通。
5. **更新链**：Zomp updater 改 endpoint 后，dmg/zip 产物可安装、可自动更新、adhoc 签名验证通过。

## Open Questions（待拍板，spec 固化为 TBD 不阻塞 P0）

- [ ] P0 spike 是否开跑（1-2 周，可先于专职 Rust 立项）
- [ ] fork 仓库形态：独立 repo `zomp`（推荐，打包产物层集成）vs monorepo 子目录
- [ ] 上游同步：季度 rebase vs 冻结（推荐季度 rebase + 定制区独立 feature）
- [ ] 旧定稿文档状态（Tauri 窗口级）标记 superseded
- [ ] 专职 Rust 人选（F1 账：P0 先探，确认后立项）

## 验收草案（doneWhen）

- P0：GPUIView 在宿主 NSWindow 渲染 Zed 工作区，键盘/鼠标可用，功耗可接受（空转 ≤ 显式停止策略成立）
- P1：OMP.app 单图标启动 = 完整 Zed 编辑器可用（embedded 稳定 + sidecar 拉起 + 更新链通）
- P2：顶部 Agent/IDE 切换 + webapp 面板 + ACP agent 对话走通
- P3：fork 深挂点（⌘K inline / 审批卡 / 数字员工侧栏）上线

---

## ACP 注册（T4）— OMP Agent 作为 Zed External Agent

> 状态：注册挂点已源码实证定位，协议契约已固化；**配置注册零 Zed 代码，provider 注册改动点在 T4 scope 外**，标注待集成验证。gate kind=unknown（无 verifier），mergePolicy=human-review。

### 结论（一句话）

OMP 作为 Zed external agent 走 **ACP 自定义 agent（custom agent）** 路径：纯 `settings.json` 的 `agent_servers` 配置驱动，Zed 侧无需改代码；Zed spawn `omp acp` 子进程，经 stdin/stdout 用 JSON-RPC 2.0 讲 ACP v1。

### ACP 协议契约（供 T3 server 侧实现）

| 项 | 值 |
|---|---|
| 协议 | Agent Client Protocol (ACP)，spec 见 https://agentclientprotocol.com |
| 传输 | JSON-RPC 2.0，newline-delimited 消息，走子进程 **stdin/stdout**；stderr 为日志（Zed 收进 `AcpDebugMessageDirection::Stderr`） |
| 协议库 | Zed workspace 依赖 `agent-client-protocol = { version = "=2.0.0", features = ["unstable"] }`（`third_party/zed/Cargo.toml:518`） |
| schema | `agent_client_protocol::schema::v1`，握手协商 `ProtocolVersion` |
| 角色 | Zed = ACP **client**（`agent_servers::AcpConnection` 持 `ConnectionTo<Agent>`）；OMP = ACP **agent/server** |

**关键澄清**：Zed 的 external agent 连接**没有 TCP 端口**——是 spawn 子进程 + stdio JSON-RPC。`omp serve :7891`（T3）是 worker sidecar 的 HTTP 端口（webapp pi-wire + `GET /health`），与 ACP 传输无关。OMP 需要**新增一个 stdio 入口** `omp acp`（或 `omp serve --acp`），不要把它和 HTTP serve 混成一个。

### Zed 侧注册配置（`settings.json`）

```json
{
  "agent_servers": {
    "omp": {
      "type": "custom",
      "command": "omp",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

schema：`settings_content::CustomAgentServerSettings`（`#[serde(tag = "type", rename_all = "snake_case")]`，`crates/settings_content/src/agent.rs:736-797`）。`Custom` 变体字段：`command`（重命名自 `path`）、`args: Vec<String>`、`env`，可选 `default_mode`/`default_config_options`/`favorite_config_option_values`。`Registry` 变体（`type: "registry"`，alias `"extension"`）走 ACP Registry。

### 注册挂点（源码锚点，已逐一核实）

配置驱动，无 per-agent 代码。数据流：

1. `settings.json` `agent_servers` → `settings_content::CustomAgentServerSettings`
2. `project::AgentServerStore::reregister_agents`（`crates/project/src/agent_server_store.rs:294`）：`Custom { command, .. }` → `LocalCustomAgent`
3. `agent_servers::CustomAgentServer::connect`（`crates/agent_servers/src/custom.rs:193`）：spawn `command` + `acp::connect`（`crates/agent_servers/src/acp.rs`）→ stdio JSON-RPC

`crates/zed/src`（T4 在 scope 内）的入口仅是 ACP 基础设施初始化，非 per-agent：

- `crates/zed/src/main.rs:706` — `acp_tools::init(cx)`（ACP 调试工具栏）
- `crates/zed/src/main.rs:715-719` — `project::AgentRegistryStore::init_global(...)`（ACP Registry）
- `crates/zed/src/main.rs:720-727` — `agent_ui::init(...)`（Agent 面板）
- `crates/zed/src/zed.rs:2461-2468` — `AI_ACTION_NAMESPACES` 含 `"acp::"`

### Provider 注册改动点（T4 scope 外，待集成）

若 OMP 要 first-class provider 待遇（类比 Claude/Codex/Gemini/Cursor 的 env 注入），改动点在 `crates/agent_servers/src/custom.rs`（**不在 T4 scope**，T4 scope 只含 `crates/zed/src/**`）：

- `custom.rs:17-20` 已有 `GEMINI_ID`/`CLAUDE_AGENT_ID`/`CODEX_ID`/`CURSOR_ID` 常量 → 加 `pub const OMP_ID: &str = "omp";`
- `custom.rs:229-247` `connect` 里 `match agent_id.as_ref() { OMP_ID => { /* env 注入 */ } }`

这一层**不是必需**——custom agent 路径已经能用，只是没有 provider 专属 env 注入。标记为 follow-up。

### T3 server 侧待实现（ACP 端）

- OMP 二进制新增 `omp acp` 子命令：读 stdin 的 ACP v1 JSON-RPC，写 stdout，stderr 打日志。
- 与 `omp serve :7891`（HTTP sidecar，`GET /health` → ok）分离。
- 最低握手：`initialize`（协商 `ProtocolVersion`）+ `session/new` + `session/prompt` + `session/update`；工具调用走 `session/update` 的 tool call。完整 schema 以 `agent-client-protocol` v2.0.0 为准。

### 验证状态

- **编译验证未跑**：zed workspace 全量 `cargo check` 需 Xcode/CLT + `runtime_shaders` 特性绕开 xcrun metal，成本高；且本任务注册路径是纯配置 + 文档，无 Rust 代码改动。按 acceptance「编译验证成本过高时明确标注待集成验证」，此处标注：**待集成验证**（gate unknown / human-review）。
- 已核实（源码实证，非推断）：协议库版本、传输方式、settings schema、注册数据流、`crates/zed/src` 入口锚点。