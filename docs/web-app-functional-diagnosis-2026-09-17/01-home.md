# 首页（`#/`）功能诊断与改进建议

- 采集：2026-09-17，T1（squad-20260917-webapp-diag）
- 前端：`http://127.0.0.1:4173`（HEAD 源码 + HMR，与本文引用的 `packages/web-app/src/**` 同一提交）
- 后端：`ws://127.0.0.1:7891/ws`（无 token）；serve 工作目录短名 `cf-ui-demo`；注册 7 个 agent（default / hr / algorithm / me / dataAgent / sw / mcode），本连接焦点 `default`（online），其余 6 个 `idle`
- 采集器：`.worktrees/_diag-harness/collect.ts`（每次运行独立起一个 headless Chrome，并行安全）
- 证据目录：`docs/web-app-functional-diagnosis-2026-09-17/evidence/01-home/`（38 个文件：4 组基线 + 交互 + 未连接态）

---

## 页面与入口

**路由与组件**
- `#/` → `HomeView`：panel 注册见 `packages/web-app/src/router.tsx:50-58`（`id: "home"`, `group: "work"`, `order: 1`, `path: "/"`）。
- 外壳 `AppShell`（`packages/web-app/src/layout/AppShell.tsx:20-34`）：左侧 `AppSidebar` + 通用顶栏 `AppTopbar`（标题「CornField 多端前端 首页」）+ 内容区。

**左侧导航**（12 项，`px ≥ 768` 可见）：首页 / 会话工作台 / 会话记录 / Agent 总览 / Skills / Memory / Todo / 模型 / 语音 / 定时任务 / 用量 / 设置。侧栏顶部还有「当前 Agent」只读块（`AppSidebar.tsx:42-60`）。

**首页自身区块**（自上而下，均可在 `home.dom.txt` / `home.controls.txt` 对号）
1. **Greeting**：Orb + 「晚上好，彭梦龙」（问候名从各 agent 的 `user.md` 解析）+ 连接摘要行 + 连接点。
2. **快速会话**（`HomeView.tsx:163-261`）：
   - Agent 选择器 `<select aria-label="切换 Agent">`（`layout/AgentSwitcher.tsx`）；
   - 上下文条：Agent / Project / 工作区 / 会话；
   - 最近一轮（真实转录，无就空态）；
   - composer：`input#home-composer` + 发送键 `aria-label="发送"`（`HomeView.tsx:230-252`）；
   - 提示行 `Enter 发送到当前会话` + `转入会话工作台（同一会话）`。
3. **项目区** `ProjectSection`（`components/ProjectContext.tsx:142-163`）：标题「项目」+ `刷新项目列表` 按钮 + 清单 / 空态 / 错误态。
4. **快捷卡片**（5 个 `<Link>`，`HomeView.tsx:23-29, 267-279`）：检查今天的定时任务→`/tasks`、最近会话回顾→`/records`、语音记录一条指令→`/voice`、切换模型→`/models`、打开 Agent 管理→`/agents`。
5. **最近活跃**（`HomeView.tsx:282-318`）：3 张 agent 卡片。
6. **工作台直达**：`打开会话工作台`（`HomeView.tsx:321-325`）。

**已连接态下的禁用控件**：仅发送键在输入框为空时禁用（`home.controls.txt:16` 标 `DISABLED`），且有可见样式差异（`disabled:opacity-40`，见「实测链路」2 与问题条外的结论）。

---

## 实测链路

四组采集，命令见「复跑步骤」。

