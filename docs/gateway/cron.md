# Gateway Cron

> 状态：已实施（2026-06-30）。Tier 1（`cron.test-run`、`bridge.status`）与结构化诊断已 ship；未落地项见 §10「后续工作（本次不做）」。

## 1. 总览

### 1.1 一句话总览

**CornField 是完全通用的 agent runner，对 DingTalk / cron / gateway 一无所知；gateway 是 host，CornField 是 subprocess，双方通过一套 RPC 帧协议通信。** Gateway 专属的能力（cron、IM channel、agentDir 路由）都必须"注入"到 CornField 里——这就是 host-tool 机制的全部由来。

### 1.2 角色分工

| 角色 | 知道什么 |
|---|---|
| CornField subprocess | 通用 LLM 循环 + 工具调用 + 工具定义。**不知道**有 cron / DingTalk |
| Gateway (host) | DingTalk 协议、agentDir、channel registry、scheduler、SQLite 存储 |
| LLM（在 CornField 里） | 看到"工具列表"，调用就是 |

### 1.3 为什么 cron 必须在 gateway 侧（不能在 CornField 里）

- **调度循环**：cron 触发是 gateway 的 scheduler（`SchedulerEngine`）的事，CornField 没时钟概念
- **触发 agent**：cron 触发 `taskType: "agent"` 任务时，由 gateway 经 AgentBridge 驱动 CornField 子进程执行——CornField 自己没法 fork 自己
- **DingTalk delivery**：channel registry 在 gateway，发送结果要回 IM——CornField 没 IM 概念
- **account 隔离**：每个 accountId = 一个 CornField 子进程；cron 任务横跨 account，调度必须在 CornField 之外的 gateway

### 1.4 为什么 LLM 不能用 `bash` 调 CLI 代替 host tool

- **D4 auto-inference 拿不到**：`resolveDeliveryForAdd()` 读 `bridge.getActiveChatContext()` 自动填 `channel/accountId/toUserId`，CLI 没这个上下文，LLM 只能硬编平台内部 ID（staffId），LLM 不该知道
- **Round-trip 浪费**：shell out 起独立进程跑 CLI，再把 stdout parse 回 LLM，绕了一圈
- **错误是文本**：host tool 通过 `parseSchedule` 立刻返回 `isError:true`；CLI 要靠 exit code 和 stdout 文本 parse
- **Tool 描述即文档**：cron 工具的 `description` 写满 MUST / MUST NOT 规则，LLM 在 system prompt + tool description 双重提示下走对路径；shell + CLI 路径没有任何 in-band 校验

## 2. 两条入口路径

| 路径 | 入口 | 是否经 LLM | delivery 来源 | 持久化 |
|---|---|---|---|---|
| Slash 命令 | 硬编码 `/cron create …` 前缀 | 否 | 不填 | JSON5 文件 + SQLite |
| LLM Host-Tool | 用户自然语言 | 是 | auto-infer 自 `getActiveChatContext()` | 仅 SQLite |

### 2.1 Slash 命令路径（不经 LLM）

- **入口**：`packages/gateway/src/gateway-message.ts` `#tryCreateCronFromMessage`——在 `handleInboundMessage` 中作为 fast-path 早于 LLM 路径执行；文本必须以 `/cron create` 起头，不匹配则 fall-through 到 LLM 路径
- **解析**：`packages/gateway/src/scheduler/from-message.ts` `parseCronIntent`——格式 `/cron create <schedule> -- <command...>`，用 `--` 作 schedule / command 分隔符（避免与 cron 表达式自身的空格冲突）
- **持久化**：`createCronTaskFromMessage` 双写：`<agentDir>/cron/tasks/<name>.json5`（人类可读 / git 友好）+ `SchedulerDbStorage.addTask`（运行时真相）；DB 写入失败时回滚 JSON5 文件，避免孤儿定义
- **限制**：硬编码 `type: "shell"`；不做 LLM 解释/校验；不带 delivery；不带 model / skills / toolsets / preScript

### 2.2 LLM Host-Tool 路径

