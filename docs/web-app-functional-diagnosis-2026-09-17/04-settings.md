# 设置页 功能诊断与改进建议

> 页面：`#/settings`（设置页）
> 仓库：cornfield（worktree `squad-webapp-diag-t4`），前端 dev server `http://127.0.0.1:4173`（本仓库 HEAD 源码 + HMR），后端 `ws://127.0.0.1:7891/ws`（无 token）。
> 采集器：`bun <repo>/.worktrees/_diag-harness/collect.ts`，每次运行启动独立 headless Chrome（每次运行 localStorage 即焚，不影响真实用户配置）。
> 证据目录：`docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings/`

## 页面与入口

- 路由入口：`#/settings`，左侧导航「设置」；组件 `packages/web-app/src/pages/settings/SettingsView.tsx`（`SettingsView` + 内部 `McpServerSection` / `ToggleRow` / `Row` / `GroupTitle`）。
- 页面自上而下 8 个区：**连接**（状态 / 连接 ID / 协议版本 / 桌面壳版本 / 更新 / WS URL / Token / 工作目录）→ **MCP 服务器** → **主题** → **快捷键** → **会话行为（三开关）** → **通知（三开关）** → **钉钉集成** → **危险操作**。
- 控件快照 `settings.controls.txt` 共 35 个交互控件；`settings.dom.txt` 是整页可见文本。基线连接正常：连接 ID `3b04864f-…`、协议 `v1`、桌面壳版本 `—`（网页直开无 `window.api`）、MCP 列表含 `gitnexus`（`/opt/homebrew/bin/gitnexus mcp`）。

## 实测链路

1. **基线采集**：`settings.png` / `.dom.txt` / `.controls.txt` / `.ws.txt` / `.console.txt` / `.network.txt`。WS 帧确认连接流程 `connected → hello → hello_ack → list_projects/list_agent_todos/git_changes/get_state/get_mcp_servers`；MCP 列表 `get_mcp_servers` 返回真实 `gitnexus`（`settings.ws.txt:15`）。
2. **检查更新（无响应验证）**：点击「检查更新」，步骤 `click → ok` 但 WS 无任何出站帧（`settings-checkupdate.ws.txt` 点击后无新帧），按钮文字仍是「检查更新」（`settings-checkupdate.steps.txt` step 4 返回 `"检查更新"`）。
3. **会话行为三开关（写 + 回滚）**：`settings-session-toggles.steps.txt` 记录初始态 `autoCompaction="toggle "（OFF）/ autoRetry="toggle "（OFF）/ keepDraft="toggle on"（ON）`；依次切 ON→OFF。`settings-session-toggles.ws.txt` 出站帧 `set_auto_compaction enabled:true/false`（req_8/req_9）、`set_auto_retry enabled:true/false`（req_10/req_11），均 `ok:true`。回滚后磁盘 `~/.cornfield/agents/default/.cornfield/config.yml` 的 `compaction.enabled: false`、`retry.enabled: false` 与基线一致。
4. **通知三开关 + 草稿保留 + 工作目录（localStorage 写 + 回滚）**：`settings-localstorage.steps.txt` 记录 `cornfield.notify.prefs` `{"agentDone":false,...}` → 回滚 `true`；`cornfield.keepDraft` `"0"` → 回滚 `"1"`；`cornfield.desktop.workspace` `/tmp/cf-diag-t4-workspace` → 回滚 `~/workspace`。
5. **WS URL 保存并重连**：`settings-reconnect.steps.txt` 填非法 URL `ws://127.0.0.1:9/ws` 后点击「保存并重连」，状态行变为「重连中（指数退避）」，连接 ID 变「—」；`settings-reconnect.console.txt` 显示 4 次 `WebSocket connection to 'ws://127.0.0.1:9/ws' failed`（`ERR_UNSAFE_PORT`）；localStorage `cornfield.serve.connection` 写成 `{"wsUrl":"ws://127.0.0.1:9/ws","token":""}`（`settings-reconnect.steps.txt` step 9）。
6. **MCP 服务器区**：`settings-mcp.steps.txt` 记录初始列表 `gitnexus`；「新增」表单可打开（`settings-mcp-mcp-form.png`）并可「取消」关闭；「启停开关」切 OFF → 列表出现「已停用」（`settings-mcp-mcp-toggled-off.png`），切回 ON → 「已停用」消失（`settings-mcp-mcp-toggled-on.png`）。`settings-mcp.ws.txt` 出站帧 `set_mcp_server {name:"gitnexus",enabled:false/true}`（req_8/req_10）均 `ok:true`。回滚后 `~/.cornfield/agent/mcp.json` 的 `gitnexus.enabled: true` 与基线一致。

## 问题

