# Gateway V1 架构设计

> 版本: 1.2
> 日期: 2026-06-23
> 状态: 修订(反映 skeleton 统一、cron 安全增强(repeatCount/at-most-once/grace window/fd-lock)、AI Card v3(blockList)、agentDir 注册、long task watcher)

---

## 1. 设计目标

### 1.1 核心目标

1. **IM 通道无关的消息处理** — 从钉钉、飞书、微信等 IM 平台接收消息，经过统一管线处理，回复回去。新增一个通道不需要改动核心处理逻辑
2. **用户会话隔离** — 每个用户各有独立的对话上下文，互不污染。用户 A 看不到用户 B 的对话历史
3. **跨账号物理隔离** — 每个钉钉机器人（账号）有独立的 Agent(独立进程 + 独立工作目录 + 独立人格)
4. **并发排队** — 当用户 A 的消息正在被处理时，用户 B 的消息排队等待，不丢失、不阻塞
5. **可观测** — 每条消息的完整生命周期有结构化日志可查：收到 → 排队 → 转发给 agent → 收到回复 → 发回 IM
6. **配置驱动** — 机器人个数、模型、个性、权限都通过配置文件声明，不改代码

### 1.2 非目标

- 不自己做模型推理（使用 `omp` 的 RPC 模式作为推理引擎）
- 不做高并发低延迟保障（目标是秒级到十秒级响应，单 Agent 串行处理）
- 不做高可用集群（单进程单机设计）
- 不做消息持久化（session 持久化由 `omp` 自己管理 JSONL 文件）

---

## 2. 核心概念

### 2.1 五个关键角色

```
钉钉开放平台                     Gateway 内部
─────────────────               ─────────────────

应用凭证 (appKey + appSecret)     Account（账号）
       │                              │
       │ 每个凭证对应一个              │ spawn + cwd
       │ 钉钉应用                     │
       ▼                              ▼
钉钉机器人（销售助手/HR助手）        omp --mode rpc 进程
       │                              │
       │ 用户在钉钉里@它              │ session.subscribe 事件流
       ▼                              ▼
用户对话（DM/群聊）                  session 文件 (.jsonl)
```

**一个账号 = 一个钉钉应用凭证 = 一个 Agent = 一个"机器人"**

### 2.2 账号 vs Agent

最容易混淆的概念：

|概念|是什么|决定因素|
|---|---|---|
|**Account(账号)**|钉钉应用凭证 (appKey/appSecret)|写在 `gateway.json` 的 `accounts` map 的 key 里|
|**Agent(智能体)**|进程(omp --mode rpc) + 工作目录(agentDir) + 人格(mission.md)|1:1 绑定账号。V1 中由 Gateway 启动，V2 中可独立部署|

```
账号 = 钉钉的"身份"（谁能收消息）
Agent = 机器人的"个性 + 记忆 + 工具"（怎么回消息）
```

**V1 规则(硬 1:1):** 一个 DingTalk 账号绑定一个 Agent(独立的进程 + 独立的 agentDir + 独立 mission)。跨账号不共享 session / model / mission。

**V2 可能性:** 如需多账号共享人格，可以手动将多个账号指向同一个 agentDir。但 V1 中不实现此能力，配置层不允许(避免状态隔离难验问题)。

### 2.3 设计参考来源

本设计参考了以下项目：

|来源|借鉴内容|
|---|---|
|**OpenClaw dingtalk-connector**|accounts 使用命名 map、会话按 conversationId 隔离、Secrets 环境变量引用|
|**Hermes Agent**|每个 agent 独立目录（profile）包含 `SOUL.md`（= 我们的 mission.md）、独立 `sessions/` 和 `config`、目录级隔离|
|**omp**|RPC 模式（`--mode rpc`）作为推理引擎、`mission.md` 自动加载为 system prompt、`switch_session` 会话切换|
|**Enterprise IM Bot 通用模式**|消息队列、熔断器、优雅关闭、滑动窗口限流

### 2.4 一句话总结

```
Gateway 是一个"消息交换机 + 调度器"：

钉钉消息 → Channel 收 → Gateway 路由 →
  找到对应 Account 的 Agent →
  切换到该用户的 session →
  发给模型处理 →
  取回复 → 发回钉钉

定时触发 → SchedulerEngine tick →
  找到到期任务 →
  优先复用对应 Account 的 warm AgentBridge(executePrompt) →
  fallback 独立 spawn omp --print / sh -c →
  交付结果到 task.deliver 通道
```

---

## 3. 架构总览

```
                  Gateway daemon 进程                            Agent 进程(1 个 / 账号)
                  ────────────────────                            ────────────────────────

DingTalk Stream ─→ Channel(协议适配)
              │
              ▼
        SessionManager(队列)
              │
              ▼
        AgentBridge(进程管理) ──→ RPC(jsonl, §8) ──→ ┌──────────────────────┐
              │                                    │     Agent(1:1)       │
              │                                    │                      │
              │                                    │  进程: omp --mode rpc│
              │                                    │  cwd:   agentDir     │
              │                                    │  运行时: packages/   │
              │                                    │         agent/       │
              │                                    │                      │
              │                                    │  ├─ mission.md       │
              │                                    │  ├─ .omp/config.yml  │
              │                                    │  ├─ .omp/prompt-includes.json
              │                                    │  ├─ sessions/        │
              │                                    │  │  ├─ cid_*.jsonl   │
              │                                    │  │  └─ cron_*.jsonl  │ ← cron 任务专用
              │                                    │  └─ knowledge/       │
              │                                    │                      │
              │                                    │  ↓ 思考/工具调用       │
              │                                    │  ↓ LLM API           │
              │                                    │  → reply(RPC 事件)   │
              │                                    └──────────────────────┘
              │                                          ▲
              │                                          │  复用: bridge.executePrompt()
              │                                          │  免 spawn — 详见 §7.4
              ▼                                          │
        OutboundMessage ◀────────── reply                │
              │                                          │
              ▼                                          │
        DingTalkChannel.sendMessage                      │
                                                       │
Cron Scheduler(同 daemon 进程)                        │
  ├─ agent 任务(accountId): 优先复用 warm AgentBridge  │
  │      ↓(失败时)                                       │
  └─ fallback: spawn omp --print "..." (独立子进程)     │
  └─ shell 任务: sh -c "command"                        │
  └─ 文件同步(§6.7): <agentDir>/cron/tasks/*.json5 →   │
                      ~/.omp/gateway-data/scheduler/    │
                      (60s polling sync)                │
```

两条线 (IM 和 cron 共用 Agent):
  消息线:  Channel → SessionManager → AgentBridge.forward() → Agent(RPC) → 回复
  定时线:  SchedulerEngine.tick() → AgentBridge.executePrompt() (warm) │ executeScheduledCommand() (fallback)