- **工具定义**：`packages/gateway/src/scheduler/host-tool.ts` `createCronToolDefinitions`，actions：`add | list | show | update | remove | enable | disable | run | runs | recent | test-run`；参数 schema 通过 `@sinclair/typebox` 严格约束
- **audit 字段**：`add` 在 `SchedulerDbStorage.addTask` 写入时 stamp 两个字段：
  - `createdByUserId = bridge.getActiveChatContext()?.userId`（可选；无 chat context 时为 `undefined`）
  - `createdByAccountId = ctx.accountId`（永远有；CornField 进程绑定的 accountId）
  - 它们是 **audit 字段**，不参与访问控制。LLM 想答"哪些是我创建的"可调 `list` 后 client-side filter `createdByUserId === <current userId>`
- **scope = agent**：同一 CornField 进程里的所有用户共享同一个 task list（存储已经是 per-account / per-agent）。`list` / `show` / `update` / `remove` / `runs` 不过滤。工具 description 已写明：「`My` in a cron context refers to the current agent, not the user asking」
- **`run` action 当前是占位符**：返回 `errResult("'run' via LLM is not yet supported; use \`cornfield-gateway cron run <name>\` from the CLI")`

## 3. 调度模型

`SchedulerEngine`（`packages/gateway/src/scheduler/engine.ts`）是 gateway 内的定时调度引擎，每个 active 任务在 `start()` 时注册定时器，`reload()` 每 tick 同步内存任务表与 storage。支持三种 `ScheduleType`：

| 类型 | 表达 | 触发机制 |
|---|---|---|
| `cron` | cron 表达式（`0 18 * * *`） | croner 计算 `nextRunAt`，到点触发 |
| `interval` | 相对间隔（`+5m`） | `setInterval`，以 `nextRunAt` 为基准防止漂移 |
| `once` | 绝对目标时间（test-run 的 `+<n>s` one-shot） | 携带 ABSOLUTE `nextRunAt`（写入者计算，不从 reload 时间重推），触发后无下次运行 |

**调度特性**（engine 内建，全部保留）：

| 机制 | 作用 |
|---|---|
| at-most-once | 执行前推进 `nextRunAt`，崩溃后不会重放 |
| 并发上限（默认 3） | `maxConcurrentRuns`，防止 interval 堆积 |
| Grace window | 超期任务跳过，重启后不追积压 |
| 重试 + 指数退避 | `RetryConfig`（maxAttempts / backoffMs），临时故障自愈 |

## 4. 执行：AgentBridge 子进程执行

### 4.1 执行链（5 层）

```
SchedulerEngine tick 命中 nextRunAt
  → SchedulerEngine.#handleTrigger(taskId)    ← 并发检查 + grace window + 重试循环
  → CronService.onTrigger(task)               ← 上下文构建 + 执行编排 + 投递
  → CronLifecycle.#executeCronAgent(params)   ← getBridgeByAgentDir + 副作用操作
  → AgentBridge.executePrompt(prompt, { sessionPath: cronSessionFilePath, ... })
      → PromptQueue.runExclusive()            ← 每 account 一个 queue
  → CornField --mode rpc 子进程（switched 到 cron session 文件）
```

### 4.2 关键设计

- **cron session 用独立 session 文件**（`cronSessionPath(agentDir)`，见 `packages/gateway/src/session-paths.ts`）：`executePrompt` 前 `#switchSession(cronSessionPath)`，不污染 IM 聊天历史；N2 契约强制子进程 `state.sessionFile` 与强制路径一致，漂移则告警（post-run drift check）
- **warm bridge 主路径 + 冷启动 fallback**：cron 通过每 account 的 warm bridge 执行，与 IM 共享 prompt queue（`runExclusive`）。两个兜底机制保证 IM 不被 cron 拖死：
  - `queueTimeoutMs`（默认 5s）：等待 queue 释放超时即抛错，转冷 fallback，卡死的 LLM turn 不会叠加第二个用户可见等待
  - `inactivityMs`（由任务 `timeoutMs` 经 `computeInactivityBudgetMs` 派生）：子进程 60s 无 session 事件则 watchdog 触发，warm-bridge 调用拒绝，转冷 fallback
  - 冷 fallback = 起一次性 `cornfield --print` 子进程跑完任务，任务仍执行
