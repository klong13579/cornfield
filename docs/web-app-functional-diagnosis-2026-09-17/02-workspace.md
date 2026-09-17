# 会话工作台（#/workspace）功能诊断与改进建议

- 日期：2026-09-17 ｜ 任务：T2 ｜ 分支：`squad/webapp-diag-t2`
- 被测：前端 dev server `http://127.0.0.1:4173`（本仓库 HEAD 源码 + HMR）；后端 `ws://127.0.0.1:7891/ws`（无 token）
- 采集器：`.worktrees/_diag-harness/collect.ts`（每次运行独立起一个 headless Chrome，多路并行安全）
- 真发送落点会话文件：`/Users/sz-0203015357/.cornfield/agents/default/sessions/--private-tmp-cf-ui-demo--/by-date/2026-09-17/221612__e791fd60.jsonl`

## 页面与入口

- 路由：`#/workspace`，在面板注册表里登记为 panel `workspace`（`packages/web-app/src/router.tsx:62-71`，`customTopbar: true`），从左侧导航「会话工作台」进入。移动裁剪路由 `#/m` 复用同一个 `WorkspaceView`（`router.tsx:235`，`compact` 模式）。
- 页面结构（`packages/web-app/src/pages/workspace/WorkspaceView.tsx`）：
  - 左：`SessionSidebar`（`WorkspaceView.tsx:193`）—— 列表/树双视图、WebUI/CLI 双源 tab、搜索、pin。
  - 中：自定义顶栏（`WorkspaceView.tsx:203-265`）＝ 连接态 + `AgentSwitcher` + 工作区读数 + `ProjectSwitcher` + 会话名 +「手机预览 / 展开右栏 / compact / 新会话」；下接 `Transcript`（`:267`）、`PlanStrip`（`:292`，本会话 Session Todo）、`QueueCard`（`:294`）、`ComposerBar`（`:303`）。
  - 右：`RightPanel`（`:305`，文件/产物/改动三 tab，默认折叠）与 `DevicePreview`（`:306`，手机预览浮层）。
- 证据：`evidence/02-workspace/workspace.png`、`workspace.controls.txt`（基线 74 个可交互控件）、`workspace.dom.txt`、`workspace.summary.json`。

## 实测链路

所有运行均无失败请求（`*.network.txt` 全为「无失败请求 / 无非 2xx 响应」），除 `panels` 一次 Vite HMR 重连外无 console 报错（`*.console.txt` 仅 vite 连接与 React DevTools 提示）。以下「帧数」指 `*.ws.txt` 的 WebSocket 收发帧数。

1. **基线加载**（`workspace.*`）：`connected → hello → hello_ack`（`connectionId`、`protocolVersion:1`、`gatewayWirePort:7892`），随后页面并发拉 `list_projects / list_agent_todos / git_changes / get_state / list_sessions / get_available_models / list_commands`，`server_snapshot` + `session_snapshot` 到达。帧数 27、网络问题 0、console 错误 0。
2. **输入条 · 非发送交互**（`composer.*`，证据 `composer.steps.txt`）：
   - Shift+Enter 插入换行且**不发送**：step 4 `press Shift+Enter → ok`，step 7 textarea 值 `"第一行\n"`，全程 WS 仍为 27 帧（无 `prompt` 出站帧）。
   - 空闲态 Esc 无副作用：step 9-11，草稿保留 `"第一行\n"`。
   - 输入 `/` 打开命令面板：step 16 `系统命令` 出现（图 `composer-slash-palette.png`）。
   - 空文本 Enter 不发送：step 22 值 `""`（`send()` 空文本直接 return，`ComposerBar.tsx:314-318`）。
