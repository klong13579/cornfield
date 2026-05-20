# 钉钉 + OMP dws 集成方案 V2.0

| 项 | 说明 |
|---|------|
| 文档版本 | V2.0 |
| 状态 | 设计草案 — 待评审 |
| 基础决策 | (a) 先上 dws Skill 集成到现有 omp 通道 (b) 出站一致用 dws (c) `omp --mode rpc` 需要实现 |

---

## 1. 设计原则

- **代码不动 pi-gateway**（目前阶段）。现有 pi-gateway 保留不动，重心放在 coding-agent 内部
- **dws 作为一等工具**。与 `bash`、`python`、`ask` 同级，agent 可在推理中直接调用
- **技能驱动**。通过 SKILL.md + Tool 实现，agent 在 prompt 指导下自主使用 dws
- **出站入站统一栈**：入站通过后续的 RPC 模式，出站通过 dws

---

## 2. 阶段划分

```
Phase 1 ──→ dws Tool + Skill（在交互 / headless 模式下可用）
   │
   ▼
Phase 2 ──→ omp --mode rpc 常驻（为常驻接入铺路）
   │
   ▼
Phase 3 ──→ 打通钉钉 ↔ omp 全链路（Stream 入站 + rpc + dws 出站）
```

---

## Phase 1 — dws Tool + Skill

### 目标

在 coding-agent 的工具系统中注册 `dws` 工具，让 agent 能在推理中通过自然语言直接操作钉钉能力（搜索联系人、查日程、发消息、操作文档等），**无需`pi-gateway`介入**。

### 文件改动

| 文件 | 变更 |
|------|------|
| `packages/coding-agent/src/tools/dws.ts` | **新建** — DwsTool 类，实现 AgentTool 接口 |
| `packages/coding-agent/src/tools/index.ts` | 注册 DwsTool |
| `packages/coding-agent/src/prompts/tools/dws.md` | **新建** — 工具描述 prompt（指导 agent 何时用、怎么用 dws） |
| `packages/self-evolution/src/skill-batch-format.ts` | 补全 dws skill 的质量标准（已存占位，需细化） |

### DwsTool 设计

```typescript
class DwsTool implements AgentTool<typeof dwsSchema, DwsToolDetails> {
  readonly name = "dws";
  readonly label = "DingTalk";
  
  // 参数：dws 子命令 + 其参数
  readonly parameters = dwsSchema;
  // {
  //   command: string;      // 如 "contact user search"
  //   args: Record<string, string>;  // 如 { query: "张三" }
  //   flags: string[];      // --format json, --dry-run 等
  // }
}
```

执行流程：

```
agent 调用 dws tool →
  验证 dws 二进制可用（$ which dws／dws auth 状态）→
  构造 CLI 参数 → spawn `dws <command> <args> --format json` →
  解析 JSON stdout →
  缓存结果（查询结果如 userId、conversationId 等可在后续步骤复用）→
  返回结构化文本给 agent
```

### 安全措施

- `--dry-run` 先行：对写操作（发送消息、创建日程、删除记录）强制先 dry-run 预览
- `--yes` 自动加：对确认提示跳过（agent 模式必需）
- 路径校验：`@file` 注入只在 cwd 安全路径内允许
- 敏感命令（DING、审批操作）在 prompt 层面约束 agent 必须征得用户同意

### SKILL.md prompt

`packages/coding-agent/src/prompts/tools/dws.md` 内容框架：

```
## dws CLI — DingTalk Workspace

### 使用条件
- 用户要求操作钉钉（搜索联系人、发消息、查日程、管理待办、操作文档等）
- 需要读取或写入钉钉内的数据

### 前提检查
1. dws 是否已安装（`which dws`）
2. 是否已登录（`dws auth status --format json`）
3. 如未登录，引导用户执行 `dws auth login --device` 或 `dws auth login`

### 常用命令映射

| 用户意图 | dws 命令 |
|---------|---------|
| 搜索联系人 | `dws contact user search --query <name>` |
| 查看日程 | `dws calendar event list` |
| 创建日程 | `dws calendar event create ...` |
| 发群消息 | `dws chat message send-by-bot --robot-code ... --group ...` |
| 搜索钉钉文档 | `dws doc search --query <keyword>` |
| 创建待办 | `dws todo task create --title ...` |
| 操作多维表 | `dws aitable record query / create / update` |

### 安全规则
- 写操作（create / update / delete / send）必须先 `--dry-run`
- 发送消息必须让用户确认内容和接收方
- 获取的 userId / conversationId 等标识符缓存复用，避免重复查询

### Schema 自省
- 不确定参数时使用 `dws schema <command>` 查询参数结构
```