- **无 wall-clock 硬上限**（2026-07-08 移除）：长但活跃的 prompt 一直跑，直到 inactivity watchdog 或 `agent_end`
- **模型切换**：任务带 `model`/`provider` 时执行前 `bridge.setModel`（记录原 model 切换前状态），执行完恢复；切换失败仅 warn，继续当前 model
- **早期方案**：曾设计独立 RPC `run_cron_task` + 子进程内 `createAgentSession()` 并行 session（消除 queue 串行），评估后未采用——warm bridge + queue timeout + cold fallback 已达成不阻塞目标，改动面更小

### 4.3 执行期安全措施

| 措施 | 位置 | 作用 |
|---|---|---|
| `disabledToolsets`（`cronjob` / `messaging`） | `gateway-cron-lifecycle.ts` + `agent-bridge.ts` | 禁用 cron 软递归与重复通知 |
| `CRON_FOUR_RULES` 注入 prompt | `cron-service.ts` | prompt 内声明：不要调 cron / send；回复文本即投递；`[SILENT]` 规则 |
| `[SILENT]` 标记 | `cron-service.ts` + `executor.ts` | agent 可静默跳过 delivery（仅 exit 0 时抑制） |
| 注入扫描（6 pattern） | `executor.ts` `scanCronPrompt` | 防 prompt injection |
| Circuit breaker（10 次/30s） | `agent-bridge.ts` | bridge 故障保护 |
| crash recovery（bounded backoff 重启） | `agent-bridge.ts` | 子进程崩溃自动恢复，返回"系统正在恢复中" fallback |

## 5. 投递

### 5.1 CronDeps — 依赖注入接口

CronService 通过此接口与 gateway 交互，不直接持有 AgentBridge、ChannelRegistry 等内部对象（`packages/gateway/src/scheduler/cron-service.ts`）：

```typescript
export interface CronDeps {
  /** 执行 agent prompt，返回结果文本 */
  executeAgent: (params: {
    agentDir: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 要排除的工具（默认 ['cronjob', 'messaging']） */
    disabledToolsets?: string[];
    model?: string;
    provider?: string;
  }) => Promise<{ output: string; error?: string }>;

  /** 投递结果到指定 channel（内部重试） */
  deliver: (params: {
    channel: string;
    accountId?: string;
    toUserId?: string;
    toConversationId?: string;
    text: string;
  }) => Promise<{ ok: boolean; error?: string }>;

  /** 日志接口 */
  log: { debug: (msg: string, ctx?: unknown) => void; info: ...; warn: ...; error: ... };
}
```

另有 `notifyFailure`（投递失败的失败卡片，独立于 deliver，best-effort 重试）与 `mirrorToSession`（成功投递后镜像到聊天 session，`attachToSession` 开启时；best-effort，失败仅 warn 不中断执行）。

### 5.2 delivery 配置

`ScheduledTask.delivery`（替代旧 `accountId` + `deliver` + `deliverUser` 的投递语义）：

```typescript
delivery?: {
  channel: string;            // "dingtalk"
  accountId?: string;         // 哪个 account 凭证
  toUserId?: string;          // DM 推送目标
  toConversationId?: string;  // group 推送目标
  mode: "announce" | "none";  // 是否投递
};
```

### 5.3 DingTalkChannel.sendMessage — 三条路由 + token cache

`packages/gateway/src/channels/dingtalk.ts`，统一投递路径（cron 不直接碰平台 API）：

```typescript
async sendMessage(msg: OutboundMessage): Promise<void> {
  // Route 1：sessionWebhook —— 交互式回复（命中即优先；业务错误过期时 fallthrough 到 2/3）
  // Route 2：accountId + toUserId —— OAuth DM 主动推送（cron delivery 主路径）
  // Route 3：accountId + toConversationId —— OAuth group 主动推送
  // 全路由失败 → throw "all routes exhausted" → CronService.notifyFailure
}

async #getOAuthToken(): Promise<string> {
  // #tokenCache：TTL = expireIn - 60s 保护带；fetch 失败清 cache 再抛
}
```

