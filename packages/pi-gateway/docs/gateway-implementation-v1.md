# Gateway V1 实施计划

> 版本: 2.0
> 日期: 2026-06-17
> 状态: 基于当前代码的 Gap 分析与重排实施计划
> 配套文档: [gateway-design-v1.md](./gateway-design-v1.md)

---

## 1. 结论摘要

当前 `packages/pi-gateway` 已具备 DingTalk Stream 接入、AgentBridge RPC 通信、基础多账号配置、credential 注入、PID/service 管理、cron scheduler、AI Card/媒体模块等能力，但实现与设计文档仍存在关键差距。

最核心的问题不是功能缺失，而是**设计不变量尚未闭合**：

1. **多账号隔离不成立**：多个 DingTalkChannel 使用同一个 `channel.id = "dingtalk"` 注册，会互相覆盖；session key 不含 `accountId`，跨账号会话会串号。
2. **AgentBridge 已接入 RPC 主链路，但只是 prompt bridge**：当前会启动 `omp --mode rpc`，并在 prompt 前执行 `switch_session`；但 Gateway 只使用 `prompt`/`switch_session` 子集，没有把 abort、steer/follow_up、模型/推理设置、compact、bash、host tools、消息查询等 RPC 命令暴露给 IM 入口。
3. **同 bridge 串行已在 AgentBridge 层兜底，但缺少上层队列语义**：`AgentBridge.forward()` 已用串行尾链避免无 id session events 错投；Gateway 仍直接调用 bridge，缺少按 `(accountId, conversationId)` 的 SessionManager、队列深度保护、drain 和可观测队列状态。
4. **多账号 fallback 破坏隔离**：account bridge 不运行时会 fallback 到默认 bridge，违背“一个账号 = 一个 Agent = 一个 agentDir”的硬隔离规则。
5. **运维入口不可靠**：`pi-gateway status` 当前从 `gateway.ts` 动态导入未导出的 `getDataDir`；`PI_GATEWAY_CONFIG` 文档声明存在但 CLI 未读取。
6. **失败语义不透明**：DingTalk send 失败只写日志不抛错，Gateway 无法重试、告警或向状态层反馈失败。

因此新的实施顺序必须先修复编译与隔离边界，再补 SessionManager / RPC 控制面 / 队列 / 运维状态等能力。AI Card、媒体、指标、健康检查属于后续增强，不能先于隔离层推进。

---

## 2. 当前实现快照

### 2.1 已实现能力

| 能力 | 当前状态 | 主要文件 |
|---|---|---|
| DingTalk Stream 接入 | 已实现，含心跳、重连、去重、权限策略 | `src/channels/dingtalk.ts` |
| 多账号配置格式 | 已使用 `accounts: Record<string, DingtalkAccountConfig>` | `src/types.ts`, `src/config.ts` |
| per-account bridge 创建 | 已创建，但路由/注册/session 隔离不完整 | `src/gateway.ts` |
| Agent RPC 子进程 | 已可 spawn `omp --mode rpc` 并处理 ready/prompt/events | `src/agent-bridge.ts` |
| Extension UI 自动取消 | 已实现，避免 headless 模式挂起 | `src/agent-bridge.ts` |
| credential 注入 | 已从 `~/.omp/agent/agent.db` 读取 API key 并注入 env | `src/credential-resolver.ts` |
| session 元数据 | 已有全局 SQLite store | `src/session-store.ts` |
| PID/status/stop | 部分实现，status CLI 存在运行时错误 | `src/gateway.ts`, `src/cli.ts` |
| launchd/systemd service | 已实现基础安装/启动/停止 | `src/service-installer.ts` |
| Cron scheduler | 已实现文件/DB/执行器 | `src/scheduler/*` |
| AI Card | 模块已实现，但未接入主消息流；存在类型/状态问题 | `src/channels/dingtalk-card.ts` |
| 媒体下载/上传 | 模块已实现，但存在资源上限和无用 token 依赖问题 | `src/channels/dingtalk-media.ts` |

### 2.2 当前不应再视为“已完成”的能力

