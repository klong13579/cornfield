# Cron 与 Gateway 解耦设计

| 项 | 说明 |
|---|---|
| 文档版本 | V1.1 |
| 状态 | 待审批 |
| 适用包 | `packages/pi-gateway`（含 `src/scheduler/`） |
| 参考实现 | OpenClaw cron（进程内 DI 模型）、Hermes cron（对比后排除） |

---

## 1. 背景与问题

### 1.1 当前架构

Gateway 是单体枢纽，在一个进程内管理：channel 连接、session 状态、AgentBridge（omp RPC 子进程）、cron 调度器。cron 与 gateway 的耦合集中在以下代码路径：

```
SchedulerEngine.#handleTrigger(taskId)
  → Gateway.#onCronTrigger(task, executionId)     // 上帝回调
    → getAccountBridge(task.accountId)             // 泄漏 AgentBridge 实例
    → bridge.setDisabledToolsets(['cronjob','messaging'])  // 副作用操作
    → bridge.setModel(task.provider, task.model)           // 副作用操作
    → bridge.executePrompt(...) 或 executeScheduledCommand(...)
    → bridge.setDisabledToolsets([]) / bridge.setModel(originalModel)  // 恢复
    → deliverWithRetry(task.deliver, summary, ...)
      → sendToChannel() / sendViaOAuth() / sendViaWebhook()  // 直接调 DingTalk REST API
```

### 1.2 耦合清单

| # | 耦合点 | 位置 | 严重程度 |
|---|---|---|---|
| C1 | cron 投递绕过 Channel 接口，直接调 DingTalk OAuth/webhook API | `gateway.ts` `sendToChannel` / `sendViaOAuth` / `sendViaWebhook` | **高** — 加新平台要改 cron 代码 |
| C2 | `Gateway.#onCronTrigger` 上帝回调，执行+投递全塞一个函数 | `gateway.ts` | **高** — 不可复用、不可测试 |
| C3 | `getAccountBridge` 泄漏 AgentBridge 实例给 cron handler | `gateway.ts` | **中** — cron 能摸到 bridge 内部方法 |
| C4 | `ScheduledTask.accountId` 同时承载执行路由和投递路由双重语义 | `scheduler/types.ts` | **中** — 执行 agent 和投递目标无法独立配置 |
| C5 | cron 不能脱离 gateway 运行 | 架构级 | **低** — 已确认不需要独立部署 |
| C6 | warm bridge 路径的副作用操作（setDisabledToolsets/setModel/restore）与执行逻辑混在一起 | `gateway.ts` `#onCronTrigger` | **高** — 注入函数若不承担会污染 bridge 状态 |
| C7 | cronRun CLI 命令动态 import gateway.ts 形成循环依赖 | `cli-commands.ts` → `gateway.ts` → `scheduler` | **中** — 解耦后 sendToChannel 删除，循环依赖必须一并消除 |
| C8 | file-store.ts syncToDb 漏写 accountId（现有 bug） | `file-store.ts` | **中** — 解耦后 agentDir 会继承同样的 bug |

### 1.3 已排除的方案

| 方案 | 排除理由 |
|---|---|
| Hermes 模型（独立部署） | 单机单实例场景下，性能（冷启动税）和鲁棒性（重复执行/投递失败/配置漂移）均不如进程内 DI |
| dws 投递 | dws 是用户额外安装的外部 CLI，不能作为 cron 投递的硬依赖。旧方案（ADR-1 网关不持有 token）已作废 |
| 引入 agentId 注册表 | OpenClaw 的 agentId 也是目录名，不解决改名问题。agentDir 路径作为 agent 标识够用 |

---

