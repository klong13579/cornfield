# Agent 总览 功能诊断与改进建议

> 页面：`#/agents`（Agent 列表）与 `#/agents/:id`（Agent 详情，7 个 tab）。
> 实测环境：前端 dev server `http://127.0.0.1:4173`（HEAD `012be3ab` 源码 + HMR），后端 serve `ws://127.0.0.1:7891/ws`（无 token），gateway 运行中（pid 49928）。
> 证据目录：`docs/web-app-functional-diagnosis-2026-09-17/evidence/05-agents/`。

## 页面与入口

- 列表页 `#/agents`：左侧导航「Agent 总览」（`packages/web-app/src/router.tsx:87-95` 注册 panel `agents`）。页面由 `AgentsView.tsx` 渲染。
  - 顶部：标题「Agent」+ 汇总「N 工作区 · N agent · N 运行中」；一条 gateway 运行状态条（pid / 调度器任务数 / 各账号 bridge 状态 chip）。
  - 筛选行：工作区 seg、状态 seg（全部状态/运行中/执行中/空闲/已停用）、搜索框、「创建员工」按钮。
  - 主体：按工作区分组的 agent 卡片（状态点、CODING/WORKER 徽标、钉钉徽标、模型、技能数、会话/详情两个按钮）。
- 详情页 `#/agents/:id`：`router.tsx:229-231` 的 `EXTRA_ROUTES` 里 `{ path: "/agents/:id", element: <AgentDetailRoute /> }`。`AgentDetailView.tsx` 渲染 7 个 tab：Skills / 钉钉 / 模型配置 / 工具开关 / 用户画像 / 文件 / Prompts。
- 数据来源：列表与详情共用 `view.agents`（`server_snapshot` 推送 → `pi-client-adapter.ts` 的 `mapAgentEntry` 映射）。serve 侧列表组装在 `packages/coding-agent/src/server/session-registry.ts:377 buildSessionList`。

## 实测链路

以下全部为真实浏览器（collect.ts 每路独立 Chrome）对运行中 serve 的实测，非 mock。

1. **列表页整页采集**（`agents-list.*`）：打开 `#/agents`，等 3s 让 WS 握手 + 预挂载结算。汇总栏显示「1 工作区 · 7 agent · 1 运行中」；7 张卡片 = default/hr/algorithm/me/dataAgent/sw/mcode，与注册表 `~/.cornfield/agent/registry.json` 的 7 个 key 一一对应。
2. **serve 真相探针**（`serve-active-union.txt` + `agents-list.ws.txt`）：直连 `ws://127.0.0.1:7891/ws` 发 `list_agents`，7 个 agent 全量条目里 **没有 `role` 字段**；default 的 `active=true`，其余 `active=false`，**全部 `attached=true`、`phase=idle`**。mcode 的 `dingtalk.enabled=false`。
3. **详情页各 tab**（`agents-detail-default.*`，steps 里逐个点击 7 个 tab 并截图）：`#/agents/default` 的 7 个 tab 全部可点、各自渲染（Skills 列表 / 钉钉未绑定提示 / 模型选择 / 工具开关 / 用户画像 mission+user.md / 文件树 / Prompts 清单）。
4. **未知 agent 深链**（`agents-unknown.*`）：`#/agents/does-not-exist` 降级为「未知 Agent / 会话未注册」，Skills tab 自动拉取报错 `Server rejected "get_skills": unknown agent: does-not-exist`，页面不崩。
5. **列表交互**（`agents-interact.*`）：状态筛选「已停用」→ 只留 mcode；「创建员工」面板可开可收；点 hr 卡片的「会话」按钮 → wire 发出 `attach(sessionId:"hr")` + `switch_session(sessionId:"hr")` 并跳到工作台（`agents-interact.ws.txt` 第 18-26 帧）。
6. **mcode 详情 + 钉钉 tab**（`agents-detail-mcode-dt.*`）：header 状态点绿色「空闲」+「钉钉已停用」badge；钉钉 tab 显示「启用」开关（off）+ 机器人名/agentDir/隐藏思考块/黑名单，保存按钮「已同步」禁用态。

## 问题