| 原声明能力 | 当前判断 | 原因 |
|---|---|---|
| 多账号 channel 注册 | 未完成 | registry 以固定 `channel.id` 为 key，多个账号互相覆盖 |
| 多账号 per-account bridge | 部分完成 | bridge 创建了，但默认 bridge 仍启动且可 fallback，隔离不成立 |
| RPC 集成 | 部分完成 | 已能 `prompt`、`switch_session`、收集最终 assistant 文本；未接入完整 RPC 控制面和流式 IM 投递 |
| PID/status 生命周期 | 部分实现 | `status` 命令动态导入错误；`getGatewayStatus()` 未使用传入 config path |
| AI Card 流式 | 部分完成 | 模块可用性未接入主流程；首次 INPUTING 失败后状态被错误标记 |
| 测试覆盖 | 不足 | 已有 bridge session 切换/串行/熔断/崩溃合同测试；仍缺多账号覆盖、SessionManager、失败发送等关键合同 |

---

## 3. Gap 分析

### 3.1 P0：必须先清除的构建/运行阻断

| Gap | 现状 | 设计依据 | 影响 | 文件 |
|---|---|---|---|---|
| TypeScript 编译错误：重复 `channels` 字段 | `Gateway.getStatus()` 返回对象重复声明 `channels` | 设计 §12 可观测状态必须可信 | 包无法干净 type-check | `src/gateway.ts` |
| TypeScript 编译错误：`robotCode` 可能 undefined | `config.robotCode ?? config.appKey` 仍可能是 `undefined` | 设计 §9.1 AI Card 是可选发送链路，不应破坏构建 | AI Card 模块类型不成立 | `src/channels/dingtalk-card.ts` |
| `pi-gateway status` 动态导入错误 | 从 `./gateway` 导入未导出的 `getDataDir` | 设计 §12 / 运维入口 | status 命令运行时崩溃 | `src/cli.ts` |

### 3.2 P1：设计不变量缺口

| Gap | 当前实现 | 目标设计 | 影响 | 文件 |
|---|---|---|---|---|
| 多账号 channel identity 缺失 | `DingTalkChannel.id` 固定为 `dingtalk`，registry Map 覆盖前账号 | 设计 §4.1：N 个 DingTalk 账号 = N 个连接 | 只有最后一个账号在线 | `src/channels/dingtalk.ts`, `src/channels/registry.ts`, `src/gateway.ts` |
| session key 不含 account | store 唯一键是 `(channel_id, conversation_id)` | 设计 §4.2 / §7：一个 session = 一个 account 的一个 conversation | 跨账号上下文串号 | `src/session-store.ts`, `src/gateway.ts` |
| session 文件不在 agentDir | 当前 path 是 `gateway-data/sessions/<channel>/<conv>.jsonl` | 设计 §7.2：`<agentDir>/sessions/<safeConvId>.jsonl` | 备份 agentDir 无法恢复完整机器人；隔离不物理化 | `src/gateway.ts` |
| RPC 控制面只接了 prompt 子集 | `AgentBridge.forward()` 会切 session 后发送 `prompt`，但没有对外暴露 abort、steer/follow_up、模型/推理设置、compact、bash、host tools、消息查询等命令 | 设计 §8 / IM 体验 | 用户无法打断、调参、分支重答、触发压缩或使用网关侧 host tools | `src/agent-bridge.ts`, `src/gateway.ts` |
| 流式事件未投递到 IM | bridge 只取最后一个 assistant `message_end` 文本；`message_update` / tool events / status/title/widget 事件没有进入 DingTalk AI Card 或文本更新链路 | 设计 §8 / §9.1 | 用户只能看到最终回复，长任务无进度，工具执行不可观测 | `src/agent-bridge.ts`, `src/gateway.ts`, `src/channels/dingtalk-card.ts` |
| 缺 SessionManager | Gateway 直接 forward 到 bridge；AgentBridge 内部串行只能防错投，不能表达按 conversation 排队、队列上限、drain 或跨 account 并行策略 | 设计 §8.2 / §11.3 | 无背压、无法优雅关闭、状态不可观测 | `src/gateway.ts`, `src/session-manager.ts` |
| 多账号启动默认 bridge | 多账号模式仍启动 `#bridge`，account bridge 不运行时 fallback | 设计 §5.3：多账号模式不创建默认 bridge | 隔离失败，错误账号人格/目录处理消息 | `src/gateway.ts` |
| agentDir 默认值未用于运行 | skeleton 创默认目录，但 config 不写入；bridge cwd 只用 `account.agentDir` | 设计 §5.5 / §6.1b | 默认安装后 Agent 从当前目录启动 | `src/cli.ts`, `src/gateway.ts`, `@oh-my-pi/pi-coding-agent/skeleton` |
| agentDir skeleton 未接入启动 | `ensureAgentDir()` 存在但 Gateway.start 未统一调用 | 设计 §6.1b | 手写配置的新账号可能没有 mission/sessions/cron 结构 | `src/gateway.ts`, `@oh-my-pi/pi-coding-agent/skeleton` |