## 2. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | cron 留在 gateway 进程内，不独立部署 | 单机单实例，进程内 DI 在性能和鲁棒性上均优于独立部署 |
| D2 | agentDir 路径作为 agent 标识，不引入 agentId/registry | 与 OpenClaw 一致（agentId=目录名），单机场景下文件系统保证唯一 |
| D3 | `accountId` 拆成 `agentDir`（执行）+ `delivery`（投递）两个独立字段 | 消除双重语义，执行路由和投递路由分离 |
| D4 | 投递复用 gateway 的 DingTalk account 凭证，走 ChannelRegistry | ADR-1 作废，gateway 持有业务 token 是合理设计 |
| D5 | 投递走 Channel 接口（OpenClaw 模式），不区分回复/推送 | channel 实现自己决定送达方式，cron 不碰平台 API |
| D6 | executeAgent 用注入函数（路径 A），cron 不接触 AgentBridge | 最小接口，cron 只需"执行 prompt，拿回结果" |
| D7 | warm bridge 保留为主路径，冷启动 `omp --print` 为 fallback | 进程边界不动，性能不退步 |
| D8 | cron 代码保留在 `packages/pi-gateway/src/scheduler/`，不独立成包 | 不独立部署 = 不需要独立包 |
| D9 | executeAgent 签名包含 disabledToolsets + model/provider 参数 | warm bridge 的副作用操作（setDisabledToolsets/setModel/restore）由 gateway 实现内部承担，cron 通过参数传递配置意图 |
| D10 | DingTalkChannel.sendMessage 支持三条路由：sessionWebhook（回复）、toUserId（DM 推送）、conversationId（group 推送） | 当前 sendViaOAuth 支持两种推送模式，设计文档原版只覆盖了 toUserId |
| D11 | deliverWithRetry 重试逻辑归属 CronService 的 deliver 实现 | sendMessage 保持单次调用语义，与交互式 reply 路径一致 |
| D12 | DingTalkChannel 实例内部加 token cache | 当前无缓存每次重新 fetch token（TTL 7200s），高频 cron 任务浪费大量 API 调用。channel 自持 `#tokenCache`，无需外部注入 |
| D13 | file-store.ts syncToDb 的 accountId 漏写 bug 一并修复 | 解耦后 agentDir 会继承同样 bug，必须同批修 |

---

## 3. 接口设计

### 3.1 CronDeps — 依赖注入接口

CronService 通过此接口与 gateway 交互，不直接持有 AgentBridge、ChannelRegistry 等内部对象。

```typescript
// packages/pi-gateway/src/scheduler/cron-service.ts

export interface CronDeps {
  /** 执行 agent prompt，返回结果文本 */
  executeAgent: (params: {
    agentDir: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** 执行期间禁用的工具集（如 cron 任务传 ['cronjob', 'messaging']） */
    disabledToolsets?: string[];
    /** per-task model 覆盖 */
    model?: string;
    /** per-task provider 覆盖 */
    provider?: string;
  }) => Promise<{ output: string; error?: string }>;

  /** 投递结果到指定 channel（内部封装重试逻辑） */
  deliver: (params: {
    channel: string;              // "dingtalk"
    accountId?: string;           // 哪个 account 凭证
    toUserId?: string;            // DM 推送目标
    toConversationId?: string;    // group 推送目标
    text: string;                 // 投递内容
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

**gateway 的 executeAgent 实现内部职责**（cron 不感知）：

```
1. 通过 agentDir 查找对应的 AgentBridge（warm bridge）
2. bridge.setDisabledToolsets(params.disabledToolsets ?? [])  // 禁用工具集
3. const originalModel = bridge.getModel()                     // 记录原始 model
4. if (params.model) bridge.setModel(params.provider, params.model)
5. try: bridge.executePrompt(params.prompt, { timeoutMs, sessionPath, inactivityMs })
6. finally: bridge.setDisabledToolsets([])                     // 恢复工具集
7. finally: bridge.setModel(originalModel)                     // 恢复 model
8. 若 warm bridge 不可用 → fallback: spawn omp --print（冷启动）
9. if (params.signal?.aborted) → bridge.abort()
```

### 3.2 ScheduledTask — 拆分 accountId

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

  // 以下字段废弃，迁移期保留兼容读取
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

**group 推送复用现有 `conversationId` 字段**——当无 `sessionWebhook` 但有 `conversationId` 时走 OAuth group 推送。不新增字段。

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
    throw new Error("No delivery route: missing sessionWebhook or accountId+toUserId or accountId+conversationId");
  }
}

/** 获取 OAuth token，带缓存（TTL = expireIn - 60s 保护带） */
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
    expiresAt: now + (expireIn - 60) * 1000,
  };
  return accessToken;
}
```

### 3.5 CronService.deliver 实现 — 重试逻辑归属

```typescript
// gateway 构造 CronService 时注入的 deliver 实现

deliver: async (params) => {
  // 构造 OutboundMessage
  const msg: OutboundMessage = {
    channelId: params.channel,
    conversationId: params.toConversationId ?? `cron:${Date.now()}`,
    content: params.text,
    accountId: params.accountId,
    toUserId: params.toUserId,
  };

  // 重试逻辑：1 次重试，固定 5s 延迟（从 gateway.ts deliverWithRetry 迁移）
  const maxAttempts = 2;
  const retryDelayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.#registry.sendMessage(msg);
      return { ok: true };
    } catch (err) {
      if (attempt < maxAttempts) {
        await Bun.sleep(retryDelayMs);
        continue;
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: "unreachable" };
}
```

