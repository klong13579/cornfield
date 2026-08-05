# omp Jarvis 实时语音 · P0 设计

> 状态：待拍板 · 2026-08-04
> 前置验证：narwal-plan realtime WebSocket 探针已通过（`/tmp/probe-realtime.ts`），
> `qwen-audio-3.0-realtime-flash/plus` 走标准 OpenAI Realtime 协议，`session.created` 正常，
> 自带 server_vad（800ms 静音）与 fun-asr 输入转写。

---

## 0. 复用基础（不从零造）

origin/main 已有一套实验性 live 实现（Codex realtime 路线，未合入本地工作区）：

| 已有件 | 位置 | 复用判断 |
|---|---|---|
| `LiveSessionController` | `coding-agent/src/live/controller.ts` | **直接复用**。已协调 realtime 表面与 AgentSession 回合，含 barge-in 电平逻辑（`MIN_BARGE_IN_LEVEL`、`OUTPUT_ECHO_RATIO`）、transcript 合并、phase 回调 |
| `LiveVisualizer` | `coding-agent/src/live/visualizer.ts` | **直接复用**。phase + 电平 + transcript 的 TUI 组件，本设计的 UX 原型在其上扩展 |
| 音频采集 `AudioCapture` | `pi-natives`（CoreAudio 绑定，PR #6849 已恢复） | **直接复用** |
| delegation 机制 | `protocol.ts` 的 `delegation.created` → 客户端 delegation | **模式复用**，协议换成 OpenAI 标准 function calling |
| 音色设置 | `live/voices.ts` + settings | **复用**，音色目录换成 qwen 的（`longanqian` 等） |
| `CodexLiveTransport` | `live/transport.ts` | **不复用**。WebRTC + attestation + Frameless Bidi 是 Codex 专有，替换为 OpenAI Realtime WebSocket transport |

**前置工程条件**：本地工作区落后 origin/main 约 1.4 万提交，开工前先 sync。

## 1. P0 目标 / 非目标

**目标**
- Mac 上 `omp` TUI 内一键进入语音模式，连续双工对话：说话 → 语音播报回答，可中途打断。
- 语音轮里需要干活时，realtime 模型通过 function call 把任务委托给 omp agent（agent-consult 模式），25+ 工具、session、memory 全保留。
- 语音轮 transcript 实时写入 omp session JSONL，语音/打字共享一份历史。
- 端到端延迟目标：说完话到开口回答 ≤ 1.5s（qwen flash 档）。

**非目标（P1+）**
- 唤醒词常驻、gateway 常驻语音播报（P2）
- 高风险动作语音确认门（P1，P0 先收敛到只读工具面）
- steer 插话分类（status/steer/cancel/followup，P1）
- 手机端 / 独立硬件 / WebRTC 传输（远期）
- 视频理解（describe_view，远期）

## 2. 总体架构

```
┌─────────────────────────── omp 进程 ───────────────────────────┐
│                                                                │
│  麦克风 ──► AudioCapture (pi-natives, CoreAudio)               │
│                │ PCM16 帧                                      │
│                ▼                                               │
│  LiveSessionController（状态机 + 电平 + 打断仲裁）              │
│                │ input_audio_buffer.append                     │
│                ▼                                               │
│  RealtimeWsTransport ──WSS──► narwal-plan                      │
│  (pi-ai/realtime)                qwen-audio-3.0-realtime       │
│                │                                               │
│     ┌──────────┴───────────────┐                               │
│     │ 语音直接回答（闲聊）      │ function_call: omp_agent_consult│
│     ▼                          ▼                               │
│  扬声器 ◄── 音频播放      AgentSession（现有 agent loop）        │
│  (output_audio.delta)      │ 工具/记忆/自我进化全保留            │
│                            │ 结果文本                           │
│                            └────► conversation.item.create     │
│                                   (function_call_output)       │
│                                   + response.create            │
│                                                                │
│  TUI: VoicePanel（phase 动效 + 卡拉OK字幕 + 工具滚动）          │
└────────────────────────────────────────────────────────────────┘
```