### 3.3 P2：防御与可运维缺口

| Gap | 当前实现 | 目标设计 | 影响 | 文件 |
|---|---|---|---|---|
| 熔断状态未对 Gateway 可观测 | AgentBridge 内部已有连续失败 OPEN/HALF_OPEN 逻辑，但没有公开 bridge state / failure counters 给 status、health 或 SessionManager | 设计 §11.2 / §12 | 运维只能从日志推断，不能按账号展示 degraded/error | `src/agent-bridge.ts`, future `session-manager.ts` |
| 无优雅关闭 drain | stop 先停 scheduler/bridge，再断 channel/store | 设计 §11.4：断 channel → drain queue → stop bridge → close store | in-flight 消息丢失 | `src/gateway.ts` |
| 崩溃窗口已在 bridge 内部实现但不可观测 | AgentBridge 维护 10 分钟崩溃窗口并可进入 ERROR suppression；Gateway/status 不能读取该状态 | 设计 §11.1 / §12 | 崩溃循环可被抑制，但运维入口不能说明哪个账号处于 ERROR | `src/agent-bridge.ts` |
| DingTalk send 失败不向上冒泡 | HTTP 非 2xx / fetch error 仅 log | 设计 §11 错误可观测 | 上层误认为发送成功 | `src/channels/dingtalk.ts` |
| `PI_GATEWAY_CONFIG` 未生效 | CLI 只解析 `--config` | CLI 文档自身声明 | service/script 配置路径被忽略 | `src/cli.ts` |
| `$ENV_VAR` appSecret 未解析 | schema 接受字符串但不展开 | 设计 §5.4 | secret 管理不符合设计 | `src/config.ts` |
| cron task type 未校验 | `--type` 直接 cast | 防御式 CLI 输入 | 拼写错误会按 shell 执行 | `src/cli.ts`, `src/scheduler/executor.ts` |
| interval/once nextRun 更新不准 | 执行后统一 `getNextRun(task.cron)` | scheduler 状态应可信 | cron list/status 显示不可信 | `src/scheduler/engine.ts` |
| 媒体下载无大小/清理上限 | `arrayBuffer()` 全量读入，临时目录不清理 | 设计 §11 防御机制 | daemon 内存/磁盘增长 | `src/channels/dingtalk-media.ts` |
| 媒体下载依赖未使用的 OAPI token | 先取旧 OAPI token，但实际请求用新 API token | 最小依赖原则 | 新 API 可用时仍可能被旧 API 阻断 | `src/channels/dingtalk-media.ts` |
| AI Card INPUTING 状态错误 | 首次切换失败也设置 `inputingStarted = true` | 设计 §9.1 主链路可靠降级 | 卡片后续无法自恢复 | `src/channels/dingtalk-card.ts` |

### 3.4 P3：可观测与 V2 能力缺口

| Gap | 当前实现 | 目标设计 | 阶段 |
|---|---|---|---|
| 聚合指标 | 无统一 metrics 输出 | 设计 §12 每分钟结构化指标 | P3 |
| 健康检查 HTTP | 无 | 设计 §11.7 / §12 | P3 |
| 速率限制 | 无 | 设计 §11.6 | P3 |
| session compaction | 无 | 设计 §11.5 | P3 |
| 配置 reload | 无 | 设计 §3.4，明确 V2 | V2 |
| Agent 独立部署 | 无 | 设计 §3.3 V2 | V2 |

### 3.5 RPC 命令覆盖分析（当前 Gateway 侧）

`omp --mode rpc` 本身的命令面比 AgentBridge 当前使用面大得多。Gateway V1 不应该盲目把所有 RPC 命令暴露给 IM；应按用户价值和安全边界分批接入。