### 交互模式下的渲染

TUI renderer 叠加渲染：

```
╭─ DingTalk ─────────────────────────────╮
│                                        │
│  contact user search — 查询联系人       │
│                                        │
│  └─ 张三                               │
│     ├─ 张三 (张经理) · 研发部           │
│     │   userId: 0813xxxx               │
│     └─ 张三丰 (架构师) · 基础架构       │
│         userId: 1723xxxx               │
│                                        │
│  ✅ 查询完成，共 2 个结果               │
╰────────────────────────────────────────╯
```

### 验收标准

- [ ] `omp -p "帮我查张三的钉钉联系方式"` → 返回联系人信息
- [ ] `omp -p "今天有什么日程"` → 返回日历事件列表
- [ ] `omp -p "给测试群发消息说项目已发布"` → dry-run 预览后执行
- [ ] 未安装 dws 时给出明确的安装引导

---

## Phase 2 — omp --mode rpc

### 目标

在 coding-agent 中实现 RPC 模式，使 omp 能作为常驻后台进程运行，通过 stdin/stdout 或 Unix socket 接收 JSON 格式的请求，返回流式或批量响应。

这是 Phase 3 的前置条件：pi-gateway（或等价的 Stream 接入层）需要通过 RPC 协议与 omp 通信，而非每次 spawn 一个子进程。

### 协议设计（JSON-RPC 2.0 over stdin/stdout）

```
→ {"jsonrpc":"2.0","id":"1","method":"chat","params":{"message":"你好","sessionId":"conv_xxx","userId":"staff_xxx","conversationId":"cid_xxx"}}
← {"jsonrpc":"2.0","id":"1","result":{"content":"你好！有什么可以帮你的？"}}
```

**方法列表（首批）**：

| 方法 | 说明 |
|------|------|
| `chat` | 单轮/多轮对话。`params`: `{message, sessionId?, userId?, conversationId?}` |
| `chat/stream` | 流式对话，通过多次 response 返回 |
| `session/list` | 列出活跃会话 |
| `session/close` | 关闭会话 |
| `ping` | 心跳探测 |

### 文件改动

| 文件 | 变更 |
|------|------|
| `packages/coding-agent/src/modes/rpc/` | **新建** — 目录 |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | **新建** — RPC 服务端（JSON-RPC 2.0 dispatch） |
| `packages/coding-agent/src/modes/rpc/transport.ts` | **新建** — stdin/stdout 或 socket transport |
| `packages/coding-agent/src/modes/rpc/client.ts` | **新建** — 客户端封装（供 pi-gateway 或其他调用方使用） |
| `packages/coding-agent/src/cli.ts` | 注册 `--mode rpc` flag |

### 执行流

```
omp --mode rpc [--port <port>] [--socket <path>]

初始化：
  1. 加载 config、初始化 session manager
  2. 启动 transport（stdin/stdout or unix socket）
  3. 等待 JSON-RPC 请求

每条请求：
  1. 解析 method + params
  2. 路由到对应的 handler（chat → agent.processMessage）
  3. 执行 agent 推理（复用已有 Session / ToolRegistry）
  4. 返回响应（普通或流式）

进程管理：
  - 心跳超时（60s 无任何请求 → 优雅退出）
  - SIGTERM/SIGINT 处理
  - maxConcurrentSessions 限流
```

### 与现有模式的差异

