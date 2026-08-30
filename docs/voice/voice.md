# Voice Jarvis 实时语音

> 状态：已实施（2026-08；P0 已交付、P1 已实现，现状以代码为准）
> 实现位置：`packages/coding-agent/src/live/`、`src/modes/controllers/voice-mode-controller.ts`、`src/modes/components/voice-orb.ts`。
> 语音 TUI 视觉重设计（待拍板，分支 feature/voice-ux）见 `docs/voice/orb-redesign.md`；原型资产：`voice_tui/`（render_frames.py 数学已被 voice-orb.ts 移植）、`docs/voice/animation/`（呼吸球动画帧）。

## 1. 目标与非目标

**P0 目标**：Mac 上 `cornfield` TUI 内一键进入连续双工语音模式（说话→语音播报，可中途打断）；需要干活时 realtime 模型通过 function call 委托给 cornfield agent（agent-consult 模式），25+ 工具/session/memory 全保留；语音轮 transcript 实时写 session JSONL，语音/打字共享历史；端到端延迟 ≤1.5s。

**P1 目标一句话**：语音成为「嘴打的 TUI」——任务直接进主会话，上下文/工具/thinking/展示天然对齐，安全靠分级确认门而不是阉割能力。

| 维度 | TUI | P0 语音 | P1 语音 |
|---|---|---|---|
| 工具面 | 全量 25+ | 只读白名单 | 全量（过确认门） |
| 会话 | 当前 session | 独立 consult 会话，零历史 | 主会话，完整历史 |
| thinking | 开 | 关 | 开 |
| 写操作 | 正常执行 | 口头拒绝 | 分级语音确认 |

**非目标 / 后续工作（P2+，本次不做）**：唤醒词常驻、gateway 语音播报、全屏动效/graphics protocol、手机端/WebRTC、视频理解。

## 2. 总体架构

```
┌─────────────────────────── cornfield 进程 ───────────────────────────┐
│  麦克风 ──AEC──▶ AudioCapture (natives, CoreAudio)          │
│                    │ PCM16 帧                                  │
│                    ▼                                           │
│  LiveSessionController（状态机 + 电平 + 打断仲裁）              │
│                    │ input_audio_buffer.append                 │
│                    ▼                                           │
│  RealtimeWsTransport ──WSS──► narwal-plan                      │
│  (ai/realtime)              qwen-audio-3.0-realtime-flash/plus│
│                    │                                           │
│     ┌──────────────┴───────────────┐                           │
│     │ 语音直接回答（chat/query 快路径）│ function_call            │
│     ▼                              │   (consult | task | control)│
│  扬声器 ◄── output_audio.delta     ▼                           │
│                                  consult 会话（只读） / 主会话   │
│                                  └──► function_call_output 回注  │
│  TUI: VoicePanel（phase 动效 + 字幕 + 工具滚动）                 │
└────────────────────────────────────────────────────────────────┘
```

职责切分原则：**realtime 模型是嘴巴和耳朵，不是大脑**。闲聊/确认/播报本地完成；任何查文件、跑命令、操作业务系统的请求必须委托 cornfield agent，绝不让 realtime 模型自己编排多步任务。

P1 两条执行路径并存：

- **query/chat 快路径**：只读 consult 会话，一次调用秒回（「天气」「TODO 几条」）。
- **task 路径**：任务直接 `sendUserMessage` 进当前主会话（`VoiceModeController.#ctx.session`），获得与打字完全相同的执行语义——完整 system prompt / 全量工具 / 完整历史 / 持久化 / memory / 自进化。展示零成本：主会话事件流本就由 TUI 渲染，语音侧只滚动工具活动行。

## 3. 传输与协议（ai realtime）

`packages/ai/src/realtime/`：`transport.ts`（WSS 握手/鉴权/指数退避重连/心跳/事件分发）、`protocol.ts`（双向事件类型）、`audio.ts`（PCM16 base64、24kHz、静音帧）、`function-bridge.ts`（function 注册/收参/回注）。

- 协议：标准 OpenAI Realtime 事件（`session.update`、`input_audio_buffer.append`、`response.create`、`response.cancel`、`conversation.item.create`）。探针已验证 narwal-plan 全支持。
- `narwal-plan` 增加 `realtime: { url: "wss://coder.narwal.com/v1/realtime", protocols: ["openai-realtime-v1"] }`（descriptors.ts，models.json 生成器产出）。
- `LiveSessionController` 把 transport 抽象成 `LiveTransport` 接口（connect/sendAudio/sendEvent/close + 事件回调），`CodexLiveTransport` 保留为实现之一，controller 按配置选。
- `LivePhase`：`connecting | listening | thinking | speaking | interrupted | muted | error`。