| RPC 命令组 | OMP RPC 已支持 | Gateway/AgentBridge 当前接入 | 建议优先级 | 接入判断 |
|---|---|---|---|---|
| 基础 prompt | `prompt`、`switch_session` | 已接入；prompt 前会 `switch_session`，并等待 `agent_end` 后返回最终文本 | 已完成主链路 | 保留为唯一主后端，避免回退到 `omp -p` 双实现 |
| 打断与插话 | `abort`、`abort_and_prompt`、`steer`、`follow_up`、队列模式 | 未接入 | P1/P2 | IM 长任务必须能打断；但要先定义同 conversation 排队语义和“新消息是插话还是后续问题” |
| 流式可观测 | session events、`extension_ui_request` 的 `notify/setStatus/setWidget/setTitle` | bridge 目前忽略大多数 UI 事件，只返回最终 assistant 文本 | P2/P3 | AI Card 接入前应先定义哪些事件可安全展示、如何节流、如何失败降级 |
| 模型与推理控制 | `set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`cycle_thinking_level` | 未接入 | P2 | 需要权限/allowlist；群聊中不能让任意用户随意切高成本模型 |
| session 操作 | `new_session`、`branch`、`get_branch_messages`、`get_last_assistant_text`、`set_session_name`、`get_messages`、`get_session_stats`、`export_html` | 只接入 `switch_session` | P2/P3 | 对 IM 有价值，但要先明确命令入口、隐私边界和大输出截断策略 |
| compact / retry | `compact`、`set_auto_compaction`、`set_auto_retry`、`abort_retry` | 未接入 | P3 | 大 session 场景需要 compact；自动重试策略应由 Agent 默认或管理员配置控制，不宜先开放给普通聊天入口 |
| bash | `bash`、`abort_bash` | 未接入 | 默认不接入 | IM 触发 shell 是高风险能力；除非有强认证、审计和 allowlist，否则不应开放 |
| host tools | `set_host_tools` + `host_tool_call/result/update` | bridge 明确拒绝所有 `host_tool_call` | P3/V2 | 需要工具注册、权限、超时、审计、幂等和错误映射；可以作为网关侧能力，但不能默认全开 |
| todos/state | `get_state`、`set_todos` | 未接入 | 低优先级 | 主要是 TUI/自动化状态能力；IM 需要时应包装成明确命令，不直接透传原始状态 |

结论：当前 Gateway 需要的是“RPC 后端 + 受控控制面”，不是“把 OMP RPC 全量透传给 DingTalk”。第一批应补打断/插话、流式状态、模型/推理只读或受控切换；bash 和 host tools 必须等权限、审计、超时和 allowlist 设计闭合后再接。

---

## 4. 新实施原则

### 4.1 不变量优先

以下不变量必须先于体验功能完成：

1. **账号隔离**：任意入站消息必须确定唯一 `accountId`，并只进入该 account 的 channel / session / bridge / agentDir。
2. **session 隔离**：任意 prompt 前必须切换到该 account 的该 conversation 的 session 文件。
3. **同 bridge 串行**：一个 Agent RPC 进程同一时间最多处理一个 prompt；不同 account 的 bridge 可以并行。
4. **失败不伪装成功**：发送失败、bridge error、config error 必须向调用方或状态层暴露。
5. **多账号无默认 fallback**：account bridge 不可用时，返回该 account 不可用，不得转交默认 bridge。

### 4.2 文档与代码的目标状态

V1 的目标不是实现设计文档所有 V2 能力，而是完成以下闭环：

```text
DingTalk(accountId)
  → Gateway
  → SessionManager(accountId, conversationId)
  → AgentBridge(accountId, cwd=agentDir)
  → switch_session(<agentDir>/sessions/<safeConvId>.jsonl)
  → prompt
  → reply
  → DingTalk(account-specific channel)
