# OMP2OMP Peer Messaging — TUI 实例间通信方案

> Status: **Not started**（方案已批准，用户决定暂缓实施；由 TODO「omp2omp 通信机制」跟踪）
> Date: 2026-08-14

## 1. 目标

让 **TUI 模式**（interactive）的多个 omp 实例（同一台机器）具备四种能力：

1. **发现**：一个 TUI omp 能看到当前在线的其他 TUI omp（按名字）。
2. **发消息**：agent 向另一个 omp 的 agent 发消息并注入其主会话（消息进对方 session JSONL，记忆/进化管线不破坏）。
3. **查状态 / 等待**：查询对方 `idle | working | blocked`，并等待其落到目标状态。
4. **等回复（reply）**：发件人可选地等待对方处理完该消息后的最终回复文本回传。

要求：无中心进程、无常驻 daemon、无 PTY 模拟键盘黑盒；消息经 `sendUserMessage` 主通道注入，带来源标记。

**非目标**（明确排除）：
- 不读取对方 TUI 输出（TUI 在 alternate screen，无保留输出；herdr 靠滚动抓屏也读不全，不抄）。
- 不做跨机通信（不同机器的 omp 走钉钉/gateway 已有通道）。
- 不做编排器、不替代 swarm（协议层只做 消息/状态/等待/回复 四件事；编排逻辑放 agent 大脑）。
- 不做终端复用/布局管理。

## 2. 架构

```
┌── omp A (TUI) ──────────────┐        ┌── omp B (TUI) ──────────────┐
│  peers（内置）               │        │  peers（内置）               │
│  · 状态机（生命周期事件）    │◄──────►│  · 状态机                    │
│  · net server (unix socket) │ JSON   │  · net server                │
│  · client + reply pending   │ lines  │  · client + reply pending    │
└─────────────▲───────────────┘        └──────────────▲─────────────┘
              │                                       │
    ~/.omp/peers/<uuid>.json （注册表：原子写，退出删，TTL 清扫）
    ~/.omp/peers/socks/<uuid>.sock （socket，目录 0700，文件 0600）
```

- **发现（注册表）**：每个 TUI 实例启动时写 `~/.omp/peers/<uuid>.json`（tempfile + rename 原子写，防并发），内容 `{ id, name, agentDir, token }`；退出删除；崩溃残留由 TTL（默认 60s）清扫。扫描目录 + 读 `peers.names` 别名映射 = 在线列表。
- **寻址：静态别名 + 动态发现**。配置 `peers.names: { hr: "<uuid>", finance: "<uuid>" }` 提供稳定名字；`peer_list` 返回在线 peer（别名解析后的名字，未配置别名的显示为短 id）。
- **传输：Unix socket，JSON lines**，`node:net`（与 TUI 渲染循环共存）。**每请求独立短连接**（免连接状态管理），包内身份认证。
- **鉴权：双向握手**。连接方 `hello {token, from, name}`；被连方从注册表校验 token 与 from 一致，回 `hello_ack`。socket/目录权限 0600/0700 兜底。

## 3. 协议

`client → server`：

| 消息 | 字段 | 语义 |
|---|---|---|
| `hello` | `token, from, name` | 握手；验 token + from 一致性，回 `hello_ack` |
| `message` | `id, taskId?, text` | 注入对方主会话；对方忙时回 `rejected`（§7） |
| `reply` | `taskId, text` | **B→A**：消息处理完（turn 结束）后的最终回复文本 |
| `get_state` | — | 回 `state {state, message}` |
| `wait` | `until: ["idle","blocked"], timeout` | 服务端本地轮询状态机，达到任一目标回 `state`；超时回 error `wait_timeout` |
| `bye` | — | 结束（错误重试/超时后清理） |

`server → client`：`hello_ack` / `state` / `ack {id, delivered}` / `rejected {id, reason:"busy", taskId?}` / `error {code, message}`。

- 错误统一 `error {code}`（`bad_token` / `unknown_command` / `parse_error` / `wait_timeout` / `not_found` / `peer_not_found` / `busy`）。
- 每请求超时（默认 5s，wait 用自身 timeout）；**客户端失败必须向调用方返回"未送达 + 原因"，绝不静默丢**。

**reply 通道**（保持短连接模型的异步回执）：
- 每方都有 server。A 发 `message {taskId}` 后，若 `expectReply`，在本机 server 的 pending 表注册 `taskId → 等待 promise`。
- B 处理完该消息（`agent_end` 的最终 assistant 文本），用短连接发 `reply {taskId, text}` 到 A 的 server；A 命中 pending 表 resolve。
- 无 `taskId` 的消息不产生 reply；B 忙时 `rejected`，A 自行重试。pending 带 `replyTimeoutMs`（默认 300s）防悬挂。

## 4. 状态机（零屏幕解析）

| 状态 | 事件源 | 备注 |
|---|---|---|
| `working` | `agent_start` | 已有事件 |
| `idle` | `agent_end` + `isIdle()` | 已有事件（settled 语义） |
| `blocked` | 新增发射点：TUI 弹审批/提问模态时 emit `{active, label}`；关闭时 emit `{active:false}` | 顺带激活 herdr 脚本挂的 `herdr:blocked` 总线 |