---

## 4. 数据流（解耦后）

### 4.1 cron 触发完整路径

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
      → gateway 实现：
        → 通过 agentDir 查找 warm bridge
        → bridge.setDisabledToolsets(['cronjob', 'messaging'])
        → bridge.setModel(task.provider, task.model)
        → bridge.executePrompt(prompt, { timeoutMs, sessionPath })
        → finally: bridge.setDisabledToolsets([]) / bridge.setModel(original)
        → fallback: spawn omp --print（warm bridge 不可用时）
      → 结果 string
    → deps.deliver({
        channel: task.delivery.channel,
        accountId: task.delivery.accountId,
        toUserId: task.delivery.toUserId,
        toConversationId: task.delivery.toConversationId,
        text: summary,
      })
      → gateway 实现：构造 OutboundMessage → registry.sendMessage → DingTalkChannel.sendMessage
        → 有 toUserId 无 sessionWebhook → OAuth DM 发送
        → 有 conversationId 无 sessionWebhook → OAuth group 发送
      → 内部重试：1 次，5s 延迟
    → CronService 记录执行状态 + lastDeliveryError
```

### 4.2 cron 不再知道的东西

- AgentBridge 的存在
- DingTalk OAuth / sessionWebhook / REST API
- ChannelRegistry 的内部结构
- gateway 的 account 配置
- bridge 的 setDisabledToolsets / setModel 操作

cron 只通过 `CronDeps.executeAgent` 和 `CronDeps.deliver` 两个接口与外部交互。

---

## 5. 改动清单

### 5.1 新增

| 文件 | 内容 |
|---|---|
| `packages/pi-gateway/src/scheduler/cron-service.ts` | CronService 类 + CronDeps 接口 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `packages/pi-gateway/src/types.ts` | OutboundMessage 加 `toUserId` 字段 |
| `packages/pi-gateway/src/scheduler/types.ts` | ScheduledTask 加 `agentDir` + `delivery`，旧字段标 deprecated |
| `packages/pi-gateway/src/scheduler/types.ts` | TaskFileDefinition 同步加 `agentDir` + `delivery` 字段 |
| `packages/pi-gateway/src/scheduler/types.ts` | `formatAgent()` 参数从 accountId 改为 agentDir |
| `packages/pi-gateway/src/channels/dingtalk.ts` | sendMessage 吸收 OAuth DM + group 主动发送逻辑（三条路由）；新增 `#tokenCache` + `#getOAuthToken()` |
| `packages/pi-gateway/src/gateway.ts` | 构造 CronService 并注入 executeAgent + deliver 实现；executeAgent 内部承担 setDisabledToolsets/setModel/restore；删除 `#onCronTrigger` 中的执行+投递逻辑 |
| `packages/pi-gateway/src/scheduler/engine.ts` | SchedulerEngine.onTrigger 回调改为调 CronService |
| `packages/pi-gateway/src/scheduler/cli-commands.ts` | `cronCreate` --account 改为写 agentDir 字段；注释删除 AgentBridge 引用；`cronList` AGENT 列改用 task.agentDir；`cronUpdate` 改为操作 agentDir + delivery；`cronRun` 投递路径改为通过 CronService.deliver（不再 import gateway.ts）；`cronReconcile` 改为迁移工具或废弃 |
| `packages/pi-gateway/src/scheduler/from-message.ts` | `createCronTaskFromMessage` 参数从 accountId 改为 agentDir（由调用方 gateway 先解析）；DB 写入改为 agentDir + delivery |
| `packages/pi-gateway/src/scheduler/storage.ts` | 新增 agent_dir 列 + delivery 相关列（delivery_channel / delivery_account_id / delivery_to_user_id / delivery_to_conversation_id / delivery_mode）；ALTER TABLE 迁移；toTask 映射；addTask / updateTask 同步 |
| `packages/pi-gateway/src/scheduler/file-store.ts` | readFile 加 agentDir + delivery 字段读取；syncToDb 加 agentDir + delivery 写入；变更检测加 agentDir + delivery 对比；**一并修复 accountId 漏写 bug** |
| `packages/pi-gateway/src/scheduler/executor.ts` | 无需修改（已接收 cwd 参数，不引用 accountId） |
| `packages/pi-gateway/src/gateway.ts` | `#onCronTrigger` 里 `cronContextPrefix` 的 `account: ${task.accountId}` 改为 `agentDir: ${task.agentDir}` |

