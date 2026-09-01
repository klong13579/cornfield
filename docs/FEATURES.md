# CornField 功能总览（FEATURES）

> 单一入口盘点 CornField 全部功能模块：已有能力、设计中的能力、未来规划。
> 每行都是**从对应 `docs/` 单篇正文提取的结论**，不是索引推测。
> 状态约定：✅ 真值（已实现，随代码更新）｜📐 设计（含已实施设计或待拍板）｜🗄 资产（示例/配置）
> 要深挖任一功能 → 点链接进 `docs/` 单篇。
>
> 维护规则：新增/修改功能时同步更新本文档对应行；状态翻转（设计→实现）时改标记。

---

## 一、功能地图速览

| 域 | ✅ 已实现 | 📐 设计/待拍板 | 单篇清单 |
|---|---|---|---|
| Agent 运行时 | 12 | 2 | [§2](#2-agent-运行时) |
| 模型与配置 | 5 | 0 | [§3](#3-模型与配置) |
| 客户端与通信 | 3 | 2 | [§4](#4-客户端与通信) |
| 扩展与技能 | 5 | 4 | [§5](#5-扩展与技能) |
| Gateway 与调度 | 4 | 1 | [§6](#6-gateway-与调度) |
| MOA 多 Agent | 1 | 0 | [§7](#7-moa-多-agent) |
| 原生能力（Rust） | 8 | 1 | [§8](#8-原生能力-rust) |
| 工具与 MCP | 6 | 0 | [§9](#9-工具与-mcp) |
| TUI 与界面 | 5 | 0 | [§10](#10-tui-与界面) |
| 语音 | 1 | 1 | [§11](#11-语音) |
| 自进化 | 1 | 0 | [§12](#12-自进化) |
| 架构决策 | 1 | 1 | [§13](#13-架构决策-adr) |
| **合计** | **52** | **12** | 62 篇正文 |

---

## 2. Agent 运行时

### ✅ 已实现

- **Session 存储** [`agent/session.md`](agent/session.md)：JSONL v3 存储模型、会话树、上下文重建契约
- **会话操作** [`agent/session-operations.md`](agent/session-operations.md)：切换 / 最近列表 / 导出 / 分享 / fork / resume / 生命周期矩阵
- **上下文压缩** [`agent/compaction.md`](agent/compaction.md)：长会话压缩 + 分支摘要两套上下文保持机制
- **规则系统** [`agent/rulebook.md`](agent/rulebook.md)：多源规则发现 → 归一化 → 优先级 → 去重 → 三分桶分发
- **Task 发现** [`agent/task-discovery.md`](agent/task-discovery.md)：Task agent 定义发现、合并、执行时选择全链路
- **Handoff** [`agent/handoff.md`](agent/handoff.md)：`/handoff` 命令生成捕获、会话切换上下文注入
- **TTSR** [`agent/ttsr.md`](agent/ttsr.md)：Time Traveling Stream Rules，注册 → 流中断 → 重试生命周期
- **Artifacts** [`agent/artifacts.md`](agent/artifacts.md)：Blob 全局内容寻址 + session 本地 artifact 双层存储、`artifact://` 解析
- **自动重试** [`agent/retry-policy.md`](agent/retry-policy.md)：标准 API 错误自动重试策略（不含 context-overflow 恢复）
- **RPC 协议** [`agent/rpc.md`](agent/rpc.md)：NDJSON over stdio 协议规范 + Host Tool 子协议
- **进程内 SDK** [`agent/sdk.md`](agent/sdk.md)：`@cornfield/coding-agent` 进程内集成面，Bun/Node embedder API
- **跨会话自主记忆** [`agent/memory.md`](agent/memory.md)：跨会话知识提取与注入（memory protocol，**默认关闭**，`memories.enabled` 开启）

### 📐 设计中
- **Prompt 组装** [`agent/prompt-assembly.md`](agent/prompt-assembly.md)：系统提示词组装管线，含 Hermes/OpenClaw 对比
- **多 Agent 编排** [`agent/multi-agent-orchestration.md`](agent/multi-agent-orchestration.md)：Supervisor + Specialists + Kanban DAG 设计讨论（未实现）

---

## 3. 模型与配置

全部 ✅ 已实现：

- **流式归一化** [`ai/streaming.md`](ai/streaming.md)：token/tool 流式传输统一规范与传播链路
- **配置发现** [`config/config-usage.md`](config/config-usage.md)：配置发现、解析优先级、子系统消费模型
- **环境变量** [`config/environment-variables.md`](config/environment-variables.md)：运行时环境变量完整参考
- **模型配置** [`config/models.md`](config/models.md)：models.yml 模型注册、选择、等价分组与运行时解析
- **密钥混淆** [`config/secrets.md`](config/secrets.md)：LLM 请求前敏感值混淆与还原

---

## 4. 客户端与通信

### ✅ 已实现

- **桌面客户端** [`client/desktop.md`](client/desktop.md)：Electron 壳 + web-app 工作台 + wire 协议层，8 层功能清单（稳定/待实现/未实现三态）
- **多端接入** [`client/multidevice.md`](client/multidevice.md)：一个 cornfield 同时支持 TUI/Web/PC/Mobile；快照层 P0✅、wire 协议 P0✅、serve 宿主 P1✅、pi-client P2 规划中
- **进程间通信** [`intercom/intercom.md`](intercom/intercom.md)：broker（gateway 内嵌全局 socket），list/send/ask/reply/pending/cancel/presence/mailbox/父子边 11 项能力，帧上限 1MiB、速率限制、掉线自愈

### 📐 设计中

- **编辑器扩展** [`client/editor-extension.md`](client/editor-extension.md)：OpenSumi vs Zed 对比，推荐 OpenSumi（ACP/InlineAssistant/BufferCodegen 三层照搬），**未开工**
- **数字员工中枢** [`client/agent-hub.md`](client/agent-hub.md)：Agent 核心 + 项目/任务/会话领域模型，16 项已拍板 3 项待拍板

---

## 5. 扩展与技能

### ✅ 已实现

- **扩展运行时** [`extend/extensions.md`](extend/extensions.md)：ExtensionAPI 工厂（工具/命令/事件）、tool_call 前置阻断、tool_result 后置覆盖、多模式 UI、五路模块发现
- **Hook 子系统** [`extend/hooks.md`](extend/hooks.md)：**遗留 API**（新用 ExtensionAPI），三类事件处理器、确定性执行顺序
- **插件市场** [`extend/marketplace.md`](extend/marketplace.md)：四路源添加（GitHub 简写/URL/Git/本地）、双作用域安装（user/project）、CLI 命令族
- **Gemini 清单** [`extend/gemini-manifest.md`](extend/gemini-manifest.md)：`gemini-extension.json` 发现规范，跨提供者优先级去重
- **技能系统** [`skills/skills.md`](skills/skills.md)：SKILL.md 布局 + frontmatter、多提供者管道（native/claude/agents/opencode）、`skill://` URL、`/skill:` 注入

### 📐 设计中

- **市场创建指南** [`skills/authoring-marketplaces.md`](skills/authoring-marketplaces.md)：marketplace.json Schema、五类插件源、发布流程（含已实施）
- **Hook 编写指南** [`skills/authoring-hooks.md`](skills/authoring-hooks.md)：事件目录 + 三个安全拦截示例（含已实施）
- **扩展编写指南** [`skills/authoring-extensions.md`](skills/authoring-extensions.md)：扩展工厂、五路发现、三投递语义（含已实施）
- **技能遥测** [`skills/telemetry.md`](skills/telemetry.md)：Skill 观测与管理（A1-A4 清单/B1-B5 追踪/C1-C6 健康/D1-D3 查询/E1-E5 摄取），**终稿待拍板**

---

## 6. Gateway 与调度

### ✅ 已实现

- **Gateway 核心** [`gateway/gateway.md`](gateway/gateway.md)：消息交换机与调度器架构（已实施 2026-06-23）
- **Cron 调度** [`gateway/cron.md`](gateway/cron.md)：定时任务引擎 + host-tool 机制（Tier 1 已 ship 2026-06-30）
- **IM Agent Prompt** [`gateway/im-agent-prompt.md`](gateway/im-agent-prompt.md)：IM Agent prompt 分层设计（custom-system-prompt.md 已实施 2026-07-13）
- **Gateway/agent 进程模型** [`adr/0001-gateway-bridge-process-model.md`](adr/0001-gateway-bridge-process-model.md)：一账号一 RPC 子进程、AgentBridge（spawn/ready/crash 恢复/熔断）、agentDir 隔离

### 📐 设计中

- **AgentBridge 布局** [`gateway/agent-bridge.md`](gateway/agent-bridge.md)：Agent 运行时 + agentDir 布局 MECE 设计（骨架已实施）

---

## 7. MOA 多 Agent

### ✅ 已实现

- **MOA** [`moa/moa.md`](moa/moa.md)：多轮多 Agent（Discovery → Pre-Ask → Loop → Synthesis），`packages/moa-extension/` 34+ 测试

---

## 8. 原生能力（Rust）

### ✅ 已实现

- **架构总纲** [`natives/natives-architecture.md`](natives/natives-architecture.md)：Loader + Rust N-API 双层架构，x64 AVX2 modern/baseline 双版本
- **Loader 运行时** [`natives/natives-addon-loader-runtime.md`](natives/natives-addon-loader-runtime.md)：候选路径探测、嵌入式 addon 提取、启动故障诊断
- **绑定契约** [`natives/natives-binding-contract.md`](natives/natives-binding-contract.md)：JS↔Rust 导出映射表、Sync/Async 风格约定
- **构建与调试** [`natives/natives-build-release-debugging.md`](natives/natives-build-release-debugging.md)：build-native/embed-native 流水线、交叉编译、故障矩阵
- **媒体与系统** [`natives/natives-media-system-utils.md`](natives/natives-media-system-utils.md)：PhotonImage（PNG/JPEG/WebP/GIF）、SIXEL、HTML→MD、剪贴板、Token 计数、macOS 电源/画像、Windows ProjFS
- **Shell/PTY/进程** [`natives/natives-shell-pty-process.md`](natives/natives-shell-pty-process.md)：executeShell + 持久 Shell、PTY 状态机、killTree 跨平台、按键解析（Kitty/xterm modifyOtherKeys）
- **文本搜索管线** [`natives/natives-text-search-pipeline.md`](natives/natives-text-search-pipeline.md)：Regex/grep/fuzzyFind/glob/AST、ANSI 处理、syntect 高亮、Token 计数
- **FS 扫描缓存** [`natives/fs-scan-cache.md`](natives/fs-scan-cache.md)：四维缓存键、TTL 1000ms、空结果重查、写入后自动失效

### 📐 设计中

- **Rust 任务取消** [`natives/natives-rust-task-cancellation.md`](natives/natives-rust-task-cancellation.md)：task::blocking/future、CancelToken、Heartbeat 协作取消规范（新可取消导出 Checklist）

---

## 9. 工具与 MCP

全部 ✅ 已实现：

- **MCP** [`tools/mcp.md`](tools/mcp.md)：服务器配置、发现、连接与运行时生命周期
- **自定义工具** [`tools/tool-authoring.md`](tools/tool-authoring.md)：编写规范 + MCP Server 集成
- **Bash 工具** [`tools/bash-tool-runtime.md`](tools/bash-tool-runtime.md)：调用执行管线与渲染内部
- **Resolve 工具** [`tools/resolve-tool-runtime.md`](tools/resolve-tool-runtime.md)：Preview/Apply 工作流、pending action 队列
- **Notebook 工具** [`tools/notebook-tool-runtime.md`](tools/notebook-tool-runtime.md)：JSON 编辑器与内核执行路径边界
- **Python REPL** [`tools/python-repl.md`](tools/python-repl.md)：Python 执行栈全链路（工具/内核/网关/环境）

---

## 10. TUI 与界面

全部 ✅ 已实现：

- **TUI 引擎** [`tui/tui.md`](tui/tui.md)：组件合约、差分渲染、输入路由、扩展 UI、自定义工具渲染器、终端生命周期
- **主题系统** [`tui/theme.md`](tui/theme.md)：JSON schema、57 个颜色 token、内置/自定义查找、热重载、色盲模式
- **会话树** [`tui/tree.md`](tui/tree.md)：`/tree` 导航（四种打开方式、五种过滤、AND 搜索、标签编辑、Summary-on-switch）
- **Slash 命令** [`tui/slash-commands.md`](tui/slash-commands.md)：五源 Provider 优先级去重、模板展开语义、流式差异
- **Voice 面板**（见 §11）

---

## 11. 语音

### ✅ 已实现

- **Voice Jarvis** [`voice/voice.md`](voice/voice.md)：实时语音对话（P0/P1 交付）——四层架构（麦克风→Controller→Transport→VoicePanel）、双工≤1.5s、意图分类六类、分级确认门（fail-closed）、四层状态机、task 走主会话全量工具链

### 📐 设计中

- **Orb UX 重设计** [`voice/orb-redesign.md`](voice/orb-redesign.md)：单色呼吸球替代文本面板（七相位映射、沉浸/面板双布局、存活表示），**待拍板，分支 feature/voice-ux**

---

## 12. 自进化

### ✅ 已实现

- **Evolution V4** [`self-evolution.md`](self-evolution.md)：三层记忆（短期注入/中期 episode/长期 pin）、四种提取方式（write_memory 主路径 + 3 回退）、认知管道钩子时序、Nudge/Escalation、SQLite WAL+FTS5、14 个 Agent 工具、`/evolution` 15+ 子命令、V3→V4 迁移

---

## 13. 架构决策（ADR）

### ✅ 已采纳/已实施

- **ADR-0001 Gateway 进程模型** [`adr/0001-gateway-bridge-process-model.md`](adr/0001-gateway-bridge-process-model.md)：一账号一进程隔离，否决单进程共享/每次 spawn/HTTP API 三方案

### 📐 已实施设计

- **ADR-0002 统一协议层** [`adr/0002-unified-protocol-layer.md`](adr/0002-unified-protocol-layer.md)：四前端收敛到唯一 Wire 契约，四阶段迁移（P0 地基✅ → P1 核心收窄✅ → P2 gateway✅ → P3 TUI 暂缓），两个 Wire 端点

---

## 四、未来方向（未开工/待拍板汇总）

按可直接动手程度排序：

| 优先级线索 | 功能 | 状态 | 依据 |
|---|---|---|---|
| TODO 待办 | OMP 桌面客户端（Tauri + 编辑器 fork Zed） | 待开发 | `topics/omp-client-design.md` |
| TODO 待办 | 独立验证者（执行与验证分离，独立进程验收） | 待开发 | `topics/independent-verifier.md` |
| TODO 待办 | 统一协议层 P3（TUI 切 Wire） | 代码完成未合 main | `feat/agent-work` 分支 |
| TODO 待办 | gateway agent 动态 enable/disable | 待开发 | `topics/agent-client-config.md` |
| TODO 待办 | session 诊断 → learning/nudge/regression 三阶段 | 待开发 | `topics/session-diagnosis-loop.md` |
| 待拍板 | 数字员工中枢（agent-hub） | 设计 3 项待拍板 | `client/agent-hub.md` |
| 待拍板 | Voice Orb UX 重设计 | 设计完成 | `voice/orb-redesign.md` |
| 待拍板 | 技能遥测系统 | 设计终稿 2026-08-12 | `skills/telemetry.md` |
| 未开工 | 编辑器扩展（OpenSumi 方案） | 设计完成 | `client/editor-extension.md` |
| 未实现 | 多 Agent 编排（Supervisor+Specialists） | 设计讨论 | `agent/multi-agent-orchestration.md` |

---

## 五、统计数据口径（生成时点 2026-09-01）

- 覆盖：`docs/` 62 篇功能正文（15 域），逐篇精读提取
- ✅ 真值（已实现）52 篇｜📐 设计/待拍板 12 篇（其中 4 篇为「含已实施设计或作者指南」）
- 未计入：资产类（示例技能、配置示例）、CHANGELOG 中的增量修补条目（功能已在各域体现）
- 状态时效：以 `docs/README.md` 索引与各篇文档头标记为准；新功能落地请在本文件对应行补记