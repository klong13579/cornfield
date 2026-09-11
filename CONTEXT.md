# Oh My Pi

Oh My Pi 是一个可进化的 AI 编程助手（terminal coding agent），同时支持通过 IM 网关（DingTalk）以消息对话形式运行。核心模型是 multi-provider LLM + 25+ 内置工具 + 技能自演化系统。单 binary 分发，Rust 原生模块加速关键路径。

## Language

### Agent
处理用户消息并调用工具的 AI 助手。可以是终端模式（cornfield CLI）或网关模式（通过 AgentBridge 以 RPC 协议驱动）。Agent 的核心循环（message → LLM → tool calls → result → next turn）由 @cornfield/agent 实现。
_Avoid_: Bot, assistant, chatbot

### Session
Agent 与用户之间的一段有边界对话。以 JSONL 文件持久化，由 pi-coding-agent 的 session 模块管理。终端会话按日期/时间分层存储；网关会话以 conversationId 命名。Session 是自我演化的基本分析单元。
_Avoid_: Chat, thread, conversation

### Tool
Agent 可调用的具名能力，具有稳定名称、输入契约和结果语义。Tool 是否已知、是否当前可调用、是否向模型直接展示，是彼此独立的状态。
_Avoid_: Function, action, command

### Tool Catalog
Catalog 是静态 Tool 定义的唯一真源：每个条目同时包含规范名称、factory 与 Tool Metadata。现有 `BUILTIN_TOOLS` 和 `HIDDEN_TOOLS` 仅作为从 Catalog 派生的兼容导出，供现有调用方使用，不再与 Catalog 并列维护。
_Avoid_: Tool registry, tool list

### Enabled Tool Set
当前 Session 经配置、环境和 Agent 边界允许调用的 Tool 集合。Enabled Tool 可以直接展示给模型，也可以通过发现协议间接呈现；具体调用仍须通过运行时权限审批。
_Avoid_: Active tools, selected tools

### Discoverable Tool Set
当前 Session 已知、属于 Enabled Tool Set、但不直接向模型展示，通过 `xd://` 挂载按需呈现的 Tool 集合。`internal` Tool 不属于此集合。
_Avoid_: Hidden tools, inactive tools

### Load Mode
Tool 的呈现与调用入口策略，由 Tool 自身声明：`essential` 表示始终以顶层 function tool 呈现，`discoverable` 表示在 `tools.xdev` 开启时挂载为 `xd://` 设备，`internal` 表示不可由配置、发现或显式 `toolNames` 选中，只能由拥有它的运行时注入（注入后模型可正常调用）。它不表达具体操作是否获准执行。
_Avoid_: Permission, enabled state

### xd:// 挂载
将 `discoverable` Tool 从模型顶层 tools 数组卸载、改以内部 URL 设备呈现的机制：`read xd://` 列出设备，`read xd://<tool>` 取文档与参数 schema，`write xd://<tool>` 传 JSON 参数执行。由 `read`/`write` 承担 transport，二者因此永不挂载。

### Tool Metadata
Tool 的静态呈现元数据，由 Tool 自身按规范名声明：Load Mode，以及用于发现与目录展示的稳定能力摘要（`internal` Tool 摘要可为空）。摘要只说明 Tool 能解决什么问题，不复制完整 description，不包含参数、权限、启用条件或使用指导。集中 essential 名单只做兜底，防止 adapter 或 UI 重注册把核心 Tool 静默降级为 `discoverable`。Tool 的动态说明、参数、权限、启用条件和实现不属于 Tool Metadata。
_Avoid_: Tool spec, Tool configuration

### Provider
LLM 提供商（OpenAI、Anthropic、Codex、Google Gemini 等）。每个 provider 有自己的 API 格式和认证方式，由 pi-ai 封装为统一接口。
_Avoid_: Backend, service, API

### Model
具体 LLM 模型标识（如 `claude-4`、`gpt-4o`）。由 `models.json`（生成产物）注册，提供 context window、thinking/reasoning、定价等元数据。用户可通过 `set_model` RPC 命令在运行时切换。

### Gateway
将 Agent 通过 IM 渠道（目前仅 DingTalk）暴露给用户的中介层。启动和管理 AgentBridge RPC 子进程，将 IM 消息转换为 agent prompt，将 agent 输出渲染为 IM 消息/卡片。属于 cornfield-gateway 包。
_Avoid_: IM server, relay

