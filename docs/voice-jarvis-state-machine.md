# Voice Jarvis 状态机（P1b 现状，以代码为准）

> 状态：梳理稿 · 2026-08-06 · 对应实现：`src/live/`、`src/modes/controllers/voice-mode-controller.ts`
> 目的：把语音栈四层状态机摊开——状态、转移、跨层交互、已测/未测清单。新行为改动前先在这里对表。

## 0. 分层总览

```
L1 传输层   RealtimeWsTransport    idle/connecting/connected/reconnecting/closed
L2 相位层   LiveSessionController  connecting/listening/thinking/speaking/interrupted/muted/error
L3 执行层   意图路由 → consult 桥 / task 路由器 / 确认门（各自独立状态机）
L4 记录层   LiveTurnBuffer + recorder（话语去重）
```

层间契约：L1 事件驱动 L2 相位；L2 的 `onTranscript/onIntent` 回调驱动 L3 分发与 L4 记录；L3 的产出（结果/确认问题）经 controller 的 `#injectUserNote`（cancel→item→create）或 function output 回到 realtime 会话播报。

---

## L1 传输层（`ai/realtime/transport.ts`）

`idle → connecting → connected ⇄ reconnecting → closed`（closed 为终态，不可复活）

- 非主动断开 → 指数退避重连（`maxAttempts` 次内）→ 重新 `connected`
- **重连契约**：每次 connected 都是服务端全新会话；config 不重放，controller 在 `session.created` 重发 `session.update`
- 重连耗尽 / `close()` → closed → controller 收到 state 回调 → `onTerminal`

## L2 相位层（`live/controller.ts`）

```
                 session.updated / ack 超时(2s)
   connecting ────────────────────────────────► listening ◄────┐
       ▲ 重连                                      │  ▲         │
       │                                          ▼  │         │
       └────────────────────────────────────  thinking  speaking
                                                   │         │
             speech_stopped / 函数派发 ────────────┘         │
             audio.delta ─────────────────────────────────►──┘
             response.done → drain → sink.end + 1000ms 沉降 ──► listening
             speaking 中持续大声音(回声地板门控) → barge-in：
                 response.cancel + 打断注记 + 停播放 → interrupted → listening
             setMuted：muted ⇄ listening/speaking（仅这三态间）
             服务端错误 ×3 → halted → onTerminal（会话终结）
             #injectUserNote（确认/摘要/迟到结果）：
                 response.cancel + 停播放 → listening → item → response.create
```

**上行门控**（每个麦克风帧，按顺序）：
disposed/halted/未 configAck → 丢弃；muted → 静音帧；speaking → 静音帧（除非连续 5 帧超过回声地板 = barge-in）；**低于 `micNoiseFloor`(0.02) → 静音帧**；其余 → 原样上行。

**端点检测（谁判定「说完了」）**：`voice.endpointing`，默认 **server**（2026-08-06 验收实锤后回退）。
- **server 模式**（默认，已验证）：server_vad 固定静默窗口判停。句中停顿偶有抢答，但整体可靠。
- **client 模式**（opt-in 实验，勿默认开启）：`turn_detection: null`，控制器自己跟踪语音：RMS ≥ 0.04 起始，静默达到 `voice.vadSilenceMs` 判定说完 → commit + response.create。**已知缺陷（2026-08-06 实测）**：固定 0.04 阈值无自适应（环境噪声峰值可达 0.035，语音略低即永不 arm）；任何 ≥ 阈值的噪声尖峰重置静默窗（真实办公环境下端点永远到不了）——表现为播报后第一句话被吞几十秒。修复需自适应噪声基线，不是调参能解决的。

**转写守卫**（`transcription.completed`，按顺序）：speaking 相位丢弃 → `#isEcho`（近 5 条助手话语匹配）丢弃 → <3 字丢弃（**确认等待期间豁免**，「确认/做/好」可达）。

## L3 执行层

### 3.1 意图分发（realtime 模型函数调用）

| 函数 | 意图 | 缓冲路由(L4) | 执行去向 |
|---|---|---|---|
| （不调用） | chat | assistant 信号/5s 超时 → flush | realtime 直答 |
| `omp_agent_consult` | query | flush（记录） | consult 桥 |
| `omp_agent_task` | task | drop（注入即记录）+ suppress 竞态标志 | task 路由器 |
| `omp_agent_control` | status/steer/cancel | steer→drop；status/cancel→flush | task 路由器 + consult 桥 |
| `omp_voice_confirm` | 确认答复 | drop | 确认门 resolveDecision |

