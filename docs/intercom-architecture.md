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
- **可靠性**:socket 文件被外部删除(误删/残留清理)时,broker 内置 watchdog
  (默认 15s 探测一次)自动 rebind 恢复——rebind 会断开全部现有连接并让客户端
  重连;`stop()` 只清理本实例真正绑定的 socket(被活 owner 拒绝的实例不会误删
  他人 socket 文件)。
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
| `children` | 本会话的子会话列表(声明了本会话为父的在线会话,含实时状态) |
| `send` | 单发,可带附件(file/snippet/context),自动推断 pending ask 作为回复 |
| `ask` | 发送并阻塞等待回复(默认超时 10min,`PI_INTERCOM_ASK_TIMEOUT_MS` 覆盖);**子模式下不带 `to` 时默认发给父** |
| `reply` | 回复指定待回复 ask(显式 `replyTo` 优先,始终带 correlation id;多条 pending 未指定时 fail loud 报错,不再按会话状态隐式猜测),保持线程 |
| `pending` | 列出未回复的 inbound ask |
| `status` | 连接状态 |
| `cancel` | 撤销已发消息(实时会话发控制帧,mailbox 直接删) |
| presence | 模型/思考中/空闲/工具执行中/tool:xxx,上下文占比随心跳刷新 |
| mailbox | 目标离线时队列暂存(256 条/24h),按 id 或「显式名字+同 cwd」补投;驱逐(超容量)与过期(24h)时向发送方回 `delivery_failed`,不静默丢件 |
| 父子边 | 子注册时声明 `parentId`(父的目标名/sessionId),broker 全量广播保留该字段;父侧子表随 presence 事件增量维护 |

协议与隐性行为:replyTo 必须匹配 pending ask(非 ask 的回复会被 broker 拒绝);
互斥 ask(双方互相等)拒绝;supersede 只能顶替同 sender→receiver 的旧消息。

## 5. 使用方式

### 5.1 工具调用(agent 视角)