**一个进程边界:**
- Gateway daemon 进程 = 协议适配 + 编排 + 队列调度 + cron 调度
- Agent 进程 = 思考/工具调用/会话历史(1 个 / 账号,长驻,被 IM 和 cron 共享)
- Cron 备用路径 = omp --print 子进程(仅在 warm bridge 不可用时使用)
- 跨边界 = RPC 协议(jsonl over stdin/stdout)
```

### 3.1 组件职责

|组件|职责|不做什么|
|---|---|---|
|**DingTalkChannel**|DingTalk Stream 协议适配。收消息、发消息、心跳、去重、重连|不转发给 agent，不做消息路由|
|**Gateway**|编排：收到消息 → 权限检查 → 找 session → 找 bridge → 转发 → 回复|不含业务逻辑|
|**SessionManager**|会话隔离、消息队列。按 conversationId 排队 + bridge 调度|不启动进程，不做模型调用|
|**AgentBridge**|管理 Agent 子进程(启动、通信、崩溃恢复、cwd 传参) + 共用接口(`forward()` / `executePrompt()`)|不感知 IM 协议，不感知用户身份|
|**Agent**|1:1 绑定 DingTalk 账号。思考/工具调用/会话历史。运行在独立进程里|不感知 IM 协议，不感知网关存在|
|**SchedulerEngine**|cron 调度:扫描 SQLite 任务表、tick 拉到期任务、调 AgentBridge.executePrompt(优先)或 executeScheduledCommand(备选)|不感知 IM 协议,知道如何交付结果(deliver 字段)|

### 3.2 Agent 概念

**Agent = 1 个进程 + 1 个工作目录 + 1 个 DingTalk 账号 = 一个完整的"机器人"。**

|组成部分|说明|所在|
|---|---|---|
|进程|`omp --mode rpc`，由 AgentBridge 启动|Gateway 进程外|
|工作目录|`agentDir` = `~/.omp/agents/<accountId>/`(可配置覆盖)|文件系统|
|运行时|`packages/agent/`(Agent 类 + agent-loop)|Agent 进程内 import|
|通信协议|JSONL over stdin/stdout(详见 §8)|跨进程边界|

**Agent 拥有**(全部在 agentDir 里):

- `mission.md` — 人格 / system prompt
- `.omp/config.yml` — 模型选择 / 工具配置
- `sessions/<convId>.jsonl` — 对话历史
- `knowledge/` — 静态知识库(可选)

**Agent 不拥有**:

- IM 协议
- 消息路由
- 用户权限检查
- 其他 Agent 的 session

**1:1 绑定规则**:

- 一个 DingTalk 账号 = 一个 Agent(进程 + 目录)
- 跨账号不共享 session / model / mission

### 3.3 Agent 生命周期(两阶段)

**V1(短期):Agent 由 Gateway 拥有。**

```
Gateway 启动
  └─ 遍历 accounts
       └─ 为每个 account spawn 一个 Agent(子进程)
Gateway 停止
  └─ 所有 Agent 一起停止(子进程随父进程退出)
```

- 简单，适合单机部署 / 内部使用
- 网关死则 agent 死，无独立升级能力
- 不需额外配置

**V2(长期):Agent 可独立部署为服务。**

```
Agent 独立启动: omp agent start --id ops --rpc-port 9100
  └─ 监听 RPC 端口，状态写入 agentDir
Gateway 作 client 连接: omrpc://host:port
```

- Agent 可独立升级、独立重启
- 可跨机部署
- 多个网关可共享同一个 Agent
- V1 配置加 `agentUrl` 字段即可启用，不破坏 V1 行为

**V1 → V2 迁移路径:**不改 AgentBridge 代码，只改 `accounts.<id>.agentUrl` 字段。V2 模式下 AgentBridge 跳过 spawn，改用网络连接。

### 3.4 配置热加载 (V2)

**V1 状态:** gateway 在 `start()` 时一次性读取 `gateway.json`，运行中不监听配置变化。要修改账号、模型、agentDir 必须 `stop` + 改配置 + `start`。这在生产环境会造成短期不可用。

**V2 目标:** 支持运行时热加载，新增/删除/修改账号不需要重启。

**触发方式(三选一或组合):**

| 触发器 | 用途 |
|---|---|
|`omp gateway reload` 命令 | 手动触发，运维控制 |
| SIGHUP 信号 | Unix 传统：kill -HUP `<pid>` 触发 reload |
| `gateway.json` 文件 mtime 监控 | 自动响应本地编辑 |

**Diff 检测:**

reload 启动后，gateway 对比新旧配置，计算出三个集合：

```
added:   new accounts — {appKey 在旧配置中不存在, 现在有}
removed: old accounts — {appKey 在旧配置中还有, 现在没了}
changed: { appKey, oldConfig → newConfig } — {agentDir 变化 / appKey 变化 / timeoutMs 变化}
```

**对每个集合的动作:**

| 集合 | 动作 |
|---|---|
|`added`| 为每个新 account 创建一个新 `AgentBridge`，启动后连接到 DingTalk |
|`removed`| 停掉对应 `AgentBridge`，断开连接，清理 PID |
|`changed`| 停掉旧 bridge，启动新 bridge（模拟删除+添加）|

**In-flight 消息处理:**

修改 agentDir 或 appKey 会重启 bridge。重启用原子性 exchange (旧 bridge 处理完手头消息后停掉，不接受新消息)。在 in-flight 期间发到该 account 的新消息:放进内存 queue 等新 bridge 起来后再调度。

**原子性策略:**

```
reload() {
    1. Snapshot new config
    2. Compute diff (added/removed/changed)
    3. For each account in 'removed' or 'changed':
        a. Mark bridge as 'draining'
        b. Wait for in-flight prompt to complete (max 60s)
        c. Kill bridge process
    4. For each account in 'added' or 'changed':
        a. Spawn new bridge
        b. Wait for ready signal
        c. Mark as 'active'
    5. Update internal maps
    6. Reload complete
}
```

**风险与限制:**

| 风险 | 处理 |
|---|---|
|in-flight 消息长时间不返回 | 60s 超时后杀掉 bridge，记录 in-flight 为 lost（用户需重发）|
|配置 reload 本身耗时 | reload 是同步的，期间不收新消息（V2.1 改进：reload 与 in-flight 并行）|
|agentDir 已删除但账号还在 | 报错不添加，保留其他账号的 reload |
|文件 mtime 监控抖动 | debounce 1s，写入完成后再处理 |
|多实例同时 reload | 使用文件锁 `/tmp/gateway.reload.lock`，串行化 |

**V2 范围外（暂不实施）:**

- 在线修改 `.omp/config.yml`（不重启 bridge）— 需要 RPC 层支持，复杂度高
- 在线修改 `agentDir` — agent 已加载的 skill/profile 无法热更新
- 在线修改 `permission` 策略 (allowUsers 等) — 实施简单，但需要 V1 SessionManager 上线

**迁移路径:** V1.5 阶段先实现命令 + SIGHUP 触发，V2 加文件监控。

---

## 4. 核心映射关系

### 4.1 组件对应关系

```
Gateway (1 个 daemon 进程)
│
├── Channel (N 个 IM 平台)
│   ├── dingtalk ──── 1 个 Stream 连接(单账号) / N 个连接(多账号)
│   └── feishu (未来)
│
├── AgentBridgePool (N 个 bridge ↔ N 个 Agent，1:1)
│   ├─ account:ops  → AgentBridge1 ──→ Agent1(agentDir1)[1:1]
│   ├─ account:hr   → AgentBridge2 ──→ Agent2(agentDir2)[1:1]
│   └─ ...
│
├── SessionManager ──── 跨所有 Agent 的会话队列调度
│
└── SchedulerEngine ── 调 cron 任务
     ├─ agent 任务(accountId): 复用上面 AgentBridge
     │      └─ bridge.executePrompt({ sessionPath: <agentDir>/sessions/cron_<id>.jsonl })
     └─ agent 任务(无 accountId) / shell 任务:
            └─ executeScheduledCommand(omp --print / sh -c) — 独立子进程
