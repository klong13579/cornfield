# Gateway V1 实施计划

> 版本: 1.0
> 日期: 2026-06-16
> 状态: 定稿
> 配套文档: [gateway-design-v1.md](./gateway-design-v1.md) — 设计目标

---

## 1. 当前状态

### 1.1 已完成能力（Phase 1-6）

| Phase | 能力 | 状态 |
|---|---|---|
| Phase 1 | DingTalk 通道重写（自定义心跳、双层去重、指数退避重连、processing keepalive、macOS LaunchAgent EBADF 修复、SDK 噪音抑制、权限策略）| ✅ |
| Phase 2 | Agent-bridge 事件驱动（Promise.withResolvers 锁存、零轮询、prompt id 路由、async stdout/stderr 读取）| ✅ |
| Phase 3 | AI Card 流式（`dingtalk-card.ts` 令牌桶限流 + QPS 自适应退避） + 媒体下载/上传（`dingtalk-media.ts`）| ✅ |
| Phase 4 | 多账号 channel 注册、`PermissionPolicy` / `DingtalkAccountConfig` / `setAccountId` 接入、standalone `parseRobotMessage` 导出 | ✅ |
| Phase 5 | install CLI（交互式钉钉凭证配置）、agents 命令工作区脚手架 | ✅ |
| Phase 6 | 14 个单元测试 + 钉钉连接 + RPC 集成（7.25s 含推理）| ✅ |

### 1.2 当前架构（实施前）

```
用户消息 → DingTalk Stream (单 appKey)
              ↓
        DingTalkChannel (parseRobotMessage)
              ↓
        Gateway.#handleInboundMessage
              ↓
        AgentBridge (1 个)
              ↓
        Agent (1 个进程，cwd 错误)
              ↓
        单一 session 文件
```

### 1.3 已验证

- 钉钉 Stream 连接成功（opencode 机器人 appKey `dingnubwjpndghf8sox8`）
- 心跳 PING/PONG（10s ping / 20s timeout）
- RPC 集成（AgentBridge → Agent(omp --mode rpc) → 模型响应，7.25s）
- 34 单元测试通过，1 跳过（需真实 LLM 的桥转发测试）
- 账号路由问题已修复（`channelId` 用基础 `"dingtalk"`，加 `accountId` 字段到 `InboundMessage`）

---

## 2. 与设计目标的差距

### 2.1 Gap 总览

按严重度和修复阶段分组：

| Gap | 严重度 | 阶段 | 修复位置 | 设计依据 |
|---|---|---|---|---|
| Agent spawn `cwd` 与 agentDir 默认值 | 高 | Phase 7 | `agent-bridge.ts` + `gateway.ts` | §5.3 / §5.5 |
| 缺失 `switchSession()` / `waitForIdle()` / `getState()` | 高 | Phase 7 | `agent-bridge.ts` | §8.1 / §2.3 |
| 无 SessionManager（无队列、无并发处理）| 高 | Phase 7 | 新建 `session-manager.ts` | §3 / §7 |
| 无熔断器（连续超时 → 队列堆积 → OOM）| 高 | Phase 7 | `agent-bridge.ts` | §11.2 |
| 无优雅关闭（stop 直接 kill，正在处理的消息丢失）| 高 | Phase 7 | `gateway.ts` | §11.4 |
| 队列无深度保护 | 高 | Phase 7 | `session-manager.ts` | §11.3 |
| agentDir 默认值（`~/.omp/agents/<accountId>/`）未生效 | 中 | Phase 7 | `agent-bridge.ts` | §5.5 |
| agentDir 不存在时未自动创建 skeleton + mission.md 占位 | 中 | Phase 7 | `gateway.ts` | §6.7 |
| bridge 持续崩溃检测（10分钟 > 5次）未实现 | 中 | Phase 7 | `agent-bridge.ts` | §11.1 |
| session 路径迁移到 agentDir/sessions/ | 中 | Phase 7 | `gateway.ts` | §7.2 |
| accounts 数组→map 的代码重构 | 中 | Phase 8 | `types.ts` + `config.ts` + `gateway.ts` | §5.1 |
| appSecret `$ENV_VAR` 解析实现 | 中 | Phase 8 | `config.ts` | §5.4 |
| appSecret 未设置时启动失败 | 中 | Phase 8 | `config.ts` | §5.4 |
| appSecret 日志/错误不展开 | 中 | Phase 8 | `logger` + `config.ts` | §5.4 |
| AI Card 接入主消息流 | 中 | Phase 8 | `gateway.ts` | §9.1 |
| session 文件无压缩（持续增长 → 加载慢）| 中 | Phase 8 | `agent-bridge.ts` | §11.5 |
| 多账号下默认 bridge 白启动 | 中 | Phase 8 | `gateway.ts` | §5.3 |
| 速率限制 | 中 | Phase 9 | `session-manager.ts` | §11.6 |
| 聚合指标 | 中 | Phase 9 | 新建 `metrics.ts` | §12 |
| 健康检查 | 低 | Phase 10 | 新建 `health.ts` | §11.7 |

