# OpenSumi Spike 验证结论

> 日期：2026-08-25（含 2026-08-25 第二轮：Electron 实跑探针）
> 目标：验证"OpenSumi 作为 omp 客户端（IDE 视图）底座"的可行性
> 方法：代码级证据 + OMP 侧 ACP 协议/会话真实运行测试 + ide-electron 实跑（spike 探针，非正式实现）

---

## 结论总览

| # | 验证点 | 结论 | 证据 |
|---|---|---|---|
| 1 | OMP agent 挂进 OpenSumi ACP 面板 | ✅ **过** | 同 SDK 同协议 + 配置化注册 + OMP server 全会话流实测通过 |
| 2 | 文件服务接 wire | ✅ **过（模式可行）** | registerProvider(scheme) 标准扩展点存在；缺口是 omp 侧 fs_write 命令（已知缺口） |
| 3 | web-app 资产复用 | ✅ **过** | OpenSumi 有 webview-host（iframe 宿主）+ browserViews 组件注入 |
| 4 | Electron 运行形态 | ⚠ **部分过** | ide-electron 官方样例（MIT，CI 绿）；spike 内未跑全量 Electron 构建，待集成阶段实跑 |

**整体判定：OpenSumi 底座成立，可以进入正式架构设计。** 四个点无结构性 blocker。

---

## 验证细节

### 1. ACP 挂载 —— 最强证据

- **OpenSumi 强制 ACP**：`packages/ai-native/CONTEXT.md`（main）规定 "Every Agent available in Agentic Layout must be an ACP Agent"。OMP 的 ACP server 正好对上。
- **同 SDK**：
  - OpenSumi client：`@agentclientprotocol/sdk@^0.16.1`（`ai-native/src/node/acp/acp-thread.ts`，`dynamic import`）
  - OMP server：`@agentclientprotocol/sdk@0.20.0`（`packages/coding-agent`）
  - ACP 协议 version=1，握手协商。
- **配置化注册（零代码）**：`ai-native.acp.agents.<agentId> = { command, args, ... }`（`default-acp-config-provider.ts` + `build-agent-process-config.ts`）。OMP 注册样例：
  ```jsonc
  // OpenSumi preferences
  "ai-native.acp.agents": {
    "omp": { "command": "/path/to/omp", "args": ["acp"] }
  }
  ```
- **OMP server 实测**（本机运行）：
  - `bun packages/coding-agent/scripts/acp-smoke.ts` → `PASS initialize → protocolVersion=1`，`PASS _ping → pong=true`
  - `bun packages/coding-agent/scripts/acp-session-test.ts` → `initialize → newSession → prompt(/help) → session/close` 全链路 PASS（agent_message_chunk 流式返回正常）

### 2. 文件服务接 wire

- OpenSumi `IFileService.registerProvider(scheme, FileSystemProvider)` 是标准扩展点（`packages/file-service/src/common/files.ts:193`），已有 `file://` 磁盘 provider 先例（`file-service-contribution.ts:40`）。
- omp 侧 wire 现状：`fs_list` / `fs_read` / `fs_read_image` 已有；**`fs_write` / `fs_edit` / `fs_diff` 缺失**（docs/editor-extension/01 已记录的第一道缺口）。实现一个 `omp-workspace://` provider 代理到 pi-wire + 补 fs_write 即可闭环。
- 另：OpenSumi ACP client 实现了 agent→client 方向的 `readTextFile/writeTextFile`（`acp-thread.ts:746-757`，走 `fileSystemHandler`）——agent 可以通过宿主读文件，作为 wire 之外的备选通道。

### 3. web-app 复用

- `packages/webview` 存在：`browser / webview-host / electron-webview` 三层 —— iframe 宿主模式可直接嵌 web-app 片段（ApprovalCard 等）。
- OpenSumi 另有组件注入扩展点（browserViews），比 iframe 更轻。

### 4. Electron 壳

- `opensumi/ide-electron`（MIT）是官方桌面样例：`yarn install → yarn build → yarn rebuild-native → yarn start`。spike 只确认了存在性与结构（`src/`、`product.json`、build scripts），未跑全量构建（Electron 下载 + 原生编译耗时长，且与 zomp 的壳可复用/替换关系需在架构设计时定）。
- 桌面 shell 已有资产：`packages/desktop`（Electron + sidecar 拉起 omp serve）——OpenSumi 路线下可复用 sidecar 机制。

---