### 5.3 删除

| 文件/函数 | 原因 |
|---|---|
| `gateway.ts: sendToChannel()` | 投递走 ChannelRegistry |
| `gateway.ts: sendViaOAuth()` | 逻辑搬进 DingTalkChannel |
| `gateway.ts: sendViaWebhook()` | 逻辑搬进 DingTalkChannel |
| `gateway.ts: deliverWithRetry()` | 重试逻辑搬进 CronService 的 deliver 实现 |
| `gateway.ts: getAccountBridge()` 泄漏给 cron | cron 不再直接接触 AgentBridge |
| `cli-commands.ts: cronRun()` 中的 `await import('../gateway')` | 消除循环依赖，投递走 CronService.deliver |

### 5.4 数据迁移

现有 cron task 的 `accountId` / `deliver` / `deliverUser` 需迁移到 `agentDir` + `delivery`：

1. gateway 启动时读取 task，若 `agentDir` 缺失但有 `accountId`，从 `gateway.json` 查 `accounts[accountId].agentDir` 填入 `agentDir`
2. 若 `delivery` 缺失但有 `deliver` + `deliverUser`，构造 `delivery` 对象
3. 写回新字段，保留旧字段兼容（deprecated 期）
4. 后续版本删除旧字段

**存储层迁移**：

- SQLite 新增 `agent_dir` 列 + `delivery_channel` / `delivery_account_id` / `delivery_to_user_id` / `delivery_to_conversation_id` / `delivery_mode` 五列
- ALTER TABLE 迁移（检查列是否存在，不存在则添加）
- `toTask()` 读取时：若 `agentDir` 为空但 `accountId` 有值，触发运行时迁移
- `file-store.ts` syncToDb 同步修复：addTask 和变更检测都要加 agentDir + delivery

### 5.5 不变

| 模块 | 说明 |
|---|---|
| SchedulerEngine | croner 调度机制不动 |
| SchedulerDbStorage 查询逻辑 | 存储层只加列，不改表结构 |
| AgentBridge | warm bridge 机制不动 |
| omp 进程边界 | 子进程通信不动 |
| Channel 接口签名 | 不加新方法，只加 OutboundMessage 字段 |
| ChannelRegistry.sendMessage | 透传 toUserId，不感知新字段 |
| SessionManager | cron 与 session 状态完全隔离，无交互 |
| executeScheduledCommand | 已接收 cwd 参数，不引用 accountId |

---

## 6. 性能评估

| 维度 | 当前 | 解耦后 | 差异 |
|---|---|---|---|
| 触发延迟 | `#onCronTrigger` 同步回调 | CronService.onTrigger → 注入函数 | 纳秒级，无实际差异 |
| warm bridge 启动 | `getAccountBridge` 直接拿实例 | `executeAgent` 内部查 bridge | 多一次 Map 查找，微秒级 |
| 冷启动路径 | spawn omp --print | 同上 | 不变 |
| 投递开销 | `sendViaOAuth` 直接调 API | `deliver` → `registry.sendMessage` → `channel.sendMessage` → OAuth | 多一次 Map 查找 + OutboundMessage 构造，微秒级 |
| OAuth token 获取 | 每次重新 fetch（无缓存） | channel 内部 `#tokenCache`，7200s TTL 内复用 | **优于当前** — 高频 cron 任务省掉大量 token 请求 |
| 并发 | maxConcurrentRuns=3 | 同上 | 不变 |
| 内存 | 无新增 | CronService 实例 + 闭包 + token cache | 常量级，可忽略 |

**结论：性能无实质差异，token 缓存带来边际改善。** 所有新增开销是 Map 查找或函数调用，在毫秒级 agent 执行和百毫秒级 API 调用面前不可见。

---

## 7. 鲁棒性评估

### 7.1 优于当前的

| 维度 | 改进 |
|---|---|
| 投递路径一致性 | cron 投递统一走 Channel 接口，加新平台零 cron 改动 |
| 可测试性 | CronService 只依赖注入接口，可 mock executeAgent/deliver 单测 |
| 错误传播 | executeAgent 和 deliver 各自返回 error，CronService 可区分执行失败 vs 投递失败 |
| agent 引用稳定性 | agentDir 直接指向 agent 目录，和投递配置独立 |
| OAuth token 管理 | 从无缓存升级为 channel 内部缓存，减少 API 调用和失败面 |
| 循环依赖 | 消除 cli-commands.ts → gateway.ts 的动态 import 循环 |
| file-store 同步 | 一并修复 accountId 漏写 bug，agentDir/delivery 同步到位 |

