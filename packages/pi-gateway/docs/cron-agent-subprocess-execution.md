# Cron 设计文档

| 项 | 说明 |
|---|---|
| 文档版本 | V2.0 |
| 状态 | 待审批 |
| 适用包 | `packages/pi-gateway` (CronLifecycle, AgentBridge) + `packages/coding-agent` (RPC mode) |
| 参考实现 | Hermes Agent (线程池 + 新 AIAgent)、OpenClaw (事件循环 + 新 AgentSession) |

---

## 目录

1. [当前架构与问题](#1-当前架构与问题)
2. [设计方案](#2-设计方案)
3. [接口设计](#3-接口设计)
4. [架构对比](#4-架构对比)
5. [`list_scheduled_tasks` 工具](#5-list_scheduled_tasks-工具)
6. [风险评估](#6-风险评估)
7. [实施计划](#7-实施计划)
8. [参考](#8-参考)

---

## 1. 当前架构与问题

### 1.1 当前调用链

```
Gateway 进程
├─ AgentBridge(s) (omp --mode rpc 子进程)
│    └─ PromptQueue → RpcTransport → omp 子进程
│        每个 DingTalk 账号一个独立 bridge
│
└─ CronLifecycle
     ├─ SchedulerStorage (JsonFileStorage, 读写 jobs.json)
     ├─ SchedulerFileStore (磁盘 task 文件 ↔ storage 同步)
     ├─ CronService (编排层)
     │    ├─ onTrigger()  — tick 回调
     │    ├─ executeAgent  — 注入函数, 由 CronLifecycle.#executeCronAgent() 实现
     │    ├─ deliver       — 注入函数, 由 CronLifecycle.#deliverCronResult() 实现
     │    ├─ notifyFailure — 注入函数, 发送失败卡片（独立于 deliver）
     │    └─ mirrorToSession — 注入函数, 投递成功后镜像到聊天 session
     │
     └─ SchedulerEngine (croner 定时调度引擎)
          ├─ start() — 为每个 active 任务注册 croner/setInterval/setTimeout
          ├─ reload() — 每 tick 同步内存 task 表与 storage
          └─ #handleTrigger() — 触发执行入口
```

**当前执行路径**（5 层调用链）：

```
tick 到来 (croner 触发 / setInterval 触发)
  │
  ▼
SchedulerEngine.#handleTrigger(taskId)      ← 并发检查 + grace window + 重试循环
  │
  ▼
CronService.onTrigger(task)                  ← 上下文构建 + 执行编排 + 投递
  │
  ▼
CronLifecycle.#executeCronAgent(params)      ← getBridgeByAgentDir + 副作用操作
  │
  ▼
AgentBridge.executePrompt(prompt)            ← PromptQueue.runExclusive()   ← 阻塞点
  │
  ▼
omp --mode rpc 子进程 (同一个 session)
```

### 1.2 当前架构的耦合问题（新方案目标：全部消除）

| # | 耦合点 | 位置 | 新方案的解法 |
|---|---|---|---|
| C1 | cron 投递绕过 Channel 接口，直接调 DingTalk OAuth/webhook API | `gateway.ts` `sendToChannel` / `sendViaOAuth` / `sendViaWebhook` | delivery 走 `DingTalkChannel.sendMessage`（§3.4）|
| C2 | `Gateway.#onCronTrigger` 上帝回调，执行+投递全塞一个函数 | `gateway.ts` | 拆为 `executeAgent`（RPC）+ `deliver`（Channel），各自独立（§2.8）|
| C3 | `getAccountBridge` 泄漏 AgentBridge 实例给 cron handler | `gateway.ts` | cron 不再直接接触 bridge，只通过 `bridge.runCronTask()`（§2.6）|
| C4 | `ScheduledTask.accountId` 同时承载执行路由和投递路由双重语义 | `scheduler/types.ts` | 拆为 `agentDir`（执行）+ `delivery`（投递）（§3.2）|
| C5 | cron 不能脱离 gateway 运行 | 架构级 | 不解决——不需要独立部署 |
| C6 | warm bridge 路径的副作用操作（setDisabledToolsets/setModel/restore）与执行逻辑混在一起 | `gateway.ts` `#onCronTrigger` | 新 session 从根源消除副作用（§2.7）|
| C7 | cronRun CLI 命令动态 import gateway.ts 形成循环依赖 | `cli-commands.ts` → `gateway.ts` → `scheduler` | 投递走 CronService.deliver，不再 import gateway（§2.9）|
| C8 | file-store.ts syncToDb 漏写 accountId（现有 bug） | `file-store.ts` | 一并修复（D13）|

### 1.3 当前安全措施（保留不变）

| 措施 | 位置 | 作用 |
|---|---|---|
| `disabledToolsets` | cron-lifecycle.ts + agent-bridge.ts | 禁用 cronjob/messaging 软递归 |
| 4 条规则注入 prompt | cron-service.ts `CRON_FOUR_RULES` | prompt 内声明：不要调 cron/send |
| `[SILENT]` 标记 | cron-service.ts + executor.ts | agent 可静默跳过 delivery |
| at-most-once | engine.ts: 执行前推进 nextRunAt | 崩溃后不会重放 |
| 并发上限 (默认 3) | engine.ts #handleTrigger | 防止 interval 堆积 |
| Grace window | engine.ts: 超期跳过 | 重启后不追积压 |
| 注入扫描 (6 pattern) | executor.ts scanCronPrompt | 防 prompt injection |
| Circuit breaker (10 次/30s) | agent-bridge.ts | bridge 故障保护 |
| 重试 + 指数退避 | engine.ts: 重试循环 | 临时故障自愈 |

### 1.4 核心问题

`CronLifecycle.#executeCronAgent()` 通过 warm bridge 执行，与 IM 共享同一子进程的 `PromptQueue`：

```
CronLifecycle.#executeCronAgent()
  └─ bridge.executePrompt()
       └─ PromptQueue.runExclusive()  ← IM 消息排队等 cron 跑完
```

`runExclusive()` 锁死整个 bridge。cron 执行期间（LLM API 调用 + tool 执行，通常 10-60s），该 account 的 IM 用户看不到任何响应。

---

## 2. 设计方案

### 2.1 核心思路

Gateway 负责调度（ticker），当定时任务到点时，通过 RPC 命令通知对应 account 的 `omp --mode rpc` 子进程。子进程在自己的进程空间内新建一个 `createAgentSession()`（独立 session 文件），与正在处理的 IM 消息在同一事件循环上交错执行，互不阻塞。

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Gateway 进程                                │
│                                                                      │
│  CronLifecycle                                                       │
│    ├─ SchedulerEngine (croner 定时器)                                 │
│    ├─ SchedulerStorage (jobs.json)                                   │
│    └─ tick → "定时任务到点"                                           │
│         │                                                            │
│         │ sendCommand("run_cron_task", {prompt, taskId, ...})        │
│         ▼                                                            │
│  AgentBridge ──→ RpcTransport ──→ spawn                              │
└─────────────────────┬────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│               omp --mode rpc  子进程 (一个 account 一个)               │
│                                                                      │
│  ┌─ RPC 命令循环 (常驻)                                               │
│  │                                                                   │
│  │  ├─ 用户消息 → IM session (常驻, 现有逻辑)                         │
│  │  │             事件循环上 await 交错                                │
│  │  │                                                                 │
│  │  └─ run_cron_task 命令 → 进程内 createAgentSession()              │
│  │                   ├─ cron session (独立文件, <agentDir>/sessions/) │
│  │                   ├─ tool 循环                                     │
│  │                   ├─ 结果回 gateway → deliver                      │
│  │                   └─ session.close()                              │
│  │                                                                   │
│  └─ 事件循环 (IM + cron + RPC 命令, 全异步交错)                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | cron 调度保留在 gateway 进程内 | 单机单实例，gateway 统一管理所有 account 的定时器 |
| D2 | cron 执行通过 `run_cron_task` RPC 命令下放到 agent 子进程 | 避免阻塞 IM 消息；保持子进程隔离优势 |
| D3 | cron session 使用独立 session 文件 | 不污染 IM 聊天历史，不自建 RPC session 切换/恢复 |
| D4 | agentDir 路径作为 agent 标识，不引入 agentId/registry | 与 OpenClaw 一致（agentId=目录名），单机场景下文件系统保证唯一 |
| D5 | `accountId` 拆成 `agentDir`（执行）+ `delivery`（投递）两个独立字段 | 消除双重语义，执行路由和投递路由分离 |
| D6 | 投递复用 gateway 的 DingTalk account 凭证，走 ChannelRegistry | gateway 持有业务 token 是合理设计 |
| D7 | 投递走 Channel 接口（OpenClaw 模式），不区分回复/推送 | channel 实现自己决定送达方式，cron 不碰平台 API |
| D8 | cron 代码保留在 `packages/pi-gateway/src/scheduler/`，不独立成包 | 不独立部署 = 不需要独立包 |
| D9 | `list_scheduled_tasks` 通过 `createAgentSession.customTools` 注入 | cron session 原生可查，不依赖 RPC session 切换 |
| D10 | DingTalkChannel.sendMessage 支持三条路由：sessionWebhook（回复）、toUserId（DM 推送）、conversationId（group 推送）| 统一投递路径 |
| D11 | deliver 重试逻辑归属 CronService 的 deliver 实现 | sendMessage 保持单次调用语义 |
| D12 | DingTalkChannel 实例内部加 token cache | 当前无缓存每次重新 fetch token（TTL 7200s），高频 cron 任务浪费大量 API 调用 |
| D13 | file-store.ts syncToDb 的 accountId 漏写 bug 一并修复 | 解耦后 agentDir 会继承同样 bug，必须同批修 |

### 2.3 已排除方案

| 方案 | 排除理由 |
|---|---|
| 纯 gateway 进程内 `createAgentSession()` | cron 崩溃会炸 gateway 进程；放弃 OMP 已有的子进程隔离优势 |
| 专用的常驻 cron RPC 子进程 | 一个 cron 任务每天跑几次，常驻 60MB 子进程浪费 |
| cron 冷子进程 `omp --print` | 每次 spawn ~2-3s，无 tool loop，无 session 持久化，功能降级 |
| OpenClaw 模型（gateway 进程内 AgentSession） | 无进程隔离，gateway 炸了 cron 一起炸，放弃 OMP 已有的分层优势 |
| 解耦旧方案（warm bridge 保留为主路径） | 仍阻塞 IM；setDisabledToolsets/setModel/restore 副作用操作无法消除 |

### 2.4 改动点总览

| 层 | 改动 |
|---|---|
| **RPC 协议** | 新增命令 `run_cron_task` + `get_scheduled_tasks` |
| **AgentBridge** | 新增 `runCronTask()`，不走 `PromptQueue.runExclusive()` |
| **CronLifecycle** | `#executeCronAgent()` 改为通过 `bridge.runCronTask()` |
| **RPC mode** | 新增 `handleRunCronTask` handler：`createAgentSession()` → `processPrompt()` → close |
| **Channel** | DingTalkChannel.sendMessage 支持三条路由 + `#tokenCache` |
| **Types** | ScheduledTask `agentDir` + `delivery` 拆分；OutboundMessage 加 `toUserId` |

### 2.5 CronLifecycle 改动

**当前：**

```typescript
async #executeCronAgent(params) {
  const bridge = this.#getBridgeByAgentDir(params.agentDir);
  // setDisabledToolsets, setModel, save/restore ...
  return await bridge.executePrompt(params.prompt, {
    timeoutMs: params.timeoutMs,
    sessionPath: cronSessionPath,
    inactivityMs: computeInactivityBudgetMs(params.timeoutMs),
  });
}
```

**新：**

```typescript
async #executeCronAgent(params) {
  const bridge = this.#getBridgeByAgentDir(params.agentDir);
  // 网关层不操作 bridge 状态，全下放到子进程
  return await bridge.runCronTask({
    prompt: params.prompt,
    taskId: params.taskId,
    agentDir: params.agentDir,
    timeoutMs: params.timeoutMs,
    model: params.model,
    provider: params.provider,
    disabledToolsets: params.disabledToolsets,
  });
}
```

### 2.6 AgentBridge 改动

```typescript
async runCronTask(params: {
  prompt: string;
  taskId: string;
  agentDir: string;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  disabledToolsets?: string[];
}): Promise<{ output: string; error?: string }> {
  // 不走 PromptQueue.runExclusive()，直接发 RPC 命令
  return await this.#transport.sendCommand("run_cron_task", params, params.timeoutMs ?? 120_000);
}
```

### 2.7 RPC mode 改动

```typescript
// packages/coding-agent/src/modes/rpc/rpc-mode.ts

async handleRunCronTask(params: {
  prompt: string;
  taskId: string;
  agentDir: string;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  disabledToolsets?: string[];
}): Promise<{ output: string; error?: string }> {
  const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");

  const { session } = await createAgentSession({
    agentDir: params.agentDir,
    hasUI: false,
    enableLsp: false,
    enableMCP: false,
    skipPythonPreflight: true,
    model: params.model ? { provider: params.provider, id: params.model } : undefined,
    customTools: [listScheduledTasksTool],
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), params.timeoutMs ?? 120_000);

  try {
    const result = await session.processPrompt(params.prompt, {
      signal: abortController.signal,
    });
    return { output: result.text };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
    await session.close();
  }
}
```

### 2.8 数据流（完整路径）

```
SchedulerEngine tick
  → CronService.onTrigger(task)
    → deps.executeAgent({
        agentDir: task.agentDir,
        prompt: task.command,
        disabledToolsets: ['cronjob', 'messaging'],
        model: task.model,
        provider: task.provider,
        timeoutMs: task.timeoutMs,
      })
      → CronLifecycle 实现：
        → getBridgeByAgentDir(agentDir)
        → bridge.runCronTask({ prompt, taskId, agentDir, timeoutMs, model, provider, disabledToolsets })
          → RPC: sendCommand("run_cron_task", ...)
            → omp 子进程 handleRunCronTask
              → createAgentSession({ agentDir, hasUI: false, ... })  ← 独立 session
              → session.processPrompt(prompt)
              → session.close()
              → 返回 { output }
      → 结果 string

    → deps.deliver({
        channel: task.delivery.channel,
        accountId: task.delivery.accountId,
        toUserId: task.delivery.toUserId,
        toConversationId: task.delivery.toConversationId,
        text: summary,
      })
      → CronLifecycle 实现：
        → registry.sendMessage(msg)
        → DingTalkChannel.sendMessage
          → sessionWebhook (回复模式)
          → toUserId (OAuth DM 推送)
          → conversationId (OAuth group 推送)

    → CronService 记录执行状态
```

### 2.9 删除

| 函数/逻辑 | 原因 |
|---|---|
| `gateway.ts: sendToChannel()` | 投递走 ChannelRegistry |
| `gateway.ts: sendViaOAuth()` | 逻辑搬进 DingTalkChannel |
| `gateway.ts: sendViaWebhook()` | 逻辑搬进 DingTalkChannel |
| `gateway.ts: deliverWithRetry()` | 重试逻辑搬进 CronService 的 deliver 实现 |
| `gateway.ts: getAccountBridge()` 泄漏给 cron | cron 不再直接接触 AgentBridge |
| `cli-commands.ts: cronRun()` 中的 `await import('../gateway')` | 消除循环依赖，投递走 CronService.deliver |
| `#executeCronAgent` 中的 setDisabledToolsets/setModel/restore | 新 session 从根源消除副作用 |

---

## 3. 接口设计

### 3.1 CronDeps — 依赖注入接口

CronService 通过此接口与 gateway 交互，不直接持有 AgentBridge、ChannelRegistry 等内部对象：

```typescript
// packages/pi-gateway/src/scheduler/cron-service.ts

export interface CronDeps {
  /** 执行 agent prompt，返回结果文本 */
  executeAgent: (params: {
    agentDir: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    disabledToolsets?: string[];
    model?: string;
    provider?: string;
  }) => Promise<{ output: string; error?: string }>;

  /** 投递结果到指定 channel */
  deliver: (params: {
    channel: string;
    accountId?: string;
    toUserId?: string;
    toConversationId?: string;
    text: string;
  }) => Promise<{ ok: boolean; error?: string }>;

  /** 日志接口 */
  log: {
    debug: (msg: string, ctx?: unknown) => void;
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}
```

### 3.2 ScheduledTask — 拆分 agentDir + delivery

```typescript
// packages/pi-gateway/src/scheduler/types.ts

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  command: string;
  type: "shell" | "agent";
  // ... 其他原有字段不变

  /** agent 执行目录（替代原 accountId 的执行语义） */
  agentDir?: string;

  /** 投递配置（替代原 accountId + deliver + deliverUser 的投递语义） */
  delivery?: {
    channel: string;              // "dingtalk"
    accountId?: string;           // 哪个 account 凭证
    toUserId?: string;            // DM 推送目标
    toConversationId?: string;    // group 推送目标
    mode: "announce" | "none";    // 是否投递
  };

  /** @deprecated 用 agentDir 替代 */
  accountId?: string;
  /** @deprecated 用 delivery.channel 替代 */
  deliver?: string;
  /** @deprecated 用 delivery.toUserId 替代 */
  deliverUser?: string;
}
```

### 3.3 OutboundMessage — 新增 toUserId

```typescript
// packages/pi-gateway/src/types.ts

export interface OutboundMessage {
  channelId: string;
  conversationId: string;
  content: MessageContent;
  replyTo?: string;
  mentions?: string[];
  messageId?: string;
  sessionWebhook?: string;
  accountId?: string;
  /** 主动推送目标用户 ID（无 sessionWebhook 时用于 OAuth DM 发送） */
  toUserId?: string;
}
```

### 3.4 DingTalkChannel.sendMessage — 三条路由

```typescript
// packages/pi-gateway/src/channels/dingtalk.ts

#tokenCache: { token: string; expiresAt: number } | null = null;

async sendMessage(msg: OutboundMessage): Promise<void> {
  if (msg.sessionWebhook) {
    // 路由 1：交互式回复（不变）
    await this.#sendViaWebhook(msg.sessionWebhook, msg.content);
  } else if (msg.accountId && msg.toUserId) {
    // 路由 2：cron DM 主动推送（从 gateway.ts sendViaOAuth 迁移）
    const token = await this.#getOAuthToken();
    await this.#sendViaOAuthDM(token, msg.toUserId, msg.content);
  } else if (msg.accountId && msg.conversationId) {
    // 路由 3：cron group 主动推送（从 gateway.ts sendViaOAuth 迁移）
    const token = await this.#getOAuthToken();
    await this.#sendViaOAuthGroup(token, msg.conversationId, msg.content);
  } else {
    throw new Error("No delivery route");
  }
}

async #getOAuthToken(): Promise<string> {
  const now = Date.now();
  if (this.#tokenCache && this.#tokenCache.expiresAt > now) {
    return this.#tokenCache.token;
  }
  const { accessToken, expireIn } = await fetchDingTalkToken(
    this.#config.appKey, this.#config.appSecret
  );
  this.#tokenCache = {
    token: accessToken,
    expiresAt: now + (expireIn - 60) * 1000,  // TTL - 60s 保护带
  };
  return accessToken;
}
```

---

## 4. 架构对比

### 4.1 执行位置

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      Execution Location                                         │
├──────────────────┬──────────────────┬────────────────────┬────────────────────────────────────┤
│     Hermes       │     OpenClaw     │   当前 OMP         │          你的新方案                   │
├──────────────────┼──────────────────┼────────────────────┼────────────────────────────────────┤
│  Gateway 进程    │  Gateway 进程    │  Gateway 进程      │  Gateway 进程                       │
│                  │                  │                    │                                    │
│  ticker          │  ticker          │  CronLifecycle     │  CronLifecycle                     │
│  (后台线程)       │  (事件循环)       │  │                 │  │                                  │
│   │              │   │              │  ▼                 │  │ sendCommand("run_cron_task")    │
│   ├─ tick        │   ├─ tick        │  AgentBridge       │  ▼                                  │
│   │  └─ pool     │   │  └─ await    │  │                 │  ┌─ omp --mode rpc (子进程) ────┐   │
│   │  .submit()   │   │  .run()      │  ├─ PromptQueue    │  │                              │   │
│   │              │   │              │  │  .runExclusive() │  │  IM session (常驻, 用户消息)  │   │
│   └─ AIAgent(c)  │   └─ AgentSsn(c) │  ▼                 │  │                              │   │
│   ┌─ AIAgent(i)  │   ┌─ AgentSsn(i) │  omp --mode rpc   │  │  new createAgentSession()     │   │
│                  │                  │  (子进程, 共享)     │  │  → cron session (独立文件)    │   │
│  同一进程         │  同一进程         │  │  IM session     │  │  → run → deliver → close     │   │
│  不同实例         │  不同 session    │  │  cron session   │  │                              │   │
│  ThreadPool      │   事件循环交错    │  │  (同一 session   │  │  同一子进程                    │   │
│  真并行           │   不阻塞         │  │   runExclusive) │  │  不同 session                 │   │
│                  │                  │  │                 │  │  事件循环交错，不阻塞            │   │
└──────────────────┴──────────────────┴────────────────────┴────────────────────────────────────┘
```

### 4.2 全面对比

| | Hermes | OpenClaw | 当前 OMP | 你的新方案 |
|---|---|---|---|---|
| **cron 执行位置** | Gateway 进程 | Gateway 进程 | `omp --mode rpc` 子进程 (IM warm bridge) | `omp --mode rpc` 子进程 (IM warm bridge) |
| **cron 进程模型** | 新 `AIAgent()` 在线程池 | 新 `AgentSession` 在事件循环 | `bridge.executePrompt()` → `runExclusive()` 序列化到 IM session | 新 `createAgentSession()` 并行，独立 session 文件 |
| **cron 和 IM 进程关系** | 同一进程 | 同一进程 | 同一子进程 | 同一子进程 |
| **cron 和 IM 执行关系** | 真并行（线程池） | 交错（事件循环） | 序列化（runExclusive） | 交错（事件循环） |
| **IM 是否阻塞** | ❌ 不阻塞 | ❌ 不阻塞 | ✅ **阻塞** | ❌ 不阻塞 |
| **子进程隔离** | ❌ 无（gateway 内） | ❌ 无（gateway 内） | ✅ gateway ↔ 子进程 | ✅ gateway ↔ 子进程 |
| **cron 炸了 IM 也炸？** | ✅ 同进程 | ✅ 同进程 | ✅ 同一子进程 | ✅ 同一子进程 |
| **gateway 会炸吗** | ✅ cron 崩 = gateway 崩 | ✅ cron 崩 = gateway 崩 | ❌ 子进程崩 ≠ gateway 崩 | ❌ 子进程崩 ≠ gateway 崩 |
| **冷启动成本** | ~0 | ~0 | 0（warm bridge） | ~50-200ms (createAgentSession) |
| **常驻内存** | AIAgent 常驻 | AgentSession 常驻 | RPC 子进程 ~60MB | 同左，cron session 临时 |
| **settings 一致性** | gateway 内统一 | gateway 内统一 | 子进程内一致 ✅ | 子进程内一致 ✅ |
| **agent 知道自己的任务** | ❌ | ❌ | ❌ | 通过 `list_scheduled_tasks` 工具 ✅ |
| **架构改动量** | build-in | build-in | 小（改 1 个文件） | 中（加 RPC 命令 + 改 #executeCronAgent） |

### 4.3 关键差异总结

| 维度 | Hermes | OpenClaw | 你的新方案 |
|---|---|---|---|
| cron 和 IM 的进程关系 | 同一进程 | 同一进程 | 同一子进程 |
| cron 和 IM 的执行关系 | 真并行（线程池） | 交错（事件循环） | 交错（事件循环） |
| IM 是否阻塞 | 不阻塞 | 不阻塞 | 不阻塞 |
| gateway 隔离性 | 无 | 无 | 有（gateway ← 子进程） |
| cron 和 IM 之间隔离 | 无 | 无 | 无（同一子进程） |

---

## 5. `list_scheduled_tasks` 工具

### 5.1 设计

| 维度 | 方案 |
|---|---|
| 注入方式 | `createAgentSession` 的 `customTools` 参数 |
| 数据源 | `CronLifecycle.schedulerStorage` |
| 通信 | RPC 命令 `get_scheduled_tasks` → gateway 返回 |
| 可见范围 | cron session 和 IM session 均可调用 |
| 返回格式 | 任务列表 + 最近执行记录 |

### 5.2 工具签名

```typescript
const listScheduledTasksTool = {
  name: "list_scheduled_tasks",
  label: "查看定时任务",
  description: "查看当前 agent 配置的所有定时任务及其执行状态、最近结果",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: async () => {
    const result = await rpcTransport.sendCommand("get_scheduled_tasks", {
      agentDir: currentAgentDir,
    }, 10_000);
    return {
      content: [{
        type: "text",
        text: formatTaskList(result.tasks),
      }],
    };
  },
};
```

### 5.3 返回示例

```json
{
  "tasks": [
    {
      "id": "daily-2000-calendar-push",
      "name": "每日日程推送",
      "cron": "0 20 * * *",
      "lastRun": "2026-07-06T20:00:00+08:00",
      "lastStatus": "success",
      "lastOutput": "已推送今日日程：1 个会议，2 个待办",
      "nextRun": "2026-07-07T20:00:00+08:00",
      "consecutiveFailures": 0
    }
  ]
}
```

---

## 6. 风险评估

### 6.1 风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| cron session 在子进程内占用 event loop | 低 | IM 响应变慢 | cron 不频繁；API 调用是 I/O 等待。和 OpenClaw 单进程多 session 等价 |
| 两个 session 同时调 native addon (Rust N-API) | 极低 | native addon 非线程安全 → crash | cron 一般不用敏感 addon；已考虑 |
| `createAgentSession()` 冷启动 50-200ms | 中 | 任务触发到开始有延迟 | cron 用时 10-60s，200ms 无感 |
| RPC 命令积累 | 低 | 事件循环积压 | maxConcurrentRuns=3 + 运行中跳过 |
| IM session 查不到自己的任务 | 中 | 不对称 | 走同一条 RPC 路径即可 |

### 6.2 安全边界

| 边界 | 机制 |
|---|---|
| cron session 不继承 IM 历史 | 独立 session 文件，不 `switch_session` |
| cron 不污染 memory/skills | `enableLsp: false`, `enableMCP: false` |
| cron 不软递归调自己 | `disabledToolsets: ["cronjob", "messaging"]` + prompt 规则 |
| cron 超时兜底 | `AbortController` + `setTimeout` |

### 6.3 实施风险

| 风险 | 严重 | 应对 |
|---|---|---|
| 已有 task 的 `accountId` 数据迁移遗漏 | 中 | 启动时自动迁移，`toTask` 运行时兼容读取 |
| OAuth token 缓存过期 | 低 | TTL = expireIn - 60s 保护带 |
| group 推送路径遗漏 | 高 | DingTalkChannel.sendMessage 三条路由全部覆盖 |
| file-store syncToDb bug | 中 | 一并修复，agentDir + delivery 完整同步 |

---

## 7. 实施计划

### 7.1 阶段一：RPC 协议 + 子进程内 createAgentSession

| 步骤 | 文件 | 改动 |
|---|---|---|
| 1 | `packages/pi-gateway/src/agent-transport.ts` | 定义 `run_cron_task` RPC 命令类型和响应格式 |
| 2 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 新增 `handleRunCronTask` handler |
| 3 | `packages/pi-gateway/src/agent-bridge.ts` | 新增 `runCronTask()` 方法 |
| 4 | `packages/pi-gateway/src/gateway-cron-lifecycle.ts` | `#executeCronAgent()` 改为调 `bridge.runCronTask()` |
| 5 | `packages/pi-gateway/src/gateway.ts` | 删除 `sendToChannel`/`sendViaOAuth`/`sendViaWebhook`/`deliverWithRetry` |

### 7.2 阶段二：`list_scheduled_tasks` 工具

| 步骤 | 文件 | 改动 |
|---|---|---|
| 6 | `packages/pi-gateway/src/agent-transport.ts` | 定义 `get_scheduled_tasks` RPC 命令 |
| 7 | `packages/pi-gateway/src/gateway.ts` 或 `gateway-cron-lifecycle.ts` | 新增 `get_scheduled_tasks` handler，读 `schedulerStorage` |
| 8 | `packages/pi-gateway/src/gateway-cron-lifecycle.ts` | 在 `#executeCronAgent` 中注入 `listScheduledTasksTool` |

### 7.3 阶段三：验证 + 数据迁移 + 清理

| 步骤 | 内容 |
|---|---|
| 9 | 验证 cron session 和 IM session 在子进程 event loop 上交错运行 |
| 10 | 验证 `AbortController` 超时能正确终止卡住的 cron session |
| 11 | 网关启动时的 task 数据迁移（accountId → agentDir + delivery） |
| 12 | 标记旧字段 `@deprecated`，后续版本清理 |
| 13 | 添加 IM session 侧 `list_scheduled_tasks` 支持 |

---

## 8. 参考

| 来源 | 用途 |
|---|---|
| `packages/coding-agent/src/task/executor.ts` | 现有 in-process subagent 模式 |
| `packages/coding-agent/src/sdk.ts` | `createAgentSession()` 接口定义 |
| Hermes Agent `cron/scheduler.py` | `ThreadPoolExecutor` + 新 `AIAgent()` |
| OpenClaw `src/cron/isolated-agent/run.ts` | in-process 新 AgentSession，事件循环交错 |
| `packages/pi-gateway/docs/hermes-gateway-cron-architecture.md` | Hermes 完整架构分析 |
| `packages/pi-gateway/docs/0002-structured-cron-diagnostics.md` | 结构化诊断 ADR（和本设计配合使用） |