`OutboundMessage` 增加 `toUserId` 字段承载主动推送目标（`packages/gateway/src/types.ts`）。

## 6. Host-Tool 机制

### 6.1 三条 RPC 协议

```
CornField 启动 → 立刻发 `ready` 给 gateway
  → Gateway 收到 ready → 调 set_host_tools RPC（payload: [{name, description, parameters}, ...]）
  → CornField 把每个定义包装成 AgentTool 适配器，注册到自己的工具集

LLM 在 tool_use 里调 cron.add({...})
  → CornField 内部适配器拦截，写 frame 到 stdout:
     { type:"host_tool_call", id, toolCallId, toolName:"cron", arguments:{...} }
  → gateway transport 解析 frame → HostToolDispatcher.handleCall()
     → 按 name 查 handler → handler.handle(args)（读 SQLite / 写 JSON5 / 查 channel）
  → Gateway 写 frame: { type:"host_tool_result", id, result:{type:"tool_result", content:[...]} }
  → CornField RpcHostToolBridge.handleResult 找到 pending promise
  → LLM 看到 tool_result，继续推理
```

### 6.2 注册与分发

- **Dispatcher**：`packages/gateway/src/host-tool-dispatcher.ts` `HostToolDispatcher`——`name → handler` 字典 + outbound frame writer；构造时机 `Gateway.#buildHostToolDispatcher`，在 `AgentBridge` 构造前完成工具注册
- **注册生命周期**：`AgentBridge.#registerHostTools` 在每次 CornField `ready` 事件触发时执行（崩溃恢复后必须重发）；`set_host_tools` 命令由 `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 处理；CornField 侧 `RpcHostToolAdapter`（`packages/coding-agent/src/modes/rpc/host-tools.ts`）把定义包成 `AgentTool`，LLM 看到的就是普通工具
- **幂等**：dispatcher 持有 definitions 缓存，gateway 重启重建 dispatcher 时一次性写入

### 6.3 Host 侧 handler 可访问的资源

- `SchedulerDbStorage`（SQLite + 文件 store）
- `ChannelRegistry`（channel 路由）
- `AgentBridge.getActiveChatContext()`（D4 auto-infer）
- handler 在 gateway 进程内本地运行，与 LLM 进程隔离：handler 失败不影响 CornField 子进程

### 6.4 Delivery Auto-Inference (D4)

`cron.add` handler 在 LLM 省略 `delivery` 时读取活跃聊天上下文并自动填充。

- **上下文写入窗口**：`AgentBridge.forwardWithMeta` 入口 `#setActiveChatContext(msg)`，finally `#clearActiveChatContext()`；存活范围 = 单次 LLM 调用的整段执行
- **推断规则**（`scheduler/host-tool.ts` `resolveDeliveryForAdd`）：
  - DM：`{channel: msg.channelId, accountId: msg.accountId, toUserId: msg.userId}`
  - 群：`{channel: msg.channelId, accountId: msg.accountId, toConversationId: msg.conversationId}`
  - 推断失败（无活跃上下文 / channel 未注册）→ 显式 error 让 LLM 重新发起带 delivery 的调用
- **外部 chat 上下文缺失场景**：cron 触发自身再调用 LLM（嵌套）时 `getActiveChatContext()` 返回 `undefined`，handler 必须拒绝 auto-infer 并要求显式 delivery

### 6.5 cron.test-run（Tier 1，已 ship）

**当前模型（2026-08-20 起为 fire-and-forget）**：`handleTestRun` → `runTestRun` core（`packages/gateway/src/scheduler/test-run.ts`，CLI + LLM 共享，避免语义 drift）：

1. 快照 task 的 `cron` / `scheduleType` / `nextRunAt` / `status`
2. 改写为 one-shot `+<n>s`，写 restore marker（`awaitingFire` + `expiresAt`），`engineReload()`
3. **立即返回** `{kind: "started", inMs, expiresAt, startedAt}`——LLM 不被阻塞
4. 引擎在 ABSOLUTE `nextRunAt` 触发 one-shot，任务走正常流水线（warm bridge 或冷 fallback），结果以 AI Card 投递（与真实 tick 相同的卡片）
5. 引擎 post-fire 的 `#restoreTestRunSchedule` 读 marker 还原 snapshot 并重排原 cron；`expiresAt` 后未触发则孤儿恢复吞掉 marker