3. **工具条**（`toolbar.*`，证据 `toolbar.steps.txt`）：点「附件」→ 触发隐藏 file input，step 6 读出 `accept="image/*"`；点「语音」→ step 10 `location.hash = "#/voice"`；模型下拉可开（`toolbar-model-menu.png`）；Agent 选择器可开、含 CODING/WORKER（`toolbar-agent-menu.png`）。
4. **图片粘贴**（`misc.*`，证据 `misc.steps.txt`）：step 3 textarea React props `onPaste:"undefined"`（而 `onChange/onInput/onKeyDown` 皆 function）；step 5 派发含 `image/png` 的合成 paste → `valueAfter:""`、`fileInputFiles:0`。→ 见问题 P1。
5. **右栏三 tab + 手机预览**（`panels.*`，证据 `panels.steps.txt`）：展开右栏后 step 6 三 tab 文案齐（文件/产物/改动）；产物、改动 tab 可切（`panels-right-panel-files.png`、`panels-right-panel-artifacts.png`、`panels-right-panel-changes.png`）；手机预览打开，step 19 `移动端预览` 出现（`panels-phone-preview.png`）。
6. **手机预览关闭**（`preview2.*`，证据 `preview2.steps.txt`）：打开后页面有 2 个 `aria-label="关闭预览"`（全屏遮板 + X）；用 `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 派发后遮板数归 0 → **Esc 可关闭预览**。
7. **消息流与工具卡**（`history.*`，证据 `history.steps.txt`、`history-history-top.png`）：打开历史会话「你的工作区在哪？」→ step 7 输入框占位符变 `@hr 发消息，或直接提问…`（输入框 agent 跟随视图焦点，SERVE-1 行为成立）；step 8 转录 19 条 `.msg-row`；正文可见工具卡「活动 · N 个工具」、失败标记「1 个失败」与模型徽标 `deepseek-v4-flash-0731`。
8. **真发送（唯一 1 次真 LLM 调用）**（`send.*`，证据 `send.steps.txt`、`send.ws.txt`）：
   - 在 `#/workspace`（焦点 `@default`）用 Enter 发送 `请用三点说明为什么代码要写测试` → wire 出站 `{"type":"prompt","message":"请用三点说明…","sessionId":"default"}`（`send.ws.txt:28`）。
   - **是否流式：是**。`thinking_delta`/`text_delta` 逐帧到达（`send.ws.txt:41`、`:91`、`:99` 起），屏幕尾部在 5.2s 时已见正文；turn 以 `text_end → message_end → turn_end → agent_end` 完整收尾（`send.ws.txt:137-143`）。
   - **耗时**：Enter 后 ~1.9s 尚无帧（step 9，`streaming:false`）→ ~5.2s 已流式（step 12，`streaming:true`）→ ~7.5s 完成（step 17，`streaming:false`）。
   - **会话文件**：step 20 读出 `/Users/sz-0203015357/.cornfield/agents/default/sessions/--private-tmp-cf-ui-demo--/by-date/2026-09-17/221612__e791fd60.jsonl`，与 `send.ws.txt:30` 的 `session_snapshot.sessionFile` 一致。
   - 说明：脚本随后那次 Esc 落在 turn 完成之后（`send.ws.txt` 无任何 `abort` 出站帧），故流式中止路径未在本次运行时覆盖 → 见「未验证与存疑」。

## 问题