**意图先于转写到达的竞态**：task/confirm 意图到达时无缓冲 → 置 `#suppressNextUserTurn`，迟到的 final 转写丢弃。

**分类边界（2026-08-06 重定义）**：按**是否依赖上下文**划分，不按读/写——依赖工作区或对话历史的问题（含指代类「这个文件」、验证类「改对了吗」、只读工作区查询）一律走 task 进主会话；自包含纯事实（天气/算术/公开信息搜索）才走 consult。原因：consult 零历史，指代类问题只有在全量历史的主会话才能答对。

**上下文保鲜**：realtime 前端的会话摘要不再是进入语音时的一次性快照——VoiceModeController 订阅主会话 `agent_end`，每轮结束（打字轮或语音任务）调 `updateInstructions` 重建摘要。注意：只发 instructions，不重发 turn_detection（qwen 在音频处理开始后禁止改它，P0 坑 #6）。

**bash 只读绿级**：确认门对静态可判只读的命令（git status/log/diff/show、ls/cat/grep 等，含只读管道）直接放行，工作区查询不必口头确认；含任何链式/重定向/替换操作符的命令不适用。

### 3.2 consult 桥（每次调用一个 invocation）

```
idle → running ──► done（agent_end → 结果文本）
              ├─► timedOut(120s) → 转后台；迟到结果走 onBackgroundResult
              └─► cancelled（abortCurrent）→ 收尾文本，结果永不播报
会话缓存：cached ──isStreaming──► 换新会话（只读查询无状态，不等僵尸回合）
```

关键语义：**abort 落在下一个 loop 边界**——运行中的工具（如慢 web_search）先跑完，期间会话 busy，新查询走新会话。

### 3.3 task 路由器

```
idle ──dispatch──► inFlight ──► done（agent_end → 摘要≤500字）
  守卫（拒绝派发）：disposed / plan mode / 门未武装(fail-closed) / isStreaming(任意来源)
  inFlight 中：steer → sendUserMessage(deliverAs:"steer")
              cancel → session.abort()
              status → 最近工具活动 / 「正在思考」兜底
```

### 3.4 handoff（controller，consult/task 共用）

```
工作承诺 vs 3s 窗口：
  3s 内完成 → function output = 结果（模型直接播）
  超时      → function output = 占位语「正在处理，请稍等…」
              工作迟到 → #injectUserNote 延迟轮（task 摘要 / consult 结果 / 取消收尾）
```

### 3.5 确认门（VoiceGate）

```
disarmed ──arm(主会话 runner)──► armed
armed + 非 inFlight → 一律放行（打字轮/consult 不受门控）
armed + inFlight + tool_call：
  green → 放行
  yellow + 本任务已粘滞 → 放行
  其余 → 确认回合（#confirmChain 串行化并行工具）：
    speak(确认注记) → 等答复(15s)
      confirm → 放行（yellow 记粘滞）
      cancel  → block + 收尾注记（指示静默）
      unclear → 重问一次 → 仍不清 → block + 收尾注记
      超时    → block
      通道不可用(speak=false) → 按 cancel
  endTask / disarm → 挂起回合按 cancel 收尾
红级永不粘滞；block 理由为 agent 可读文本。
```

## L4 记录层（LiveTurnBuffer）

```
final 用户转写 → hold ──intent=query──► flush（recorder 记录）
                    ├─intent=task/confirm─► drop（+suppress 标志兜迟到转写）
                    ├─assistant 信号（partial/final）─► flush
                    └─5s 无意图（chat 直答）─► flush
确认等待中的用户转写：不进缓冲（门消费）；steer 注入即记录（drop）。
```

---

## 跨层交互矩阵（★=本轮新增测试）