### 2.2 详细分析

#### 2.2.1 Agent spawn 传 `cwd` 与 agentDir 默认值 (高)

**目标：** bridge cwd 解析顺序符合设计 §5.3 + §5.5。

**解析顺序：**
1. `account.agentDir` 显式指定 → 使用
2. 未指定 → 使用默认值 `~/.omp/agents/<accountId>/`
3. 仅在没有 accountId 上下文时 →  fallback 到 `process.cwd()`

**修复：**
```typescript
// agent-bridge.ts
const agentDir = opts.cwd ?? defaultAgentDir(opts.accountId);
const proc = spawn(["omp", "--mode", "rpc", "--model", opts.model], {
  cwd: agentDir,
  env: { ...process.env, PI_LOG_LEVEL: "info" },
  stdio: ["pipe", "pipe", "pipe"],
});
```

**验收：** 多账号配置下，ps 验证每个 Agent 进程的 cwd 为 `account.agentDir`；未指定 agentDir 的账号落在 `~/.omp/agents/<id>/`。

---

#### 2.2.2 agentDir 自动创建 skeleton (中)

**目标：** 设计 §6.7 要求 agentDir 不存在时自动创建完整 skeleton。

**修复：**
```typescript
// gateway.ts
async function ensureAgentDir(agentDir: string, accountId: string): Promise<void> {
  if (await exists(agentDir)) return;
  await fs.mkdir(join(agentDir, "sessions"), { recursive: true });
  await fs.mkdir(join(agentDir, "knowledge"), { recursive: true });
  await Bun.write(
    join(agentDir, "mission.md"),
    `# ${accountId} 助手\n\n## 身份\n你是一个通用助手，尚未定义具体角色。\n\n⚠️ 请编辑此文件定义机器人的角色、能力、行为准则。\n`,
  );
  // .omp/ 目录由 omp 首次启动时自动创建
}
```

**验收：** 新账号首次启动后，`~/.omp/agents/<id>/` 完整存在含 mission.md 占位；`cat mission.md` 能看到警告提示。

---

#### 2.2.3 session 路径落在 agentDir/sessions/ (中)

**目标：** 设计 §7.2 要求 session 路径为 `agentDir/sessions/<safeConvId>.jsonl`。

**修复：** SQLite `sessions.omp_session_path` 字段从全局路径改为 `account.agentDir + '/sessions/' + safeConvId + '.jsonl'`。

**迁移：** 启动时检测旧路径，存在则 mv 到新路径（不复制，避免双写）。

**验收：** 备份 agentDir 即可恢复该机器人的全部对话；旧路径文件被迁移并记录日志。

---

#### 2.2.4 bridge 持续崩溃检测 (中)

**目标：** 设计 §11.1 要求"持续崩溃（10 分钟内 > 5 次）| 停止重启，告警，bridge 进入 ERROR 状态"。

**修复：**
```typescript
// agent-bridge.ts
#crashTimestamps: number[] = [];