- [P1] 同一 agent 的「停用」状态在列表页与详情页不一致：mcode 列表页红点「已停用」，详情页绿点「空闲」。
  证据：`agents-list.dom.txt` 中 mcode 卡片为「钉钉已停用 / 已停用」；`agents-detail-mcode-dt.dom.txt` 头部为「空闲 · 最近活跃 —」。
  根因：列表页 `AgentCard` 用 `isAccountStopped(agent)`（gateway 账号 `enabled:false` 或不在运行账号表）把状态点覆盖成红色「已停用」（`packages/web-app/src/pages/agents/AgentsView.tsx:104-108`、`:293-309`）；详情页 `AgentDetailView` 头部只认 `agent.status`（serve 快照里 mcode 仍是 `idle`），**不套用** gateway 停用覆盖（`packages/web-app/src/pages/agents/AgentDetailView.tsx:84-87` 与 `statusText` `:248-261`）。两处对「停用」用了不同判定，且只在一处覆盖。
  建议：把 `isAccountStopped` 抽成共享函数，列表卡片与详情头部用同一份判定；详情页停用时状态点也应显示红色「已停用」，或至少与列表同文案。

- [P2] 状态语义错位：「运行中 / 空闲」不是「进程是否在跑」，而是「是否有连接聚焦此 agent」，且是**全部连接的并集**。
  证据：`serve-active-union.txt` —— 探针把自己的连接 `switch_session` 到 hr 后，`list_agents` 返回 **default 与 hr 同时 `active=true`**；`agents-list.dom.txt` 汇总「1 运行中」，但 `agents-list.ws.txt`/探针显示 7 个 agent **全部 `attached=true`**（serve 启动即预挂载）。
  根因：serve 的 `activeAgentIds()` 对所有 `targets`（连接）取 `getActiveAgentId()` 求并集（`packages/coding-agent/src/server/wire-server.ts:349-357`），`buildSessionList` 据此设 `active`（`session-registry.ts:383`）；前端 `mapAgentEntry` 把 `active` → `"online"`、`attached` → `"idle"`（`packages/web-app/src/state/pi-client-adapter.ts:1543`）。而 `AgentInfoDto.active` 的注释写「本连接焦点 agent」与实现不符（`packages/pi-wire/src/results/agents.ts:23-24`）。
  建议：要么把汇总与文案改成「聚焦中」这类准确措辞，要么在 serve 侧区分「进程运行态」（attached）与「连接焦点态」（active），避免把「7 个 agent 都在跑」显示成「1 运行中」。

- [P2] 「工作区」分组/筛选失效：serve 从不输出 `role` 字段，所有 agent 恒落入「默认工作区」。
  证据：探针/`serve-active-union.txt` 中 7 个 agent 条目均无 `role`；`agents-list.dom.txt` 汇总「1 工作区」、主体只有一个「默认工作区 · 7 agents」分组。
  根因：`buildSessionList` 组装的 entry 只有 id/name/active/attached/agentDir/skillCount/dingtalk/…，**没设 `role`**（`session-registry.ts:380-388`）；前端 `workspace: s.role ?? "默认工作区"`（`pi-client-adapter.ts:1541`）于是恒定兜底。`SessionListEntry.role` 在 wire 层声明为「workspace.json role」（`packages/pi-wire/src/frames.ts:86-87`）但 serve 不填。
  建议：`buildSessionList` 补 `role`（读 workspace.json 的 role，与 `loadAgentMetas` 同源）；否则该筛选 seg 与分组标题应降级为单一「全部」，避免给用户一个永远只有一桶的「工作区」假分组。

- [P2] 没有 detach 入口，也没有 agent 进程的启停入口；唯一「启停」是钉钉 tab 的账号 `enabled` 开关（写 gateway.json，非 agent 进程）。
  证据：前端 `PiClient` 接口只有 `attach()` / `switchSession()`，无 `detach()`（`packages/web-app/src/lib/pi-client-api.ts:520-523`）；serve 有 `detach` 命令（`wire-server.ts:668-688`）但全前端无调用点；「会话」按钮走 `store.focusAgent` = attach + switch（`AgentsView.tsx:263-266`）；钉钉 tab 的「启用」开关 → `store.setGatewayAccount`（`AgentDetailView.tsx:362`）。
  根因：产品面未提供 detach / agent 进程启停入口；「启停」一词被钉钉账号开关借用，容易让人以为能停掉 agent 进程。
  建议：如需进程级启停，补 wire 命令与 UI 入口；否则把钉钉 tab 的「启停与身份」标题改为「钉钉账号启停」，与 agent 进程语义脱钩。