| # | 场景 | 现行行为 | 测试状态 |
|---|---|---|---|
| 1 | task 执行中说「停」 | abort 主会话；摘要按取消收尾 | ✅ router 单测 |
| 2 | consult 执行中说「停」 | abortCurrent + 收尾文本；busy 残留期新查询换新会话 | ✅ consult 单测×3 |
| 3 | **确认等待中说「停」** | control(cancel) → abort → agent_end → gate.endTask → 挂起确认按 cancel 收尾 → 工具 block（双重取消，无害） | ★ 新增 gate 单测 |
| 4 | 无任务时说「停」 | 返回「没有在跑的任务或查询」；提示词禁止假报「已取消」 | ✅ router 单测 + 提示词（模型合规=验收项） |
| 5 | **确认问题播报中被打断** | barge-in 停播放；问题文本仍在上下文，用户仍可回答，门继续等 | ★ 新增 controller 单测（注入停播放）；组合=验收 |
| 6 | task 跑着来新 task | busy 提示（isStreaming 任意来源） | ✅ router 单测 |
| 7 | task 跑着来 query | 并行 consult（两会话独立） | 构造保证，验收观察 |
| 8 | 重连发生在 task 执行中 | task 在主会话继续；realtime 重连后是全新会话（上下文丢失）；挂起确认成孤儿 → 15s 超时 block | 传输层有测试；组合=验收观察 |
| 9 | 语音退出(alt+v)时 task 在跑 | task 继续（真实会话）；门 disarm；缓冲 flush 落盘 | 验收观察 |
| 10 | 确认等待中静音 | 上行静音帧，用户无法回答 → 15s 超时 block | 构造保证 |
| 11 | 服务端错误累计 | ×3 熔断终止；session.updated 重置计数 | ★ 新增 controller 单测（重置） |
| 12 | 意图先于转写到达 | suppress 标志丢迟到转写 | 实现级（controller 私有，验收观察） |
| 13 | 确认答复「确认」(2字) | 确认等待期间豁免 <3 字守卫 | ✅ controller 单测 |
| 14 | 回声/噪声 | isEcho + <3字 + speaking 丢弃 + 噪声地板 + 1000ms 沉降 | ✅ 多项 |
| 15 | 慢工作占位/迟到送达 | handoff 两段式；cancel-first 防 create 碰撞 | ✅ controller 单测×4 |
| 16 | 并行工具双确认 | #confirmChain 串行，一次只问一个 | ✅ gate 单测 |
| 17 | 取消状态被后续操作冲掉 | 按 invocation 隔离 | ✅ consult 回归单测 |

## 已知缺口（诚实清单，2026-08-06 二轮更新）

1. ~~abort 不能打断运行中的工具~~ **大部分已修**：web_search 全链接通 AbortSignal（executeSearch 透传 + anthropic/gemini/exa/jina/zai 五个 provider 补接；abort 不再落链到下一个 provider）；bash 本就完善。残留：exa 的 MCP 路径不传信号（传输层限制，已注释）；python 内核/task 子代理的中断属 agent 层通用问题，不在语音范围。
2. ~~重连后 realtime 上下文丢失~~ **已修**：重连完成（connecting→listening）时若有任务/查询在跑，注入状态摘要（任务文本来自 router/bridge 的 currentTask），模型不再凭空编「还在处理」。残留：重连前挂起的确认必然 15s 超时（新会话没有确认上下文）——可接受。
3. **模型合规性只能靠提示词**：假报「已取消」、编造系统状态——提示词已四度加固（含「control 返回是唯一权威」「没事不许说已取消」），剩余靠验收观察。
4. ~~面板相位与任务态不同步~~ **已修**：listening 相位渲染「▸ 执行中」活动行；任务/查询结束后清理活动行。
5. **consult 的 thinkingLevel:"off" 对 deepseek 系模型不生效**（根因已查实）：`toReasoningEffort("off")` 返回 undefined，与「未设置」不可区分；openai thinkingFormat 分支在 reasoning=undefined 时什么都不发，服务端默认 thinking 开启。qwen/zai 格式不受影响（显式发 enable_thinking:false / thinking.disabled）。候选修复（需对 narwal-plan 端点实测后二选一）：a) openai 格式下显式 off 发 `reasoning_effort: "none"`（codex 传输已有 none 档先例）；b) 按模型族补 enable_thinking。未实测不盲发参数——400 风险大于 thinking 多耗的延迟。
6. **abort 落在下一个 loop 边界**（不变）：运行中的工具先跑完。web_search 修复后该窗口从「整个请求时长」缩到「信号传播时长」；红级 bash 长命令中说「停」，仍要等命令自己结束。