#recordCrash(): void {
  const now = Date.now();
  this.#crashTimestamps.push(now);
  // 仅保留 10 分钟内的崩溃
  this.#crashTimestamps = this.#crashTimestamps.filter(t => now - t < 600_000);
  if (this.#crashTimestamps.length > 5) {
    this.#state = "error";
    logger.error("bridge entered ERROR state", {
      accountId: this.#options.accountId,
      crashes: this.#crashTimestamps.length,
    });
  }
}
```

**验收：** 模拟 10 分钟内 6 次崩溃，最后一次后 bridge state = error；崩溃记录按时间窗口滚动。

---

#### 2.2.5 AgentBridge 关键方法 (高)

**目标态：**
- `switchSession(sessionPath)` — 切换 Agent 进程的活跃 session
- `waitForIdle()` — 等待当前 prompt 完成
- `getState()` — 查询当前状态（idle / busy / error）
- `compact(customInstructions?)` — 触发 session 压缩

**修复（伪代码）：**
```typescript
class AgentBridge {
  // ...existing
  
  async switchSession(sessionPath: string): Promise<void> {
    this.#pendingSessionPath = sessionPath;  // 排队的目标 session
    await this.waitForIdle();                 // 等当前处理完
    await this.#sendCommand("switch_session", { sessionPath });
  }
  
  async waitForIdle(): Promise<void> {
    if (this.#state === "idle") return;
    await this.#idlePromise.promise;  // Promise.withResolvers 锁存
  }
  
  getState(): RpcSessionState {
    return {
      state: this.#state,
      activeSessionPath: this.#activeSessionPath,
      pid: this.#proc?.pid,
    };
  }
  
  async compact(customInstructions?: string): Promise<void> {
    await this.#sendCommand("compact", { customInstructions });
  }
}
```

**验收：** 用户 A 和用户 B 顺序发消息，bridge 自动切换 session，两者上下文不污染。

#### 2.2.6 SessionManager (高)

**职责：**
- session 元数据查询（SQLite）
- 按 conversationId 排队
- bridge 调度（找空闲 bridge 或排队）
- 队列深度保护（详见 §2.2.9）
- 速率限制

**接口：**
```typescript
class SessionManager {
  constructor(
    store: SQLiteSessionStore,
    bridges: Map<string, AgentBridge>,
    options: { maxQueueDepth: number, rateLimitPerWindow: number }
  );
  
  async enqueue(msg: InboundMessage, session: SessionRecord): Promise<string | null>;
  // 入队 → 调度 bridge → 返回回复
  
  getQueueStats(): QueueStat[];
  // 返回每个队列的深度和等待时长
  
  async waitForAllDrained(timeoutMs: number): Promise<void>;
  // 用于优雅关闭
}
```

**关键不变式：**
- 同一 `conversationId` 的消息按到达顺序处理
- 同一 bridge 上不同 `conversationId` 的消息串行（避免 session 竞争）
- 不同 bridge 上的消息可并行

**验收：** 5 个用户并发发消息，每用户 3 条，最终每用户都收到 3 条回复，顺序正确。

#### 2.2.7 熔断器 (高)

**场景：** 模型 API 限流或网络故障，bridge 连续超时，消息无意义堆积。

**设计：** 标准三态熔断器（CLOSED / OPEN / HALF-OPEN）。

```typescript
class CircuitBreaker {
  state: "closed" | "open" | "half-open" = "closed";
  failureCount = 0;
  lastFailureTime = 0;
  