```

---

## 5. 优先级路线图

### P0：构建与运维入口修复

**目标**：让模块恢复可检查、可启动、可诊断的基本状态。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| 修复 `Gateway.getStatus()` 重复字段 | `gateway.ts` | TypeScript diagnostics 无重复字段错误 |
| 修复 AI Card `robotCode` 类型 | `dingtalk-card.ts` | 类型明确；缺少 robotCode/appKey 时返回 null 或明确错误 |
| 修复 `pi-gateway status` 导入 | `cli.ts` / `config.ts` | `pi-gateway status` 可打印状态和 data dir |
| 接入 `PI_GATEWAY_CONFIG` | `cli.ts` | `--config` 优先，其次 env，最后默认路径 |
| 清理明显违反项目约束的类型/导入问题 | 相关文件 | 不引入新行为变化 |

**并行策略**：可由 2 人并行。

- A：`gateway.ts` + `cli.ts`
- B：`dingtalk-card.ts` + diagnostics

---

### P1-A：多账号 identity 与路由修复

**目标**：先让“多个账号同时在线”成立。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| 为 channel registry 引入注册 key | `ChannelRegistry.register()` 或 DingTalk channel id 策略 | 多个 DingTalk account 注册后 registry 保留 N 个 channel |
| OutboundMessage 带 account 路由信息 | `types.ts`, `gateway.ts`, `registry.ts`, `dingtalk.ts` | 回复能发回收到消息的 account channel |
| InboundMessage accountId 必填化或在 DingTalk 路径强保证 | `types.ts`, `dingtalk.ts`, `gateway.ts` | 多账号消息缺 accountId 时拒绝而非 fallback |
| 移除多账号默认 bridge 启动 | `gateway.ts` | accounts 非空时只启动 per-account bridge |
| 禁止 account bridge fallback 默认 bridge | `gateway.ts` | account bridge down 返回明确错误 |

**验收场景**：配置两个 DingTalk accounts，registry 中有两个连接；Bot A 和 Bot B 都能独立接收消息；Bot A bridge down 时 Bot A 返回不可用，Bot B 不受影响。

**并行策略**：本阶段需要先统一 identity 方案，不建议多人同时改同一批核心类型。可拆成：

- A：设计并落地 registry / outbound account 路由合同。
- B：同步补测试用例与 fixture，等待 A 的类型合同后接入。

---

### P1-B：agentDir 与 session 物理隔离

**目标**：让一个 account 的所有运行数据落在自己的 agentDir。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| 统一 `resolveAgentDir(accountId, explicitDir)` 使用点 | `@oh-my-pi/pi-coding-agent/skeleton`, `gateway.ts`, `agent-bridge.ts` | 未配置 agentDir 时 cwd 为 `~/.omp/agents/<accountId>/` |
| Gateway 启动时 ensure skeleton | `gateway.ts`, `@oh-my-pi/pi-coding-agent/skeleton` | 手写 config 的新 account 首启生成 mission/sessions/cron/knowledge/.gitignore |
| setup 默认 agentDir 写入或 Gateway 按默认解析 | `cli.ts`, `setup.ts`, `gateway.ts` | 接受默认目录时实际 cwd 与创建目录一致 |
| session path 改为 `<agentDir>/sessions/<safeConvId>.jsonl` | `gateway.ts` / future session manager | session 文件在 account agentDir 内 |
| session 元数据按 account 隔离 | `session-store.ts` 或迁移到 per-agent db | 同一 conversationId 在两个 account 下生成两条独立 session |

**验收场景**：两个 account 均不显式配置 agentDir；启动后创建 `~/.omp/agents/<account>/`；同一个 conversationId 在两个 account 下生成不同 session 文件。

**并行策略**：可与 P1-A 后半并行，但必须共享同一个 account identity 合同。

- A：agentDir 解析和 skeleton。
- B：session path/key 迁移和测试。

---

### P1-C：AgentBridge RPC 控制面与状态可观测

**目标**：在已完成的“切 session 后串行 prompt”基础上，把 bridge 的公开合同从单一 `forward()` 扩展为受控 RPC 控制面，并让 Gateway/SessionManager 能观察 bridge 状态。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| 定义 bridge 状态 | `AgentBridgeState = idle | busy | restarting | error | stopped`，包含 circuit/crash 摘要 | status/health 可查询，不靠 private flag 或日志推断 |
| 保留 `switchSession(sessionPath)` 与串行 prompt 合同 | `agent-bridge.ts` | prompt 前发送 `switch_session` 并等待 ack；同 bridge 并发仍串行 |
| 拆分 `forward()` 内部层次 | `agent-bridge.ts` | `extract inbound text`、`switch session`、`prompt and collect`、`format response` 边界清晰 |
| 增加受控命令入口 | `agent-bridge.ts` | 至少支持 `abort`；后续可扩展 `steer/follow_up`、model/thinking、compact |
| 保留 `waitForIdle()` | `agent-bridge.ts` | graceful shutdown / reload 可等待 in-flight |
| 保留 headless extension/host tool 防挂起逻辑 | `agent-bridge.ts` | confirm/select/input/editor 自动取消仍生效；host tools 未启用时继续明确拒绝 |

**关键设计决策**：V1 不支持同一个 AgentBridge 内并发 prompt。所有并发由 SessionManager 排队。这样可以避免无 id session events 错路由，也符合设计 §8.3。

**验收场景**：同一个 account 下 A/B 两个 conversation 并发发消息，bridge 实际串行：A 完成后切到 B；A/B 的 session 文件和回复互不污染；长任务期间用户发送“停止”可触发 `abort` 并得到明确反馈。

**并行策略**：不建议并行编辑 `agent-bridge.ts`。可拆成：

- A：AgentBridge 状态与受控 RPC 命令。
- B：基于 fake RPC process 的合同测试。
---

### P1-D：SessionManager 与背压

**目标**：把并发控制从 Gateway/Bridge 中抽出来，形成可测试的调度层。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| 新增 SessionManager | `session-manager.ts` | `enqueue()` 返回该消息最终回复 |
| 队列按 `(accountId, conversationId)` 分组 | `session-manager.ts` | 同一 conversation 顺序处理 |
| 同 account 单 worker 串行 bridge | `session-manager.ts` | 同 account 不并发 prompt |
| 不同 account 并行 | `session-manager.ts` | account A 慢不阻塞 account B |
| 队列深度保护 | `session-manager.ts`, config | 超限立即返回“系统繁忙” |
| drain 接口 | `session-manager.ts`, `gateway.ts` | stop 可等待队列完成 |

**验收场景**：5 个用户并发，每人 3 条消息；同用户顺序保持，不同 account 可并行；超过队列上限返回明确拒绝。

**并行策略**：可与 P1-C 的测试并行，但集成必须等 P1-C bridge 合同稳定。

- A：SessionManager 核心。
- B：Gateway 集成与 tests。

---

### P2：防御机制与失败语义

**目标**：让长期 daemon 运行时不会静默失败或无限堆积。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| AgentBridge 状态外显 | `agent-bridge.ts`, `gateway.ts` | status 能显示 per-account bridge 的 running/busy/circuit/error/crash 窗口摘要 |
| 熔断器参数化与告警 | `agent-bridge.ts` 或 `circuit-breaker.ts` | 连续 N 次超时 OPEN，冷却后 HALF_OPEN；阈值可配置或集中常量化 |
| 优雅关闭 | `gateway.ts`, `session-manager.ts` | SIGTERM：断 channel → drain → stop bridge → close store |
| DingTalk send 失败冒泡 | `dingtalk.ts`, `registry.ts`, `gateway.ts` | HTTP 非 2xx 可被上层记录为发送失败 |
| `$ENV_VAR` appSecret 解析 | `config.ts` | env 缺失时该 account 启动失败且不泄露 secret |
| cron type 校验 | `cli.ts`, scheduler types | 非 `shell|agent` 拒绝创建 |
| scheduler nextRun 修正 | `scheduler/engine.ts`, `scheduler/types.ts` | cron/interval/once 执行后 nextRun 正确 |

**并行策略**：P2 可以分 4 条并行线。

- A：AgentBridge 崩溃窗口 + 熔断器。
- B：Gateway graceful shutdown + send failure propagation。
- C：config secret + CLI validation。
- D：scheduler nextRun。

---

### P3：体验与资源治理

**目标**：在隔离和防御完成后提升用户体验与资源稳定性。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| AI Card 接入主消息流 | `gateway.ts`, `dingtalk-card.ts` | 支持 card 创建失败降级普通消息 |
| 修复 AI Card INPUTING 状态 | `dingtalk-card.ts` | 首次状态切换失败后允许重试 |
| 媒体下载资源上限 | `dingtalk-media.ts` | 超过大小拒绝；临时文件有清理策略 |
| 移除无用 OAPI token 阻断 | `dingtalk-media.ts` | 新 API 可用时不被旧 OAPI token 失败阻断 |
| session compaction | `agent-bridge.ts` / SessionManager | 大 session 可触发 compact |
| 速率限制 | SessionManager | 用户短时间连发得到友好提示 |

**并行策略**：可由 3 条独立线并行。

- A：AI Card 主链路。
- B：媒体资源治理。
- C：rate limit + compaction。

---

### P4：可观测与运维增强

**目标**：让运维可以判断系统健康，而不是只看日志。

| 任务 | 改动范围 | 验收 |
|---|---|---|
| metrics 聚合日志 | `metrics.ts`, Gateway/SessionManager/Bridge hooks | 每分钟输出 message/latency/error/queue/bridge 状态 |
| health HTTP | `health.ts` | `GET /health`, `/health/accounts`, `/health/queues` |
| status 命令增强 | `cli.ts`, `gateway.ts` | 展示 accounts、bridge state、queue depth、scheduler state |
| service 状态补充 | `service-installer.ts` | launchd/systemd 状态和 gateway PID 状态一致 |

**并行策略**：metrics 合同先定，health/status 可并行消费 metrics snapshot。

---

### V2：不纳入当前 V1 修复的能力

| 能力 | 原因 |
|---|---|
| 配置热加载 `reload` / SIGHUP / mtime watch | 需要 bridge/channel/queue 原子替换，必须等 V1 drain 和 SessionManager 稳定 |
| Agent 独立部署 / `agentUrl` | 需要 AgentBridge 网络模式，不应与当前 stdin/stdout RPC 修复混做 |
| 在线切换 model/agentDir | 当前 V1 通过重启 bridge 实现，在线切换需要 RPC 支持 |
| 多网关共享同一个 Agent | 需要分布式锁/session 协调，超出单机 V1 目标 |

---

## 6. 并行开发总策略

### 6.1 依赖图

```text
P0 构建/CLI 修复
  ↓