### 1. 桌面基线（1440x900，已连接）— `--name home`
- 页面正常加载；`console` 3 行（Vite 连接 ×2 + React DevTools 提示），**0 error / 0 pageerror**；网络 **0 失败请求**（`home.network.txt`）。
- WS 21 帧：`hello` / `hello_ack` / `list_projects`×2 / `list_agent_todos` / `git_changes`×2 / `get_state` / `fs_read(user.md)`×2 + `server_snapshot` / `session_snapshot`。证据：`home.ws.txt`。
- 控件 27 个。证据：`home.controls.txt`、`home.png`、`home.summary.json`。
- 关键读数：Agent 选择器 `v="default"`，7 个选项，非 online 的带 `（idle）` 后缀（`home.dom.txt:6-12`）；上下文条 `Agent default / Project 未归属 / 工作区 cf-ui-demo / 会话 01a0afb9-…`（`home.dom.txt:13-19`）；项目区「未声明任何 Project。声明文件：`~/.cornfield/agent/projects.json`」（`home.dom.txt:27`）；最近活跃 3 卡副标题**全为「—」**（`home.dom.txt:35-43`）。

### 2. 移动视口（390x844，已连接）— `--name home-mobile`
- 12 个侧栏导航链接在 DOM 中存在但**全部 `[0,0 0x0]`（display:none）**。证据：`home-mobile.controls.txt:2-13`。
- 截图确认：**无侧栏、无汉堡/抽屉/底部 tab**，顶栏只剩标题。证据：`home-mobile.png`。
- 「最近活跃」第 3 张卡 `[372,783 160x64]`（右缘 532 > 视口 390）被裁。证据：`home-mobile.controls.txt:24-26`、`home-mobile.png`。

### 3. 交互实测（1440x900）— `--name home-interact --steps home-interact-steps.json`

| # | 动作 | 观测 | 证据 |
|---|---|---|---|
| A | Agent 选择器 default→hr | select value=`hr`，composer placeholder 变 `给 hr 发一条指令…`；WS 出站 `attach{hr}`(req_9)+`switch_session{hr}`(req_10)，回流 `session_snapshot(hr)` | `home-interact.steps.txt:2-5`、`home-interact.ws.txt:22-25`、`home-interact-agent-hr.png` |
| B | 切回 default | value=`default`，placeholder 复原；WS `attach{default}`(req_15)+`switch_session{default}`(req_16) | `home-interact.steps.txt:7-11`、`home-interact.ws.txt:36-38` |
| C | composer 填文本→清空 | 填后发送键 **ENABLED**（截图里变实心黑），清空后 **DISABLED** | `home-interact.steps.txt:13-18`、`home-interact-composer-filled.png` |
| D | 空文本点发送键 | 步骤**失败**（`Timeout 8000ms`）且**全日志无任何出站 `prompt` 帧** → 两个判据同时成立=真禁用 | `home-interact.steps.txt:21`、`home-interact.ws.txt`（无 prompt） |
| E | 点`刷新项目列表` | 步骤 ok，出站 `list_projects`(req_21)→`{projects:[],currentProjectSource:"none"}` | `home-interact.steps.txt:24`、`home-interact.ws.txt:50-51` |
| F | 5 张快捷卡依次点击 | hash 依次 = `#/tasks` / `#/records` / `#/voice` / `#/models/catalog` / `#/agents`（**5/5 命中**） | `home-interact.steps.txt:28-46` |
| G | 最近活跃卡（default） | hash=`#/workspace` | `home-interact.steps.txt:50-52` |
| H | `转入会话工作台（同一会话）` | hash=`#/workspace` | `home-interact.steps.txt:55-58` |

> 结论：首页**所有可点控件都确实产生了效果**（导航/切换/刷新均有出站帧或 hash 变化）；未发现"看起来能点但没反应"的已连接态控件。

### 4. 未连接态（指向死端口 `ws://127.0.0.1:9999/ws`，不碰真 serve）— `--name home-disconnected`

- 渲染完整且**每个禁用控件都带说明**：select 文本「未连接」、composer placeholder、最近一轮「未连接 serve——连接后…」、项目区「未连接——Project registry 不可用」。证据：`home-disconnected.steps.txt:3-4`、`home-disconnected.controls.txt:16-18`、`home-disconnected-disconnected.png`。
- 禁用读数：`agentSelDisabled:true / agentSelText:"未连接" / inputDisabled:true / sendDisabled:true`。证据：`home-disconnected.steps.txt:4`。
- 点`重试`：步骤 ok，但 2s 后 `main.innerText` **逐字不变**；console 出现 5 次 `ERR_CONNECTION_REFUSED`（自动重连），UI 无任何失败原因或加载反馈。证据：`home-disconnected.steps.txt:8-10`、`home-disconnected.console.txt:4-8`、`home-disconnected-after-retry.png`。
- 点发送键：失败（`Timeout 8000ms`，同判据=真禁用）。证据：`home-disconnected.steps.txt:14`。