```

**关键:** Agent 独立于 Gateway 进程。一个 DingTalk 账号 = 一个 Agent(进程 + 工作目录 + 人格)。V1 中 Gateway 负责启动 Agent，V2 中 Agent 可独立部署。

**Cron 任务复用 Agent:** 当一个 cron 任务设置了 `accountId` 时,SchedulerEngine 通过 `Gateway.getAccountBridge(accountId)` 拿到该账号的 bridge,调用 `bridge.executePrompt()`。这样 cron agent 任务和 IM 消息共享同一个 RPC 进程(避免每分钟起一个新进程),代价是必须使用 per-task session 文件防止 cron 状态污染 IM 会话(详见 §7.4)。

### 4.2 关键规则

```
一个 Agent 进程      → 管理 N 个 session 文件(通过 switch_session 切换)
一个 session 文件    → 对应 1 个钉钉会话(1 个用户 DM 或 1 个群)
一个 session 文件    → 1 个 account 的 1 个 conversation(跨账号隔离)
所有 Agent 的        → session 文件通过 accountId 前缀隔离

Spawn 关系:
  Gateway(PID 1)
    ├── spawn → Agent A(PID 10) ← 子进程，stdin/stdout 通信,生命周期 = Gateway
    ├── spawn → Agent B(PID 11) ← 同上
    ├── spawn → omp --print(PID 20, 21, ...)
    │     ← 仅在 cron agent 任务的 warm-bridge 不可用时 spawn(执行完即销毁)
    └── spawn → sh -c(PID 30, 31, ...)
          ← 仅在 cron shell 任务 spawn(执行完即销毁)

进程生命周期：
  Gateway.stop()  → 断开 Stream → drain 队列 → 停 Agent → 关存储
  Agent 崩溃      → AgentBridge 自动重启(指数退避 1s→30s)；持续崩溃才停止
  Gateway 崩溃    → OS 回收所有子进程(V1)

Session 共享原则：
  IM 消息: switchSession(<agentDir>/sessions/cid_<convId>.jsonl) ← 活跃 IM 会话
  cron 任务: switchSession(<agentDir>/sessions/cron_<taskId>.jsonl) ← 独占
                ↓ 任务结束
                switchSession(<previousSession>) ← IM 会话恢复(若有)

崩溃恢复策略详见 §11.1。V2 独立 Agent 不受 Gateway 崩溃影响，详见 §3.3。
```

---

## 5. 配置格式

### 5.1 完整格式

```jsonc
// ── 场景 A: 单账号 ──
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "appKey": "dingxxx",
      "appSecret": "secxxx",          // 或 "$ENV_VAR_NAME" 引用环境变量

      // 权限策略
      "dmPolicy": "allowlist",       // open | allowlist | closed
      "groupPolicy": "allowlist",
      "allowedUsers": ["staff001"],
      "allowedGroups": []
    }
  },

  // ── Agent 配置 ──
  // model 不在此配置，由 agentDir/.omp/config.yml 决定（§6.3）
  "agent": {
    "ompPath": "omp",
    "timeoutMs": 120000
  },

  // ── Cron 调度器 ──
  "cron": {
    "enabled": true,
    "maxConcurrentRuns": 3
  }
}
```

```jsonc
// ── 场景 B: 多账号（accounts map）──
// key = 账号名，在日志和指标中直接使用
// 每个 account = 一个钉钉机器人 = 一个 Agent(独立进程 + 独立 agentDir)
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "groupPolicy": "allowlist",
      "allowedUsers": ["staff001"],
      "allowedGroups": [],

      "accounts": {
        "ops": {
          "appKey": "dingbot_ops",
          "appSecret": "sec_ops",
          "agentDir": "/data/robots/ops",
          "timeoutMs": 60000
        },
        "hr": {
          "appKey": "dingbot_hr",
          "appSecret": "$DINGTALK_HR_SECRET",
          "agentDir": "/data/robots/hr"
        }
      }
    }
  },

  // ── Agent 配置 ──
  // model 不在此配置，由 agentDir/.omp/config.yml 决定（§6.3）
  // 多账号时作为 accounts 中各 account 的默认值
  "agent": {
    "ompPath": "omp",
    "timeoutMs": 120000
  },

  // ── Cron 调度器 ──
  "cron": {
    "enabled": true,
    "maxConcurrentRuns": 3
  }
}
```

### 5.2 三种场景

```jsonc
// ── 场景 A: 最简单 — 一个机器人，什么都不配 ──
{ "channels": { "dingtalk": { "enabled": true,
    "appKey": "dingxxx", "appSecret": "secxxx"
}}}
// → 启动一个 Agent，用 omp 自身默认模型


// ── 场景 B: 三个机器人，不同个性 ──
{ "channels": { "dingtalk": { "enabled": true,
    "accounts": {
      "ops": {
        "appKey": "dingbot_ops",
        "appSecret": "sec_ops",
        "agentDir": "/data/robots/ops"
        // → 读取 /data/robots/ops/mission.md  → "你是运维助手"
      },
      "hr": {
        "appKey": "dingbot_hr",
        "appSecret": "sec_hr",
        "agentDir": "/data/robots/hr"
      },
      "dev": {
        "appKey": "dingbot_dev",
        "appSecret": "sec_dev",
        "agentDir": "/data/robots/dev"
      }
    }
  }}
}
// → 启动三个 Agent，各自 cwd 不同，个性不同
```

### 5.3 配置加载规则

```
读取 channels.dingtalk:

  有 accounts（非空）？
  ├── 是：多账号模式
  │    每个 account → 创建一个 AgentBridge
  │    bridge.cwd    = account.agentDir ?? process.cwd()
  │    bridge.secret = 支持 $ENV_VAR 环境变量引用
  │    忽略顶层的 appKey/appSecret
  │    不创建默认 bridge
  │
  └── 否：单账号模式
        使用顶层的 appKey/appSecret
        创建一个 AgentBridge（agent 段有默认值兜底）