**为什么异步**：旧同步版在 `runExclusive` 里等 `inMs + timeoutMs`（默认 150s），agent-bridge watchdog 60s 无 session 事件会杀掉 LLM（"Agent bridge failed"）。立即返回保持 LLM 存活；verdict 由卡片送达用户，LLM 事后可用 `cron.runs <name>` 读执行历史。

**设计决策（拍板）**：

- **`inMs` 约束**：运行时调用方硬拒 `inMs < 60s`（1x gateway tick——引擎 reload 晚于 `nextRunAt` 就看不到 one-shot）；`inMs >= 120s`（2x tick）才安全；core 对 `inMs < tick` 报 WARNING、`< 2x tick` 报 NOTE
- **Schedule restore 不变量**：restore 由引擎 post-fire 保证（marker 驱动），孤儿恢复兜底；不再依赖 handler 侧 finally
- **Abort**：gateway 侧 `HostToolDispatcher.handle(args)` 当前不传 AbortSignal——LLM 取消时 CornField 丢结果帧，gateway 仍跑完（fire-and-forget 天然如此）
- **阻断语义**（B 方案）：投递卡片后向 LLM 起源 IM session 推一条 prompt，LLM 在下一轮看到结果，形成"发起 → 异步执行 → 回推"闭环

### 6.6 bridge.status（Tier 1，已 ship）

独立 host tool（`packages/gateway/src/bridge-status-tool.ts`，不在 `scheduler/` 下）。

- **只读诊断，无参数**：handler 调 `bridge.getSnapshot()`，返回原 snapshot（`pid` / `circuitOpenedAt` / `crashCount` 等细节）+ 派生的 `summary` 字段
- **`summary` 是预计算的一句话判断**：LLM 不用解读 state machine；每个 state 都有 actionable 措辞——`error` 升级给 operator、`degraded` 等待 cooldown、`busy` 不要重复 dispatch
- **description 明确禁止 speculative polling**：bridge 健康是常态，盲调浪费 tool round-trip；只有 LLM 有具体理由怀疑 bridge 有问题时才调

## 7. 数据结构

### 7.1 ScheduledTask（`packages/gateway/src/scheduler/types.ts`）

```typescript
export type TaskStatus = "active" | "paused" | "disabled";
export type ScheduleType = "cron" | "interval" | "once";
export type TaskType = "shell" | "agent";

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  cron: string;                 // 表达式；interval/once 时携带相对或绝对目标
  command: string;              // agent 任务的 prompt / shell 任务的命令
  status: TaskStatus;
  scheduleType?: ScheduleType;
  taskType?: TaskType;
  model?: string;               // agent 任务模型覆盖
  provider?: string;
  enabledToolsets?: string[];   // 工具白名单（省 token）
  repeatCount?: number;         // 运行次数上限，null = 不限制
  repeatCompleted?: number;
  timeoutMs?: number;
  retry?: RetryConfig;          // maxAttempts / backoffMs / retryOn
  preScript?: string;
  /** 上次输出注入（a+ 分层上下文） */
  injectLastOutput?: "always" | "on_failure" | "never";
  injectToolCalls?: number;     // 上次失败时注入最近 N 次工具调用
  injectFailureContext?: boolean; // 失败上下文注入总开关
  forceFail?: boolean;          // DEBUG-only：强制本跑记录为失败
  attachToSession?: boolean;    // 成功后镜像到聊天 session（continuable jobs）
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  failCount: number;
  /** Agent 执行目录（替代 accountId 的执行语义） */
  agentDir?: string;
  /** 投递配置（替代 deliver + deliverUser） */
  delivery?: {
    channel: string;
    accountId?: string;
    toUserId?: string;
    toConversationId?: string;
    mode: "announce" | "none";
  };
  lastDeliveryError?: string;
  /** audit：LLM host tool 创建者的 staffId（从活跃 chat context stamp） */
  createdByUserId?: string;
  createdByAccountId?: string;
}
```