- [P1] 现象：在输入框（textarea）粘贴图片**完全无反应**——不生成附件、不改草稿、不报错；这是「看起来能粘贴但没反应」。 / 证据：`evidence/02-workspace/misc.steps.txt` step 3（textarea 的 React props：`onPaste:"undefined"`，`onChange/onInput/onKeyDown` 均为 function）与 step 5（派发含 `image/png` File 的合成 paste → `valueAfter:""`、`fileInputFiles:0`）；`evidence/02-workspace/misc.png`；源码 `packages/web-app/src/pages/workspace/ComposerBar.tsx:413-431`（textarea 只挂了 `onChange`/`onInput`/`onKeyDown`，无 `onPaste`）、`ComposerBar.tsx:177-190`（唯一入图路径 `onPickImages`）、`ComposerBar.tsx:516-523`（`accept="image/*"` 的隐藏 file input）。 / 根因：入图只有「附件按钮 → 文件选择器」一条通道；textarea 未接 `onPaste`，也没有从 `clipboardData` 提取 `image/*` 的代码——浏览器对 textarea 的默认粘贴只处理文本，图片被静默丢弃。 / 建议：给 textarea 加 `onPaste`，从 `e.clipboardData.items` 过滤 `item.type.startsWith("image/")` → `getAsFile()` → 复用 `onPickImages` 的 FileReader→base64 逻辑（抽成 `addImageFiles(files)`）；仅在确实取到图片时才 `preventDefault()`，纯文本粘贴保持默认不动。

- [P2] 现象：模型下拉把「当前」徽标**同时打在两条 `deepseek-v4-flash` 上**（ALIBABA-CODING-PLAN 组一条、另一条在 NARWAL-PLAN 组），并把 alibaba 组置顶；而本会话实际生效的是 `narwal-plan/deepseek-v4-flash`——用户无法判断当前真正在跑哪个。 / 证据：`evidence/02-workspace/modelmenu.steps.txt` step 6（`rowCount:381`，`badgedRows:["deepseek-v4-flash 当前","deepseek-v4-flash 当前"]`）、step 4（菜单文本中「当前」出现 2 次）、step 5（组 `NARWAL-PLAN 111`）；`evidence/02-workspace/send.ws.txt:19`（`get_available_models` 首条 `id=deepseek-v4-flash` 的 `provider=alibaba-coding-plan`）对比 `send.ws.txt:22`（`get_state` 的 `model.provider=narwal-plan`）；源码 `packages/web-app/src/state/session-store.ts:1800`（view 只存 `snapshot.model?.id`，丢弃 provider）、`ComposerBar.tsx:38` 与 `ComposerBar.tsx:273`（`modelList.find(m => m.id === currentModelId)?.provider` 取首个匹配）、`ComposerBar.tsx:607-611`（`m.id === view.model` 即渲染「当前」）。 / 根因：视图层只保留 model id，provider 靠「列表里第一个同 id 项」反推；同一 id 存在于多个 provider 时（本环境 `deepseek-v4-flash` 同时在 alibaba-coding-plan 与 narwal-plan 下），置顶组、按钮 ProviderLogo、「当前」徽标三处都可能指向错的 provider。 / 建议：把 provider 一并放进 view（`get_state` 已返回 `model.provider`），徽标/置顶/logo 改用 `(provider, id)` 双键比对；下拉行点击本已带 provider（`store.setModel(m.id, m.provider)`，`ComposerBar.tsx:599`），保持一致即可。

- [P2] 现象：顶栏 `compact` 按钮一点即向服务端发 `{"type":"compact"}`，触发**当前会话的上下文压缩**（不是视图折叠）；按钮无二次确认、无影响说明，且左侧紧邻「手机预览 / 收起右栏」两个纯 UI 开关、右侧是「新会话」，极易被当成同类视图按钮误点。 / 证据：源码 `packages/web-app/src/pages/workspace/WorkspaceView.tsx:257-259`（`onClick={() => store.compact()}`）、`packages/web-app/src/state/session-store.ts:494-496`、`packages/web-app/src/state/pi-client-adapter.ts:256-258`（`this.#req({ type: "compact" })`）、服务端 `packages/coding-agent/src/server/wire-server.ts:2194`（`case "compact": await session.compact(...)`）；控件位置 `evidence/02-workspace/workspace.controls.txt`（`button [1290,8 66x31] «compact»`，同行还有 `«手机预览»/«展开右栏»/«新会话»`）。 / 根因：「压缩上下文」被归进了顶栏的**视图操作区**，命名沿用内部术语 compact，缺确认与后果说明。 / 建议：至少补 `title`/确认并说明「会压缩本会话上下文」；更稳的是把它移出视图操作区（放进会话操作/更多菜单），或直接改名为「压缩上下文」。