### 7.2 持平的

| 维度 | 说明 |
|---|---|
| 调度可靠性 | SchedulerEngine 不动 |
| 一致性 | 单进程，天然互斥，无重复执行风险 |
| warm bridge 稳定性 | AgentBridge 机制不动 |
| 进程隔离 | omp 子进程边界不动 |
| SessionManager | cron 与 session 状态完全隔离，无交互 |

### 7.3 实施风险

| 风险 | 严重程度 | 应对 |
|---|---|---|
| warm bridge 副作用操作（setDisabledToolsets/setModel/restore）迁移遗漏 | 高 | executeAgent gateway 实现内部完整承担，CronDeps 签名包含 disabledToolsets + model + provider 参数 |
| group 推送路径遗漏 | 高 | DingTalkChannel.sendMessage 三条路由：sessionWebhook / toUserId(DM) / conversationId(group) |
| 现有 task 数据迁移遗漏 | 中 | 迁移函数加单测；gateway 启动时自动迁移并日志记录；toTask 运行时兼容读取 |
| cronRun 循环依赖 | 中 | cronRun 投递改为通过 CronService.deliver，不再 import gateway.ts |
| file-store syncToDb bug | 中 | 一并修复，agentDir + delivery 完整同步 |
| OAuth token 缓存失效 | 低 | TTL 取 expireIn - 60s 保护带；token 过期后下次调用自动重新获取 |
| abort 能力 | 低 | executeAgent 签名已有 AbortSignal，gateway 实现接到 bridge.abort()；注意 bridge.executePrompt 用自定义超时（inactivityMs + timeoutMs），不是标准 AbortSignal，需转译 |

---

## 8. 测试影响

以下测试文件引用 accountId / deliver / deliverUser，需要更新：

| 测试文件 | 改动 |
|---|---|
| `test/scheduler-cron-update.test.ts` | --account 改为写 agentDir；断言改为 task.agentDir |
| `test/scheduler-from-message-smoke.test.ts` | createCronTaskFromMessage 参数从 accountId 改为 agentDir |
| `test/scheduler-reconcile.test.ts` | reconcile 语义重新评估（agentDir 是明确路径，不需要反推）；测试需重写或删除 |
| `test/scheduler-resolve-agent-cwd.test.ts` | resolveAgentCwd 保留为兼容函数则测试可保留；废弃则删除 |
| `test/scheduler-outbound-delivery-smoke.test.ts` | accountId 改 agentDir；独立性验证改为 delivery.accountId vs task.agentDir |
| `test/cron-warm-bridge-fallback.test.ts` | accountId 改 agentDir；getBridgeByAgentDir 替代 getAccountBridge |
| `test/cron-warm-bridge-fallback.test.ts` | 验证 setDisabledToolsets / setModel / restore 在 executeAgent 实现中完整执行 |

---

## 9. 参考来源

| 来源 | 用途 |
|---|---|
| [OpenClaw cron 源码](https://github.com/openclaw/openclaw/blob/main/src/cron/types.ts) | CronServiceDeps DI 模型、delivery 设计 |
| [OpenClaw cron 文档](https://docs.openclaw.ai/automation/cron-jobs) | 执行模式（main/isolated）、投递模式（announce/webhook/none） |
| [OpenClaw 架构分析](https://www.openclawbook.xyz/en/ch18-cron-scheduling-and-automation/18.1-cron-system-design) | CronService 类设计、操作序列化、启动恢复 |
| [Hermes cron 架构](docs/hermes-gateway-cron-architecture.md) | 对比独立部署方案，确认排除 |
| oh-my-pi 代码探查（agent://0-MapAgentChannel） | 当前架构基线、耦合点清单 |
| oh-my-pi 代码探查（agent://1-CheckGatewayOnCronTrigger） | #onCronTrigger 完整逻辑步骤、副作用操作清单 |
| oh-my-pi 代码探查（agent://2-CheckSchedulerTypes） | accountId/deliver/deliverUser 完整引用清单 |
| oh-my-pi 代码探查（agent://3-CheckChannelInterface） | DingTalkChannel 状态清单、OAuth 迁移依赖链 |