---

## 问题

- [P2] 现象：中文输入法下在 composer 按 Enter 确认候选词会**直接把消息发出去**（未定稿的拼音/候选被当正文）。 / 证据：`packages/web-app/src/pages/home/HomeView.tsx:236-238`；仓库内 grep `isComposing|compositionend` 无命中（同一模式也见 `packages/web-app/src/pages/workspace/ComposerBar.tsx:367`）。 / 根因：`onKeyDown={e => { if (e.key === "Enter") send(); }}` 未排除 `e.nativeEvent.isComposing`（也未 `preventDefault`）。 / 建议：改为 `if (e.key === "Enter" && !e.nativeEvent.isComposing) send();`。（本条为**静态代码判定**，headless 无法复现真实 IME，见「未验证与存疑」1。）
- [P2] 现象：区块标题「最近活跃」名不副实——展示的是**注册表前 3 个** agent，未按活跃度排序，且三张卡副标题**恒为「—」**。 / 证据：`evidence/01-home/home.dom.txt:6-12`（Agent 选择器 7 个选项的完整顺序：default/hr/algorithm/me/dataAgent/sw/mcode）、`evidence/01-home/home.dom.txt:35-43`（最近活跃三卡正好是该顺序前 3 个，且副标题均跟「—」）、`evidence/01-home/home.controls.txt:24-26`（三卡文本 `«ddefault—»/«hhr—»/«aalgorithm—»`）；web-app 全仓 grep `lastAction` 仅出现在 `AgentDetailView.tsx:87,122` 与 `AgentsView.tsx:347`（都是展示，无排序）。 / 根因：`packages/web-app/src/pages/home/HomeView.tsx:124` `const recent = view.agents.slice(0, 3);` 直接取注册表前 3 项，没有任何 recency 排序；`HomeView.tsx:308` 在 serve 未下发 `lastAction` 时渲染占位「—」。 / 建议：按 `lastAction`（或 serve 的时间戳）倒序取前 N；无数据时把标题改成「最近注册」或隐藏该区块，别让「最近活跃」这个断言无据。
- [P2] 现象：390x844 视口下**左侧导航整体消失且无任何替代入口**（无汉堡/抽屉/底部 tab）。 / 证据：`evidence/01-home/home-mobile.controls.txt:2-13`（12 个导航链接全部 `[0,0 0x0]`）、`evidence/01-home/home-mobile.png`（无侧栏、无汉堡，顶栏只有标题）。 / 根因：`packages/web-app/src/layout/AppSidebar.tsx:21` `className="hidden w-[240px] … md:flex"`；`packages/web-app/src/layout/AppShell.tsx:20-34` 未提供 `<md` 的导航替代（`layout/` 目录 grep `md:hidden|hamburger|drawer` 无命中）。 / 建议：给 `<md` 提供抽屉/汉堡（或底部 tab）。影响是**全站**，不止首页——移动端除首页自带链接外无法到达 /workspace、/settings 等。
- [P2] 现象：未连接态点「重试」后**页面无任何变化**，连接失败原因不上屏。 / 证据：`evidence/01-home/home-disconnected.steps.txt:8-10`（点击后 2s，`main.innerText` 与点击前逐字相同）、`evidence/01-home/home-disconnected.console.txt:4-8`（5 次 `ERR_CONNECTION_REFUSED`）、`evidence/01-home/home-disconnected-after-retry.png`。 / 根因：`packages/web-app/src/pages/home/HomeView.tsx:148-154` `onClick={() => void store.connect()}`——`void` 吞掉 `connect()` 的 rejection，失败既不写 `commandError` 也不改 UI；自动重连的失败只落 console。 / 建议：重试加 pending 态，并在失败时把连接层原文（如「连接被拒绝：检查 WS URL」）上屏（复用既有 `view.commandError` 提示条）。
- [P3] 现象：390x844 视口下「最近活跃」三张卡不换行，第 3 张右缘超出视口被裁，且无可见横向滚动提示。 / 证据：`evidence/01-home/home-mobile.controls.txt:24-26`（第 3 张 `[372,783 160x64]`，右缘 532 > 390）、`evidence/01-home/home-mobile.png`。 / 根因：`packages/web-app/src/pages/home/HomeView.tsx:287` `<div className="flex gap-2.5">` 固定不换行 + 卡片 `min-w-[160px]`；外层 `HomeView.tsx:127` 为 `overflow-y-auto`（x 向计算为 auto，但无可见滚动条样式）。 / 建议：`flex-wrap` 或横向可滚 + 明确滚动指示。
- [P3] 现象：未连接态「刷新项目列表」按钮**仍可点**，点击后界面无任何可见变化。 / 证据：`evidence/01-home/home-disconnected.controls.txt:20`（该按钮未标 `DISABLED`）。 / 根因：`packages/web-app/src/components/ProjectContext.tsx:148-158` 只要传了 `onRefresh` 就渲染刷新钮（首页恒传）；未连接时 `packages/web-app/src/state/session-store.ts:1264-1292` 把错误写进 `#projectsError`，但 `packages/web-app/src/lib/project-read-model.ts:55` 先判 `!connected` 返回 `disconnected`——错误文案被「未连接」态盖住，于是点击无可见结果。 / 建议：未连接时禁用刷新钮（与其它禁用态一致），或让 `projectsError` 在 disconnected 态也透出。
- [P3] 现象：连接摘要行在无分支时留下空字段——DOM 文案为 `cf-ui-demo · · 7 agent 运行中 · 0 定时任务待执行`（连续两个分隔符），且未说明 `cf-ui-demo` 是仓库名还是工作目录。 / 证据：`evidence/01-home/home.dom.txt:4`（视觉上两空格折叠成单个 `·`，见 `home.png`）。 / 根因：`packages/web-app/src/pages/home/HomeView.tsx:141` `` `${view.env.repos} · ${view.env.branch} · …` `` 无条件拼接空字段。 / 建议：`[repos, branch].filter(Boolean).join(" · ")`，或给两段加标签（仓库 / 分支）。
- [P3] 现象：未连接态 composer 的占位文案是「给**研发助手**发一条指令…」，指向一个注册表里并不存在的 agent。 / 证据：`evidence/01-home/home-disconnected.controls.txt:17`（`ph="给研发助手发一条指令…"`）。 / 根因：`packages/web-app/src/pages/home/HomeView.tsx:240` `` placeholder={agent ? `给 ${agent.name} 发一条指令…` : "给研发助手发一条指令…"} `` 的兜底写死一个具体名字。 / 建议：兜底改中性文案（如「发一条指令…」），名字只从焦点 agent 取。