  constructor(
    private threshold = 10,        // 连续失败阈值
    private cooldownMs = 60_000,   // 熔断冷却
  ) {}
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = "half-open";
      } else {
        throw new CircuitOpenError();
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
}
```

**集成：** AgentBridge 的每次 `prompt()` 调用包在 `circuit.call(...)` 中。

**验收：** 模拟连续 10 次超时，bridge 进入 OPEN 状态，新消息直接返回错误而非排队。

#### 2.2.8 优雅关闭 (高)

**目标态：** 设计 §11.4 顺序：
1. 断开所有 channel
2. 等待队列处理完（30s 超时）
3. 停止所有 bridge
4. 关闭存储

```typescript
async stop(): Promise<void> {
  logger.info("Gateway shutting down");
  
  // 1. 断开所有 channel，不再收新消息
  await this.#registry.disconnectAll();
  
  // 2. 等待所有会话队列处理完（30s 超时）
  const drained = await this.#sessionManager.waitForAllDrained(30_000);
  if (!drained) {
    logger.warn("shutdown timeout, some messages may be lost", {
      pendingQueues: this.#sessionManager.getQueueStats()
    });
  }
  
  // 3. 停止所有 bridge
  for (const bridge of this.#bridges.values()) {
    bridge.stop();
  }
  
  // 4. 关闭存储
  this.#store?.close();
  
  logger.info("Gateway stopped");
}
```

**验收：** 发送 SIGTERM，10s 内正在处理的消息完成回复，10-30s 内的消息被处理或丢弃并告警。

#### 2.2.9 队列深度保护 (高)

**MAX_QUEUE_DEPTH = 100**（单 conversationId 队列上限）。

```typescript
async enqueue(msg, session): Promise<string | null> {
  const queue = this.#getQueue(session.conversationId);
  
  if (queue.messages.length >= this.MAX_QUEUE_DEPTH) {
    logger.warn("queue full, rejecting", {
      conversationId: session.conversationId,
      depth: queue.messages.length,
    });
    return "系统繁忙，请稍后重试。";
  }
  
  // ...
}
```

**拒绝而非丢弃：** 用户得到明确反馈。

#### 2.2.10 多账号下默认 bridge 不应启动 (中)

**目标态：** 设计 §5.3 配置加载规则——多账号模式只创建 accounts 中声明的 bridge，单账号模式只创建顶层 bridge。

#### 2.2.11 AI Card 接入主消息流 (中)

**目标态：** `dingtalk-card.ts` 已实现，集成到 `handleInboundMessage`：收到消息即创建 card，回复时更新 card 状态。

**集成点：** Gateway 收到消息后，先创建 AI Card 获得 cardInstanceId，回复时更新 card 状态。

**改动：**
```typescript
// gateway.ts
async #handleInboundMessage(msg: InboundMessage): Promise<void> {
  // 1. 立即创建 AI Card（"正在思考..."）
  const cardId = await this.#card.createCard(msg.sessionWebhook, "正在思考...");
  
  try {
    // 2. 转发给 agent
    const reply = await this.#sessionManager.enqueue(msg, session);
    
    // 3. 流式更新 card（如果支持）
    await this.#card.updateCard(cardId, reply);
  } catch (err) {
    await this.#card.updateCard(cardId, "处理失败: " + err.message);
  }
}
```

#### 2.2.12 session 文件自动压缩 (中)

**触发：** AgentBridge 处理完消息后检查 session 文件大小，> 1MB 触发 compact。

**实现：**
```typescript
async #postProcess(): Promise<void> {
  const stat = await fs.stat(this.#activeSessionPath);
  if (stat.size > 1024 * 1024) {
    logger.info("session file large, compacting", { 
      path: this.#activeSessionPath, 
      size: stat.size 
    });
    await this.compact();
  }
}
```

#### 2.2.13 appSecret 环境变量引用 (中)

**支持语法：** `"appSecret": "$DINGTALK_HR_SECRET"`。

**实现：**
```typescript
function resolveSecret(value: string): string {
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    const resolved = process.env[envName];
    if (!resolved) {
      throw new Error(`env var ${envName} not set`);
    }
    return resolved;
  }
  return value;
}
```

**安全：**
- 日志中只输出 `appSecret: "$DINGTALK_HR_SECRET"`（不展开）
- 错误信息中也不展开

#### 2.2.14 accounts 改为命名 map (中)

**目标格式：**
```jsonc
"accounts": {
  "ops": { "appKey": "...", "appSecret": "..." },
  "hr":  { "appKey": "...", "appSecret": "..." }
}
```

**改进：**
- 日志 `accountId=ops`（人类可读）
- 索引 O(1)
- 配置改动 diff 友好

**改动：**
- `types.ts`：`accounts: Record<string, DingtalkAccountConfig>`
- `config.ts`：反序列化后保留 key
- `gateway.ts`：遍历 `Object.entries(accounts)` 创建 bridge

#### 2.2.15 速率限制 (中)

**算法：** 滑动窗口，每个 conversationId 每 10 秒最多 3 条。

**实现：**
```typescript
class RateLimiter {
  #windows = new Map<string, number[]>();
  