- [P3] 现象：模型下拉把**全部可用模型一次性平铺**（本环境 381 行；单组 alibaba-coding-plan 252、narwal-plan 111），组内不折叠、无搜索/过滤，只能在 `max-h-[46vh]` 的滚动区里翻找。 / 证据：`evidence/02-workspace/modelmenu.steps.txt` step 6（`rowCount:381`）、step 5（组计数）、step 4（菜单文本 7685 字符）；`evidence/02-workspace/toolbar-model-menu.png`、`modelmenu.png`；源码 `ComposerBar.tsx:583-616`（`max-h-[46vh] overflow-y-auto` + 对 `modelGroups` 全量 `map`，无过滤输入）。 / 根因：下拉只做了「按 provider 分组 + 当前 provider 置顶 + 容器滚动」，没有任何筛选维度（无搜索框、组头不可折叠、无「仅当前 provider」）。 / 建议：加按 id/provider 子串的过滤输入框；组头可折叠；或默认只展开当前 provider 组。

- [P3] 现象：`WorkspaceView` 顶部注释与实现不符——注释声称右栏已被移除。 / 证据：`packages/web-app/src/pages/workspace/WorkspaceView.tsx:141-144`（「右栏已按用户决策移除，对话区占满全宽」）对比 `WorkspaceView.tsx:305`（实际 `<RightPanel collapsed={!ui.rightPanelOpen} />`）与 `RightPanel.tsx` 全文件。 / 根因：右栏恢复后未回填注释。 / 建议：按当前实现改写该注释（右栏存在、默认折叠、由顶栏按钮切换），避免下一个读者据此删错代码。

## 未验证与存疑

- **Esc 中止（流式中）未实测**：本轮唯一一次真发送的回复在脚本按下 Esc 之前/附近就已收尾——`send.ws.txt` 无任何 `abort` 出站帧，turn 以 `agent_end` 完整结束（`send.ws.txt:143`）。故「streaming 时按 Esc → `store.abort()`」只在静态层确认：`ComposerBar.tsx:367-373`（Enter 在 streaming 时也走 `store.abort()`）与 `ComposerBar.tsx:374-376`（`Escape && active` → `store.abort()`）。空闲态 Esc 无操作已实测（`composer.steps.txt` step 9-11）。复跑时若要覆盖此项，需在流式期间（如 Enter 后 2-3s）按 Esc，并核对 `*.ws.txt` 出现 abort 出站帧。
- **compact 点击的运行时效果未执行**：属写/不可逆操作，按规则只做静态审查（代码路径见问题 P2），未点击。
- **模型下拉中点选模型（`set_model`）与「思维级别」切换未执行**：会写配置。静态路径 `ComposerBar.tsx:598-601`、`ComposerBar.tsx:627-630`。
- **Agent 选择器点选未执行**（`store.focusAgent` → attach + 切连接焦点）。只验证了「菜单能开」与「输入框 agent 跟随视图焦点」（`history.steps.txt` step 7，占位符变 `@hr 发消息…`）。
- **右栏「改动」tab 的 repoRoot 与会话 cwd 不一致（存疑）**：`panels-right-panel-changes.png` 显示改动来自 `/Users/sz-0203015357/.cornfield`（「工作区 未跟踪」若干行），而当前会话文件路径编码的 cwd 是 `/private/tmp/cf-ui-demo`（`send.ws.txt:12` 的 `sessionFile`）。「agent 工作区 ≠ 会话 cwd」是否为预期未确认，不做结论。
- **采集器局限（非产品问题，但会影响判据）**：`collect.ts` 的 `{"press":["body","Escape"]}` **不会**把按键送达 window 级监听——`preview.steps.txt` 里派发后遮板仍在（`preview-preview-after-escape.png`），而改用 eval 派发 `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 后遮板归 0（`preview2.steps.txt` step 6/8，`preview2-esc-eval-dispatched.png`）。凡涉 window 级快捷键的验证，请用 eval 派发，避免误判成「点了没反应」。
- **消息级操作条未做视觉确认**：`MsgActions` 的撤销/重试/分叉/复制按钮是 hover/focus 显隐（`packages/web-app/src/render/msg-actions.css:1-14`，`opacity:0` → `.msg-row:hover` 或 `:focus-within` 露出），截图未悬停故不可见，属设计而非缺陷；触屏可达性未验证。
- **未做**：真机/移动端（`#/m` 只经由手机预览 iframe 间接确认）、并发多连接下的行为、离线/重连路径。

