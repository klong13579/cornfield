# T2 · agent 进程操作入口（detach / 启停能力边界）—— 交付说明

squad: squad-20260918-webapp-agents · 分支: squad/webapp-agents-t2 · 模型: narwal-plan/deepseek-v4-pro

## 能力清单（先探明边界，再落地）

| 能力 | 服务端是否存在 | 命令名 | 依据（代码 + 实测） |
|---|---|---|---|
| attach | 存在 | `attach` | `packages/pi-wire/src/commands.ts:341`（`{ id?, type: "attach", sessionId }`）；`wire-server.ts:651-667` 实现（幂等，未注册 ok:false）。前端 `PiClient.attach()` + store `focusAgent()` 已有调用点（诊断 `05-agents.md` 实测 5：点 hr「会话」发出 `attach(sessionId:"hr")` 帧）。 |
| detach | 存在 | `detach` | `packages/pi-wire/src/commands.ts:343`；`wire-server.ts:668-688` 实现：`default` 不可卸、有连接聚焦该附件时 `ok:false`（`agent is active on a connection`）。此前全前端无调用点 —— **本票补上**。 |
| 启停（start / stop / restart） | **不存在** | 无 | `packages/pi-wire/src/commands.ts` 全命令面没有 agent 进程级 start/stop/restart。唯一「启停」是钉钉 tab 的账号 `enabled` 开关（`set_gateway_account` 写 `gateway.json`，热生效的是 gateway bridge，**不是 agent 进程**）。 |

结论：attach / detach 已存在，本票只补 detach 的前端调用链（接口 → adapter → store → UI）；启停不存在，本票只交付命令契约 + 缺口记录 + 后续票，不假装已实现。

## detach 全链路落地（本票实现）

| 层 | 文件 | 改动 |
|---|---|---|
| wire 接口 | `packages/web-app/src/lib/pi-client-api.ts` | `PiClient` 加 `detach(sessionId): Promise<void>` |
| adapter | `packages/web-app/src/state/pi-client-adapter.ts` | `detach(sessionId)` → `#req({ type: "detach", sessionId })` |
| store | `packages/web-app/src/state/session-store.ts` | `detachAgent(agentId)` + `DetachAgentResult` |
| UI 列表 | `packages/web-app/src/pages/agents/AgentsView.tsx` | 卡片加「卸载」按钮（仅 `attached && id!=="default"`）+ 就地反馈 |
| UI 详情 | `packages/web-app/src/pages/agents/AgentDetailView.tsx` | 头部加「卸载」按钮 + 就地反馈 |

`detachAgent` 的行为：

1. **忙态拦截（发命令之前）**：目标 agent `status === "busy"`（即 phase ∈ streaming / executing_tool / compacting / retrying）时，直接返回 `{ ok: false, busy: true, error: "agent is busy: <id>" }`，**一个字节都不发**。detach 释放的是空闲实例；拆别人正在跑的会话不许悄悄发生。
2. **成功后刷新**：`await fetchAgents()`，把 `attached:false` 的现状刷进 `view.agents` —— 列表与详情同步落到「未挂载」（serve 侧也因 `detached` 事件广播了 `server_snapshot`，但 store 不假手推送，与 `createAgent` 同一条「写状态归 store」纪律）。
3. **失败原样透出**：`serveVerdictOf(err).message` —— 未知 agent / 被占用 / default 拒拆，都是 serve 原文，客户端不改写。

## 六条判据的落地

1. **能力清单**（见上表）：attach/detach 已存在（附命令名），启停不存在。
2. **detach 入口可用**：列表卡片与详情头部都有「卸载」按钮（对已挂载的非 default agent）；有会话在跑时 store 忙态拦截，按钮点下去看到「该 agent 正在执行任务（streaming），无法卸载」。
3. **启停不存在 → 只交契约**：见 `FOLLOWUP-agent-process-stop.md`（命令名 / 参数 / 返回结构 + 缺口记录 + 后续票）。本票不宣称已实现。
4. **成功后状态同步**：`fetchAgents()` 刷新，列表卡片状态点变「未挂载」、详情头部变「会话未注册」。
5. **失败路径有原因**：`unknown agent` / `agent is active on a connection: X (switch_session first)` / `cannot detach default agent` 全部原样可见。
6. **不误伤其它连接聚焦的 agent**：serve 侧 `detach` 已挡「active on a connection」（对比的是附件地址），错误原文透出 UI，用户明确知道是「有连接在用它」，而不是悄悄拆掉。

## 证据

- **实测 `list_agents`（只读探针）**：`docs/web-app-agents-t2/evidence/serve-list-agents.txt` —— 直连运行中的 serve（`ws://127.0.0.1:7891/ws`），7 个 agent 全 `attached:true`、`phase:idle`、default 是本连接焦点 `active:true`。不 attach/detach 任何真实 agent（写动作交给单元测试，避免拆掉运营中的会话）。
- **单元测试**：`packages/web-app/test/diag-agent-process-control.test.ts`（5 pass / 0 fail）—— 锁住四条命令面事实：detach 帧带对 `sessionId`、忙态拦截**不发帧**、serve 拒绝原文透出、成功后重拉 `list_agents`。

## Gate

- `bun run --cwd=packages/web-app check` → 通过（biome + tsgo）
- `bun run --cwd=packages/coding-agent check` → 通过（biome + tsgo；本票未改 coding-agent，仅探明）
- `bun test packages/web-app/test/diag-agent-process-control.test.ts` → 5 pass / 0 fail

## 既有消费方影响

- 接口只新增 `detach()`，`attach`/`switchSession`/`listAgents` 逐字节不变；store 只新增 `detachAgent`，未动 `focusAgent`/`createAgent`/`fetchAgents` 的既有语义。
- UI 卡片与详情头部只加按钮与反馈行，未动既有「会话 / 详情 / 钉钉 / 模型」渲染。