职责切分原则：**realtime 模型是嘴巴和耳朵，不是大脑**。闲聊、确认、播报由它本地完成；任何需要查文件、跑命令、操作业务系统的请求，必须走 `omp_agent_consult` 委托，绝不让 realtime 模型自己编排多步任务。

## 3. 模块设计

### 3.1 `pi-ai`：RealtimeWsTransport（新增）

位置：`packages/ai/src/realtime/`，与现有 SSE transport 平级。

```
realtime/
  transport.ts        # WSS 连接管理：握手、重连、心跳、事件分发
  protocol.ts         # OpenAI Realtime 事件类型（client/server 双向）
  audio.ts            # PCM16 base64 帧编解码、采样率常量
  function-bridge.ts  # function call 注册与结果回注
```

- 协议：标准 OpenAI Realtime 事件（`session.update`、`input_audio_buffer.append`、`response.create`、`response.cancel`、`conversation.item.create`），探针已验证 narwal-plan 全支持。
- provider 描述符：`narwal-plan` 增加 `realtime: { url: "wss://coder.narwal.com/v1/realtime", protocols: ["openai-realtime-v1"] }`（走 `descriptors.ts`，models.json 由生成器产出，不手改）。
- 配置即代码：首个接入模型 `qwen-audio-3.0-realtime-flash`（快、便宜），`plus` 备选；`session.update` 里显式设 `turn_detection: server_vad(800ms)`、`input_audio_transcription: fun-asr`、音色。
- **待实测项**：输入/输出 PCM 采样率（OpenAI 惯例 24kHz，Qwen 惯例输入 16kHz/输出 24kHz）——bring-up 第一天用探针脚本验证 `input_audio_format`/`output_audio_format` 的实际行为，写在 transport 常量里。

### 3.2 `LiveSessionController` 改造（复用 + 抽象）

- 把 transport 抽象成接口 `LiveTransport`（connect/sendAudio/sendEvent/close + 事件回调），两个实现：`CodexLiveTransport`（保留）、`RealtimeWsTransport`（新）。controller 按配置选实现，其余逻辑不动。
- `LivePhase` 扩展：`connecting | listening | thinking | speaking | interrupted | muted | error`（现有基础上加 `thinking`/`interrupted`，对应 UX 原型）。
- 状态机迁移：
  - `listening`：server_vad 检测到语音开始（`input_audio_buffer.speech_started`）。
  - `thinking`：`input_audio_buffer.speech_stopped` 或 function call 进行中。
  - `speaking`：首个 `response.output_audio.delta` 到达。
  - `interrupted`：speaking 中收到 `speech_started` → 立即 (a) 发 `response.cancel`，(b) 清空本地播放缓冲，(c) UI 碎裂反馈（<100ms），(d) 回落 `listening`。

### 3.3 委托桥：`omp_agent_consult`（唯一注册的 function）

realtime session 只注册**一个** function：

```json
{
  "name": "omp_agent_consult",
  "description": "Delegate any task requiring files, shell, business systems, or multi-step work to the omp agent. Chitchat and confirmations stay local.",
  "parameters": { "task": "string", "context": "string?" }
}
```

- 收到 `response.function_call_arguments.done` → controller 把 `task` 作为 user message 注入当前 `AgentSession`（复用现有 delegation 通道 `LIVE_DELEGATION_MESSAGE_TYPE`）。
- AgentSession 跑完 → 提取结果文本 → `conversation.item.create(function_call_output)` + `response.create` → 模型把结果口语化播报。
- **thinking 期不断线**：consult 超过 ~3s 时，往 session 注入一条 "还在处理" 的上下文，让模型可以先说"我查一下，稍等"（对应 Hermes 的 tool-aware speech）。
- 工具执行过程（tool call 名称滚动）通过 phase 回调透传给 TUI。