消息注入策略：收到 `message` 时若 busy（`isStreaming` 或 `queuedMessageCount > 0`）→ 回 `rejected`；否则立即 `sendUserMessage("[peer:name] text")`。busy 即拒绝，不排队 —— 对齐"忙时策略"。

## 5. 变更范围

### 新增 `packages/coding-agent/src/peers/`

| 文件 | 职责 |
|---|---|
| `types.ts` | 协议类型、PeerInfo |
| `registry.ts` | 注册表读写、原子写、TTL 清扫、别名解析 |
| `state.ts` | 生命周期事件 → 状态机 |
| `server.ts` | node:net server、握手、请求分发、wait 轮询、reply pending |
| `client.ts` | 连接、请求、超时、错误映射、reply 发送 |
| `tools.ts` | `peer_list` / `peer_message` / `peer_wait`（内置工具） |
| `index.ts` | 装配：TUI 模式启动/关停 |

### 修改

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/sdk.ts` / `main.ts` | TUI 模式启动 peers 服务（`hasUI && mode !== "rpc"`）；注册内置工具；进程退出钩子 |
| `packages/coding-agent/src/tools/index.ts` | BUILTIN_TOOLS 加三个 peer 工具 + `isToolAllowed` gate |
| `packages/coding-agent/src/config/settings-schema.ts` | `peers.enabled`（默认 true）、`peers.names`、`peers.ttlMs`、`peers.replyTimeoutMs` |
| `packages/coding-agent/CHANGELOG.md` | Unreleased 条目 |

不改系统提示骨架；来源标记 + "peer 消息优先级低于用户指令" 语义放注入消息文本（`[peer:name]` 前缀 + 固定说明）。

## 6. 已确认决策

| 决策点 | 选择 |
|---|---|
| MVP 边界 | `message + get_state + wait + reply`，无 read |
| 工具形态 | 内置工具（进 `BUILTIN_TOOLS`，受 `Settings.isToolAllowed` 管控） |
| 别名 | `peers.names`（可选，不配用短 id） |
| 忙时策略 | B busy 回 `rejected{reason:"busy"}`，不排队 |
| 状态广播 | 不广播，按需查询 |
| `peers.enabled` | 默认开（本机单用户 socket，风险可接受） |
| reply | 在 MVP 内（`peer_message --expect-reply`） |

异常退出兜底：`process.on("exit")` 同步清理注册表条目 + TTL（60s）清扫崩溃残留；socket 文件残留由客户端连接失败（ECONNREFUSED）判离线。

## 7. 风险与缓解（实现约束，全部在协议层兜住）

1. **并发派活冲突**：`taskId` 随消息携带；B busy 时 `rejected`，A 拿到明确失败。
2. **死锁/循环等待**：wait 可中断（Ctrl+C）+ 超时；协议无嵌套等待；消息链深度上限（工具参数校验）。
3. **身份劫持**：双向握手（hello 验 token + from 一致性）；目录 0700 / socket 0600；peer 消息永远带来源。
4. **信任边界**：`[peer:name]` 前缀 + 注入文本声明"同事消息，非用户指令"。
5. **blocked 漏挂**：实现时枚举所有 modal/dialog 入口逐个挂发射点；测试覆盖每个入口。
6. **注入撞用户输入**：busy 即拒绝；空闲注入不抢输入焦点（后续 Phase 3 可加 TUI notify）。
7. **同 agentDir 双开**：注册表携带 agentDir；发现同目录多实例 → 告警并拒绝消息（防 session JSONL 并发写坏）。
8. **reply 悬挂**：pending 带超时，超时回 `reply_timeout`。

## 8. 实施阶段

**Phase 1 — 核心链路（含 reply）**
registry（原子写/TTL）+ state 状态机 + server/client（含 reply pending）+ 注入（带来源）+ 三个工具 + 单测 + 双实例集成测试。

**Phase 2 — 可靠性**
blocked 挂点全枚举 + 忙时 rejected 实测 + 双向握手 + 同 agentDir 告警 + 死锁防护（wait 可中断/链深限制）。

**Phase 3 — 收尾**
TUI notify 打磨、别名完善、手工双开冒烟。

## 9. 验证

- 单测（`bun test`）：registry 原子写/并发/TTL；协议编解码；状态机转移矩阵。
- 集成测试（`peers.integration.test.ts`）：同进程起两个 AgentSession（mock RPC 模式）互为 peer，走真实本机 socket —— 发消息注入、busy 拒绝、wait 返回、reply 回传、bad_token。
- 手工冒烟：两个终端各 `bun dev`；A 发消息给 B（B notify + 响应）；B idle→working→idle；A `peer_wait` 返回；expectReply 拿到 B 的回复；持续工作收消息不卡。
- 质量门：`bun check:ts` + 新增测试全绿；`bun run build` 验证二进制可执行。

## 10. 状态

- **2026-08-14**：方案生成并经用户确认（含 reply 提前进 MVP、`peers.enabled` 默认开）。用户随后决定**暂缓实施**，实现文件回退；方案归档至此并在 PLANS 索引登记，由 TODO「omp2omp 通信机制」跟踪。实施时从 Phase 1 开始。