> 另：已连接态未发现「看起来能点但没反应」或「禁用了但没有说明」的控件——发送键禁用态有 `opacity-40` 视觉差异（`home.png` 灰 vs `home-interact-composer-filled.png` 实心黑），未连接态每个禁用控件都有文字说明（见「实测链路」4）。

---

## 未验证与存疑

1. **真实发送未跑**（「真实发送恰好 1 次」是 T2 的验收项，避免重复真 LLM 调用与费用）。因此「快速会话」写入路径的端到端（`prompt` → 回复帧 → 「最近一轮」渲染 → 「查看完整对话」按钮出现）在首页**未验证**。已验的只有：输入可填、发送键三态（禁用/启用/禁用）、点击禁用键无出站帧。
2. **IME 缺陷为静态代码判定**：headless Chrome 无法复现真实中文输入法组合态，`HomeView.tsx:236-238` 的结论来自源码阅读与全仓 grep，无运行时证据；建议在真实带输入法的浏览器上复现后再定级。
3. **Agent 选择器的禁用外观**只在**已连接**态观察（select 可用）。未连接态的 select 已标 `DISABLED` 且文本为「未连接」（有说明），但「已连接却有 0 个 agent 可选」这一中间态本次不可得（注册表恒 7 个），其禁用外观未验证。
4. **移动端断点未全扫**：仅采 390x844；768–1024 区间与 `md` 切换临界点未采。
5. **对 shared serve 的副作用**：为验证 Agent 选择器，本连接做了一次 `attach hr` 并在结尾切回 `attach default`（该连接焦点最终回到 default，见 `home-interact.ws.txt:36-38`）。副作用：hr 被 lazy attach 并打开/生成了它的会话文件 `…/OMP-workspace-test/hr3/sessions/by-date/2026-09-17/221613__a335cab9.jsonl`（`home-interact.ws.txt:22-23`）。**未清理**——那是 hr 自己的会话日志，删除它属 scope 外的破坏性写。
6. `*.ws.txt` 会**同时捕获 Vite HMR 的 WebSocket**（首帧 `{"type":"connected"}`），非 serve 帧；判读出站帧时只看 `{"type":"request"…}` / `hello` 等 serve 协议帧。
7. 「最近会话回顾」的两个入口都覆盖到了：快捷卡→`/records`（`home-interact.steps.txt:34`），「最近活跃」区块本身只在首页呈现（未点进去逐个核对截图）。