  allow(conversationId: string, limit = 3, windowMs = 10_000): boolean {
    const now = Date.now();
    const window = (this.#windows.get(conversationId) || [])
      .filter(t => now - t < windowMs);
    if (window.length >= limit) return false;
    window.push(now);
    this.#windows.set(conversationId, window);
    return true;
  }
}
```

**响应：** 超过限制时回复 `"请不要连续发送多条消息，我会依次处理。"`

#### 2.2.16 聚合指标 (中)

**输出：** 每分钟写一条结构化日志，包含计数器。

```json
{"level":"info","message":"metrics","period":60,
 "messagesReceived":142,
 "messagesProcessed":138,
 "agentErrors":2,
 "avgLatencyMs":8765,
 "p99LatencyMs":30000,
 "queueDepth":3}
```

**字段：**
- `messagesReceived` / `messagesProcessed` — 消息计数
- `agentErrors` / `agentTimeouts` — 失败计数
- `avgLatencyMs` / `p99LatencyMs` — 延迟分位
- `queueDepth` — 队列深度
- `circuitBreakerState` — 熔断器状态

**实现：** 内存计数器 + 定时输出（无需 Prometheus 等外部依赖）。

#### 2.2.17 健康检查 (低)

**开启方式：** 环境变量 `PI_GATEWAY_HTTP_PORT=9090`。

**端点：**
- `GET /health` — 总体状态
- `GET /health/accounts` — 每个账号的连接 / 队列 / PID
- `GET /health/queues` — 每个会话的队列深度和等待时长

**实现：** 内置 Bun HTTP server，零依赖。

---

### 2.3 组件接口契约

> 目标态见设计文档 §10。本节列出 TypeScript 签名作为实施参考。

#### 2.3.1 Gateway

```typescript
class Gateway {
  constructor(config: GatewayConfig);

  async start(): Promise<void>;
  async stop(): Promise<void>;
  get isRunning(): boolean;

  async getStatus(): Promise<GatewayStatus>;
  async sendDirectMessage(text: string): Promise<string | null>;
}
```

#### 2.3.2 DingTalkChannel

```typescript
class DingTalkChannel {
  setAccountId(accountId: string): void;
  getAccountId(): string;

  async connect(config: DingTalkConfig): Promise<void>;
  async disconnect(): Promise<void>;
  isConnected(): boolean;

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  async sendMessage(msg: OutboundMessage): Promise<void>;
}
```

#### 2.3.3 SessionManager

```typescript
class SessionManager {
  constructor(
    store: SQLiteSessionStore,
    bridges: Map<string, AgentBridge>,
    defaultBridge?: AgentBridge
  );

  // 入队 → 等待处理 → 返回回复
  async enqueue(msg: InboundMessage, session: SessionRecord): Promise<string | null>;

  getQueueStats(): QueueStat[];
  cleanup(): void;  // 5min 无消息的队列自动回收
}
```

#### 2.3.4 AgentBridge

```typescript
class AgentBridge {
  constructor(options: AgentBridgeOptions);

  // 生命周期
  async start(): Promise<void>;
  stop(): void;
  get isRunning(): boolean;

  // RPC 协议命令
  async switchSession(sessionPath: string): Promise<void>;
  async waitForIdle(): Promise<void>;
  async prompt(message: string): Promise<string | null>;
  async getState(): Promise<RpcSessionState | null>;