**P0 工具面收敛**：voice session 的 AgentSession 走独立 profile，只放只读工具（read/search/find/lsp/git status 类）+ 明确低风险的业务查询；写操作（write/edit/bash 变更类）在 P0 一律由模型口头拒绝并提示"切到文字模式执行"。P1 再上语音确认门。

### 3.4 音频播放与回声

- 播放：`response.output_audio.delta` 为 base64 PCM16，本地用环形缓冲 + `AudioPlayback`（pi-natives 侧补一个播放绑定；若 P0 来不及，`afplay`/`ffplay` 子进程兜底，延迟可接受）。
- 回声/自触发：server_vad 模式下扬声器外放会被麦克风拾取误触发打断。P0 两招：
  1. speaking 期间抬 server_vad threshold（`session.update` 动态调，0.5→0.75）；
  2. 本地电平仲裁复用 controller 现有的 `OUTPUT_ECHO_RATIO` 逻辑，speaking 中输入电平未显著超过输出包络则不判打断。
  - 全量 AEC（回声消除）~~P1 再评估~~ **已交付**：AVAudioEngine voice processing（commit d6b6b761c，`voice.aec` 开关）。

### 3.5 上下文与会话统一

- 每个 finalized 语音轮（user transcript + assistant transcript）以标准 message 追加进当前 session JSONL，打上 `source: "voice"` 标记——打字轮和语音轮共享历史，memory/self-evolution 自动生效。
- 进入语音模式时，把当前 session 的最近 N 轮摘要注入 realtime session instructions（bounded context，参考 origin/main 的 `session.context.append` 500 字节分块模式）。

### 3.6 打断语义（抄 Hermes 一条）

用户打断后，注入下一轮的用户消息带注记：「（你刚才的语音回答被打断了，没说完）」——让模型知道发生了什么，能自然接上而不是失忆。

### 3.7 Settings

```yaml
voice:
  enabled: false            # 总开关
  model: qwen-audio-3.0-realtime-flash   # flash | plus
  voice: longanqian         # 音色目录走 voices.ts 模式
  consultProfile: readonly  # P0 固定只读
  interrupt: true           # barge-in 开关
  vadSilenceMs: 800
```

## 4. TUI UX 交互原型

### 4.1 布局位置

VoicePanel 作为 TUI 顶部常驻面板（进入语音模式时挂载，退出时卸载），三行区：徽章行 / 字幕区（可滚 2-4 行）/ 状态栏。复用差分渲染，每帧只重绘变化单元格。

### 4.2 状态原型图

**① CONNECTING（进入语音模式，握手建联）**
```
╭────────────────────────────────────────────────╮
│              ◌ jarvis · 连接中…                │  ← braille spinner，琥珀色
│   正在建立语音通道 (narwal-plan realtime)      │
╰────────────────────────────────────────────────╯
```

**② LISTENING（聆听，你在说话）**
```
╭────────────────────────────────────────────────╮
│   ▂▄▆█▇▅▃▅▇█▆▄▂▃▅▇█▇▅▃▂                       │  ← 实时麦克风电平，20fps，亮青色
│   ● 聆听中                                     │
│   帮我把明天上午的日程同步到钉钉▌              │  ← fun-asr 转写逐字流出，灰=partial 白=final
╰────────────────────────────────────────────────╯
```

**③ THINKING（判停，请求在跑 / consult 进行中）**
```
╭────────────────────────────────────────────────╮
│                  ⣾ 思考中                      │  ← spinner，琥珀色
│   ▸ omp_agent_consult: 同步日程到钉钉          │  ← 委托任务一行摘要
│   ▸ tool: bash  curl -s api.dingtalk.com/…     │  ← 工具调用实时滚动（沿用现有折叠样式）
╰────────────────────────────────────────────────╯
```