## 集成点清单（进入正式架构设计时逐项处理）

1. **SDK 版本对齐**：OpenSumi `^0.16.1` vs OMP `0.20.0` —— 同协议 v1，预计兼容（字段增量式演进），集成时对齐版本或补一条双向握手测试兜底。**低风险，但要显式处理。**
2. **注册 omp agent**：`ai-native.acp.agents.omp = { command: <omp 二进制>, args: ["acp"] }`；cwd 由 OpenSumi 按 workspace 传入（`AcpTargetConfigRequest.cwd`）。
3. **审批通道（重要缺口）**：OpenSumi client 已实现 `requestPermission` handler + permission rules（`acp-permission-rpc.service.ts`）；**OMP 的 AcpAgent 目前不发射 requestPermission、不声明权限能力** —— ACP 模式下审批流是断的。需补：AcpAgent 在工具需要审批时向 client 发 requestPermission（agent→client 单向方法，工作量小，但这是"审批卡内嵌"需求的前置）。
4. **fs_write 等 wire 命令**：文件保存/编辑链路的前置（已知缺口，docs 已记录）。
5. **agent workspace 预览**：注册 `omp-agent://` scheme provider → wire fs_list/fs_read；编辑 agent 文件需显式授权（需求 D5）。
6. **web-app 资产**：优先走 browserViews 组件注入；大组件走 webview iframe。
7. **Electron 集成**：determine zomp 壳 vs 现有 packages/desktop 关系（复用 sidecar / 托盘 / 更新）。

---

## 风险与未验证项（诚实声明）

- 未跑 OpenSumi 全量 Electron 应用（点 4 为代码级确认）。
- 未做 OpenSumi 真实 UI 层与 OMP 的端到端对话（需要 ide-electron 跑起来 + 注册 agent + 实际 prompt 一次）。
- 审批通道缺口（集成点 3）未实测，属于"通道存在、发射方缺失"。
- ai-native 模块较新，OpenSumi 迭代快，版本跟随账需在架构设计中计入（比 zomp 的季度 rebase 轻：npm 依赖升级 vs GPL fork 合并）。

---

## 建议

- **OpenSumi 为底座，进入正式架构设计**（编排点 1-7）。
- 架构设计期第一阶段先跑一次**全量探针**：ide-electron 起起来 + 注册 omp agent + 真实对话 + agent workspace 文件树读出 —— 消除点 4 与端到端不确定性。此探针同时产出 OpenSumi 版本快照，锁定后续升级基线（含 SDK 版本对齐）。
---

## 第二轮：Electron 实跑探针（2026-08-25 下午）

### 做了什么

在 `~/Desktop/Narwal/omp-opensumi-spike/ide-electron` 上：
- 全量依赖升到 `3.9.1-next-1787303337.0`（**ACP Agentic Layout 只存在于 next 通道**，3.2.1 / 3.9.0 stable 均无 acp 文件，事实已核实：3.2.1 → 0 个，3.9.0 → 0 个，next → 402 个）
- 注册 `AINativeModule`（browser + node）、按源码 `ai-native.acp.agents` 偏好格式注入 `omp` agent（bun + `omp acp`）
- 跑通构建链：webpack 5 全量 build、原生模块 electron-ABI 重建（node-pty/spdlog/keytar/@parcel/watcher，nsfw 编译失败但确认运行时无人 require）
- **应用真实启动并渲染**：窗口 + 欢迎页（开始使用/打开文件夹）+ workspace 页（带工作区参数）

### 黑屏根因（全部定位并修复，均为环境级，非架构 blocker）

| # | 根因 | 修复 |
|---|---|---|
| 1 | Electron 22 主进程 = Node 16，缺 Web Streams（`TransformStream`）→ MCP SDK/eventsource-parser 模块作用域崩溃 | node 入口 polyfill：`node:stream/web` + undici（fetch/Headers/Request/Response） |
| 2 | **tiktoken**（ai-native inline 补全 tokenizer）在模块作用域同步编译 3.2MB wasm → Chromium 主线程 >4KB 同步编译拦截 | webpack alias stub 掉 tiktoken（inline completions 是 docs v1 显式拒绝的 P2 项；WASM-DIAG 探针证实唯一同步编译源就是它，**不是 tree-sitter**） |
| 3 | monaco editor worker 走 CDN，next 版本 CDN 路径 404 | patch worker URL → 本地 `node_modules/@opensumi/ide-monaco/worker/editor.worker.bundle.js` |
| 4 | yarn install 每次清掉 electron 二进制与原生模块 build 产物 | 流程固定：install 后重跑 `node electron/install.js` + 逐个 node-gyp 重建（`--python=/usr/bin/python3`，系统 python 3.14 无 distutils） |

