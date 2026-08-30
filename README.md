<p align="center">
  <img src="assets/cornfield-full.svg" alt="CornField" width="400">
</p>

<h1 align="center">CornField</h1>

<p align="center">
  <strong>AI 时代的个人超级工作台</strong><br>
  <em>An experimental personal super workspace for the AI era.</em>
</p>

<p align="center">
  <a href="https://github.com/klong13579/cornfield/releases/latest"><img src="https://img.shields.io/github/v/release/klong13579/cornfield?display_name=tag&style=flat&colorA=222222&colorB=58A6FF" alt="Latest release"></a>
  <a href="https://github.com/klong13579/cornfield/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/klong13579/cornfield/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/klong13579/cornfield/blob/main/LICENSE"><img src="https://img.shields.io/github/license/klong13579/cornfield?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
</p>

> Personal project · Experimental · Desktop-first exploration

CornField 是一个个人实验性项目。我正在探索一种 AI 时代的个人工作方式：让 AI 与工具、文件、知识、记忆和工作流共同组成一个可持续使用的工作环境。

项目从终端 AI Coding Agent 起步，正在探索桌面客户端形态。桌面端与终端 Agent 并行演进，具体界面、交互和能力边界仍会持续调整。

## 目录

- [产品方向](#产品方向)
- [桌面客户端](#桌面客户端)
- [当前可用能力](#当前可用能力)
  - [CornField 核心](#cornfield-核心)
  - [CornField 集成](#cornfield-集成)
  - [底层基础](#底层基础)
- [终端 Agent](#终端-agent)
- [本地开发](#本地开发)
- [文档与项目结构](#文档与项目结构)
- [开发入口](#开发入口)
- [致谢](#致谢)
- [许可](#许可)

## 产品方向

CornField 不把自己定义成一个已经定型的平台。它是一个持续演进的个人工作台实验：

- 让 Agent 能够理解项目、文件、工具和上下文，而不只是生成一次性答案；
- 把模型、工具、记忆、自动化和界面组织在同一个可扩展内核周围；
- 以桌面客户端为主要探索方向，同时保留终端作为稳定、可组合的工作入口；
- 优先验证真实工作流中的价值，再决定哪些能力值得长期保留。

## 桌面客户端

**Experimental Desktop Client**

桌面端目前是 Electron 外壳，加载 CornField Web 工作区并管理本地 `serve` sidecar。它与终端 Agent 共享核心能力，正在探索项目、文件、Git 与 Agent 协作的桌面工作方式。

当前已确认的形态：

- macOS Apple Silicon 优先；
- 托盘常驻、单例运行和工作目录管理；
- 内嵌 CornField sidecar 与 Web renderer；
- 通过 GitHub Actions 在 release 时构建 `.dmg`、`.zip` 和更新元数据；
- 自动更新需要用户确认下载，当前构建使用 adhoc 签名，未包含 Apple 公证。

### 下载实验版

桌面客户端发布后，可在 [GitHub Releases](https://github.com/klong13579/cornfield/releases/latest) 下载最新 macOS `.dmg`。

首次打开未公证的实验版本时，macOS 可能需要在 Finder 中右键应用并选择“打开”。当前不承诺跨平台桌面发行版或稳定的向后兼容性。

## 当前可用能力

下面按产品归属和抽象层次组织能力。具体实现和配置以代码及文档为准；这里不把尚未稳定的方向写成产品承诺。

### CornField 核心

- **有状态 Agent 运行时**：维护对话状态，执行工具调用，流式输出事件。
- **项目与文件工作流**：围绕工作目录进行读取、编辑、搜索、Shell 和版本控制操作。
- **任务与多 Agent 编排**：支持探索、规划、设计、审查和执行等不同角色，并行运行任务，实时获取产物。
- **会话与上下文管理**：会话持久化、分支、压缩、恢复和项目级上下文文件。
- **记忆与自进化**：从工作过程提取可复用经验，维护长期记忆和技能资产。
- **Todo 与工作状态**：按阶段管理任务，在交互界面中持续显示进度。
- **Gateway 与自动化**：通过 AgentBridge、会话队列和调度器连接消息通道与定时任务。
- **钉钉通道**：支持 DingTalk Stream 消息收发、重连、去重、多账号隔离和结果投递。
- **可观测性**：提供 Gateway health、status、metrics 和调度执行日志。

相关入口：[@cornfield/agent](./packages/agent/README.md)、[Gateway 文档](./docs/gateway/gateway.md)、[记忆文档](./docs/agent/memory.md)、[自进化架构](./docs/self-evolution.md)。

### CornField 集成

- **多模型与多凭据**：接入不同模型提供商，支持角色化模型选择、凭据轮换和失败回退。
- **LSP**：提供诊断、定义、类型定义、实现、引用、悬停、符号、重命名、代码操作、状态和重载等代码智能能力。
- **MCP 与插件**：支持 stdio/HTTP 传输、OAuth 和外部工具接入。
- **Skills、Hooks 与 Slash Commands**：通过静态提示、技能、钩子和 TypeScript 命令扩展工作流。
- **浏览器与 Web 能力**：支持可访问性快照、阅读模式和页面交互。
- **Python / Notebook**：提供持久 IPython 内核、文件辅助函数、流式输出和富渲染。
- **SSH 与远程工作**：支持持久连接、主机管理、Shell 探测和远程文件工作流。
- **配置发现**：兼容多种 AI 编程工具的规则、技能、MCP、Hooks 和上下文配置。
- **RPC 与 SDK**：可通过 RPC 或 SDK 将 Agent 能力嵌入其他应用。

相关入口：[@cornfield/coding-agent](./packages/coding-agent/README.md)、[Extensions](./docs/extend/extensions.md)、[Skills](./docs/skills/skills.md)、[MCP 配置](./docs/tools/mcp.md)、[SDK](./docs/agent/sdk.md)、[RPC](./docs/agent/rpc.md)。

### 底层基础

- **终端 TUI**：交互式编辑器、会话面板、Todo 面板、主题和流式输出。
- **Rust Native Engine**：通过 N-API 提供 Shell、grep、文本处理、按键、语法高亮、glob、任务、进程、图像、剪贴板和 HTML 等原生能力。
- **工具调用协议**：统一的 Agent 消息、工具参数、事件流和 RPC 通信模型。
- **Bun 运行时**：以 Bun 作为开发与运行时基础，使用 TypeScript、Rust 和 Electron 构建各层能力。

相关入口：[@cornfield/tui](./packages/tui/README.md)、[@cornfield/natives](./packages/natives/README.md)、[Native 架构](./docs/natives/natives-architecture.md)、[工具运行时文档](./docs/tools/bash-tool-runtime.md)。

## 终端 Agent

终端仍是当前最完整、最容易验证的使用入口。它提供交互式 TUI、非交互打印模式、RPC 和 ACP 等运行方式。

### 本地开发运行

要求：Bun `>= 1.3.7`。

```bash
git clone https://github.com/klong13579/cornfield.git
cd cornfield
bun install
bun dev
```

首次使用时，根据所选模型提供商配置 API Key 或 OAuth。详细配置见：[环境变量](./docs/config/environment-variables.md)、[模型配置](./docs/config/models.md)、[配置说明](./docs/config/config-usage.md)。

### 常用能力入口

- `/model`：选择模型和模型角色；
- `/review`：对分支、提交或未提交变更进行结构化审查；
- `/extensions`：管理扩展、技能、Hooks 和配置发现；
- `/agents`：查看和管理 Agent；
- `/session`：切换、分支、恢复和导出会话；
- `Ctrl+T`：展开或收起 Todo 面板。

完整 CLI、快捷键和工具说明见 [Coding Agent 文档](./packages/coding-agent/README.md) 及 `docs/` 目录。

## 文档与项目结构

| 路径 | 内容 |
| --- | --- |
| `packages/desktop/` | Electron 桌面客户端与 sidecar 管理 |
| `packages/web-app/` | 桌面端加载的 Web 工作区 |
| `packages/coding-agent/` | CLI、TUI、工具注册与会话编排 |
| `packages/agent/` | Agent 核心运行时 |
| `packages/ai/` | 模型、Provider、流式协议与 OAuth |
| `packages/gateway/` | DingTalk 通道、AgentBridge 与调度器 |
| `packages/self-evolution/` | 记忆、自进化和技能提取 |
| `packages/tui/` | 终端 UI 组件与布局 |
| `packages/natives/` | Rust N-API 原生模块封装 |
| `docs/` | 运行时、工具、扩展、Gateway 与架构文档 |
| `AGENTS.md` | 仓库开发约定与验证命令 |

建议从 [文档索引](./docs) 和各 package README 开始阅读。设计中的编辑器、客户端和协作方向记录在 `docs/editor-extension/` 与相关 ADR 中。

## 开发入口

桌面端完整构建（包含 Web、Agent 二进制、Electron 壳和安装包）：

```bash
cd packages/desktop
bun run build:desktop
```

常用检查命令：

```bash
bun run check:ts
bun run check:rs
```

更完整的仓库约定、测试策略和发布流程见 [AGENTS.md](./AGENTS.md)。当前项目主要由个人维护，功能和接口可能随探索快速变化。

## 致谢

CornField 基于 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) 的代码与架构持续演进，部分底层终端 Agent 能力和设计受到 [pi-mono](https://github.com/badlogic/pi-mono) 启发。感谢 OMP 与 pi-mono 作者及开源社区。

## 许可

本项目采用 [MIT License](./LICENSE)。