**④ SPEAKING（语音播报）**
```
╭────────────────────────────────────────────────╮
│   ))) ⌇ ⌇ ⌇ )))                               │  ← 声纹环随 TTS 输出电平律动，亮青色
│   ◉ 播报中 · 0:12                             │
│   明天上午三个会：九点半供应商评审，           │
│   十一点周会，中间空档四十分钟……▌             │  ← 卡拉OK：跟音频时间戳逐句点亮
│            [ 说话可随时打断 ]                  │  ← 常驻提示
╰────────────────────────────────────────────────╯
```

**⑤ INTERRUPTED（打断瞬间）**
```
╭────────────────────────────────────────────────╮
│   ))) ⌇ ⌇  ✕                                  │  ← 声纹碎裂一帧，琥珀闪 300ms
│   ⚡ 已打断 · 聆听中…                          │  ← 100ms 内必须出视觉反馈，随即回落 ②
│   等下，评审改到下午了▌                        │
╰────────────────────────────────────────────────╯
```

**⑥ MUTED / 退出过渡**
```
╭────────────────────────────────────────────────╮
│                   ◉ jarvis                     │  ← 暗青呼吸脉冲，8fps
│   ✓ 已同步 · 明天 3 个日程                     │  ← 结果摘要，3s 淡出
│   按 Ctrl+V 继续语音 / Esc 退出语音模式        │
╰────────────────────────────────────────────────╯
```

**⑦ ERROR**
```
╭────────────────────────────────────────────────╮
│   ✕ 语音通道异常：{原因}                       │  ← 红色
│   按 Ctrl+V 重连 / Esc 退出                    │
╰────────────────────────────────────────────────╯
```

### 4.3 动效规格

| 状态 | 视觉元素 | 帧率 | 颜色（接现有 theme） |
|---|---|---|---|
| connecting | braille spinner | 12fps | 琥珀 |
| listening | 8-12 格电平条 `▁▂▃▄▅▆▇█`，数据=采集帧 RMS 环形缓冲 | 20fps | 亮青 |
| thinking | spinner + 工具滚动 | 12fps | 琥珀 |
| speaking | 声纹环，振幅=输出音频帧 RMS；字幕按句点亮 | 20fps | 亮青 + 白字幕 |
| interrupted | 碎裂帧 → 立即回落 listening | 一次性 | 琥珀闪 |
| muted/idle | 单点呼吸（亮度 30%↔70%） | 8fps | 暗青 |
| error | 静态 | — | 红 |

- 字幕区：partial transcript 灰色、final 白色、播报句跟随音频逐句加亮（karaoke）。
- 空闲零重绘，不烧 CPU；`NO_COLOR`/dumb terminal 降级为纯状态词 + spinner。
- 所有渲染走 `replaceTabs`/`truncateToWidth` 消毒，沿用 render-utils 约定。

### 4.4 按键

| 键 | 行为 |
|---|---|
| `Ctrl+V` | 进入/退出语音模式（语音中=重连） |
| `Esc` | 退出语音模式；speaking 中按 = 打断并静音本轮 |
| `Ctrl+M` | mute 切换 |
| 其余键 | 语音模式下面板外的正常文字输入不受影响（随时可打字插话，与语音同 session） |

## 5. 错误与降级

| 故障 | 行为 |
|---|---|
| WSS 握手失败/鉴权 403 | ERROR 态 + 明确原因（区分网络/鉴权/模型不可用），不重试风暴（指数退避 3 次） |
| 连接中途断开 | 自动重连 1 次，失败落 ERROR；未完成的 consult 任务继续在后台跑，结果以文字形式落在聊天流 |
| 音频设备不可用 | 进入语音模式前预检，失败给出 `brew install` / 权限引导 |
| realtime 模型不调 consult 直接编造 | instructions 里强约束 + P0 只读工具面兜底（编造代价低） |
| consult 超时（>60s） | function_call_output 返回超时说明，模型口头告知"任务较重，已转后台，结果稍后文字给你" |

## 6. 交付拆解与验收