**打断语义**：speaking 中收到 `speech_started` → 立即 (a) `response.cancel`（容忍 "no active response" 良性竞态），(b) 清空本地播放缓冲（服务端不发送 truncation 事件，必须客户端自清），(c) ≤100ms UI 反馈，(d) 回落 listening。被打断后下一轮用户消息带注记「（你刚才的语音回答被打断了，没说完）」。

## 4. 委托桥与意图分类

### 4.1 omp_agent_consult（P0，只读快路径）

仅注册一个 function：`{ name: "omp_agent_consult", parameters: { task: string, context?: string } }`。收到 `response.function_call_arguments.done` → task 作为 user message 注入 consult 会话（复用 `LIVE_DELEGATION_MESSAGE_TYPE`）；consult >3s 注入「还在处理」上下文让模型先垫话；>60s 返回超时说明；结果 `conversation.item.create(function_call_output)` + `response.create` → 口语化播报。

**P0 工具面收敛**：consult 独立 profile 只放只读工具（read/search/find/lsp/git status 类），写操作口头拒绝并提示切文字模式。

### 4.2 意图分类（P1 steer router）

realtime 前端对每条 finalized 语句分类，以 function call 形式发出（`omp_agent_task` / `omp_agent_control`），不是独立小模型。判定表：

| 意图 | 判定 | 去向 |
|---|---|---|
| `chat` | 闲聊、无需工具 | realtime 直接答 |
| `query` | 只读查询 | consult 快路径 |
| `task` | 需要动手（改代码/跑命令/发消息/建文件） | 主会话执行 |
| `status` | 「到哪了」 | 口播当前活动（最新 `tool_execution_start`） |
| `steer` | 「先看 X」 | `sendUserMessage(text, { deliverAs: "steer" })` 注入运行中会话 |
| `cancel` | 「停」 | `session.abort()` |

statu/steer/cancel 仅在 task 执行中有意义；空闲时按 chat 处理。误触发三层防线：VAD 门限 → 提示词级不确定确认（task/query 边界模糊先口头复述确认，确认轮按 chat 处理不派发）→ 确认门兜底。

**并发约束**：busy 判据是 `session.isStreaming`（任意来源）。打字轮在跑时来 task → 排队提示，不注入（`AgentBusyError`）。consult query 与 voice task 分属两会话，允许并行。`LiveTaskRouter`（`live/task-router.ts`）负责 busy 检查/注入/事件监听/摘要回传/voice task in flight 标志。

## 5. 分级确认门（P1 安全）

**机制**：落在既有 `tool_call` extension hook 上（`ExtensionToolWrapper` 已包裹主会话全部工具），voice 模式激活时注册内部 handler，随 alt+v 进出注册/注销。`tool_call` handler 可 `block` 并附理由，无超时限制——语音确认往返时延天然被容纳。**作用域**：仅 voice task in flight 时介入；打字轮/consult 不触发。

| 级别 | 工具 | 语音行为 |
|---|---|---|
| 绿 | read/search/find/ast_grep/lsp/git_status/web_search/calc/list_models/weather | 直接执行 |
| 黄 | edit/write/ast_edit/notebook/task | 语音确认：「我要修改 src/foo.ts，确认吗」 |
| 红 | bash/python/debug/puppeteer/resolve 及副作用类 | 确认 + 明确措辞，**超时=放弃，永不默认执行** |

- bash 按 `input.command` 静态分类：命中破坏性模式（rm/git push/git reset --hard/kill/mkfs/drop/覆盖重定向等）为红，其余黄。
- **粘滞**：一个 task 内黄级确认过一次后续同级不重复问（语音独有新语义）；红级永不粘滞。
- 确认词白名单「确认/做/好」；听不清再问一次，两次不清放弃。超时 15s 放弃。1-2 字短答复豁免噪声过滤。
- **fail-closed**：`--no-extensions`（无 extensionRunner）时 task 路径拒绝执行，退回只读 consult 并口头说明。
- plan mode 会话：task 路径直接拒绝，口头提示切文字模式。
- 拒绝/超时回传：block 携带 agent 可读理由，agent 调整行为而非盲目重试。

## 6. 上下文统一与去重

