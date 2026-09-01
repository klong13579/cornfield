# CornField 文档索引

> 本页面是 `docs/` 的唯一入口。规矩：
> - **一个功能一篇文档**；新文档先查这里有没有同名/同主题，禁止分叉
> - 文件名 = 功能名（小写 kebab），不带版本后缀（-v1/-v2.0）、不带产品旧名前缀（omp-）
> - 生命周期标记三态：**真值**（随代码更新，代码是最终裁决）/ **设计**（含已实施设计，若后续实现偏离以真值文档+代码为准）/ **资产**（示例/图片）
> - 功能开发过程文档（时间线/进展快照/实施记录）不进 docs/；要废弃设计先行在此页把文件状态改为"设计（已废弃）"再删
> - 跨文档链接一律写相对当前文件的路径（别写根绝对）。

## agent — Agent 运行时

|文档|说明|状态|
|---|---|---|
|agent/session.md|会话存储 JSONL 模型/迁移/上下文重建|真值|
|agent/session-operations.md|会话切换/最近列表/导出/共享/fork/resume|真值|
|agent/compaction.md|压缩与分支摘要|真值|
|agent/memory.md|自主记忆（memory protocol）|真值|
|agent/rulebook.md|规则发现/归一化/优先级|真值|
|agent/task-discovery.md|task 子系统 agent 定义发现与选择|真值|
|agent/handoff.md|/handoff 生成管线|真值|
|agent/ttsr.md|TTSR 注入生命周期|真值|
|agent/artifacts.md|blob/artifact 存储与 artifact:// 解析|真值|
|agent/retry-policy.md|非压缩自动重试策略|真值|
|agent/prompt-assembly.md|Prompt assembly v1.0|设计|
|agent/multi-agent-orchestration.md|多 Agent 编排设计|设计（待实现规划）|
|agent/rpc.md|RPC 协议参考 + Host Tool 子协议|真值|
|agent/sdk.md|进程内 SDK 集成面|真值|

## ai — Provider 与流式

|文档|说明|状态|
|---|---|---|
|ai/streaming.md|token/tool 流式归一化|真值|

## client — 桌面/前端客户端

|文档|说明|状态|
|---|---|---|
|client/desktop.md|桌面客户端功能说明（desktop + web-app + editor-extension + 协议）|真值（随版本更新盘点）|
|client/editor-extension.md|编辑器扩展：现状摸底 + OpenSumi/Zed 借鉴 + 架构结论|设计（未开工）|
|client/multidevice.md|多端架构（host + TUI/Web/PC/Mobile 接入）|设计（P0/P1 已实施，P2 规划中）|
|client/project-container.md|项目容器（Project）+ Coding Task：现状/行业对照/领域模型/分期|设计（待拍板）|

## config — 配置与模型

|文档|说明|状态|
|---|---|---|
|config/config-usage.md|配置发现与解析|真值|
|config/environment-variables.md|环境变量参考|真值|
|config/models.md|models.yml 模型配置|真值|
|config/secrets.md|密钥混淆|真值|

## extend — 扩展生态

|文档|说明|状态|
|---|---|---|
|extend/extensions.md|扩展运行时 + 模块发现与加载|真值|
|extend/hooks.md|钩子|真值|
|extend/marketplace.md|市场/插件系统 + 安装器 plumbing|真值|
|extend/gemini-manifest.md|gemini-extension.json 清单扩展|真值|

## gateway — IM 网关与调度

|文档|说明|状态|
|---|---|---|
|gateway/gateway.md|Gateway 总体设计（agent bridge/多账号/通道）|设计（已实施）|
|gateway/cron.md|Cron 调度 + Host-Tool + 结构化诊断|真值|
|gateway/agent-bridge.md|Agent 进程 + agentDir 布局设计|设计（已实施）|
|gateway/im-agent-prompt.md|IM Agent Prompt 分层设计|设计（已实施）|

## intercom

|文档|说明|状态|
|---|---|---|
|intercom/intercom.md|Agent 进程间通信方案|真值（已接入生产）|