---

## 复跑步骤

**环境前提**：前端 dev server 监听 `127.0.0.1:4173`（HEAD + HMR）；后端 serve 监听 `ws://127.0.0.1:7891/ws`。不要用 `packages/web-app/test/e2e/*.spec.ts`（会 spawn `vite preview` 抢 4173）。

```bash
# 0) 前置检查：前端在跑
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/     # 期望 200

# 变量（按你的 worktree 根替换 REPO）
REPO=$(git rev-parse --show-toplevel)
HARNESS=/Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts
OUT="$REPO/docs/web-app-functional-diagnosis-2026-09-17/evidence/01-home"

# 1) 桌面基线（已连接，1440x900）
bun "$HARNESS" --page '#/' --out "$OUT" --name home --view 1440x900

# 2) 移动视口（390x844）
bun "$HARNESS" --page '#/' --out "$OUT" --name home-mobile --view 390x844

# 3) 交互实测（Agent 切换 / composer 三态 / 禁用发送 / 项目刷新 / 5 张快捷卡 / 最近活跃 / 工作台入口）
bun "$HARNESS" --page '#/' --out "$OUT" --name home-interact --view 1440x900 --wait 800 \
  --steps "$OUT/home-interact-steps.json"

# 4) 未连接态（指向死端口 9999，不碰真 serve）
bun "$HARNESS" --page '#/' --out "$OUT" --name home-disconnected --view 1440x900 --wait 2500 \
  --ws ws://127.0.0.1:9999/ws --steps "$OUT/home-disconnected-steps.json"
```

**判读规则**
- 每步结果见 `<name>.steps.txt`；「点了没反应」判据 = 该步 `失败：… Timeout` **且** `<name>.ws.txt` 里无对应出站帧（缺一不可）。
- 「禁用了但没有说明」判据 = `<name>.controls.txt` 标 `DISABLED` **且**截图里与可用态无可见差异（本页发送键两者都满足"有差异"，故不成立）。
- 未连接态下 `home-disconnected.console.txt` 出现 `ERR_CONNECTION_REFUSED` 是**预期**（指向死端口）。
- 截图：`home.png`（基线）、`home-mobile.png`（移动）、`home-interact-agent-hr.png`（切 hr 后）、`home-interact-composer-filled.png`（发送键启用）、`home-disconnected-disconnected.png` / `home-disconnected-after-retry.png`（未连接态点击前后）。
