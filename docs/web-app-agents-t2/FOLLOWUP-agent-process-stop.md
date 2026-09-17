# 后续票：agent 进程级启停（start / stop）

> 由票 09（T2，agent 进程操作入口）落出。状态：**缺口，未实现**。
> 移交对象：squad-20260918-webapp-agents 协调者（web-diag）—— 请据此建正式 issue 并排期。

## 背景

票 09 探明：服务端 wire 命令面（`packages/pi-wire/src/commands.ts`）只有 `attach` / `detach`，
**没有 agent 进程级 start / stop / restart**。现有的「启停」是钉钉 tab 的账号 `enabled` 开关
（`set_gateway_account` 写 `gateway.json`，热生效的是 gateway bridge，不是 agent 进程）。

detach 只是「释放一个已 attached 的进程内实例」，且**忙态拦截**（有会话在跑不许拆）。当一个
agent 跑挂 / 需要强制重启时，当前没有对应命令 —— 这是本缺口要补的。

## 建议命令契约（待实现方确认，非本票交付）

### `stop_agent`

```ts
| { id?: string; type: "stop_agent"; sessionId: string; force?: boolean }
```

- `sessionId`：定向注册表 agent（与其它定向命令同语义：Agent 名或附件地址）。
- `force`（可选，缺省 `false`）：
  - `false`：优雅停止 —— 有会话在跑（phase busy）时 `ok:false`，原因可见（如
    `agent is busy: <id> (force=true to stop)`）；空闲时停掉并释放进程内实例。
  - `true`：强制停止 —— 中断正在进行的 turn（对应底层 session 的 abort / dispose）。
- 返回：`{ stopped: boolean; phase?: string }`（`stopped:false` + 原因在 error 上）。

### `start_agent`

```ts
| { id?: string; type: "start_agent"; sessionId: string }
```

- 语义与 `attach` 互补：`attach` 是「lazy 挂载会话实例」，`start_agent` 是「显式拉起这个
  agent 的进程内实例」（对已 stopped 的 agent）。是否与 `attach` 合并、还是独立命令，由实现方
  在 serve 侧定（本票不替实现方拍板）。

### 返回结构（两类命令共用）

```ts
{ ok: boolean; error?: string; agentId?: string; phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool" }
```

## 缺口记录

- 服务端：`wire-server.ts` 无 `stop_agent` / `start_agent` 分支；`SessionRegistry` 无对应的
  stop/start 方法（`detach` 之外没有「强制中断在跑会话」的公开语义）。
- 前端：无 `PiClient.stopAgent/startAgent`、无 UI 入口。
- 权限/占用语义需在实现时定义：stop 一个有连接聚焦（active）的 agent，与 detach 一样需要
  明确阻止或确认，不能悄悄打断别人正在看的会话。

## 判据（实现时的验收）

- [ ] `stop_agent` / `start_agent` 在 wire 命令面 + serve 实现，命令名与上表一致或实现方已改并在
      这里回写。
- [ ] 忙态非 force stop 被阻止，原因可见；force stop 中断在跑 turn 且列表状态同步回 idle/stopped。
- [ ] 未知 agent / 占用（active on a connection）/ 无权限三类失败路径有可见原因。
- [ ] 前端有对应入口（与 detach 同一 UI 语义：有会话时明确阻止或确认）。

## 本票边界

本票（09/T2）**不实现**上述命令，只交付契约 + 缺口记录 + 本后续票。detach 那条链（接口 →
adapter → store → UI）已在本票落地并测试通过，启停在此之上补。