- task 在主会话内执行 → 上下文构造上统一，无需摘要注入。
- **一条话语只允许一条记录进主会话**：task/steer 以注入的 user message 为准，recorder 对应转写抑制；query/chat/status/cancel 由 recorder 照常记录。finalized 转写先进待决缓冲，意图 function call 到达后路由；无 function call 或缓冲 >5s 回落为记录。
- 进语音模式时注入当前 session 最近 N 轮摘要到 realtime instructions（500 字节分块）；realtime 前端 6 轮摘要注入只服务 chat/query 连贯性。
- 语音轮在 session JSONL 中打 `source: "voice"` 标记，memory/self-evolution 自动生效。

## 7. 摸底测试结果与协议坑

### 摸底测试结果（2026-08-04 实测）

| 测试项 | 结果 |
|---|---|
| function calling 路由 | 8/8 全对（闲聊/数学不调；查文件/git/天气/发钉钉全调） |
| 语音→转写→工具→口语化播报全链路 | 通过 |
| barge-in | 通过，297ms 触发 `speech_started`；**需客户端自行清播放缓冲** |
| 延迟 | 文本路由 255-1026ms；语音全链路 speech_stopped→首个音频 2501ms（含模拟工具零往返） |
| PCM | 24kHz PCM16 双向实测可用（`input_audio_format`/`output_audio_format` 显式声明） |

### 协议坑（实现必须处理）

1. 音频增量事件名是 `response.audio.delta` / `response.audio_transcript.delta`，不是 OpenAI 文档的 `response.output_audio.*` —— 两类都兼容。
2. server_vad 判停必须在语音流后继续实时发送静音帧，否则 `speech_stopped` 永不触发（服务端音频时钟靠帧推进）。
3. 纯 text 模态下工具结果回注后的 follow-up response 无文本增量；用 text+audio 模态联调 consult。
4. fun-asr 流式转写增量用 `stash`/`text` 字段（非标准 `delta`），final 用标准 `transcript`。
5. 无显式 truncation 事件——打断时客户端必须自清播放缓冲。
6. **会话开始后禁止更新 `turn_detection`**（"Cannot update 'turn_detection' after session has started"）——动态抬 VAD 门限方案已否决；回声幽灵轮靠客户端 VAD/AEC 处理。
7. barge-in 的 `response.cancel` 可能落在已结束的 response 上（良性竞态，容忍）。
8. 服务端正在生成 response 时发 `response.create` 被拒——所有主动 `response.create` 先发 `response.cancel`（无活跃 response 时 cancel 是良性竞态）。已修于 `function-bridge.ts` 与 controller `#injectUserNote`。
9. **播放结束后的回声沉降窗口需 ≥1000ms**：300ms 太短，短回复的回声会被转写为用户轮形成自循环（`#isEcho` 只能拦记录，拦不住服务端已提交的轮）。同批修复：确认门收尾注记改为「不主动说话」；确认等待期 1-2 字短答复豁免噪声过滤。

## 8. 验收场景

**总验收场景**：进语音模式 →「你好」（直答）→「看下 git status」（consult）→ 播报中插话（打断+续答）→ Esc 退出 → JSONL 四轮 transcript 齐全。

## 9. 开放问题 / 风险

1. narwal-plan realtime 并发/时长限制未知（OpenClaw 的 OpenAI 路线 8 并发/30min TTL；narwal 侧待测）。
2. 计费口径：按分钟还是 token，flash/plus 价差影响默认档。
3. 真实人声 vs 合成音 VAD 差异：真人断句更碎，800ms 静音参数待调。
4. realtime 端点偶发抖动（音频帧服务端丢弃）；task 派发失败降级提示「语音通道不稳，先用文字」。
5. 确认词 ASR 可靠性；冗余按键通道留 P2 评估。
6. 误分类代价不对称：query→task 多一轮确认（低成本）；task→query 只读拒绝（用户重说）。分类 prompt 宁可偏 task。

## 10. 四层状态机（现状以代码为准）

目的：把语音栈四层状态机摊开——状态、转移、跨层交互、已测/未测清单。新行为改动前先在这里对表。

### 10.1 分层总览

```
L1 传输层   RealtimeWsTransport    idle/connecting/connected/reconnecting/closed
L2 相位层   LiveSessionController  connecting/listening/thinking/speaking/interrupted/muted/error
L3 执行层   意图路由 → consult 桥 / task 路由器 / 确认门（各自独立状态机）
L4 记录层   LiveTurnBuffer + recorder（话语去重）
```

层间契约：L1 事件驱动 L2 相位；L2 的 `onTranscript/onIntent` 回调驱动 L3 分发与 L4 记录；L3 的产出（结果/确认问题）经 controller 的 `#injectUserNote`（cancel→item→create）或 function output 回到 realtime 会话播报。