  get pid(): number | undefined;
  get crashCount(): number;
}

interface AgentBridgeOptions {
  ompPath?: string;
  model?: string;
  cwd?: string;          // 对应 account.agentDir
  timeoutMs?: number;    // 默认 120000
  maxCrashRetries?: number;
  crashBackoffMs?: number;
}
```

---

## 3. 实施阶段

> 本节是各 Phase 的任务列表与代码量估算。每个任务的详细实现（代码、验收）见 §2.2。

### Phase 7: 基础能力修复（高严重度）

**目标：** 多账号基础可用，session 隔离、消息队列、防御机制齐备。

**依赖任务：**

| 任务 | 估计代码 | 验收测试 | 详细 |
|---|---|---|---|
| RPC spawn 传 cwd（含默认路径解析）| ~15 行 | 多账号启动后 `ps` 验证 cwd | §2.2.1 |
| agentDir 不存在时自动创建 skeleton + mission.md 占位 | ~40 行 | 新账号首次启动后目录结构完整 | §2.2.2 |
| session 路径落到 agentDir/sessions/ | ~30 行 | session 文件落在 agentDir/sessions/ | §2.2.3 |
| bridge 持续崩溃检测（10分钟 > 5次）| ~30 行 | 模拟崩溃后 bridge 进入 ERROR 状态 | §2.2.4 |
| AgentBridge 加 switchSession / waitForIdle / getState / compact | ~80 行 | 双用户顺序发消息不污染 | §2.2.5 |
| SessionManager 实现 | ~200 行 | 5 用户并发测试通过 | §2.2.6 |
| 熔断器 | ~80 行 | 模拟 10 次超时进入 OPEN | §2.2.7 |
| 优雅关闭 | ~40 行 | SIGTERM 后正在处理的消息完成 | §2.2.8 |
| 队列深度保护 | ~10 行 | 100 条后返回拒绝消息 | §2.2.9 |

**预计总代码：** ~525 行  
**预计测试：** ~18 个新单元测试

### Phase 8: 防御加固（中严重度）

**目标：** 配置安全、AI Card 体验、配置可读性。

| 任务 | 估计代码 | 详细 |
|---|---|---|
| accounts 数组→map 代码重构 | ~30 行（types / config / gateway 三处）| §2.2.14 |
| appSecret `$ENV_VAR` 解析 | ~20 行 | §2.2.13 |
| appSecret 未设置时启动失败 | ~10 行 | §2.2.13 |
| appSecret 日志/错误不展开 | ~10 行（中间件层）| §2.2.13 |
| 多账号下默认 bridge 不启动 | ~15 行 | §2.2.10 |
| AI Card 接入主消息流 | ~100 行 | §2.2.11 |
| session 文件自动压缩 | ~30 行 | §2.2.12 |

**预计总代码：** ~215 行

### Phase 9: 可观测（中严重度）

| 任务 | 估计代码 |
|---|---|
| 速率限制 | ~40 行 |
| 聚合指标 | ~50 行 |

**预计总代码：** ~90 行

### Phase 10: 可选 + 测试

| 任务 | 估计代码 |
|---|---|
| 健康检查 HTTP 端点 | ~100 行 |
| SessionManager 端到端测试 | ~150 行测试 |
| 熔断器状态机测试 | ~80 行测试 |
| Graceful shutdown 集成测试 | ~50 行测试 |
| 端到端多账号测试 | ~100 行测试 |

**预计总代码：** ~480 行（含测试）

### 总览

```
Phase 7:  ~525 行  （基础能力，阻塞多账号）
Phase 8:  ~215 行  （安全 + 体验）
Phase 9:  ~90 行   （可观测）
Phase 10: ~480 行  （可选 + 测试）
───────────────────
合计:    ~1310 行
```

---

## 4. 风险与缓解

| 风险 | 严重度 | 缓解策略 |
|---|---|---|
| session 路径迁移破坏现有数据 | 中 | 启动时检测旧路径，自动迁移；保留 30 天旧路径副本 |
| 熔断器误判（偶发超时）导致全员拒绝 | 中 | 阈值设宽松（连续 10 次 60s 超时），HALF-OPEN 试发 1 条 |
| 多账号 Agent 进程过多耗尽系统资源 | 低 | accounts 配置层不加限制，运维侧控制账号数（< 10）|
| 队列消息带 session 状态，stop 期间产生新消息 | 中 | 优雅关闭期间 channel 已断开，新消息进不来（不会堆积）|
| AI Card 创建失败降级为普通消息 | 中 | catch 创建异常，回退到 sendMessage |
| 速率限制误伤（用户正常连发）| 低 | 阈值宽松（10s 3 条），超出时友好提示而非拒绝 |
| bridge 持续崩溃后停止恢复，需手动重启 | 中 | ERROR 状态时告警；运维通过 health 端点查看并手动重启 gateway |

---

## 5. 监控指标

### 5.1 业务指标（每分钟输出）

```json
{
  "messagesReceived": 142,
  "messagesProcessed": 138,
  "agentErrors": 2,
  "agentTimeouts": 1,
  "circuitOpens": 0,
  "rateLimitHits": 0,
  "avgLatencyMs": 8765,
  "p99LatencyMs": 30000,
  "queueDepth": 3,
  "queueMaxDepth": 12,
  "activeBridges": 2,
  "sessionCount": 47
}
```

### 5.2 健康检查端点（Phase 10 开启后）

```
GET /health          → 200 { status: "ok", uptime, activeBridges }
GET /health/accounts → [{ accountId, connected, queueDepth, pid, state }]
GET /health/queues   → [{ conversationId, depth, oldestAgeMs }]
```

### 5.3 关键告警阈值

| 指标 | 阈值 | 动作 |
|---|---|---|
| 熔断器状态 | OPEN | 告警 |
| 队列深度 | > 50（单队列）| 告警 |
| P99 延迟 | > 60s | 告警 |
| Agent 进程崩溃次数 | > 3/小时 | 告警 |
| channel 断连重试次数 | > 5/分钟 | 告警 |

---

## 6. 实施排期建议

```
Week 1: Phase 7 全部（基础能力 + 防御机制）
Week 2: Phase 8 全部（配置安全 + AI Card）
Week 3: Phase 9 + Phase 10 测试（可观测 + 测试）
```

可串行（每个 Phase 完成后跑端到端验证），也可并行（多个 agent 同时改不同文件）。

**Phase 7 是阻塞依赖**，必须先完成；Phase 8-10 互相独立，可任意顺序。

**V1 范围外、不实施的项（见 §7.1）**：per-group 配置覆盖、群聊会话粒度、pairing DM、配置 reload。

---

## 7. 附录

### 7.1 V1 不实施的项

| 能力 | 不实施原因 |
|---|---|
| **群聊会话粒度配置** (`groupSessionScope`) | 群聊整个群一个 session 已足够。 |
| **per-group 配置覆盖** | accounts 级别已足够；per-group 是优化不是必需。YAGNI。 |
| **pairing DM 策略** | 仅开放给公司内使用，allowlist 足够；pairing 是公开 chatbot 场景的方案。 |
| **配置 reload** | 重启即可，reload 需热替换 bridges/channels/queues 复杂。 |
| **短作业优先调度 (SJF)** | 预估耗时不可靠（短消息可能触发复杂工具调用），用户体验提升有限。 |
| **Agent 独立部署** (V2) | V1 中 Agent 由 Gateway 作为子进程拥有。V2 需加 `agentUrl` 配置 + AgentBridge 网络连接模式，独立跨机部署。 |

### 7.2 参考资料

| 主题 | 资料 |
|---|---|
| 熔断器模式 | Michael Nygard《Release It!》、resilience4j |
| 优雅关闭 | Kubernetes Pod 终止规范、HTTP 服务 graceful shutdown |
| 队列深度保护 | RabbitMQ / Kafka producer 限流 |
| Session 压缩 | LLM 应用上下文窗口管理最佳实践 |
| Rate Limiting | 滑动窗口 / 令牌桶算法 |
| Health Check | K8s liveness/readiness probe 模式 |
| Secret 管理 | 12-Factor App config-as-env-vars、OWASP |
| 多 Agent 目录隔离 | Hermes Agent profile 模式 |
| 钉钉多账号 | OpenClaw dingtalk-connector |
| 进程调度 | SJF, STCF |
