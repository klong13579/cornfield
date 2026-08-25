# @oh-my-pi/editor-extension

omp 客户端壳集成层：OpenSumi 3.9.1-next 组装 + web-app 风格主题 + omp ACP agent 正规注册。
对应票 05（壳骨架），是 06/07/08/09/10/11 六张后续票的共同前置。

## 一句话架构

- **壳**：OpenSumi web 形态（`renderApp` + `AILayout` + 默认布局），浏览器渲染；node 侧 `start-server` 起 Koa + 静态服务 + 文件服务。
- **对话**：IDE 内 Agentic Layout 走 **ACP**，spawn `omp acp`（stdio JSON-RPC），流式回复渲染（spike 已端到端验证）。
- **主题**：自定义 color-token JSON（`extensions/omp-web-app/omp-web-app-light.json`）对齐 web-app V6 亮色 token，经 `IThemeService.registerThemes` 注册。
- **配置**：omp 配置系统唯一真源；OpenSumi 偏好仅存瞬时视图态（后续票 07 落地偏好改道）。

## 运行

```bash
# 根目录安装依赖（一次性；@opensumi 3.9.1-next 体积较大）
bun install

# 起壳（webpack dev server 8080 + node server 8000 + webview 8899）
bun run --cwd=packages/editor-extension start

# 打开项目（?workspaceDir= 传工作区，Agentic Layout 为 workspace-local，无工作区不预热）
# http://127.0.0.1:8080?workspaceDir=/path/to/project

# 验收冒烟（静态配置校验 + omp acp ACP 握手）
bun run --cwd=packages/editor-extension smoke
```

## omp agent 正规注册（非 spike 的 provider patch）

OpenSumi `DefaultACPConfigProvider` 按偏好解析 ACP agent，spike 曾直接 patch 该 provider 强制 omp。
本包改用正规偏好配置（见 `src/browser/index.ts` `defaultPreferences`）：

| 偏好键 | 作用 |
|---|---|
| `ai.native.agent.defaultType` | 默认 agent 类型 = `omp` |
| `ai.native.agent.configs` | agent 目录（`getDefaultAgentType` 据此识别 `omp` 可用） |
| `ai-native.acp.agents` | per-agent spawn 覆盖（`command`/`args`/`env`） |

`command`/`args` 由 webpack DefinePlugin 注入（`OMP_ACP_COMMAND`/`OMP_ACP_ARGS`）：
dev 默认 `bun <repo>/packages/coding-agent/src/cli.ts acp`；生产用 `OMP_ACP_COMMAND=omp OMP_ACP_ARGS='["acp"]'` 覆盖。

## 三个绕弯的正规落地（spike 记录 → 本包）

1. **默认 agent 选择**：用 `ai.native.agent.defaultType` + `ai.native.agent.configs` + `ai-native.acp.agents` 三键（不再 patch `DefaultACPConfigProvider`）。
2. **工作区传递**：`?workspaceDir=` / `WORKSPACE_DIR` 对齐（`src/browser/render-app.ts`）；无工作区则 ACP 池不预热。
3. **watcher 进程 EINVAL**：短 TMPDIR（`src/node/start-server.ts` `OMP_TMPDIR`，默认 `/tmp/omp-ide`），规避 unix socket 路径上限。

## monaco worker 本地化

next 通道 CDN worker 路径 404：`src/browser/monaco-env.ts` 在 OpenSumi 注册前设置
`window.MonacoEnvironment`，worker 指向本地 `editor.worker.bundle.js`（webpack CopyPlugin 从
`@opensumi/ide-monaco/worker/` 复制到 `dist/`）。

## 版本锁定

OpenSumi 全量 `3.9.1-next-1787303337.0`（ACP Agentic Layout 只存在于 next 通道）；`@opensumi/di` 1.10.1。
升级走单独评审（next 通道不稳定，见 `docs/editor-extension/topics/v3-architecture.md` 风险节）。

## 已知边界

- 本包 `check` 仅跑 biome（`biome check .`），不跑 tsgo 类型检查：OpenSumi 模板用 `ts-loader transpileOnly`，
  `.d.ts` 体量巨大且非本包责任范围；类型正确性由上游模板 + spike 实证保证。
- 依赖声明完整但本 worker 不跑 `bun install`（会改根 `bun.lock`，超 scope）；由集成阶段安装。
- 原生模块（node-pty/nsfw/spdlog 等）在 webpack node 配置中 `externals`，运行时由 node_modules 提供，
  与 spike 环境清单一致（见 `docs/editor-extension/topics/spike-opensumi-verdict.md` 第二轮）。