- [P3] 「已停用」筛选桶语义与卡片标签冲突：`AgentStatus."stopped"`（serve 未挂载）在卡片里渲染成「未挂载」，筛选按钮却标「已停用」。
  证据：`mapAgentEntry` 未 busy/active/attached 时给 `status:"stopped"`（`pi-client-adapter.ts:1543`）；`AgentCard.statusLabel` 没有 `agent.status === "stopped"` 分支，落到 else →「未挂载」（`AgentsView.tsx:301-309`）；筛选按钮「已停用」对应 `statusFilter === "stopped"`（`AgentsView.tsx:176-183`）。当前实测 7 个 agent 全部预挂载，`attached` 恒 true，此路径仅在预挂载失败时才可见。
  根因：两套「stopped」共用一个词——gateway 账号停用（红色「已停用」）与 serve 未挂载（灰色「未挂载」），筛选 UI 把它们并进同一个桶。
  建议：`AgentStatus` 的 `"stopped"` 改为 `"unmounted"` 或让卡片为它补一个明确的「未挂载」分支，筛选标签与卡片文案对齐。

- [P3] 列表页挂载即发 `list_agents`，与 WS 连接竞态，产生 4 条带完整堆栈的 console warning（`PiDisconnectedError`）。
  证据：`agents-list.console.txt` 与 `agents-interact.console.txt` 各有 4 条 `Cannot send "list_agents": not open (status=connecting)` + 堆栈。
  根因：`AgentsView.tsx:67-69` 的 `useEffect` 挂载即 `store.fetchAgents()`，而此刻 WS 未 open，`listAgents()` 抛 `PiDisconnectedError`（`pi-client-adapter.ts:528-542` 的 catch 里 `console.warn`），session-store 侧又记一次。列表最终靠 `server_snapshot` 推送恢复，这轮 `list_agents` 是白发且刷屏。
  建议：`fetchAgents` 在 `view.connected` 就绪后再发（与详情页各 tab 的 `if (!view.connected) return` 同款守卫），或让 `listAgents` 在未连接时静默返回空而不是 warn。

- [P3] 卡片 footer 的「定时任务」数量与「最近活跃」是死字段：serve 从不提供 `cronCount` / `lastAction`，永不渲染。
  证据：`mapAgentEntry` 未设 `cronCount` / `lastAction`（`pi-client-adapter.ts:1537-1552`），`SessionEntryLike` 也无这两字段（`:1520-1532`）；`agents-list.dom.txt` 卡片 footer 只有模型 + 「N 技能」，无「定时任务 / 最近活跃」。
  根因：`AgentsView.tsx:344-347` 渲染 `agent.cronCount` / `agent.lastAction`，但 wire 层没有数据源。
  建议：要么补 serve 侧的 cronCount/lastAction 字段，要么删掉这两行渲染，别留一个永远不出现的位。

- [P3] 未知 agent 深链（`#/agents/does-not-exist`）降级可用，但模型徽标显示焦点 agent 的模型，可能误读为该 agent 存在且有模型。
  证据：`agents-unknown.dom.txt` 头部「未知 Agent」+ 模型徽标「deepseek-v4-flash」+「会话未注册」；`agents-unknown.console.txt` 报 `get_skills` unknown agent 但页面不崩。
  根因：`AgentDetailView.tsx:76` `currentModel = agent?.model ?? view.model ?? ""` —— 未知 agent 回落到 `view.model`（本连接焦点 default 的模型）。
  建议：未知 agent 时徽标显示「—」或不显示，不回落焦点模型。

- [P3] 钉钉 tab 的「启用」「隐藏思考块」开关无文字态，on/off 仅靠 CSS 色块区分（[inference]，未做 on/off 截图对比）。
  证据：`agents-detail-mcode-dt.controls.txt` 两个 toggle 按钮的文本为空（`role="switch"` 无 aria-label 无文字）。
  根因：`AgentDetailView.tsx:409-415`、`:447-453` 的开关是 `className="toggle ${enabled ? "on" : ""}"` 的空按钮，状态不落文字。
  建议：开关加 `aria-label`（如「启用钉钉账号：开/关」）或相邻文本态，避免色弱/截图上无法判断。

## 未验证与存疑

- **「执行中」（busy）状态未能实测**：`busy` 由 `phase ∈ {streaming, executing_tool, compacting, retrying}` 派生（`pi-client-adapter.ts:1535-1536`），实测时 7 个 agent 全部 `phase=idle`。触发需要真实 LLM 调用，本轮诊断不动真实 agent 跑任务，故「执行中」态仅代码级确认，未实拍。
- **「空态」（agents.length === 0）未能实测**：空态分支（`AgentsView.tsx:225-243`）在真实 serve 有 7 个 agent 时不可达；触发需要清空/隔离 registry，属不可逆写，故只做静态审查（代码确认空态有「创建员工」按钮兜底）。
- **「创建员工」提交（create_agent）只测了面板开合，未提交**：提交会在 serve 真实建 agentDir + 写 registry，属写盘动作，本轮只静态审查三态逻辑（`CreateAgentPanel.tsx` 的 idle/submitting/existing/failed）。
- **钉钉 tab 的「启用」开关未实际切换**：切换走 `set_gateway_account` 写 `~/.cornfield/gateway.json`（全局配置，热生效），属全局写，只静态审查；「启用」on/off 的视觉区分度未做 A/B 截图对比（见 P3 末条）。
- **多连接并集行为**：`active` 是所有连接的焦点并集（已用探针证明 default 与 hr 同时 active）。当前有哪些其它连接聚焦 default 未逐一清点，属环境态，不影响结论。