- [P2] 连接状态行永远显示 "connected"，没有「已断开」分支 / 证据：`settings.dom.txt:5-6` 显示 `状态 → connected`；根因在 `packages/web-app/src/pages/settings/SettingsView.tsx:200-201` 的三元 `{view.reconnecting ? "重连中（指数退避）" : "connected"}` 把 `view.connected === false && !view.reconnecting`（初始未连 / 断线未进入重连）折叠进 "connected"，`conn-dot` 同步 `view.reconnecting ? "reconnecting" : ""`（同文件 200 行）导致断线时绿点也不变 / 根因：状态渲染丢弃了 `view.connected`，只剩「重连中」与「connected」两态 / 建议：改为三分支 `!view.connected ? (view.reconnecting ? "重连中（指数退避）" : "已断开") : "已连接"`，绿点加 warn 态。
- [P2] 「检查更新」按钮在网页直开下点了没反应 / 证据：`settings-checkupdate.steps.txt` step 2 `click @button=检查更新 → ok`，但 `settings-checkupdate.ws.txt` 点击后无任何出站帧，step 4 eval 返回按钮文字仍为 `"检查更新"`（未进入「检查中…」）；根因 `packages/web-app/src/pages/settings/SettingsView.tsx:116-129` 的 `checkUpdateNow` 依赖 `window.api.app.checkUpdate`，网页直开无 `window.api` 时静默 `return`，而按钮渲染（216-223 行）不区分是否有壳，始终可点 / 根因：更新流是 Electron 壳专属能力，网页直开仍渲染可点按钮且无降级 / 建议：无 `window.api.app.checkUpdate` 时禁用并给说明，或整行隐藏（与桌面壳版本「—」一致）。
- [P2] 主题区是静态占位，无任何可交互控件 / 证据：`settings.controls.txt`（35 控件）主题区无任何 button/input，`settings.dom.txt:27-31` 仅文本「颜色主题 亮色（V6）」「消息密度 紧凑」；根因 `packages/web-app/src/pages/settings/SettingsView.tsx:336-350` 用 `<span>` 硬编码「亮色（V6）」芯片与「紧凑」，无 toggle/radio / 根因：主题与消息密度功能未实现，渲染成看起来像设置、实则不可交互的静态文本 / 建议：接线真实主题切换，或标注「即将上线」占位。
- [P2] 钉钉集成区 AppKey/AppSecret 输入框禁用但无可见禁用态 / 证据：`settings.controls.txt:31-32` 标 `input DISABLED`；`packages/web-app/src/pages/settings/SettingsView.tsx:446-448`（AppKey）与 `456-458`（AppSecret）的 `className` 与可用输入框同款（`bg-surface-2 border-hairline`），无 `disabled:` 变体；`packages/web-app/src/index.css` 全文件只有 `.btn:disabled`（244-247）与 `.chip > select:disabled`（346）两处 disabled 规则，没有 `input:disabled` / 根因：禁用态靠 placeholder 文案（「（配置存本地 gateway.json，编辑待接入）」/「••••••」）而非视觉样式区分，用户不读 placeholder 就不知道不可编辑 / 建议：给禁用输入框加 `disabled:opacity-60 disabled:cursor-not-allowed` 或统一 `input:disabled` 样式。
- [P2] 「保存并重连」会用空串覆盖已保存的 Token / 证据：`packages/web-app/src/pages/settings/SettingsView.tsx:42` `useState("")` 使 Token 字段永不回显；`saveConnection`（84 行 `store.reconfigure({ wsUrl: url, token: token.trim() })`）以空串提交，`saveServeConfig`（`packages/web-app/src/state/pi-client-adapter.ts:144-150`）把 `token:""` 写进 `cornfield.serve.connection`；实测 `settings-reconnect.steps.txt` step 9 显示 localStorage 写成 `{"wsUrl":"…","token":""}` / 根因：Token 输入框不回显 + 提交时直接用空 state，用户只改 WS URL 也会顺带清掉 token（本环境 serve 无 token，故「清空已存 token」属代码推断） / 建议：初值从 `loadServeConfig().token` 读取（可掩码显示），或「保存并重连」保留原 token 除非用户显式修改。
- [P3] 快捷键表含未实现的「Cmd+M 切换模型（TODO）」 / 证据：`settings.dom.txt:39-40`、`packages/web-app/src/pages/settings/SettingsView.tsx:359` 硬编码 `["Cmd+M", "切换模型（TODO）"]` / 根因：TODO 占位直接展示给用户 / 建议：实现 Cmd+M 切换模型，或移除该行，避免承诺不可用快捷键。
- [P3] 「测试连接（TODO）」与「重置设置」两个禁用按钮，禁用原因只藏在悬停 title 里 / 证据：`settings.controls.txt:33、35` 标 `button DISABLED`；`packages/web-app/src/pages/settings/SettingsView.tsx:463-470`（测试连接，`title="P3 gateway 只读状态代理接入"`）与 `491-498`（重置设置，`title="重置逻辑待定…"`）仅有 `title`，无可见文案；`.btn:disabled { opacity:0.5 }`（`index.css:244-247`）给了透明度但没给「为什么禁用」 / 根因：禁用原因未渲染成可见文本 / 建议：按钮旁渲染原因，或去掉 disabled 改成点击后提示「尚未开放」，避免只有悬停才知道。
- [P3] 「保存并重连」成功无反馈，失败才有提示 / 证据：`packages/web-app/src/pages/settings/SettingsView.tsx:76-88` `saveConnection` 仅 `setSaveError`；对比工作目录 `saveWorkspaceDir` 有 `workspaceSaved` → 显示「已保存」（90-105 行、328 行） / 根因：连接保存成功路径缺反馈状态 / 建议：加成功态提示（如「已保存并重连」）。