### 10.2 L1 传输层（`ai/realtime/transport.ts`）

`idle → connecting → connected ⇄ reconnecting → closed`（closed 为终态，不可复活）

- 非主动断开 → 指数退避重连（`maxAttempts` 次内）→ 重新 `connected`
- **重连契约**：每次 connected 都是服务端全新会话；config 不重放，controller 在 `session.created` 重发 `session.update`
- 重连耗尽 / `close()` → closed → controller 收到 state 回调 → `onTerminal`

### 10.3 L2 相位层（`live/controller.ts`）

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

### 10.4 L3 执行层

#### 意图分发（realtime 模型函数调用）

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

#### consult 桥（每次调用一个 invocation）

```
idle → running ──► done（agent_end → 结果文本）
              ├─► timedOut(120s) → 转后台；迟到结果走 onBackgroundResult
              └─► cancelled（abortCurrent）→ 收尾文本，结果永不播报
会话缓存：cached ──isStreaming──► 换新会话（只读查询无状态，不等僵尸回合）
```

关键语义：**abort 落在下一个 loop 边界**——运行中的工具（如慢 web_search）先跑完，期间会话 busy，新查询走新会话。

#### task 路由器

```
idle ──dispatch──► inFlight ──► done（agent_end → 摘要≤500字）
  守卫（拒绝派发）：disposed / plan mode / 门未武装(fail-closed) / isStreaming(任意来源)
  inFlight 中：steer → sendUserMessage(deliverAs:"steer")
              cancel → session.abort()
              status → 最近工具活动 / 「正在思考」兜底
```

#### handoff（controller，consult/task 共用）

```
工作承诺 vs 3s 窗口：
  3s 内完成 → function output = 结果（模型直接播）
  超时      → function output = 占位语「正在处理，请稍等…」
              工作迟到 → #injectUserNote 延迟轮（task 摘要 / consult 结果 / 取消收尾）
```

#### 确认门（VoiceGate）

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

### 10.5 L4 记录层（LiveTurnBuffer）

```
final 用户转写 → hold ──intent=query──► flush（recorder 记录）
                    ├─intent=task/confirm─► drop（+suppress 标志兜迟到转写）
                    ├─assistant 信号（partial/final）─► flush
                    └─5s 无意图（chat 直答）─► flush
确认等待中的用户转写：不进缓冲（门消费）；steer 注入即记录（drop）。
```

### 10.6 跨层交互矩阵（★=本轮新增测试）

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

### 10.7 已知缺口（诚实清单，2026-08-06 二轮更新）

1. ~~abort 不能打断运行中的工具~~ **大部分已修**：web_search 全链接通 AbortSignal（executeSearch 透传 + anthropic/gemini/exa/jina/zai 五个 provider 补接；abort 不再落链到下一个 provider）；bash 本就完善。残留：exa 的 MCP 路径不传信号（传输层限制，已注释）；python 内核/task 子代理的中断属 agent 层通用问题，不在语音范围。
2. ~~重连后 realtime 上下文丢失~~ **已修**：重连完成（connecting→listening）时若有任务/查询在跑，注入状态摘要（任务文本来自 router/bridge 的 currentTask），模型不再凭空编「还在处理」。残留：重连前挂起的确认必然 15s 超时（新会话没有确认上下文）——可接受。
3. **模型合规性只能靠提示词**：假报「已取消」、编造系统状态——提示词已四度加固（含「control 返回是唯一权威」「没事不许说已取消」），剩余靠验收观察。
4. ~~面板相位与任务态不同步~~ **已修**：listening 相位渲染「▸ 执行中」活动行；任务/查询结束后清理活动行。
5. **consult 的 thinkingLevel:"off" 对 deepseek 系模型不生效**（根因已查实）：`toReasoningEffort("off")` 返回 undefined，与「未设置」不可区分；openai thinkingFormat 分支在 reasoning=undefined 时什么都不发，服务端默认 thinking 开启。qwen/zai 格式不受影响（显式发 enable_thinking:false / thinking.disabled）。候选修复（需对 narwal-plan 端点实测后二选一）：a) openai 格式下显式 off 发 `reasoning_effort: "none"`（codex 传输已有 none 档先例）；b) 按模型族补 enable_thinking。未实测不盲发参数——400 风险大于 thinking 多耗的延迟。
6. **abort 落在下一个 loop 边界**（不变）：运行中的工具先跑完。web_search 修复后该窗口从「整个请求时长」缩到「信号传播时长」；红级 bash 长命令中说「停」，仍要等命令自己结束。