## 复跑步骤

前置：dev server(4173) 与后端 ws(7891) 已在跑（**勿自行起进程**）。所有命令可直接复制执行。

```bash
REPO=/Users/sz-0203015357/Desktop/Narwal/cornfield
WT=$REPO/.worktrees/squad-webapp-diag-t2
OUT=$WT/docs/web-app-functional-diagnosis-2026-09-17/evidence/02-workspace
COLLECT=$REPO/.worktrees/_diag-harness/collect.ts

# 前置检查
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4173/

# 1. 基线（截图 + controls/console/network/ws）
bun $COLLECT --page '#/workspace' --name workspace --wait 3000 --out $OUT

# 2. 输入条：Shift+Enter 换行 / 空闲 Esc / 斜杠面板 / 空 Enter（无真发送）
bun $COLLECT --page '#/workspace' --name composer --wait 2500 --out $OUT --steps $OUT/steps-composer.json

# 3. 工具条：附件 / 语音 / 模型下拉 / Agent 选择器（只读）
bun $COLLECT --page '#/workspace' --name toolbar --wait 2500 --out $OUT --steps $OUT/steps-toolbar.json

# 4. 图片粘贴通道 + 右栏默认折叠（见问题 P1）
bun $COLLECT --page '#/workspace' --name misc --wait 2500 --out $OUT --steps $OUT/steps-misc.json

# 5. 右栏三 tab + 手机预览 + 历史会话消息流
bun $COLLECT --page '#/workspace' --name panels --wait 2500 --out $OUT --steps $OUT/steps-panels.json

# 6. 手机预览：Esc 关闭（collector 的 press(["body","Escape"]) 不达 window，用 eval 派发）
bun $COLLECT --page '#/workspace' --name preview2 --wait 2500 --out $OUT --steps $OUT/steps-preview2.json

# 7. 历史会话：消息流与工具卡
bun $COLLECT --page '#/workspace' --name history --wait 2500 --out $OUT --steps $OUT/steps-history.json

# 8. 模型下拉结构：「当前」徽标重复 / 总行数（见问题 P2、P3）
bun $COLLECT --page '#/workspace' --name modelmenu --wait 2500 --out $OUT --steps $OUT/steps-modelmenu.json

# 9. 真发送（唯一一次，烧真配额）：Enter 发送 → 观测流式
bun $COLLECT --page '#/workspace' --name send --wait 2500 --out $OUT --steps $OUT/steps-send.json
```

判据复核：
- P1：`read $OUT/misc.steps.txt`（step 3 `onPaste:"undefined"`、step 5 `fileInputFiles:0`），并静态核对 `ComposerBar.tsx:413-431` 无 `onPaste`。
- P2/P3：`read $OUT/modelmenu.steps.txt`（step 6 `rowCount` 与 `badgedRows`），交叉核对 `send.ws.txt:19` 与 `send.ws.txt:22` 的 provider。
- 「点了没反应」类判断一律同时看 `*.steps.txt`（是否 timeout）与 `*.ws.txt`（是否真的没出站帧），只看其一等于猜。