## 未验证与存疑

- **「新建会话」（危险操作）未实测点击**：入口 `SettingsView.tsx:478-490`，门控 `window.confirm("后端尚无会话删除命令…")`。点击成功会经 `store.newSession()` 在共享后端建新会话，且 headless Chrome 下 `window.confirm` 自动 dismiss 的行为未验证，故只做静态审查。
- **「重置设置」为纯禁用占位**：`SettingsView.tsx:491-498`，`disabled` + `title="重置逻辑待定（曾为空动作，已禁用防误导）"`，无逻辑，仅静态审查。
- **钉钉集成 AppKey/AppSecret/测试连接**：`SettingsView.tsx:441-470`，全部 `disabled`；写目标为本地 `gateway.json`（全局配置），属「会改全局配置的写」，按约定只做静态审查，未触发任何写入。
- **桌面壳更新流（检查/下载/重启更新）**：`SettingsView.tsx:109-188` 的状态机（`idle→checking→available/uptodate→downloading→downloaded→installing`）依赖 `window.api.app.*`，网页直开无此桥接，无法运行时验证；仅验证了「检查更新」在无壳下无响应（见问题第 2 条）。
- **「测试 MCP 连接」按钮未点击**：`test_mcp_server`（`pi-client-adapter.ts:1027-1034`）会 spawn `gitnexus mcp` 并做 JSON-RPC initialize 握手（8s 超时），涉及外部进程/网络，本轮未实测。
- **MCP 新增/编辑/删除的完整写链路未实测**：本轮只实测了「启停开关」（`set_mcp_server {enabled}` 写 `~/.cornfield/agent/mcp.json` 并回滚，见实测链路第 6 条）。新增/编辑（`set_mcp_server` upsert）与删除（`remove_mcp_server`，门控 `window.confirm`）会改同一全局文件，且删除门控 confirm 在 headless 下未验证，故列为存疑；新增表单的打开/取消与字段布局已实测（`settings-mcp-mcp-form.png`）。
- **纯「已断开」（connected=false 且未重连）渲染窗口期未运行时复现**：需停后端或耗尽重连才能稳定进入该态，本轮只确认「重连中」态正确（`settings-reconnect`），「已断开」渲染缺失为代码静态审查结论（问题第 1 条）。
- **通知权限弹窗在 headless 下的行为未断言**：`ensureNotifyPermission`（`lib/notifications.ts:53-63`）在切换 ON 时请求 `Notification.requestPermission()`；本轮只验证了 `cornfield.notify.prefs` 的 localStorage 写入与回滚，未断言权限弹窗的授予/拒绝结果。

## 复跑步骤

```bash
# 环境前置：前端 dev server http://127.0.0.1:4173、后端 ws://127.0.0.1:7891/ws 已在跑（勿自行起进程）。

# 1) 基线采集（整页截图 + 控件快照 + WS 帧 + console/network）
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings --view 1440x900 --wait 2000

# 2) 检查更新无响应验证
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings-checkupdate --view 1440x900 \
  --steps '[{"mark":"点击检查更新"},{"click":"@button=检查更新"},{"wait":800},{"eval":"[...document.querySelectorAll(\"button\")].find(x=>x.textContent.includes(\"检查\"))?.textContent.trim()"}]'

# 3) 会话行为三开关（ON→OFF，写 serve 配置并回滚）
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings-session-toggles --view 1440x900 \
  --steps '[{"click":"@button=自动压缩"},{"wait":1000},{"click":"@button=自动压缩"},{"wait":1000},{"click":"@button=自动重试"},{"wait":1000},{"click":"@button=自动重试"},{"wait":1000}]'

# 4) 通知/草稿/工作目录（localStorage 写并回滚）
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings-localstorage --view 1440x900 \
  --steps '[{"click":"@button=Agent 完成"},{"wait":600},{"click":"@button=Agent 完成"},{"wait":600},{"click":"@button=草稿保留"},{"wait":600},{"click":"@button=草稿保留"},{"wait":600}]'

# 5) WS 保存并重连（非法 URL 触发重连态）
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings-reconnect --view 1440x900 \
  --steps '[{"fill":["#conn-wsurl","ws://127.0.0.1:9/ws"]},{"wait":300},{"click":"@button=保存并重连"},{"wait":3500}]'

# 6) MCP 启停开关（写 mcp.json 并回滚）
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/settings' --out docs/web-app-functional-diagnosis-2026-09-17/evidence/04-settings \
  --name settings-mcp --view 1440x900 \
  --steps '[{"click":"@button=gitnexus 启停开关"},{"wait":1000},{"click":"@button=gitnexus 启停开关"},{"wait":1000}]'

# 回滚核查（两处全局写落盘后应与基线一致）
read ~/.cornfield/agents/default/.cornfield/config.yml   # compaction.enabled:false / retry.enabled:false
read ~/.cornfield/agent/mcp.json                         # gitnexus.enabled:true
```
