# T1 · Agent 总览（一致结论 / 竞态 / 未知降级 / 删无数据源渲染）—— 交付说明

squad: squad-20260918-webapp-agents · 分支: squad/webapp-agents-t1 · 模型: narwal-plan/deepseek-v4-pro

## 范围

- `packages/web-app/src/pages/agents/agent-status.ts`（新增：共享状态判定，列表/详情共用的单一事实）
- `packages/web-app/src/pages/agents/AgentsView.tsx`
- `packages/web-app/src/pages/agents/AgentDetailView.tsx`
- `packages/web-app/test/diag-agents-consistency.test.ts`（新增）
- `packages/web-app/test/diag-agents-stale-fields.test.ts`（新增）
- `docs/web-app-agents-t1/`（本说明 + 证据）

未动 `packages/pi-wire` / `packages/coding-agent` / ComposerBar（各自 scope 之外，ComposerBar 是 T3）。

## 判据逐条落地

### ① 同一 agent 列表与详情同一结论与措辞

抽共享函数 `agentStatusDisplay(agent, gwStatus)`（`agent-status.ts`）：gateway 账号停用（`enabled:false` / 不在运行账号表）优先覆盖 serve 快照；其余按 serve `online/busy/idle/stopped` 翻译。列表卡片与详情头部都只调这一处。

- 前：mcode 列表「已停用」，详情「空闲 · 最近活跃 —」（`evidence/before-mcode-detail.dom.txt` 第 3 行 vs `evidence/before-agents-list.dom.txt` 第 84 行）。
- 后：mcode 列表「已停用」，详情「已停用」（`evidence/after-mcode-detail.dom.txt` 第 3 行 = `after-agents-list.dom.txt` 第 85 行）。

### ② 筛选桶与卡片文案同词

`AgentStatus` 的 serve `"stopped"`（未挂载）与 gateway 账号停用（已停用）此前共用「已停用」一个桶，卡片却把 serve `"stopped"` 写成「未挂载」。现在拆成两个桶：`未挂载`（serve 未挂载）+ `已停用`（gateway 账号停用），与卡片文案一一对应。

- 后：筛选行出现「未挂载」「已停用」两个独立桶（`after-agents-list.dom.txt` 第 18-19 行）；前只有「已停用」（`before-agents-list.dom.txt` 第 18 行）。
- 单测锁：serve `stopped` 卡片写「未挂载」、不写「已停用」（`diag-agents-consistency.test.ts`）。

### ③ 列表页 console 无失败命令堆栈

`AgentsView` 挂载即发 `fetchAgents()`，与 WS 握手竞态，产生带堆栈的 `PiDisconnectedError` 告警。改为与详情页各 tab 同款守卫：`view.connected` 就绪（WS open）后再拉，`server_snapshot` 推送照常补全列表。

- 前：4 条 `Cannot send "list_agents": not open` 堆栈（`evidence/before-agents-list.console.txt`）。
- 后：只剩 vite debug + React DevTools 提示，无线索堆栈（`evidence/after-agents-list.console.txt` 3 行）。

### ④ 未知 agent 深链不借焦点模型徽标

`currentModel` 原为 `agent?.model ?? view.model ?? ""`，未知 agent 回落到本连接焦点模型。改为 `agent?.model ?? "—"`。

- 后：`#/agents/does-not-exist` 头部「未知 Agent」+ 模型徽标「—」（`evidence/after-unknown.dom.txt` 第 4-5 行），不再出现焦点模型 `deepseek-v4-flash`。
- 单测锁：`diag-agents-consistency.test.ts` 断言 html 不含 `deepseek-v4-flash`、含 `—`。

### ⑤ 钉钉开关可读文字 / 无障碍态

「启用」「隐藏思考块」两个空 `role="switch"` 按钮，on/off 仅靠色块。补 `aria-label`（含开/关态），与既有 `aria-checked` 组成完整无障碍态。

- 单测锁：`diag-agents-consistency.test.ts` 断言 `aria-label="启用钉钉账号：关"` / `aria-label="隐藏思考块：关"`。

### ⑥ 消费 role/domain 新字段，旧字段名不残留

06 已合入 wire `role`（= workspace.json `domain`），适配层 `mapAgentEntry` 本就把它映射为 `workspace`。本票锁住这条契约，防回归：wire `role` → DTO `workspace`，DTO 上不残留 `role` 旧字段名。

- 单测锁：`diag-agents-stale-fields.test.ts` 的 `list_agents 消费 role 字段`（FakeWebSocket 集成）。

### ⑦ 删无数据源渲染（cronCount / lastAction）

serving 端无数据源（调度器在 gateway 进程、lastAction 无 wire 字段），此前值缺失时渲染 `—` / 不渲染，看起来像「坏了」。本票删渲染、不留占位：

- `AgentsView.tsx` 卡片 footer：删 `cronCount`（定时任务）与 `lastAction`（最近活跃）两行，`skillsCount`（技能）保留（有数据源）。
- `AgentDetailView.tsx` 头部：删「· 最近活跃 —」（原第 87 行）与第二行「· 最近活跃 —」（原第 122 行），只留状态词与工作区名；`statusText` 死代码一并删除。
- 为什么删而不是占位：这两列**不存在于服务端数据模型**，不是「暂时拿不到」；占位等于把「不存在」渲染成「坏了」，误导用户。skillsCount / workspace / 状态文案 / 钉钉徽标均有数据源，保留且值正确。

- 前：详情头部「空闲 · 最近活跃 —」+「默认工作区 · 最近活跃 —」（`before-mcode-detail.dom.txt` 第 3、8 行）。
- 后：详情头部「已停用」+「默认工作区」（`after-mcode-detail.dom.txt` 第 3、8 行），无「最近活跃」；列表卡片「5 技能」仍在、无「定时任务 / 最近活跃」（`after-agents-list.dom.txt` 第 86-87 行）。
- 单测锁：`diag-agents-stale-fields.test.ts` 给 DTO 注入 `cronCount:3` / `lastAction:"昨天 23:00"` / `skillsCount:5`，断言只渲染「5 技能」、不渲染另两个。

## 证据清单（docs/web-app-agents-t1/evidence/）

- `before-agents-list.{png,dom,console}.txt` —— 列表（前）
- `before-mcode-detail.{png,dom}.txt` —— mcode 详情（前）
- `after-agents-list.{png,dom,console}.txt` —— 列表（后，4174 自己起的 vite）
- `after-mcode-detail.{png,dom}.txt` —— mcode 详情（后）
- `after-unknown.{png,dom,console}.txt` —— 未知深链（后）

采集方式：主检出的浏览器收集器 `.worktrees/_diag-harness/collect.ts`（绝对路径）；「后」用本工作树自起的 vite（127.0.0.1:4174，非共享 4173，后者是主检出的改动前代码）。共用 serve `ws://127.0.0.1:7891/ws`（真实 registry + gateway，mcode 是网关外账号 = 已知停用 agent）。

## Gate

- `bun run --cwd=packages/web-app check` → 通过（biome + tsgo）
- `bun test packages/web-app/test/diag-agents-consistency.test.ts` → 7 pass / 0 fail
- `bun test packages/web-app/test/diag-agents-stale-fields.test.ts` → 3 pass / 0 fail