| 阶段 | 内容 | 验收（可测） |
|---|---|---|
| P0a | RealtimeWsTransport + 探针式连通测试 | 脚本级：收发音频帧、拿到 transcript 和音频回包 |
| P0b | controller 状态机 + 音频播放 + barge-in | 对着 Mac 说话→播报；播报中插话，声音 ≤300ms 内停止 |
| P0c | omp_agent_consult 委托桥 | 语音说"看下 TODO.md 里有几条待办"→ 触发真实工具调用 → 语音播报正确答案 |
| P0d | VoicePanel TUI | 六态动效按 4.3 规格呈现；打断反馈 ≤100ms |
| P0e | session 历史合并 + settings | 语音轮 transcript 出现在 session JSONL，重进会话上下文连续 |

**总验收场景**（一条过）：进入语音模式 → "你好"（闲聊直答）→ "帮我看下 git status 有没有没提交的东西"（consult 触发）→ 播报中插话"等等先说有几个文件"（打断+续答）→ Esc 退出 → session JSONL 里四轮 transcript 齐全。

## 7. 摸底测试结果（2026-08-04 已实测，脚本 `/tmp/qwen-realtime-bench.ts` / `bench2.ts`）

| 测试项 | 结果 |
|---|---|
| function calling 路由判断 | **8/8 全对**（闲聊/数学/能力询问不调；查文件/git/天气/发钉钉全调，参数为高质量中文任务描述） |
| 语音→转写→工具→口语播报全链路 | **通过**：fun-asr 转写准确；工具结果口语化转述完美（"待办清单里一共有 3 件事，分别是……"） |
| barge-in | **通过**：播报中插话，297ms 触发 `speech_started`，模型自然切换话题。未见显式 truncation 事件——**客户端必须在 speech_started 时自行清空播放缓冲** |
| 延迟 | 文本路由 255-1026ms；语音全链路 speech_stopped→首个音频 2501ms（含模拟工具零延迟往返；生产 consult 要加 AgentSession 自身耗时，"还在处理"填充机制必要） |
| PCM 采样率 | 24kHz PCM16 双向实测可用（`input_audio_format`/`output_audio_format` 显式声明） |

**协议坑（实测踩出，transport 实现必须处理）：**
1. 音频增量事件名是 `response.audio.delta` / `response.audio_transcript.delta`，不是 OpenAI 文档的 `response.output_audio.*` 命名——两类都要兼容。
2. server_vad 判停**必须在语音流后继续实时发送静音帧**，否则 `speech_stopped` 永不触发（服务端音频时钟靠帧推进）。
3. 纯 text 模态下工具结果回注后的 follow-up response 无文本增量（verbalization 为空）；text+audio 模态正常。不要用 text-only 联调 consult。
4. fun-asr 流式转写增量载荷用 `stash`/`text` 字段（非标准 `delta`），final 用标准 `transcript` 字段。
5. 未见显式 truncation 事件——打断时客户端必须自己清播放缓冲，不能指望服务端通知。
6. **会话开始后禁止更新 `turn_detection`**（服务端报错 "Cannot update 'turn_detection' after session has started processing audio"）——设计 3.4 的「speaking 期间动态抬 VAD 门限」方案在 qwen 上不可行，已回滚。扬声器回声被 fun-asr 提交为幽灵用户轮的问题，留给 P1 的客户端 VAD / AEC（参考 stt/vad.ts 已有能量 VAD + AudioCapture 实时 RMS）。
7. barge-in 的 `response.cancel` 可能落在服务端已结束的 response 上（"Conversation has no active response"）——属良性竞态，controller 容忍，不视为错误。

**遗留待验证：**
1. narwal-plan realtime 连接的并发/时长限制（OpenClaw 的 OpenAI 路线有 8 并发/30min TTL，narwal 侧未知）。
2. 计费口径：按分钟还是按 token，flash/plus 价差——影响默认档选择。
3. 真实麦克风人声与 `say` 合成音的 VAD 差异（合成音语调平；真人断句更碎，800ms 静音参数可能要调）。