P1-A account/channel identity
  ↓
P1-B agentDir + session key/path ─┐
  ↓                              │
P1-C AgentBridge session RPC      │
  ↓                              │
P1-D SessionManager + queue  ←────┘
  ↓
P2 防御机制 / secret / scheduler / send failure
  ↓
P3 AI Card / media / compaction / rate limit
  ↓
P4 metrics / health / status
```

### 6.2 推荐并行编组

| 小组 | 阶段 | 文件边界 | 说明 |
|---|---|---|---|
| Core Routing | P1-A | `types.ts`, `channels/registry.ts`, `channels/dingtalk.ts`, `gateway.ts` | 定义 account/channel identity 合同，其他组依赖它 |
| Session Isolation | P1-B | `setup.ts`, `config.ts`, `session-store.ts`, `gateway.ts` | agentDir、session path、session metadata |
| Bridge Runtime | P1-C/P2 | `agent-bridge.ts` | RPC session、串行、状态机、崩溃、熔断 |
| Queue Integration | P1-D | `session-manager.ts`, `gateway.ts` | 等 Bridge Runtime 的公开合同稳定后接入 |
| CLI/Config/Ops | P0/P2/P4 | `cli.ts`, `config.ts`, `service-installer.ts` | 可大部分独立推进 |
| Scheduler | P2 | `scheduler/*` | 与消息主链路低耦合，可独立修 |
| DingTalk UX | P3 | `dingtalk-card.ts`, `dingtalk-media.ts`, `dingtalk.ts` | 等主链路隔离稳定后接入体验功能 |
| Observability | P4 | `metrics.ts`, `health.ts`, `gateway.ts` | 依赖 SessionManager/Bridge 状态接口 |

### 6.3 文件冲突控制

高冲突文件：

- `src/gateway.ts`
- `src/agent-bridge.ts`
- `src/types.ts`

控制策略：

1. `types.ts` 的 account/session/outbound 合同先由 Core Routing 一次性定稿。
2. `agent-bridge.ts` 同一时间只允许 Bridge Runtime 改动；其他组通过公开接口消费。
3. `gateway.ts` 分两次集成：先接 account/channel identity，再接 SessionManager；不要在同一个 PR 同时塞 AI Card、scheduler、metrics。
4. `dingtalk-card.ts` / `dingtalk-media.ts` 等体验模块不得先于 P1 合并进主流程。

---

## 7. 验收测试矩阵

### 7.1 P0 验收

| 场景 | 期望 |
|---|---|
| TypeScript diagnostics | gateway 包无 P0/P1 类型错误 |
| `pi-gateway status` | 不崩溃，显示 running/pid/dataDir |
| `PI_GATEWAY_CONFIG=/tmp/gateway.json pi-gateway config` | 读取 env 指定文件 |

### 7.2 P1 验收

| 场景 | 期望 |
|---|---|
| 两个 DingTalk accounts 启动 | registry 中有两个有效 channel，两个 bridge，两个 cwd |
| 同 conversationId 发给两个 bot | 生成两个不同 session，位于两个 agentDir |
| 同 account 两个用户并发 | 按队列串行，不错投 |
| 不同 account 并发 | 互不阻塞 |
| account bridge down | 该 account 返回不可用，不 fallback |
| 手写 config 不写 agentDir | 自动创建并使用 `~/.omp/agents/<accountId>/` |

### 7.3 P2 验收

| 场景 | 期望 |
|---|---|
| 连续超时 | 熔断 OPEN，后续请求快速失败 |
| 10 分钟内 6 次崩溃 | bridge 进入 ERROR，不无限重启 |
| SIGTERM during prompt | channel 停收，队列 drain，超时后明确记录丢失 |
| DingTalk webhook 500 | Gateway 能感知发送失败 |
| `$DINGTALK_SECRET` 未设置 | 对应 account 启动失败且不泄露 secret |
| `cron create --type agnet` | 拒绝创建 |

### 7.4 P3/P4 验收

| 场景 | 期望 |
|---|---|
| AI Card 创建失败 | 降级普通文本回复 |
| AI Card INPUTING 首次失败 | 后续可重试，不永久跳过 |
| 发送大文件 | 超限拒绝，不 OOM |
| metrics 输出 | 每分钟有结构化 message/queue/latency/error 指标 |
| `/health/accounts` | 返回每个 account 的 channel/bridge/queue 状态 |

---

## 8. 测试策略调整

### 8.1 必须新增的合同级测试

| 测试 | 覆盖合同 |
|---|---|
| registry multi-account keeps all channels | 多账号 channel 不覆盖 |
| outbound routes to matching account channel | 回复走原 account 通道 |
| session key includes account | 跨账号同 conversation 不共享 session |
| default agentDir is used as bridge cwd | 默认目录不只是创建，还实际使用 |
| bridge serializes prompts | 同一 bridge 并发不发生错投 |
| SessionManager preserves per-conversation order | 同会话消息顺序处理 |
| SessionManager allows cross-account parallelism | 不同账号互不阻塞 |
| account bridge failure does not fallback | 隔离失败时不静默降级 |
| sendMessage propagates failure | 发送失败可被上层观察 |
| appSecret env resolution redacts secret | secret 展开但不泄露 |

### 8.2 需要重写或降级的测试

| 当前测试 | 问题 | 处理 |
|---|---|---|
| `dingtalk-channel.test.ts` dedup 本地 Map 测试 | 没测真实实现 | 改为通过 channel 行为或导出纯函数测试 |
| `communicate.test.ts` 真实 spawn `omp --mode rpc` | 依赖本机环境，易 flaky | 移到 integration，并默认跳过或用 fake RPC binary |
| 只断言 `not.toThrow` / module imports | 合同弱 | 替换为可观察行为断言 |

---

## 9. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| session key/path 迁移破坏旧数据 | 高 | 启动迁移前备份；旧全局 path 只读迁移到 agentDir；迁移日志包含 account/conversation |
| RPC `switch_session` 与实际 omp 协议不一致 | 高 | 先用 fake RPC 定合同，再用真实 `omp --mode rpc` 做一条集成验证 |
| 多账号 channel id 改动影响单账号 | 中 | 单账号兼容 path 保留；测试覆盖 single-account 与 multi-account |
| 禁止 fallback 后可用性下降 | 中 | 返回明确“该机器人暂不可用”，这是正确隔离行为，不应牺牲安全边界 |
| send failure 冒泡导致旧流程报错增多 | 中 | Gateway catch 后记录并可重试/降级；不要吞掉失败 |
| SessionManager 引入后行为变化大 | 高 | 先用 fake bridge 做队列合同测试，再接真实 bridge |
| AI Card 主链路耦合过重 | 中 | AI Card 必须可配置/可降级；失败不影响文本回复 |

---

## 10. 建议里程碑

### Milestone 0：可检查基线

- P0 全部完成。
- `status/config/start` 基础命令可运行。
- 无当前已知 TypeScript 阻断错误。

### Milestone 1：多账号隔离闭环

- P1-A + P1-B 完成。
- 多账号 channel 不覆盖。
- session/account/agentDir 物理隔离成立。
- 默认 bridge fallback 被移除。

### Milestone 2：RPC session、控制面与队列闭环

- P1-C + P1-D 完成。
- prompt 前切 session。
- 同 bridge 串行，不同 account 并行。
- 至少支持受控 `abort`，并明确 `steer/follow_up` 的排队语义。
- 有队列深度保护和 drain 能力。

### Milestone 3：daemon 防御闭环

- P2 完成。
- 熔断、崩溃窗口、优雅关闭、send failure、secret env、scheduler 修复完成。

### Milestone 4：体验与观测闭环

- P3 + P4 完成。
- AI Card/媒体安全接入。
- metrics/health/status 能反映真实 account/queue/bridge 状态。

---

## 11. V1 完成定义

V1 只有在以下条件同时满足时才算完成：

1. 多账号配置下，每个 account 有独立 DingTalk channel、AgentBridge、agentDir、session 文件。
2. 同一个 account 内所有 prompt 串行处理，不存在 AgentBridge event 错投。
3. 不同 account 可并行处理，互不阻塞。
4. 任意发送失败、bridge 崩溃、secret 缺失都能被调用方或运维状态观察到。
5. `pi-gateway status` 能展示真实运行状态。
6. SIGTERM 不直接丢弃 in-flight 消息，至少执行 drain 或明确记录丢失。
7. 测试覆盖多账号隔离、session 隔离、并发顺序、fallback 禁止、send failure、secret env。

未满足这些条件前，AI Card、健康检查、reload 等增强能力不能作为“完成”替代核心可靠性闭环。