```

### 5.4 Secret 环境变量引用

`appSecret` 字段支持 `$ENV_VAR_NAME` 语法，启动时从环境变量解析。

```jsonc
{
  "appSecret": "$DINGTALK_OPS_SECRET"   // ← 启动时替换为 process.env.DINGTALK_OPS_SECRET
}
```

**规则：**
- 值以 `$` 开头 → 视为环境变量名，从 `process.env` 读取
- 否则 → 视为明文
- 环境变量未设置 → 启动失败（带明确错误）
- **日志/错误中只输出原语法**（`$DINGTALK_OPS_SECRET`），不展开，避免泄露

### 5.5 agentDir 默认位置

`account.agentDir` 可省略，省略时使用默认值。

**默认值：** `~/.omp/agents/<accountId>/`

```
accounts: { "ops": { "appKey": "...", "appSecret": "..." } }
↓
~/.omp/agents/ops/   ← agentDir 默认值
├── mission.md
├── .omp/
├── sessions/
└── knowledge/
```

**生产建议：** 显式指定 `agentDir` 到集中路径（如 `/data/robots/ops/`），便于备份、迁移、跨机部署。默认路径适合个人开发/实验场景。

### 5.6 LLM API Key 解析

Gateway spawn `omp --mode rpc` 子进程时，需要为 omp 提供 LLM provider 的 API key。
tmux/launchd 等环境不 source shell profile，导致环境变量缺失。

**机制：** Gateway 从 `~/.omp/agent/agent.db` 的 `auth_credentials` 表读取已存储的
provider API key，注入为环境变量传给子进程。

| Provider | env var | 来源 |
|---|---|---|
| narwal-plan | `NARWAL_PLAN_API_KEY` | agent.db `auth_credentials` |
| alibaba-coding-plan | `ALIBABA_API_KEY` | agent.db `auth_credentials` |

**与 §5.4 的区别：** §5.4 的 `$ENV_VAR` 是 DingTalk appSecret 解析（gateway 进程内使用）；
本节是 LLM API key 注入（传给 omp 子进程）。两套独立机制。

---

## 6. agentDir 目录结构

### 6.1 完整结构

```
<agentDir>/                          ← Agent 工作目录(一个账号 = 一个目录)
│
├── AGENTS.md                        ← Manifest + 全局硬约束
│                                       提取 MUST/NOT → <hard-constraints>
│
├── mission.md                       ← 【核心】系统提示词 / 角色定义
│                                       决定了机器人的"人格"
│                                       omp 启动时读取并注入 system prompt
│
├── TOOLS.md                         ← 工具用法 + co-located MUST/MUST NOT
│
├── TODO.md                          ← 当前任务状态
│
├── prompt-includes.json             ← 显式声明 always-on 文件注入列表
│                                       (AGENTS.md, mission.md, TOOLS.md, TODO.md,
│                                        knowledge/external-workspaces.md)
│
├── .omp/
│   ├── config.yml                   ← omp 配置(模型、工具、主题等)
│   ├── SYSTEM.md                    ← Gateway agent 基线 system prompt
│   ├── evolution/                   ← 自我进化数据(可选, gitignored)
│   └── skills/                      ← 技能定义(可选)
│       └── <skill-name>.md
│
├── sessions/                        ← 该机器人的对话记录
│   ├── cid_<safeConvId>.jsonl       ← 用户 的对话历史
│   ├── cron_<taskId>.jsonl          ← cron 任务 session(§7.4)
│   └── ...
│
├── cron/                            ← 该机器人的定时任务
│   ├── tasks/                       ← .json5 任务定义文件
│   │   ├── daily-report.json5
│   │   └── health-check.json5
│   └── logs/                        ←(自动)cron 任务运行日志(.log)
│
├── knowledge/                       ← 可选:静态知识库(FAQ/手册)
│   ├── external-workspaces.md       ← 外部数据源映射(always-on)
│   ├── faq.md                       ← 常见问题
│   ├── handbook/                    ← 手册
│   │   └── server-restart.md
│   └── .gitkeep
│
├── scripts/                         ←(可选)cron 任务使用的 helper 脚本
├── external/                        ← 可选:外部数据源 YAML
├── weekly-reports/                  ← 周报快照(项目专属)
├── examples/                        ← 数据示例
├── docs/                            ← 设计文档(仅供人读)
└── .gitignore
```

### 6.1a-0 文件来源对照

| 路径 | 创建者 | 说明 |
|---|---|---|
| AGENTS.md | skeleton | Manifest + 全局硬约束 |
| mission.md | skeleton | 核心人格 |
| TOOLS.md | skeleton | 工具用法 + must/must not |
| TODO.md | skeleton | 当前任务占位 |
| prompt-includes.json | skeleton | always-on 文件注入清单 |
| .omp/config.yml | skeleton | runtime 硬依赖(modelRoles) |
| .omp/SYSTEM.md | skeleton | Gateway agent 基线 system prompt |
| .omp/evolution/ | 运行时 | 自我进化数据(gitignored) |
| .omp/skills/ | 用户 | 按需技能 |
| knowledge/external-workspaces.md | skeleton | 外部数据源映射 |
| knowledge/faq.md | 用户 | 常见问题 |
| knowledge/handbook/ | 用户 | 操作手册 |
| sessions/*.jsonl | omp 运行时 | 对话记录(gitignored) |
| cron/tasks/*.json5 | 用户 | 定时任务定义 |
| cron/logs/*.log | 运行时 | 执行日志(gitignored) |
| scripts/ | 用户 | helper 脚本 |
| external/ | 用户 | 外部数据源映射 |
| weekly-reports/ | 用户 | 周报快照 |
| examples/ | 用户 | 数据示例 |
| docs/ | 用户 | 设计文档 |
| .gitignore | skeleton | Git 忽略规则 |


### 6.1a 文件系统设计说明

agentDir 文件系统的设计遵循五个原则:

**1. 配置在文件中,不在进程中。**

  agent 的人格、模型、行为规则、工具配置全部存储在文件里。备份 agentDir = 完整恢复整个机器人。同一代码可以启动无限个不同人格的机器人,只需要切换 agentDir 路径。

**2. 物理隔离 = 安全隔离。**

  每个 agent 拥有独立的文件系统命名空间。运维机器人的 session 文件不会被 HR 机器人读到。cron 任务、脚本、知识库都按 agent 分隔——故障不会跨越目录边界。

**3. 按生命周期分层。**

  以 agentDir 根为原点,距离根越近的文件越核心(人格定义),距离越远的越基础设施(运行时数据):

```
 <agentDir>/          ← 人格核心(AGENTS.md, mission.md, TOOLS.md)
  ├── .omp/          ← 运行时配置 + 系统 prompt 覆盖(模型/工具/SYSTEM.md/注入清单)
  ├── sessions/      ← 运行时数据(对话历史)
  ├── cron/          ← 定时任务(调度元数据)
  ├── knowledge/     ← 参考知识
  └── external/      ← 外部数据源映射