执行路由（`agentDir`）与投递路由（`delivery`）拆为两个独立字段，消除旧 `accountId` 的双重语义；旧字段运行时兼容读取。

## 8. 结构化诊断（CronRunDiagnostics）

Gateway 的定时任务执行诊断从 raw text 升级为结构化数据（`packages/gateway/src/scheduler/diagnostics.ts`，沿用 OpenClaw 的 `CronRunDiagnostics` 模式）。

### 8.1 背景问题

1. **状态矛盾**：JSONL 记录 `exitCode=0`、`status=success`，但执行实际因超时而失败。调用方只能从 raw text 推断真相，无法可靠区分"真的成功"和"成功记录了一个失败"
2. **不可查询**：JSONL 是追加写入的平面文件，CLI 命令需逐文件 grep。没有分页、过滤、按严重度排序能力

### 8.2 诊断结构

```typescript
type CronRunDiagnosticSource =
  | "cron-preflight"    // 任务定义/配置校验
  | "cron-setup"        // 启动/预热/Operator 取消
  | "model-preflight"   // 模型/Provider 预检
  | "agent-run"         // Agent 执行异常/超时
  | "tool"              // 工具调用失败
  | "exec"              // Subprocess 执行失败
  | "delivery"          // 结果投递失败
  | "cron-debug";       // 调试用 override（如 forceFail）
type CronRunDiagnosticSeverity = "info" | "warn" | "error";

interface CronRunDiagnosticEntry {
  ts: number;
  source: CronRunDiagnosticSource;
  severity: CronRunDiagnosticSeverity;
  message: string;           // 自动脱敏，上限 1000 字符
  toolName?: string;         // 仅 source=tool 时
  exitCode?: number | null;  // 仅 source=exec 时
  truncated?: boolean;       // message 被截断时
}

interface CronRunDiagnostics {
  summary?: string;          // 最严重诊断摘要，上限 2000 字符
  entries: CronRunDiagnosticEntry[];  // 上限 10 条
}
```

### 8.3 诊断收集点

每个采集点产生一个或多个 entry；`CronService.onTrigger()` 在各失败/异常点调 `appendDiagnostic()`（内存累积），执行结束时一次性写入 JSONL（`appendExecutionLog`），保证无中间态丢失。

| 采集点 | source | severity | 时机 |
|---|---|---|---|
| 任务定义/配置校验失败 | cron-preflight | error | onTrigger 入口 |
| 启动/Operator 取消 | cron-setup | error | 起始/取消 |
| Provider 预检失败 | model-preflight | warn/error | executeAgent 前 |
| Agent 超时/报错 | agent-run | error | warm bridge 返回 error |
| 工具调用失败 | tool | error | tool 执行异常 |
| Subprocess 执行失败 | exec | error/warn | `executeScheduledCommand` 返回非零 |
| Wall-clock 达超时 | exec | error | timedOut=true |
| 投递失败 / 投递被抑制 | delivery | error / info | `deliver()` 返回 !ok / `[SILENT]` |
| 重新调度被跳过 | cron-preflight | info | grace window / 并发限制 |
| 调试强制失败 | cron-debug | info | forceFail 生效 |

### 8.4 JSONL 写入策略

保持 JSONL 追加写入，内容从 raw text 改为 `{ diagnostic: CronRunDiagnostics }` 包裹的结构化 entry。每条 entry 同时保留 `exitCode`/`status` 等遗留字段以兼容消费者，但诊断决策以 `diagnostics` 字段为准：

```json
{
  "id": "exec_xxx",
  "ts": 1783023402539,
  "exitCode": 0,
  "status": "success",
  "durationMs": 1715732,
  "diagnostics": {
    "summary": "Agent RPC inactive for 971734ms, subprocess also timed out",
    "entries": [
      { "ts": 1783023400000, "source": "agent-run", "severity": "error",
        "message": "Agent RPC inactive for 971734ms (no session event for 60000ms, hard cap 300000ms)" },
      { "ts": 1783023402000, "source": "exec", "severity": "error",
        "message": "Subprocess timed out after 300000ms", "exitCode": 124 }
    ]
  }
}
```