## 复跑步骤

环境已由 squad 协调者起好，**不要自己起进程**（前端 `http://127.0.0.1:4173`、serve `ws://127.0.0.1:7891/ws`）。采集器固定用 `bun <repo>/.worktrees/_diag-harness/collect.ts`。

```bash
REPO=/Users/sz-0203015357/Desktop/Narwal/cornfield
OUT=docs/web-app-functional-diagnosis-2026-09-17/evidence/05-agents

# 1. 列表页整页（截图 + dom + controls + console + network + ws）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents' --out "$OUT" --name agents-list --wait 3000

# 2. serve 真相：7 个 agent 的 active/attached/phase/role（role 应为空，active 应为并集）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents' --out "$OUT" --name agents-list --wait 3000 \
  --steps '[{"eval":"fetch(\"http://127.0.0.1:7891/ws\").then(()=>\"ws endpoint needs a WS client; see serve-active-union.txt\")"}]'

# 3. 详情页各 tab（default）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents/default' --out "$OUT" --name agents-detail-default --wait 2500 \
  --steps '[{"shot":"d-skills"},{"click":"@text=钉钉"},{"wait":1500},{"shot":"d-dingtalk"},{"click":"@text=模型配置"},{"wait":2000},{"shot":"d-model"},{"click":"@text=工具开关"},{"wait":2000},{"shot":"d-tools"},{"click":"@text=用户画像"},{"wait":1500},{"shot":"d-profile"},{"click":"@text=文件"},{"wait":2000},{"shot":"d-files"},{"click":"@text=Prompts"},{"wait":2000},{"shot":"d-prompts"}]'

# 4. 未知 agent 深链
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents/does-not-exist' --out "$OUT" --name agents-unknown --wait 3000

# 5. 列表交互（停用筛选 / 创建面板开合 / 会话按钮 attach+switch）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents' --out "$OUT" --name agents-interact --wait 2500 \
  --steps '[{"click":"@button=已停用"},{"wait":1200},{"shot":"i-filter-stopped"},{"click":"@button=全部状态"},{"wait":1000},{"click":"@button=创建员工"},{"wait":1200},{"shot":"i-create-panel"},{"click":"@button=收起创建表单"},{"wait":800},{"eval":"(() => { const cards=[...document.querySelectorAll(\u0027main .rounded-xl\u0027)]; const card=cards.find(c => c.textContent.includes(\u0027hr\u0027) && c.textContent.includes(\u0027WORKER\u0027)); const btn=[...card.querySelectorAll(\u0027button\u0027)].find(b => b.textContent.trim()===\u0027会话\u0027); btn.click(); return \u0027clicked hr 会话\u0027; })()"},{"wait":2500},{"shot":"i-after-hr-session"}]'

# 6. mcode 详情 + 钉钉 tab（注意：mcode 头部有「钉钉已停用」badge，@text=钉钉 会点中 badge 而非 tab，必须用 @button=钉钉）
bun $REPO/.worktrees/_diag-harness/collect.ts --page '#/agents/mcode' --out "$OUT" --name agents-detail-mcode-dt --wait 2500 \
  --steps '[{"click":"@button=钉钉"},{"wait":1500},{"shot":"dt-tab"}]'
```

判据回查：

- 「点了没反应」= `.steps.txt` 该步 `失败：… Timeout` 且 `.ws.txt` 无对应出站帧（本次全部 tab/按钮均 ok）。
- 「停用不一致」= 对比 `agents-list.dom.txt`（mcode「已停用」）与 `agents-detail-mcode-dt.dom.txt`（mcode「空闲」）。
- 「工作区失效」= 任何一次 `list_agents` 的 agent 条目里都无 `role` 字段（见 `serve-active-union.txt`）。
- 「运行中=焦点并集」= 先把某连接 `switch_session` 到 hr，再 `list_agents`，default 与 hr 同时 `active=true`。