```

**4. 内容优先于目录。**

  只定义目录结构,不预定义用户内容文件名(除 5 个 always-on 外)。omp 框架钩子文件(`.omp/config.yml`、`.omp/SYSTEM.md`、root `AGENTS.md`)在 skeleton 中创建为占位模板;用户内容文件(`knowledge/*`、`external/*`)由 agent 创建者决定。结构提供组织框架,不约束内容。

**5. 可选文件不报错。**

  结构图中标注"(可选)"的文件在缺失时不应产生任何错误或警告。只有 mission.md 和 .omp/config.yml 是 runtime 的硬依赖。

-

### 6.1b agentDir 自动创建

**行为：** Gateway 启动时，若 account 的 agentDir 不存在，调用 `@oh-my-pi/pi-coding-agent/skeleton` 的 `ensureAgentDir()` 自动创建完整 skeleton。Gateway 不再自维护 skeleton 逻辑。

**创建内容（由 coding-agent skeleton 模块负责）：**

```
<agentDir>/
├── AGENTS.md                ← Manifest + 全局硬约束
├── mission.md               ← 默认人格模板
├── TOOLS.md                 ← 工具用法
├── TODO.md                  ← 当前任务占位
├── prompt-includes.json     ← always-on 文件注入声明（5 文件）
├── .omp/
│   ├── config.yml           ← 默认 modelRoles 配置
│   ├── SYSTEM.md            ← Gateway agent 基线 system prompt
│   └── skills/              ← 技能定义（空目录）
├── knowledge/
│   ├── external-workspaces.md ← 外部数据源映射
│   ├── faq.md               ← 常见问题（空模板）
│   └── handbook/            ← 操作手册（空目录）
├── cron/
│   ├── tasks/               ← 任务定义（空目录）
│   └── logs/                ← 运行日志（空目录）
├── sessions/                ← 对话记录目录
└── .gitignore               ← Git 忽略规则
```

**规则：**

1. 仅当 `mission.md` 不存在时触发全量创建。已初始化的目录（mission.md 存在）执行 additive 更新：补充缺失的 skeleton 文件，不覆盖已有内容。
2. `mission.md` 写入通用助手占位模板，包含身份、能力、行为准则、工具使用引导，明确标注需用户编辑。
3. 所有目录（`.omp/`、`.omp/skills/`、`knowledge/`、`knowledge/handbook/`、`cron/`、`cron/tasks/`、`cron/logs/`、`sessions/`）创建为带 `.gitkeep` 的空目录。`scripts/`、`external/`、`weekly-reports/`、`examples/`、`docs/` 为用户按需创建的目录，skeleton 不预创建。
4. `.omp/config.yml` 作为 runtime 硬依赖在 skeleton 中创建，含默认 `modelRoles` 配置。`.omp/SYSTEM.md` 作为 gateway agent system prompt 基线（非空独占模板）同步创建。
5. 创建过程中任何 I/O 失败视为该 account 启动失败，错误信息明确指示路径和故障原因。
6. additive 更新不覆盖任何已存在文件的内容。
7. `.gitignore` 写入默认内容，忽略运行时数据，保留配置文件：

   ```gitignore
   sessions/
   cron/logs/
   .omp/evolution/
   .omp/*
   !.omp/config.yml
   !.omp/SYSTEM.md
   *.log
   *.bak
   ```

**设计理由：** 降低新账号的配置门槛。用户只需在 gateway.json 声明 `appKey/appSecret`，agentDir 自动就绪。mission.md 占位文件保证 omp 启动时不报错，同时引导用户定义角色。Gateway 不再重复维护 skeleton 逻辑——所有 skeleton 创建统一走 `@oh-my-pi/pi-coding-agent/skeleton`。

**AgentDir 注册：** Gateway 在创建/ensure agentDir 后调用 `registerAgent(accountId, agentDir)` 将路径写入 `~/.omp/agent/registry.json`，使 `omp agent list` 能发现 gateway 创建的 agentDirs。注册失败非致命(仅 warn 日志)。

### 6.2 mission.md

**核心文件，定义了机器人的"人格"。** omp 在启动时读取此文件作为系统提示词。

```markdown
# 运维助手

## 身份
你是公司内部的运维助手，负责监控、故障排查和日常运维操作。

## 能力
- 查询服务器状态、日志、指标
- 执行常规运维命令（需用户确认）
- 分析故障根因
- 生成运维报告

## 行为准则
- 所有操作前先解释清楚，等待用户确认再执行
- 敏感操作（重启服务、删文件）必须二次确认
- 数据脱敏：不暴露密码、token、内网 IP 到回复中

## 安全
- 日志输出中隐藏 appSecret
- 不把 token 放到会话回复中（只存 session 文件）
```

### 6.3 .omp/config.yml

**omp 配置，决定模型、主题、默认行为等。**

```yaml
# 该 agent 默认使用的模型
modelRoles:
  default: narwal-plan/minimax-m3   # 默认场景
  smol: narwal-plan/minimax-m3       # 轻量任务（文本处理、简单问答）
  slow: narwal-plan/glm-5.2          # 复杂任务（代码生成、深入分析）

# 外观主题
theme: dark
```

**模型名不写在 gateway.json 中** — 它在 `agentDir/.omp/config.yml` 的 `modelRoles.default` 里。这样每个 agent 可以独立选模型。
不写则使用 omp 全局默认（`~/.omp/agent/config.yml` 的 `modelRoles.default`）。

### 6.4 sessions/ 目录（对话记录）

**每个用户的对话保存在独立的 JSONL 文件里。**

```
sessions/
├── cid_<safeConvId>.jsonl          ← 用户A 和机器人的对话
├── cid_<safeConvId2>.jsonl         ← 用户B 和机器人的对话
└── cid_<safeConvId3>.jsonl         ← 某群聊的对话
```

文件格式（omp 原生 session 格式）：

```jsonlines
{"role":"user","content":"今天的销售数据是多少？"}
{"role":"assistant","content":"[调用函数 getSalesData]"}
{"role":"toolResult","content":"..."}
{"role":"assistant","content":"今日销售额为 ¥23,500，比昨日增长 8%。"}
```

**文件名安全：**

- conversationId 中的非字母数字字符替换为 `_`
- 太长则取前 64 字符 + hash 后缀，避免文件名过长
- 文件名只用作标识，不用于排序

---

### 6.5 knowledge/（知识库）

**可选。存放静态参考文档。**

```
knowledge/
├── faq.md                           ← 常见问题（系统会加载到 system prompt 附加上下文中）
├── handbook/                        ← 操作手册目录
│   └── server-restart.md
├── external-workspaces.md           ← 外部数据源映射
└── .gitkeep
```

**注意：** knowledge/ 不是实时更新的外部数据源，而是人工维护的静态参考。实时数据应通过工具（MCP、API）获取。

---

### 6.6 Hermes Agent 参考

Hermes Agent 是一个参考实现，其 `~/.hermes/` 目录结构与本设计的 agentDir 有相似之处：

|Hermes|本设计|说明|
|---|---|---|
|`config.yaml`（540 行，涵盖全部配置）|`.omp/config.yml` + `gateway.json`|职责拆分：agent 层面只配模型/工具，gateway 层面配账号/Channel|
|`SOUL.md`|`mission.md`|人格定义，核心文件|
|`profiles/<name>/`|`<agentDir>/` 的上一级（即 `~/.omp/agents/`）|多 profile = 多 agentDir，Hermes 的 profiles 也是独立目录|
|`cron/`|`cron/tasks/` + `cron/logs/`|定时任务定义 + 运行日志|
|`state.db`|`cron/logs/`|日志格式(SQLite vs .log 区别)|
|`sessions/`|`sessions/`|对话记录（格式不同：Hermes 是 request_dump + jsonl）|

**核心差异：**

- Hermes 一个进程服务一个 profile（通过 `--profile` 切换），本设计一个进程服务多个账号（每个账号一个 agentDir）
- Hermes 配置集中（单个 540 行 yaml），本设计配置按拆（gateway.json / .omp/config.yml / mission.md）
- Hermes 运行时文件与配置混合在同一目录，本设计运行时文件（`sessions/`、`cron/logs/`）有清晰命名空间

---

### 6.7 目录加载流程

```
Agent 启动时:
  1. 读取 .omp/config.yml        ← 模型、工具配置
  2. 读取 mission.md              ← 写入 system prompt
  3. OMP 原生 discovery 扫 root AGENTS.md  ← Manifest 触发器
     ├── 提取 MUST NOT / NEVER 行 → <hard-constraints>
     └── 剩余内容 → <context>
  4. 读取 root prompt-includes.json  ← 注入 always-on 文件
     ├── AGENTS.md
     ├── mission.md
     ├── TOOLS.md
     ├── TODO.md
     └── knowledge/external-workspaces.md
  5. 读取 .omp/SYSTEM.md         ← 覆盖 OMP 内置 system prompt（gateway agent 基线）
  6. cron 引擎扫描 cron/tasks/       ← 注册定时任务

Agent 接收消息时:
  1. 从 agentDir/sessions/ 读取或创建 session 文件
  2. omp 会话层管理上下文（compaction / pruning）
  3. 回复后追加到 session 文件
```

---

## 7. 会话隔离

### 7.1 隔离粒度

```
一个 Agent      → 管理 N 个 session 文件
                 （通过 switch_session 切换会话）

一个 session    → 对一个 IM 会话（1 个用户 DM 或 1 个群）

跨账号隔离     → Agent A 看不到 Agent B 的 session
                  （文件系统级隔离，不同 agentDir）

隔离保证:
  SQLite UNIQUE(channel_id, conversation_id)
  + agentDir 文件系统命名空间
  + RPC 进程只加载自己的 agentDir
```

### 7.2 保存位置

- session 文件：`<agentDir>/sessions/<safeConvId>.jsonl`
- session 元数据：`<agentDir>/sessions/sessions.db`（SQLite，元数据索引）

元数据表结构：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(channel_id, conversation_id)
);
```

注意：session 元数据放在 agentDir 内的 `sessions/sessions.db`（V1 实施时迁移自当前全局 `gateway-data/` 位置）。

### 7.3 session 文件命名约定

- IM 会话：`<agentDir>/sessions/cid_<safeConvId>.jsonl`(前缀 `cid_` 区分非 cron session)
- Cron 任务: `<agentDir>/sessions/cron_<taskId>.jsonl`(前缀 `cron_` + 任务 ID,见 §7.4)

### 7.4 cron 任务复用 warm bridge(无新进程)

`SchedulerEngine.#onCronTrigger(task)` 是 cron agent 任务的主入口。**当任务设置了 `accountId` 且该账号有 warm bridge 可用时,任务不 spawn 新进程,而是复用已存在的 bridge。**

完整流程:

```
┌─────────────────┐
│  Engine tick    │  SchedulerEngine 轮询 SQLite 任务表
└────────┬────────┘
         │ 1. 拉取到期任务
         ▼
┌─────────────────────────────┐
│  task.taskType === 'agent'  │
│  && task.accountId?         │  路由决策
│  && Gateway.getAccountBridge│
│     (accountId)?            │
└──────┬──────────────┬───────┘
       │              │
   warm 路径       fallback 路径
       │              │
       ▼              ▼
  ┌──────────┐   ┌────────────┐
  │ bridge.  │   │ execute-   │
  │ execute  │   │ Scheduled- │
  │ Prompt(  │   │ Command(   │
  │   …)     │   │   …)       │
  └─────┬────┘   └──────┬─────┘
        │               │
        │               ▼
        │         spawn omp --print (独立子进程)
        │         cwd = accountDir (如解析得到)
        │         + preScript + skills
        │
        ▼
  ┌────────────────────────────────────┐
  │ 1. switchSession(cron_<id>.jsonl) │  ← 独占 cron session,防污染 IM 会话
  │ 2. setModel(task.model)            │  ← 可选,任务可换 model
  │ 3. setProvider(task.provider)      │  ← 可选
  │ 4. executePrompt(task.command, {   │  ← 含 inactivity watchdog (5min 默认)
  │     timeoutMs,                     │     30min hard cap
  │     sessionPath,                   │
  │     inactivityMs,                  │
  │   })                               │
  │ 5. switchSession(priorSession)     │  ← 恢复 IM 会话(若有)
  │ 6. setModel(originalModel)         │  ← 恢复 model(若有)
  └─────┬──────────────────────────────┘
        │
        ▼
  ┌──────────────────┐
  │ deliverWithRetry │  向 task.deliver 发送结果
  │  +appendDelivery │  2 次重试,最终失败写 delivery-failures.jsonl
  │  FailureLog      │
  └──────────────────┘
```

**为什么复用 warm bridge:**

- IM agent 进程在 idle 时仍在运行(预热),新 cron 任务不需要新 fork 一个 omp 子进程
- 复用 = 省内存 + 避免冷启动 + 利用已加载的 mission / config
- 代价:必须用 exclusive lock(`#runExclusive`)保证同一 bridge 上的 IM 消息和 cron 任务不交错,必须用 per-task session 隔离状态

**为什么 session 必须切到 cron_<id>:**

- bridge 同一时刻只有一个活跃 session(`#activeSessionPath`),IM 用户可能正在该 session 上交互
- 不切 session → cron 的 user/assistant 消息会写入 IM 会话的历史 JSONL
- 切到 cron_<id>.jsonl → cron 状态独立,IM 用户的下一条消息进入自己的 session
- 任务结束后 switch 回之前的 IM session(若有)—— 保留 bridge 的 IM 上下文

**Fallback 路径不复制状态:**

`executeScheduledCommand(omp --print)` 启动新 omp 进程,从空 session 开始。所以 fallback 能 honor `preScript` 和 `skills` 字段(在 omp --print argv 里),而 warm bridge 路径不能(bridge 启动时就决定了 model / skills / preScript 的加载策略)。

**Cron 任务交接动作:** warm bridge 路径下,如果 `task.skills` 或 `task.preScript` 被设置,Gateway 记 warn 日志并建议用 fallback(fallback 能 honor 这些字段)。

**Inactivity 防御:** `executePrompt` 的 `inactivityMs` 参数启用 per-prompt watchdog(500ms 轮询)。如果 bridge 的 `lastActivityAt` 在指定窗口内没有推进(比如 RPC 等待模型超时、工具卡住、stream 断),watchdog 发 `abort` 命令并 reject。这是防止 cron 任务被卡死占用整个 wall-clock timeout 的机制,借鉴 Hermes 的 `HERMES_CRON_TIMEOUT` 默认(600s)。

**Delivery 重试与持久化:** 任务结果经 `deliverWithRetry` 发送到 `task.deliver` 通道,首次失败 5s 后重试 1 次,二次失败追加到 `~/.omp/gateway-data/scheduler/logs/delivery-failures.jsonl`(taskId / taskName / channel / userId / reason / attempts / exitCode)。任务本身的 exit code 不被交付失败污染。

**Delivery 失败可观测:** `cron list` 命令新增 DELIVERY 列,显示每个任务最近 24h 内的交付失败次数。0 = 绿色 ✓,1+ = 红色 "× N"。交付失败数与执行失败数分开追踪(`lastDeliveryError` 字段),执行成功但交付失败不会导致重试执行。

---

### 7.5 Cron 任务字段与安全机制

**任务字段（TaskFileDefinition）：**

```json5
{
  name: "daily-report",
  description: "每日销售报告",
  cron: "0 9 * * *",
  command: "请生成昨天的销售报告摘要",
  type: "agent",         // "agent" | "shell"
  accountId: "ops",      // agent 任务必填;shell 任务可选(仅用于显示)
  model: "narwal-plan/qwen3-coder-plus",  // 可选:覆盖默认模型
  provider: "narwal-plan",
  enabledToolsets: ["read", "search", "bash"],  // 工具隔离
  repeatCount: 10,       // 执行 10 次后自动禁用(null = 无限)
  timeoutMs: 300000,
  retry: { maxAttempts: 2, backoffMs: [10000, 30000] },
  skills: [],
  preScript: "",
  deliver: "dingtalk",
  deliverUser: "staff001"  // 主动推送到指定用户
}
```

**新增字段说明：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `repeatCount` | number | 总执行次数上限,达到后自动禁用任务 |
| `repeatCompleted` | number (运行时) | 已执行次数,运行时自动累加 |
| `enabledToolsets` | string[] | cron agent 任务工具隔离列表。Agent 进程中注入 `enabledToolsets` 参数,限制模型可调用的工具集,减少 token 消耗 |
| `deliverUser` | string | 主动推送目标用户 ID(对应`deliver`通道)。Gateway 通过 `channels.<id>.sendMessage(userId, text)` 将 cron 结果推送给指定用户 |
| `lastDeliveryError` | string (运行时) | 上次交付失败的错误信息,用于区分执行失败与交付失败 |

**安全性约束：**

- **`accountId` 对 agent 任务为必填:** 无 `accountId` 的 agent 任务无法使用 warm bridge,只能走 fallback `omp --print` 路径。Gateway 启动时扫描所有旧任务,`cron reconcile` 命令可批量补填缺失的 accountId。
- **工具隔离:** Agent 进程收到 `enabledToolsets` 后,只在指定工具集内推理。当前硬编码为 `["read", "search", "bash", "write", "edit", "find", "replace", "todo_write", "web_search"]`,向 agent prompt 注入 [CRON-CONTEXT] 前缀声明工具限制。
- **At-most-once 语义:** Engine 在触发执行前先将 `nextRunAt` 推进到下一次(而不是执行后再设)。若执行中进程崩溃,重启后不会重放已推进的任务。
- **Grace Window:** 任务超过 nextRunAt 的宽限期后跳过本次执行。宽限期 = 两次 cron 间隔的一半(最短 2min,最长 2h)。防止网关重启后任务积压爆炸。
- **FD 级排他锁:** Scheduler daemon 使用文件描述符级别排他锁(`flock(LOCK_EX)`)替代之前的 `mkdir` 锁,崩溃时由 OS 自动释放,不会留下残留锁文件。
- **执行记录清洗:** `delivery-failures.jsonl` 记录全局交付失败;成功后会清除任务的 `lastDeliveryError`。

## 8. RPC 协议

### 8.1 正常流程

```
AgentBridge                    Agent (omp --mode rpc)
    │                                │
    │  1. 启动进程                    │
    │─────────────────────────────→  │  stdin/stdout 建立 JSONL 通道
    │                                │
    │  2. 发送 switch_session        │
    │─────────────────────────────→  │  {"type":"command","name":"switch_session","args":{...}}
    │                                │  加载该 session 文件
    │  ←───────────────────────────  │  {"type":"ack","id":"...","ok":true}
    │                                │
    │  3. 发送 prompt                 │
    │─────────────────────────────→  │  {"type":"command","name":"prompt","args":{"messages":[...]}}
    │                                │  调用 LLM API
    │  ←───────────────────────────  │  {"type":"event","event":"text_delta","delta":"..."}
    │  ←───────────────────────────  │  {"type":"event","event":"tool_use","data":{...}}
    │  ←───────────────────────────  │  {"type":"agent_end","messages":[...]}
    │                                │
    │  4. 回复目标                    │
    │  → DingTalkChannel.send        │
```

### 8.2 并发流程

```
Gateway.start()
  │
  ├── 遍历 accounts（设计 §5.3）
  │    ├── account:A → AgentBridge X → spawn Agent A
  │    │                                     ├── cwd: agentDir/A
  │    │                                     └── stdin/stdout RPC 通道
  │    └── account:B → AgentBridge Y → spawn Agent B
  │                                          ├── cwd: agentDir/B
  │                                          └── stdin/stdout RPC 通道
  │
  ├── SessionManager（全局队列，每个 bridge 一个 Worker）
  │    ├── enqueue(msg) → 按 conversationId 排队
  │    ├── dequeue()    → 发送到对应 bridge
  │    └── 队列深度控制（§11.3）
  │
  └── SchedulerEngine(60s tick + 60s file sync)
       ├── 拉取 SQLite 任务表中的到期任务
       │    │
       │    ├─ task.taskType === 'agent' && accountId → reuse AgentBridge (warm path)
       │    │     bridge.executePrompt(cmd, { sessionPath: <agentDir>/sessions/cron_<id>.jsonl,
       │    │                                inactivityMs: computeInactivityBudgetMs(timeoutMs) })
       │    │
       │    └─ task.taskType === 'shell' || (agent && !accountId) → executeScheduledCommand
       │          spawn omp --print / sh -c (cwd: accountDir if any)
       │
       ├── <agentDir>/cron/tasks/*.json5 ↔ SQLite tasks 表(60s polling 双向同步)
       │
       └── appendExecutionLog + (交付失败时) appendDeliveryFailureLog
```

### 8.3 多账号并发

```
接上例：用户 A 找 Bot A，用户 B 找 Bot A，用户 C 找 Bot B

  accout:A (运维机器人，单 RPC 进程)
    ├── session: 用户 A 正在等待回复  ← 当前活跃
    └── session: 用户 B 排队中        ← queue depth = 1

  accout:B (HR 机器人，单 RPC 进程)
    └── session: 用户 C 正在等待回复  ← 互不阻塞
```

**关键行为:**

- 同一 account 的不同用户排队共享同一个 Agent RPC 进程
- 不同 account 的 Agent 进程完全独立，互不阻塞
- 队列深度保护在 SessionManager 层，按 account 隔离

---

## 9. 数据格式链

### 9.1 数据格式链

```
钉钉原始消息 (DingTalkRawMessage)
  ↓  parseRobotMessage()
InboundMessage (统一格式)
  ↓  Gateway.#handleInboundMessage
     ↓  权限检查
     ↓  SessionManager 排队
     ↓  AgentBridge.switchSession()  →  RPC: switch_session
     ↓  AgentBridge.prompt()         →  RPC: prompt
     ↓
reply: string | OutboundMessage
  ↓  DingTalkChannel.sendMessage
     └── AI Card（若配置）
         └── dingtalk-card.ts 流式更新

**AI Card 流式更新（v3 — OpenClaw blockList schema）：**

Gateway 在 Agent 响应过程中通过 `ForwardStreamHandlers` 收集流式事件,分阶段渲染 DingTalk AI Card:

```
prompt 开始
  ↓
创建卡片 (PROCESSING → INPUTING)  ← 首次 text_delta 到达后切换
  ↓
text_delta 流 → 追加到卡片正文块
  ↓
tool_use 事件 → card blockList.blocks[] 追加 tool/think 块
  │  ├─ tool block:  显示工具调用名称和参数预览
  │  └─ think block: 显示模型思考过程
  ↓
tool_result 事件 → 更新对应 tool 块状态
  ↓
agent_end → 卡片切换到 FINISHED,不可再编辑
```

**Card 状态机:** `PROCESSING` → `INPUTING` → `FINISHED`。状态切换失败时降级普通文本回复,不阻塞主链路。`INPUTING` 状态的首次失败不会永久跳过重试。

**blockList schema:** 使用 OpenClaw 兼容的 `msgmenu` 卡片格式,支持文字段落、思维链、工具调用等块类型。

**Long Task 进度通知:** AgentBridge 对超过阈值的 tool call(默认 3min)通过 `onLongTask` handler 发送进度 ping。AI Card 路径消费该事件展示"工具执行中..."卡片,并在后续 ping 中更新时间戳。
```

**字段映射：**

|DingTalk 字段|InboundMessage 字段|
|---|---|
|`conversationId`|`conversationId`|
|`senderId`|`userId`|
|`senderNick`|`userName`|
|`conversationType`(`1`=DM,`2`=群)|`isGroup`|
|`conversationTitle`|`conversationTitle`|
|`text.content`|`content.text`|
|`msgId`|`messageId`|
|`robotCode`|`accountId`(用于路由到对应 bridge)|

### 9.2 文件系统布局（完整）

```
~/.omp/
├── gateway.json                    ← gateway 配置（账号/Channel/Cron）
├── gateway-data/                    ← gateway 运行时状态
│   ├── gateway.pid                 ← (永久) 进程 PID
│   ├── logs/service.log            ← (永久) 服务模式 stdout/stderr
│   ├── scheduler/                  ← cron 引擎运行时状态
│   │   ├── scheduler.db            ← 任务表 + 执行记录 (SQLite WAL)
│   │   ├── tasks/                  ← SQLite 镜像的人读 .json5 任务定义
│   │   └── logs/                   ← 执行日志
│   │       ├── by-task/<slug>/<YYYY-MM-DD>.jsonl  ← 任务运行历史(per-day JSONL)
│   │       └── delivery-failures.jsonl            ← 交付失败全局记录
│   ├── sessions.db                 ← IM 会话元数据(SQLite,OMP-owned)
│   └── credentials.json            ← agent-level LLM API 凭证(如果需要)
│
└── agents/                         ← 所有 agent 的工作目录
    ├── ops/                        ← 运维机器人
    │   ├── mission.md              ← 人格
    │   ├── AGENTS.md               ← Manifest + 硬约束
    │   ├── TOOLS.md                ← 工具用法
    │   ├── .omp/
    │   │   ├── config.yml          ← 模型/工具
    │   │   ├── SYSTEM.md           ← Gateway agent 基线 system prompt
    │   │   └── skills/             ← 技能
    │   ├── sessions/               ← 对话记录(IM session + cron session 共用)
    │   │   ├── cid_*.jsonl         ← IM 会话历史
    │   │   └── cron_*.jsonl        ← cron 任务专用 session(§7.4)
    │   ├── cron/                   ← cron 任务源(用户编辑)
    │   │   └── tasks/*.json5       ← 任务定义(60s polling 同步到 SQLite)
    │   ├── scripts/                ← 脚本
    │   └── external/               ← 外部数据源
    │
    └── hr/                         ← HR 机器人
        ├── mission.md
        ├── ...
        └── external/
```

---

## 10. 关键接口

### 10.1 组件接口签名

`Gateway` 内部组件通信接口，按分层列出。

|组件|公开方法|说明|
|---|---|---|
|DingTalkChannel|`connect()`, `disconnect()`, `isConnected()`, `sendMessage()`, `onMessage()`|Channel 接口,所有 IM 平台一致|
|Gateway|`start()`, `stop()`, `handleInboundMessage()`, `sendDirectMessage()`|编排层,不直接暴露给外部|
|SessionManager|`enqueue()`, `enqueueWithMeta()`, `dequeue()`, `getQueueDepth()`|入队处理、状态查询、清理(后两个方法返回完整 meta 用于 dingtalk-formatter)|
|AgentBridge|`forward()`, `forwardWithMeta()`, `executePrompt()`, `switchSession()`, `setModel()`, `getState()`, `getSnapshot()`, `abort()`|Agent 进程管理、session 切换、prompt 发送、共用入口(IM + cron)、long task watcher(> 3min 工具调用自动通知 onLongTask)|
|SchedulerEngine|`tick()`, `onCronTrigger()`, `reconcile()`, `cronRun()`|cron 调度:tick 拉取到期任务、onCronTrigger 处理 warm path、cronRun 手动触发|

**设计原则:** 各组件只暴露 `async` 方法，不暴露内部状态(黑盒)。`SessionManager` 不感知 IM 协议，`AgentBridge` 不感知会话隔离粒度。

**AgentBridge 接口说明:**
- `forward(msg, session)` — IM 入口,处理 InboundMessage,返回 AgentResponseMeta
- `forwardWithMeta(msg, session)` — IM 入口,返回 AgentResponseMeta 用于 dingtalk-formatter
- `executePrompt(prompt, { timeoutMs?, sessionPath?, inactivityMs? })` — cron 入口,复用 warm bridge,可切到 per-task session,inactivity watchdog 防止卡死
- `switchSession(path)` — 切到指定 JSONL session(在 `#runExclusive` 锁里运行,与现有 IM/cron 提示原子)
- `setModel(provider, model)` — 动态切换模型(task model override 需要)
- `getState()` / `getSnapshot()` — 查询 bridge 状态(`gateway status` 命令使用)
- `abort()` — 中断当前活跃 prompt(IM 用户的 abort 消息和 cron inactivity watchdog 都用)

---

## 11. 错误处理与防御机制

### 11.1 错误处理

|故障点|影响|响应|
|---|---|---|
|DingTalk 断连|消息无法收发|自动重连(指数退避 1s→30s)；30s 后告警|
|Agent 进程崩溃|该 account 不可用|自动重启(指数退避 1s→30s)；持续崩溃(10 分钟 > 5 次)→停止重启,告警,进入 ERROR 状态|
|LLM 超时|当前消息失败|返回友好错误给用户；触发熔断器计数|
|Session 文件损坏|该会话无法加载|尝试恢复(取最近的完整行)；失败则新建 session|
|appSecret 未设置|该 account 启动失败|启动时检测并报错,不启动对应 bridge,不影响其他 account|
|agent.db 缺少 provider API key|该 account 的 LLM 调用失败|启动时检测并告警，提示用户通过 omp 配置凭证|
|cron 任务无 accountId|warm 路径不可用|fallback 到 executeScheduledCommand(omp --print)|
|cron warm-bridge 调用失败|任务结果不准确|catch → 记 warn → fallback 到 omp --print 重试|
|cron warm-bridge skills/preScript 被设|无法被 warm 路径 honor|记 warn 提示用 fallback(--account 不设)|
|cron 任务卡死(无事件)|持续占用 bridge|inactivity watchdog (5min 默认) abort + reject,任务报失败|
|cron 交付失败|用户收不到任务结果|deliverWithRetry 重试 1 次,二次失败写 delivery-failures.jsonl + error 日志|

### 11.2 熔断器（Circuit Breaker）

|状态|行为|触发条件|
|---|---|---|
|CLOSED|正常处理请求|默认状态|
|OPEN|直接拒绝新请求,返回"系统繁忙"|连续 10 次超时(>60s)或错误|
|HALF_OPEN|试发一条,成功则 CLOSED,失败则 OPEN|OPEN 状态后等待 30s|

### 11.3 队列深度保护

- 全局最大队列深度 `MAX_QUEUE_DEPTH = 100`
- 超过深度时新消息立即拒绝(返回"当前排队人数较多，请稍后再试")
- 按 account 内的 conversationId 排队,同 conversation 的消息顺序处理
- 深度阈值可配置(`gateway.json.cron.maxConcurrentRuns` 类似方式)

### 11.4 优雅关闭（Graceful Shutdown）

```
Gateway.stop():
  1. 断开所有 Channel（不再接收新消息）
  2. 等待队列中剩余消息处理完（30s 超时）
  3. 停止所有 AgentBridge（发送 kill SIGTERM）
  4. 关闭存储（SQLite WAL checkpoint）
  5. 进程退出
```

### 11.5 Session 文件管理

- session 文件达到 200 条消息(可配置)时触发压缩
- 压缩:保留最近的 50 条消息 + 1 条摘要消息
- 保留 session 文件开头的时间戳和 metadata 行
- 压缩期间新消息等待

### 11.6 速率限制（Rate Limiting）

- 每个用户(conversationId) 10s 内最多 3 条消息
- 超过时回复"请不要连续发送多条消息，我会依次处理"
- 滑动窗口实现

### 11.7 健康检查

- 端点:HTTP `/health` (端口 9100)
- 返回:服务状态、各 Channel 连接状态、各 bridge 状态
- 暂时不属于 V1 实现（依赖部署环境）

---

## 12. 可观测

|指标|值|告警|
|---|---|---|
|消息延迟|平均 < 30s|P99 > 60s 告警|
|Agent 进程崩溃次数|> 3/小时|告警|
|channel 断连重试次数|> 5/分钟|告警|
|消息丢弃率|> 0.01%|告警|
|消息排队深度|> 50|告警|

聚合日志格式：

```json
{"level":"info","message":"metrics","period":60,
 "messagesReceived":142,
 "messagesProcessed":138,
 "agentErrors":2,
 "avgLatencyMs":8765,
 "p99LatencyMs":30000,
 "queueDepth":3}
```

---

## 13. 未来

|能力|状态|条件|
|---|---|---|
|Agent 独立部署(V2)|设计已完成§3.3|加 agentUrl 配置,AgentBridge 网络连接模式|
|飞书/企业微信 Channel|待设计|需要社区贡献|
|Agent 共享人格(多账号同 agentDir)|待设计(V2)|配置层改 accounts 引用同一 agentDir|
|代理能力(Delegation)|部分实现 + 待扩展|目前 cron + AgentBridge 复用是 primitive 形式,SessionManager 升级为跨账号调度器可以叠加更智能的代理|
|知识库自动同步|**已实施**|`cron` 命令创建定时任务调用 `dws` 同步工具即可(不再"待设计")|
|Secrets 管理系统|待设计|OMP secrets 系统集成到 gateway|
|cron 路径硬工具限制|待设计|目前 [CRON-CONTEXT] prompt prefix 是软约束,下一步可以在 omp coding-agent 加 `--exclude-tools` flag 在 cli 层禁用部分工具|
|cron 路径独立 persona|待设计|目前 cron prompt 前缀只告诉 agent "这是 cron 任务",不能为 cron 单独定义 system prompt。下一步可让 cron 任务可指定 `persona` 字段,Gateway 自动在 prompt 里拼接额外 system prompt 块|

---