辅助函数（防不可信输入）：

- `normalizeCronRunDiagnostics`：校验并约束未信任载荷（source/severity 白名单、时间戳、长度截断；超 10 条留最新——晚期失败比 setup 噪声更能解释最终结果）
- `summarizeCronRunDiagnostics`：取最严重 message 作为 operator 摘要
- `mergeCronRunDiagnostics`：多组诊断合并，偏好最高严重度、最近 summary
- `createDiagnosticFromError`：单个 entry 诊断

### 8.5 边界（本次不做）

只改诊断系统，不涉及：CLI 命令（`cron status`）、HTTP 端点（`/health/cron`）、钉钉查询接口、SQLite 替代 JSONL（存储迁移见 §10）。

## 9. 失败模式

执行层与投递层的失败路径（多数已在 §8 诊断收集点覆盖，这里列执行语义）：

| 失败 | 行为 |
|---|---|
| warm bridge 不存在（agentDir 无对应 bridge） | 返回 error，engine 统计 + 按 RetryConfig 重试 |
| queue 等待超时（> 5s） | warm-bridge 调用抛错 → 冷 `cornfield --print` fallback，任务仍跑 |
| inactivity watchdog（子进程 60s 无 session 事件） | warm-bridge 调用拒绝 → 冷 fallback |
| circuit open（10 次/30s） | `executePrompt` 抛 "circuit is open"，走 fallback / 记录失败 |
| 子进程 crash | crash recovery（bounded backoff 重启），cron 转冷 fallback |
| model 切换失败 | warn 后继续当前 model（不中断任务） |
| sessionPath drift（N2） | 告警；强制路径与子进程实际 sessionFile 不一致时记录 |
| delivery 全路由失败（webhook 过期且无 OAuth 路由） | throw → 失败卡片（notifyFailure，独立于 deliver，内部重试） |
| 执行超时 | 无 wall-clock 硬上限；仅 inactivity watchdog 触发（超时=持续无输出） |
| `[SILENT]` 出现在非零 exit | 不抑制投递（可能是 malformed 响应，用户应看到） |
| test-run marker 孤儿（引擎未在 expiresAt 前触发） | 孤儿恢复吞掉 marker，任务保持 rewrite 前状态的前提下告警 |

## 10. 后续工作（本次不做）

- **cron `run` action 经 LLM**：当前占位返回错误，需 CLI `cornfield-gateway cron run <name>`；落地时复用 `runMode: "due" | "force"` 语义
- **cancel wire 帧**：`RpcHostToolCancelRequest` → `HostToolDispatcher.handle` 的取消传播是 cleanup 工作
- **test-run 并发**：同 task 并发 test-run 会互相覆盖 schedule rewrite；需要时加 advisory lock
- **诊断升级**：SQLite 存储、`cron status` CLI、`/health/cron` HTTP 端点
- **Tier 2/3 host tools**：`agent.delegate`（跨 account 编排）、`session.show/list/search`、`channel.search_contact`（dws skill 已有等价能力）；`channel.send_message` 已实现（`packages/gateway/src/host-tools/dingtalk-send-message-tool.ts`）
- **故意不声明为 host tool**（gateway 内部 / operator 路径）：PID 文件 / daemon 控制 / 状态文件、circuit breaker 重置、bridge restart / 杀 CornField 子进程、action registry（card 点击 handler）、启动时连接 / 重连 DingTalk

## 11. 参考

### 关键文件