| 维度 | print 模式 | rpc 模式 |
|------|-----------|----------|
| 进程 | 每次命令创建 | 常驻 |
| 会话 | `--resume`/`--no-session` | 通过 `sessionId` 管理 |
| 输入 | 命令行参数 + pipe | JSON-RPC |
| 输出 | stdout | JSON-RPC response |
| 流式 | 不支持（等待完成） | 支持 stream/chunk |
| 适用 | 交互式终端 | 网关、后台、CI |

### TUI 不做、复用现有的

rpc 模式不启动 TUI，不渲染界面。TUI 集成交由交互式模式处理。

### 验收标准

- [ ] `echo '{"jsonrpc":"2.0","id":"1","method":"chat","params":{"message":"你好"}}' | omp --mode rpc` → 返回 JSON 响应
- [ ] 支持多会话隔离（不同 sessionId 不串）
- [ ] 支持流式 chat（逐步返回 token）
- [ ] 心跳超时自动退出
- [ ] SIGTERM 优雅终止进行中的推理

---

## Phase 3 — 打通全链路

### 目标

将 DingTalk Stream 入站、omp RPC、dws 出站连接为一条完整链路。

### 架构

```
钉钉用户
   │
   ▼  Stream WebSocket
pi-gateway（或等价的轻量 shim）
   │
   ▼  JSON-RPC over stdin/stdout or socket
omp --mode rpc（常驻）
   │
   ▼  dws chat message send-by-bot
钉钉用户收到回复
```

### 与 V1.1 设计方案的关系

- **Stream 入站**：继续用 pi-gateway 的 `channels/dingtalk.ts`，修复 Token 获取和协议对齐
- **OMP 桥接**：从 spawn `omp -p` 改为连接本地 RPC 端口/进程
- **出站**：替换 REST API 为 spawn `dws chat message send-by-bot`（已对齐 ADR-1）
- **配置**：`gateway.json` 的 `agent.ompPath` 增加 `omp --mode rpc` 启动逻辑

### 增量改动

| 模块 | 变更 |
|------|------|
| `pi-gateway/src/channels/dingtalk.ts` | 修复 Token 获取（OAuth 2.0 设备流）、对齐 Stream SDK 协议 |
| `pi-gateway/src/agent-bridge.ts` | 从 spawn `omp -p` 改为 `rpc-client.send("chat", ...)` |
| `pi-gateway/src/gateway.ts` | 启动时 spawn `omp --mode rpc` 子进程，管理其生命周期（探测、重启） |
| 出站 | 从 REST API 改为 `dws chat message send-by-bot` |

### 验收标准

- [ ] 钉钉群里给机器人发消息 → 机器人回复 omp 的推理结果
- [ ] 多会话不串（不同 conversationId 对应不同 session）
- [ ] 出站消息一致走 dws，不走 REST API
- [ ] omp RPC 崩溃后 pi-gateway 自动重启

---

## 3. 关键决策记录

| ID | 决策 | 理由 |
|----|------|------|
| D1 | Phase 1 dws 工具集成到 coding-agent，不依赖 pi-gateway | 最大复用现有通道，快速验证 dws 通路 |
| D2 | 出站一致用 `dws chat message send-by-bot` | 对齐 ADR-1，网关不持有开放平台业务 token |
| D3 | RPC 协议选 JSON-RPC 2.0 over stdin/stdout | 最简实现，无需端口分配，无外部依赖 |
| D4 | Phase 2 rpc 模式不带上 TUI | rpc 模式设计目标是非交互场景（后台/网关） |
| D5 | Stream 入站保留 pi-gateway，不改其结构 | 聚焦 delta，重写 gateway 通道非当前目标 |

---

## 4. 风险与缓解

| 风险 | 缓解 |
|------|------|
| dws CLI 行为变更导致工具失效 | dws 命令输出解析用 `--format json` + `--jq` 精确提取，减少对输出顺序依赖 |
| 多 dws 命令串行执行慢 | 无状态的查询可并行 `Bun.spawn`，rpc 模式下可做连接池 |
| Stream 协议复杂性高于预期 | Phase 3 留够 buffer，先以 polling `dws chat message list` 兜底 |
| RPC 模式 Session 状态管理复杂 | 复用现有 `SessionManager`，rpc 内只做 JSON 序列化包装 |