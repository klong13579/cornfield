# OMP Intercom —— Agent 进程间通信方案与使用说明

> 状态:已实现并接入生产(gateway 内嵌 broker + omp 内置扩展)
> 历史:早期 omp2omp peers 方案(docs/plans/2026-08-14, 已删)由本实现替代,TODO「omp2omp 通信机制」由此达成

## 1. 目标

让**任意 omp 进程**相互通信:发现在线会话、发消息、等待回复(list/send/ask/reply)——
TUI 会话、gateway 账号 agent(rpc 模式)、子进程在同一网络内互通。

来源:移植 pi 生态的 **pi-intercom**(MIT,作者 Nico Bailon),本仓库 fork 自 pi,
扩展 API 已先行对齐 pi 0.84.2,因此移植零语义适配。

## 2. 架构

```
omp 会话 A(进程内)           omp 会话 B(进程内)      gateway 账号(进程内)
  intercom 内置扩展            intercom 内置扩展        intercom 内置扩展
  IntercomClient ──────────┐  ┌──────────────────────┐
                          │  │                      │
                  ~/.omp/intercom/broker.sock       │
                          │  │ (全局 socket,0600)    │
                    ┌─────┴──┴─────┐                │
                    │   broker     │◄───────────────┘
                    │  (gateway 进程内)              │
                    │  路由/mailbox/                │
                    │  presence/ask 边              │
                    └──────────────┘                │
```

- **broker(gateway 内嵌)**:单机消息路由中枢,持有在线注册表、断线 mailbox(24h)、
  ask/reply 语义校验、presence(模型/状态/上下文占比)。地址固定 `~/.omp/intercom/`
  (全局,不随 agentDir 变),所有进程连同一个 broker —— 这是跨账号互通的前提。
- **生命周期**:gateway 启动即起 broker,`gateway.stop()` 时优雅关闭;**没有独立
  broker 进程**,gateway 未运行则 intercom 不可用(连接会明确报错)。
- **扩展**:pi-intercom 作为 **omp 内置扩展**打包进二进制
  (`src/intercom-extension/`,经 `sdk.ts` inlineExtensions 挂载),二进制运行时
  无需外部依赖解析。

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| broker 宿主 | gateway 内嵌 | gateway 常驻,免 spawn/锁/自退;运维面合并 |
| broker 范围 | 全局 socket(`~/.omp/intercom`) | agentDir 隔离会形成互不相通的小网络,跨账号必须全局 |
| 扩展形态 | 内置(进二进制) | 二进制运行时动态加载外部扩展无法解析 `@oh-my-pi/*` 裸包 |
| 独立 broker 进程 | 不要 | 目标场景 gateway 常驻;无 gateway 场景暂不支持(明确报错) |
| 快捷键 | `alt+i`(原 pi 的 `alt+m` 与 omp 语音静音冲突) | 打开会话 overlay |
| 信任模型 | 本机单用户,socket 0600 | 与 omp2omp 方案一致,不做跨机 |

## 4. 能力

| 动作 | 语义 |
|---|---|
| `list` / `list-cwd` | 在线会话(id/名字/cwd/模型/状态/上下文占比) |
| `send` | 单发,可带附件(file/snippet/context),自动推断 pending ask 作为回复 |
| `ask` | 发送并阻塞等待回复(默认超时 10min,`PI_INTERCOM_ASK_TIMEOUT_MS` 覆盖) |
| `reply` | 回复当前/指定待回复 ask(自动解析目标,保持线程) |
| `pending` | 列出未回复的 inbound ask |
| `status` | 连接状态 |
| `cancel` | 撤销已发消息(实时会话发控制帧,mailbox 直接删) |
| presence | 模型/思考中/空闲/工具执行中/tool:xxx,上下文占比随心跳刷新 |
| mailbox | 目标离线时队列暂存(256 条/24h),按 id 或「显式名字+同 cwd」补投 |

协议与隐性行为:replyTo 必须匹配 pending ask(非 ask 的回复会被 broker 拒绝);
互斥 ask(双方互相等)拒绝;supersede 只能顶替同 sender→receiver 的旧消息。

## 5. 使用方式

### 5.1 工具调用(agent 视角)

```
intercom({ action: "list" })
intercom({ action: "send", to: "hr", message: "..." })          // 按名字/ID/前缀寻址
intercom({ action: "ask", to: "finance", message: "..." })      // 阻塞等回复
intercom({ action: "reply", message: "..." })                   // 回复待处理 ask
intercom({ action: "send", to: "hr", message: "...", attachments: [{ type: "snippet", name: "a.ts", language: "typescript", content: "..." }] })
```

会话命名(`/name hr`)让目标地址稳定;未命名会话用 `subagent-chat-<id>` 短别名,
重连后用显式名 + 同 cwd 匹配 mailbox。

### 5.2 TUI

- **`alt+i`**:打开会话列表 overlay(↑/↓ 选择 → 输入消息 → 发送)
- **`/intercom`**:同上(命令入口);**`/intercom-id`**:把当前会话的寻址片段插入输入框
- 收消息:带边框的 `From: <sender> (<cwd>)` 渲染;忙时走 steer 队列不打断当前工作

### 5.3 场景

- **planner-worker**:规划会话 `ask` 给执行会话,阻塞取回决定
- **跨账号业务 agent**:gateway 账号(如 hr、finance)互发,或 TUI 直接指挥账号
- **进度汇报**:worker `send` 周期回报,发方不阻塞

## 6. 配置

`~/.omp/intercom/config.json`(不存在即全默认):

```json
{
  "enabled": true,
  "confirmSend": false,
  "inboundTrigger": "always",
  "replyHint": true,
  "stableId": "optional-stable-session-id"
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `confirmSend` | false | 交互会话发送前确认 |
| `inboundTrigger` | `"always"` | `always`/`replies`/`never`:收消息是否自动触发模型 turn |
| `replyHint` | true | 收到的 ask 附回复指引 |
| `stableId` | — | 重启后保持的会话地址 |

环境变量:`PI_INTERCOM_ASK_TIMEOUT_MS`(ask 超时)、`PI_INTERCOM_LIVENESS_INTERVAL_MS`/`_TIMEOUT_MS`(心跳)。

## 7. 前置条件与排障

- **必须运行 omp-gateway**(broker 宿主)。未运行时扩展报:
  `Intercom broker unreachable ... Start omp-gateway first`
- 账号进程未入网:确认用的 omp 二进制是含内置扩展的新版(`~/.local/bin/omp`),
  然后 `omp-gateway service stop && sleep 5 && service start`
- `alt+i` 无反应:检查 config `enabled`;确认扩展工具存在(`/intercom` 命令可试)
- 会话收不到消息:对方忙时(非交互模式)自动拒绝且回复说明;`intercom({action:"status"})` 查连接

## 8. 限制

- 同机单用户网络(无跨机;跨机走 gateway/钉钉)
- gateway 停止 ⇒ broker 停止 ⇒ intercom 不可用(会话断线重连自动恢复)
- 每次重启 gateway 都会拉起 broker,socket 权限 0600,本机同用户即信任

## 9. 相关实现

- 扩展:`packages/coding-agent/src/intercom-extension/`
- broker(gateway 内嵌):`packages/omp-gateway/src/intercom/`
- API 对齐(pi 0.84.2 面):`packages/coding-agent/src/extensibility/extensions/types.ts`
- 上游:pi-intercom(npm `pi-intercom`,GitHub nicobailon)