### Channel
IM 平台接入的具体实现（目前仅 DingTalkChannel）。负责消息解析（文本/图片/文件/音视频）、卡片构建、媒体下载、Stream 回调订阅等。

### Bridge (AgentBridge)
管理 `cornfield --mode rpc` 子进程的生命周期，通过 JSON-line RPC 协议与 agent 进程通信。每个 gateway 账号持有自己的 Bridge 实例，提供 prompt 转发、会话切换、模型热切换、工具禁用等能力。

### Wire 协议
前端与 cornfield 核心之间的唯一协议契约：帧、命令 union、结果形状、事件类型。所有前端（TUI、web、桌面、IM 适配）说 Wire，核心实现 Wire。全 TypeScript，前端直接 import 协议类型，不生成、不镜像。
_Avoid_: RPC 协议, DTO 契约

### Wire 端点
宿主 Wire 协议、实现一个领域切片的进程。serve 端点宿主项目会话；gateway 端点宿主 CronTask、账号与 IM 投递。一套协议、多个端点、按关切分域。

### Sidecar
由桌面壳拉起并监督的伴随进程（当前为 cornfield serve）。生命周期跟随主程序：启动时 spawn、按端口契约复用或接管、退出时回收。不是常驻服务——桌面关闭后定时任务不能活在 sidecar 里。

### 服务端→客户端请求
Wire 协议中服务端向客户端索取用户输入（权限批准、选择、确认、自由输入）的通用请求，客户端应答走同一协议返回。权限批准是其第一个实现。

### Self-evolution
Agent 的自主学习系统。从 session 记录中提取技能（skills）、工作流模式、用户偏好，存入 SQLite 演化数据库，并在后续会话中注入上下文。无需外部训练管道，纯在线/离线混合。
_Avoid_: Training, fine-tuning, learning pipeline

### Skill
从 Self-evolution 中提取的可复用上下文块。可以是编码惯例、工具使用模式、项目特有知识等。以 .md 文件形式存入 `~/.cornfield/agent/skills/`，通过 system prompt 注入 agent 上下文。
_Avoid_: Convention, pattern, template

### Memory
Agent 需要在会话间记住的事实（用户偏好、项目配置、正在进行的任务状态）。通过 write_memory / read_memory 工具管理，由 self-evolution 的 memory 模块存储。
_Avoid_: Database, cache, state

### Natives
Rust 编写的 N-API cdylib（`crates/pi-natives`），暴露性能敏感的操作给 JS 层：grep、shell（brush）、文本处理、语法高亮、glob、任务管理等。编译为 `pi-natives.{platform}.node`，有 modern（AVX2）和 baseline 两个变体。
_Avoid_: Native addon, WASM, extension

### CronTask / ScheduledTask
Gateway 中由调度器按 cron 表达式定时触发的 agent 或 shell 任务。每 CronTask 有唯一 id、cron 表达式、type（agent/shell）、agentDir、timeoutMs、retry 策略等。定义以 JSON5 文件存放在 `cron/tasks/` 下，运行时同步至 jobs.json。

### CronExecution
CronTask 的一次触发执行。有唯一 executionId、startedAt、endedAt、exitCode、status（running/success/failure）。持久化在 JSONL 执行日志中。

### CronRunDiagnostics
CronExecution 的结构化诊断数据。包含多个 CronRunDiagnosticEntry，每个有 source（cron-preflight / agent-run / tool / exec / delivery）、severity（info/warn/error）、message、可选 toolName/exitCode。上限 10 条，每条 1000 字符，自动脱敏。
  _Avoid_: log, output, stderr

### CronDeliveryStatus
CronExecution 的投递结果状态：delivered（成功送达）/ not-delivered（送达失败）/ unknown（未确认）/ not-requested（未配置投递）。

### FailureDestination
CronTask 可选的独立失败通知目标。与主 delivery 分离，确保投递链自身出问题时用户仍能收到告警。配置在 cron 任务定义的 failureDelivery 字段。

### SchedulerEngine
CronTask 的调度执行引擎。管理 croner 定时器，处理并发限制、grace window 跳过、重试逻辑、执行记录。在 cornfield-gateway 内部。
  _Avoid_: cron service, scheduler daemon

### CronLifecycle
Gateway 中协调 SchedulerEngine 和 AgentBridge 的胶水层。负责 warm bridge 执行（executeAgent）、冷启动子进程回退（executeScheduledCommand）、投递、失败通知。在 gateway-cron-lifecycle.ts。