## moa — 多 Agent 编排

|文档|说明|状态|
|---|---|---|
|moa/moa.md|MOA 多轮多 Agent 设计（TCO 输入补全 + multi-round + quality）|真值|

## natives — Rust 原生层

|文档|说明|状态|
|---|---|---|
|natives/natives-architecture.md|总览（loader 两层架构）|真值|
|natives/natives-addon-loader-runtime.md|loader 运行时|真值|
|natives/natives-binding-contract.md|JS/TS 侧 N-API 契约|真值|
|natives/natives-build-release-debugging.md|构建/发布/调试 runbook|真值|
|natives/natives-media-system-utils.md|媒体 + 系统工具|真值|
|natives/natives-rust-task-cancellation.md|Rust 任务执行与取消|真值|
|natives/natives-shell-pty-process.md|Shell/PTY/进程/按键|真值|
|natives/natives-text-search-pipeline.md|文本/搜索管线|真值|
|natives/fs-scan-cache.md|fs 扫描缓存契约|真值|

## skills — 技能

|文档|说明|状态|
|---|---|---|
|skills/skills.md|技能系统总览|真值|
|skills/authoring-marketplaces.md|市场编写|真值|
|skills/authoring-hooks.md|钩子编写|真值|
|skills/authoring-extensions.md|扩展编写|真值|
|skills/telemetry.md|技能观测与管理设计|设计（终稿）|
|skills/examples/|示例技能（hello-extension / mini-marketplace / safety-hook）|资产|

## tools — 工具与 MCP

|文档|说明|状态|
|---|---|---|
|tools/mcp.md|MCP 配置/传输/运行时生命周期|真值|
|tools/tool-authoring.md|自定义工具 + MCP server/tool 编写|真值|
|tools/bash-tool-runtime.md|Bash 工具运行时|真值|
|tools/resolve-tool-runtime.md|Resolve 工具运行时|真值|
|tools/notebook-tool-runtime.md|Notebook 工具运行时|真值|
|tools/python-repl.md|Python 工具与 IPython 运行时|真值|

## tui — 终端 UI

|文档|说明|状态|
|---|---|---|
|tui/tui.md|TUI 集成契约（扩展 UI/custom tool UI/renderer）|真值|
|tui/theme.md|主题参考|真值|
|tui/tree.md|/tree 命令参考|真值|
|tui/slash-commands.md|Slash 命令内部|真值|

## voice — 语音

|文档|说明|状态|
|---|---|---|
|voice/voice.md|Voice Jarvis 实时语音（P0+P1 已实现，四层状态机）|真值|
|voice/orb-redesign.md|语音 UX Orb 重设计|设计（待拍板，分支 feature/voice-ux）|
|voice/animation/|呼吸球动画帧|资产|

## adr — 架构决策

|文档|说明|状态|
|---|---|---|
|adr/0001-gateway-bridge-process-model.md|Gateway bridge 进程模型|决策（已采纳）|
|adr/0002-unified-protocol-layer.md|统一协议层|决策（已采纳）|

## 根级

|文档|说明|状态|
|---|---|---|
|self-evolution.md|Evolution 功能方案（v4，当前默认实现）|真值|
|zomp-zed-agent-settings.json.example|Zed 集成示例配置|资产|

## 生命周期迁移记录（2026-08-30）

本次重构从 67 篇平铺 + 包内 docs 归并为 15 域目录、68 篇：

- **删除**（过程/失效/被替代，17 篇）：moa-development-history、known-test-failures、me-context-review、porting-to-natives、omp-client-design、omp-client-zed-integration(.spec)、todo/topic-design-and-status、hermes 研究 2 篇、im-platform-plan、editor-extension/topics×5
- **合并**（13 组 → 13 篇）：moa×2、session-operations×2、voice×2、extensions×2、marketplace×2、tool-authoring×2、mcp×3、tui×2、rpc×2、gateway×2、cron×3、editor-extension×3、gateway 域迁入
- **改名**（去 omp-/去版本）：self-evolution.md、gateway/cron.md、agent/prompt-assembly.md 等