| 文件 | 角色 |
|---|---|
| `packages/gateway/src/scheduler/host-tool.ts` | `cron` host tool 定义与 handler（createCronToolDefinitions / handleCronAction / resolveDeliveryForAdd） |
| `packages/gateway/src/scheduler/engine.ts` | SchedulerEngine：cron/interval/once 三种调度 + at-most-once / grace / 并发上限 |
| `packages/gateway/src/scheduler/cron-service.ts` | CronService 编排 + CRON_FOUR_RULES + 诊断收集 |
| `packages/gateway/src/scheduler/test-run.ts` | `runTestRun` core（CLI + LLM 共享；snapshot / one-shot rewrite / marker / 恢复） |
| `packages/gateway/src/scheduler/test-run-marker.ts` | test-run restore marker 读写 |
| `packages/gateway/src/scheduler/diagnostics.ts` | CronRunDiagnostics 类型 + normalize / summarize / merge / createDiagnosticFromError |
| `packages/gateway/src/scheduler/execution-log.ts` | JSONL 执行日志（诊断 entry 落盘） |
| `packages/gateway/src/scheduler/executor.ts` | `executeScheduledCommand` / `scanCronPrompt` 注入扫描 / `SILENT_MARKER` |
| `packages/gateway/src/scheduler/types.ts` | ScheduledTask / SchedulerStorage 类型 |
| `packages/gateway/src/scheduler/from-message.ts` | slash 命令解析与双写 |
| `packages/gateway/src/scheduler/cli-commands.ts` | `cron …` CLI（cronTestRun / cronRun / 执行记录查询） |
| `packages/gateway/src/host-tool-dispatcher.ts` | `HostToolDispatcher` |
| `packages/gateway/src/bridge-status-tool.ts` | `bridge.status` host tool |
| `packages/gateway/src/agent-bridge.ts` | `#registerHostTools` / `#setActiveChatContext` / `executePrompt` / circuit breaker / crash recovery |
| `packages/gateway/src/gateway.ts` | `start()` / `#buildHostToolDispatcher` |
| `packages/gateway/src/gateway-cron-lifecycle.ts` | scheduler 启动、`#executeCronAgent`、投递与镜像 |
| `packages/gateway/src/gateway-message.ts` | `handleInboundMessage` / `#tryCreateCronFromMessage` |
| `packages/gateway/src/session-paths.ts` | `cronSessionPath(agentDir)` |
| `packages/gateway/src/channels/dingtalk.ts` | sendMessage 三路由 + token cache |
| `packages/gateway/src/commands/gateway.ts` | CLI 分发（`case "test-run"` 等） |
| `packages/coding-agent/src/modes/rpc/host-tools.ts` | CornField 侧 `RpcHostToolAdapter` |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | `set_host_tools` 命令处理 |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | RpcHostToolDefinition 类型 |
| `packages/coding-agent/src/skeleton/assets/TOOLS.md` | 新 agentDir 默认 TOOLS.md（含 cron 章节占位） |

### 协议契约

| Frame / Command | 方向 | 角色 |
|---|---|---|
| `set_host_tools` | gateway → CornField | 注册 host tool 定义（每次 ready 重发） |
| `host_tool_call` | CornField → gateway | LLM 调用 host tool |
| `host_tool_result` | gateway → CornField | handler 返回结果 |
| `RpcHostToolCancelRequest` | CornField → gateway | 取消 in-flight 调用 |

### 持久化布局

```
~/.cornfield/
  agent/                          # 通用 agent 状态
    config.yml
    sessions/by-date/<date>/<id>.jsonl
  agents/<accountId>/             # 每账号 agentDir
    cron/tasks/<name>.json5       # slash 命令创建时的副本
    sessions/                     # cron session 文件（独立于 IM session）
  gateway-data/
    scheduler.db                  # 任务真相源 (SQLite)
    scheduler/tasks/*.json5       # file store（SchedulerFileStore.syncToDb）
    scheduler/logs/               # 执行 JSONL（含 diagnostics entry）
    sessions.db                   # IM session 记录
```

注意：slash 路径双写到 `agents/<accountId>/cron/tasks/<name>.json5`（per-agent），与 `SchedulerFileStore` 的 `gateway-data/scheduler/tasks/` 是两条独立路径；当前实现走显式 DB addTask，不是 file-store 的 syncToDb 路径。

### 参考实现

参考 OpenClaw 的 `cron-tool.ts` / `CronRunDiagnostics` 与 Hermes 的 cron scheduler；本设计在 scope 隔离（CornField-per-account 天然进程级隔离，无需 per-user 过滤）与执行模型（warm bridge + cold fallback，非网关进程内新 session）上与之不同。