```
intercom({ action: "list" })
intercom({ action: "children" })                   // 我的子会话列表(监控子 omp 状态)
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
- 收消息:带边框的 `From: <sender> (<cwd>)` 渲染;忙时**默认走 follow-up 队列,当前回合结束后处理**——不 abort 在途工具、不 skip 剩余工具、不打扰阻塞中的 ask;要旧打断语义需显式配 `inboundMode: "interrupt"`

### 5.3 场景

- **planner-worker**:规划会话 `ask` 给执行会话,阻塞取回决定
- **跨账号业务 agent**:gateway 账号(如 hr、finance)互发,或 TUI 直接指挥账号
- **主 omp 监控子 omp(父子编排)**:主会话通过 `send ... openProjectPaneIfMissing: true` 拉起
  子 omp 时,子进程启动注入 `PI_SUBAGENT_ORCHESTRATOR_TARGET` / `_SESSION_ID` / `_RUN_ID` /
  `_CHILD_AGENT` / `_CHILD_INDEX`,完成三件事:
  1. 子注册时携带 `parentId`,主会话 `intercom({ action: "children" })` 即可看到全部在线的子
     (状态/上下文占比随 presence 实时刷新,不轮询);
  2. 子每完成一个任务回合(`agent_end`)自动向父发送结构化完成报告(5s 防抖,标题
     「Subagent completed its task round.」+ Run/Agent/Child index),无需子记得主动汇报;
  3. 子的 `ask` 不带 `to` 时自动路由给父裁决;`contact_supervisor`(need_decision /
     progress_update / interview_request)因注入的 env 自动激活,父的裁决以 reply 返回。
  子重启后(重连)parentId 不变,主侧子表自动恢复;父离线时完成报告 best-effort 丢弃,
  不阻塞子自身流程。

  **gateway 账号当子**:`~/.omp/gateway.json` 的账号配置加 `intercomParent`
  (父的目标名或 stableId,通常是操作者 TUI 会话的 `/name` 或 `stableId`),该账号
  的 agent omp 启动时即注入 `PI_SUBAGENT_*` 元数据并注册为父的子——主会话同样
  `children` 可见、收到自动完成报告、可裁决其 `contact_supervisor` 升级。

```json
{
  "accounts": {
    "hr": {
      "appKey": "...",
      "appSecret": "...",
      "intercomParent": "main"
    }
  }
}
```

## 6. 配置

`~/.omp/intercom/config.json`(不存在即全默认):

```json
{
  "enabled": true,
  "confirmSend": false,
  "inboundTrigger": "always",
  "inboundMode": "queue",
  "replyHint": true,
  "stableId": "optional-stable-session-id"
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `confirmSend` | false | 交互会话发送前确认 |
| `inboundTrigger` | `"always"` | `always`/`replies`/`never`:收消息是否自动触发模型 turn |
| `inboundMode` | `"queue"` | `queue`/`interrupt`:忙时收消息的处理策略——`queue` 排到当前回合结束(默认,不打断),`interrupt` 立即 steer 打断(旧行为,会 abort 在途工具并跳过剩余工具) |
| `replyHint` | true | 收到的 ask 附回复指引(始终携带显式 `replyTo`) |
| `stableId` | — | 重启后保持的会话地址 |

环境变量:`PI_INTERCOM_ASK_TIMEOUT_MS`(ask 超时)、`PI_INTERCOM_LIVENESS_INTERVAL_MS`/`_TIMEOUT_MS`(心跳)。

## 7. 前置条件与排障

- **必须运行 omp-gateway**(broker 宿主)。未运行时扩展报:
  `Intercom broker unreachable ... Start omp-gateway first`
- 账号进程未入网:确认用的 omp 二进制是含内置扩展的新版(`~/.local/bin/omp`),
  然后 `omp-gateway service stop && sleep 5 && service start`
- `alt+i` 无反应:检查 config `enabled`;确认扩展工具存在(`/intercom` 命令可试)
- 会话收不到消息:对方忙时(非交互模式)自动拒绝且回复说明;`intercom({action:"status"})` 查连接
- **会话偶发掉线**:broker 重启 / SIGKILL / 事件循环停顿 >5s(心跳超时)都会触发
  自动重连,1~40s 内恢复,无需手动干预;长期不恢复先检查 gateway 是否在运行
- **send 报 "does not fit" / delivery_failed "frame limit"**:消息超过 1 MiB
  帧上限(含附件与会话信息包装),拆小再发

## 8. 限制与可靠性边界

- 同机单用户网络(无跨机;跨机走 gateway/钉钉)
- gateway 停止 ⇒ broker 停止 ⇒ intercom 不可用(会话断线重连自动恢复)
- 每次重启 gateway 都会拉起 broker,socket 权限 0600,本机同用户即信任
- **帧上限 1 MiB**:发送与转发两侧对称执行。超限消息在写侧本地拒绝(send 报错
  "does not fit");broker 转发前对实际转发帧预检——消息体 + 会话信息包装后
  超限时回 `delivery_failed`(reason 含 frame limit),接收方不受牵连
- **写缓冲上限 8 MiB/连接**:接收方长时间不读导致缓冲堆积超限时断开该连接
  (客户端自动重连恢复),防止单连接拖垮进程内存
- **速率限制**:每连接 240 token、120/s 回充。超限帧回 `error` ack 但不断连;
  连续拒绝 50 帧(持续洪水特征)才断开——一次性批量发送(如 260 条通知)
  只会被节流不会掉线
- **掉线自愈**:优雅关闭 2s 内感知断线;SIGKILL/崩溃(无 FIN)由 liveness 心跳
  (30s 间隔/5s 超时,`PI_INTERCOM_LIVENESS_INTERVAL_MS`/`_TIMEOUT_MS` 覆盖)
  兜底,最迟 ~35s 感知;重连退避 1s→30s 无限重试,broker 恢复即自动入网

## 9. 相关实现

- 扩展:`packages/coding-agent/src/intercom-extension/`
- broker(gateway 内嵌):`packages/omp-gateway/src/intercom/`
- API 对齐(pi 0.84.2 面):`packages/coding-agent/src/extensibility/extensions/types.ts`
- 上游:pi-intercom(npm `pi-intercom`,GitHub nicobailon)

## 10. 测试闭环

一次跑全:根目录 `bun run test:intercom`(或分包跑)。三层各锁不同的失效模式,覆盖率侧重并发语义:

| 层 | 位置 | 覆盖 | 门控 |
|---|---|---|---|
| 单元(路由/决策层,无 broker) | `packages/coding-agent/test/intercom-extension/{reply-tracker,inbound-concurrency}.test.ts` | 串话消歧:`resolveReplyTarget` 显式 replyTo 优先、≥2 pending fail loud、过期 prune;busy 投递决策:`resolveInboundDeliveryMode`/`buildInboundDeliveryOptions`/`buildReplyCommand`(hint 恒带 correlation id、busy 默认 followUp) | 无,默认跑 |
| 集成(真实 broker + 真实 client,无 LLM) | `packages/omp-gateway/test/intercom-inbound-concurrency.test.ts`(并发 ask/reply 通路:双子并发 ask、replyTo 各归其位无串话、互斥 ask deadlock 拒绝、同源双 ask 独立边、stale reply 拒绝、cancel 隔离、父并行 ask demux)、`intercom-parent-child.test.ts`(父边契约) | 无,默认跑 |
| 端到端(真实 omp rpc 子进程 + 真 LLM) | `packages/omp-gateway/test/intercom-parent-child-e2e.test.ts`(child 注册/完成报告/contact_supervisor 闭环) | `E2E=1` |

单元层保证路由决策,集成层保证 broker 消息通路与并发语义(这是修复串话/抢断/多槽 waiter 的底层契约),e2e 层保证真实子进程全链路。纳入 CI:`bun run ci:test:full` 自动包含前三者,e2e 层按需 `E2E=1 bun test`。