# Oh My Pi

Oh My Pi 是一个可进化的 AI 编程助手（terminal coding agent），同时支持通过 IM 网关（DingTalk）以消息对话形式运行。核心模型是 multi-provider LLM + 25+ 内置工具 + 技能自演化系统。单 binary 分发，Rust 原生模块加速关键路径。

## Language

### Agent
处理用户消息并调用工具的 AI 助手。可以是终端模式（omp CLI）或网关模式（通过 AgentBridge 以 RPC 协议驱动）。Agent 的核心循环（message → LLM → tool calls → result → next turn）由 pi-agent-core 实现。
_Avoid_: Bot, assistant, chatbot

### Session
Agent 与用户之间的一段有边界对话。以 JSONL 文件持久化，由 pi-coding-agent 的 session 模块管理。终端会话按日期/时间分层存储；网关会话以 conversationId 命名。Session 是自我演化的基本分析单元。
_Avoid_: Chat, thread, conversation

### Tool
Agent 可调用的具名能力（读、写、bash、搜索、代码编辑等）。每个 Tool 有唯一名称、参数描述和 handler 实现。注册在 `createTools()` 中，可被 settings 按名启用/禁用。
_Avoid_: Function, action, command

### Provider
LLM 提供商（OpenAI、Anthropic、Codex、Google Gemini 等）。每个 provider 有自己的 API 格式和认证方式，由 pi-ai 封装为统一接口。
_Avoid_: Backend, service, API

### Model
具体 LLM 模型标识（如 `claude-4`、`gpt-4o`）。由 `models.json`（生成产物）注册，提供 context window、thinking/reasoning、定价等元数据。用户可通过 `set_model` RPC 命令在运行时切换。

### Gateway
将 Agent 通过 IM 渠道（目前仅 DingTalk）暴露给用户的中介层。启动和管理 AgentBridge RPC 子进程，将 IM 消息转换为 agent prompt，将 agent 输出渲染为 IM 消息/卡片。属于 pi-gateway 包。
_Avoid_: IM server, relay

### Channel
IM 平台接入的具体实现（目前仅 DingTalkChannel）。负责消息解析（文本/图片/文件/音视频）、卡片构建、媒体下载、Stream 回调订阅等。

### Bridge (AgentBridge)
管理 `omp --mode rpc` 子进程的生命周期，通过 JSON-line RPC 协议与 agent 进程通信。每个 gateway 账号持有自己的 Bridge 实例，提供 prompt 转发、会话切换、模型热切换、工具禁用等能力。

### Self-evolution
Agent 的自主学习系统。从 session 记录中提取技能（skills）、工作流模式、用户偏好，存入 SQLite 演化数据库，并在后续会话中注入上下文。无需外部训练管道，纯在线/离线混合。
_Avoid_: Training, fine-tuning, learning pipeline

### Skill
从 Self-evolution 中提取的可复用上下文块。可以是编码惯例、工具使用模式、项目特有知识等。以 .md 文件形式存入 `~/.omp/agent/skills/`，通过 system prompt 注入 agent 上下文。
_Avoid_: Convention, pattern, template

### Memory
Agent 需要在会话间记住的事实（用户偏好、项目配置、正在进行的任务状态）。通过 write_memory / read_memory 工具管理，由 self-evolution 的 memory 模块存储。
_Avoid_: Database, cache, state

### Natives
Rust 编写的 N-API cdylib（`crates/pi-natives`），暴露性能敏感的操作给 JS 层：grep、shell（brush）、文本处理、语法高亮、glob、任务管理等。编译为 `pi-natives.{platform}.node`，有 modern（AVX2）和 baseline 两个变体。
_Avoid_: Native addon, WASM, extension