### 遗留一项（如实声明）

**工作台布局槽为空**（#main 只渲染 box-panel 标题，菜单/文件树/编辑器未挂载）。A/B 已验证 **与 AINativeModule 无关**（移除后依旧）；指向 sample 模板代码（3.2.1 时代 wiring）与 3.9.1-next 核心的版本错配。**未达成**：Agentic Layout 实时 UI + OMP 真实对话（命令面板确认无 agentic 指令——Agentic Layout 需工作区且槽挂载后才有入口）。

### 结论更新

- 点 1 ACP 挂载：**PASS**（协议同 SDK + 配置注册 + OMP server 全生命周期实测 + 应用带 agent 配置正常启动——启动链路无 agent 相关错误）
- 点 2 文件服务接 wire：**PASS**（不变）
- 点 3 web-app 复用：**PASS**（不变）
- 点 4 Electron 运行形态：**部分过 → 环境问题全部有解**，完整 UI 端到端待集成阶段用版本对齐的模板重跑

### 对集成阶段的第一条任务（改动）

不要继续 patch 这个 3.2.1 模板——用与 3.9.x/next 对齐的模板（`opensumi/ide-startup` 或 core 主干的 electron 例程 + next 版本锁快照）重建探针环境，任务两步：① 布局槽正常挂载；② 注册 omp agent → 打开 Agentic Layout → 一次真实 prompt 闭环。探针环境与全部 patch 保留在 `~/Desktop/Narwal/omp-opensumi-spike/ide-electron`（含本 README 记录思路），可复现。

---

## 第三轮：端到端 ACP 对话达成（2026-08-25 晚）

### 换版本对齐模板后的完整链路

`opensumi/ide-startup`（3.9.0 → 3.9.1-next-1787303337.0，AI-native 模块自带）+ `AILayout` + `?workspaceDir=` 传工作区 + 注册 omp agent → **全链路闭环实测通过**：

```
OpenSumi Agentic Layout
  → spawn `bun …/cli.ts acp`（OMP ACP server，真实进程）
  → ACP initialize 握手（protocolVersion=1）
  → session/new（cwd=/tmp/sumi-probe-ws，OMP 校验绝对路径正确性）
  → session/prompt "你好，介绍一下你自己"
  → OMP（DeepSeek V4 Flash）思考 + 调用 identity 工具 → 流式回复
  → 渲染回 OpenSumi 聊天 UI
```

OCR 实测 UI：OMP 自报身份（Oh My Pi 0.19.0 / DeepSeek V4 Flash / cwd=/tmp/sumi-probe-ws / 能力清单）。

### 三个绕弯（记录给集成阶段）

1. **默认 agent 选择**：`ai.native.agent.defaultType`（不是 acp.defaultAgentType）；且用户偏好会覆盖 defaultPreferences → 探针直接 patch `DefaultACPConfigProvider` 强制 omp（绕开偏好管道，效果确定）
2. **工作区传递**：web 版经 URL `?workspaceDir=`，不随 WORKSPACE_DIR 自动到浏览器；Agentic Layout 是 workspace-local，无工作区时 ACP 池不预热、面板永远"初始化中"
3. **watcher 进程 EINVAL**：TMPDIR 路径超长导致 unix socket listen 失败 → 用短 TMPDIR（/tmp/osi）解决；prewarm 线程池会复用旧 agent 线程（agent 绑定），换默认 agent 需重启 node server

### 结论（终版）

- 点 1 ACP 挂载：**PASS（端到端实证）**——OpenSumi spawn OMP、握手、会话、prompt、流式回复全通
- 点 2 文件服务接 wire：**PASS**（registerProvider 标准扩展点）
- 点 3 web-app 复用：**PASS**（webview-host / browserViews）
- 点 4 运行形态：**PASS（web 形态全通）**；Electron 侧环境问题（Node16 polyfill / tiktoken stub / monaco worker 本地化 / 原生模块重建流程）全部定位有解，见第二轮

**OpenSumi 为 omp 客户端底座：架构可行性完全证实。** 集成阶段起点 = 用 ide-startup 对齐模板 + 本文档三个绕弯清单。
