# cornfield Jarvis 实时语音 · 设计（P0 + P1 合并稿）

> 状态：**P0 已交付、P1 已实现**（2026-08），实现位置 `packages/coding-agent/src/live/` + `src/modes/controllers/voice-mode-controller.ts` + `src/modes/components/voice-orb.ts`。
> 本文档是 `voice-jarvis-p0-design.md` 与 `voice-jarvis-p1-design.md`(P1 评审修订稿) 的合并稿，原文已删（git 历史可查）。
> 现状状态机/已测未测清单见 `docs/voice-jarvis-state-machine.md`；语音 TUI 视觉重设计（待拍板、分支 feature/voice-ux）见 `docs/voice-ux-orb-redesign.md`。
> 原型资产：`voice_tui/`（render_frames.py 数学被 voice-orb.ts 移植）、`orb-animation/`（呼吸球动画帧）。

## 1. 目标与非目标

**P0 目标**：Mac 上 `cornfield` TUI 内一键进入连续双工语音模式（说话→语音播报，可中途打断）；需要干活时 realtime 模型通过 function call 委托给 cornfield agent（agent-consult 模式），25+ 工具/session/memory 全保留；语音轮 transcript 实时写 session JSONL，语音/打字共享历史；端到端延迟 ≤1.5s。

**P1 目标一句话**：语音成为「嘴打的 TUI」——任务直接进主会话，上下文/工具/thinking/展示天然对齐，安全靠分级确认门而不是阉割能力。

| 维度 | TUI | P0 语音 | P1 语音 |
|---|---|---|---|
| 工具面 | 全量 25+ | 只读白名单 | 全量（过确认门） |
| 会话 | 当前 session | 独立 consult 会话，零历史 | 主会话，完整历史 |
| thinking | 开 | 关 | 开 |
| 写操作 | 正常执行 | 口头拒绝 | 分级语音确认 |

**非目标（P2+）**：唤醒词常驻、gateway 语音播报、全屏动效/graphics protocol、手机端/WebRTC、视频理解。

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

## 7. 摸底测试结果（2026-08-04 实测）

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

## 8. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0a | RealtimeWsTransport + 探针式连通 | 脚本级收发音频帧、拿 transcript 和音频回包 |
| P0b | controller 状态机 + 播放 + barge-in | 说话→播报；播报中插话 ≤300ms 停（实测 297ms） |
| P0c | omp_agent_consult 委托桥 | 语音问 TODO → 真实工具调用 → 语音播报 |
| P0d | VoicePanel TUI | 状态动效按规格；打断反馈 ≤100ms |
| P0e | session 合并 + settings | 语音轮 transcript 进 JSONL，重进会话上下文连续 |
| P1a | 意图分类 + 主会话路由 + 确认门 | 语音改 TODO → 黄级确认 → 执行 → 口播摘要；取消/超时/fail-closed 全覆盖 |
| P1b | steer/cancel/status | 「停」能 abort，「到哪了」口播进度 |

**总验收场景**：进语音模式 →「你好」（直答）→「看下 git status」（consult）→ 播报中插话（打断+续答）→ Esc 退出 → JSONL 四轮 transcript 齐全。

## 9. 开放问题 / 风险

1. narwal-plan realtime 并发/时长限制未知（OpenClaw 的 OpenAI 路线 8 并发/30min TTL；narwal 侧待测）。
2. 计费口径：按分钟还是 token，flash/plus 价差影响默认档。
3. 真实人声 vs 合成音 VAD 差异：真人断句更碎，800ms 静音参数待调。
4. realtime 端点偶发抖动（音频帧服务端丢弃）；task 派发失败降级提示「语音通道不稳，先用文字」。
5. 确认词 ASR 可靠性；冗余按键通道留 P2 评估。
6. 误分类代价不对称：query→task 多一轮确认（低成本）；task→query 只读拒绝（用户重说）。分类 prompt 宁可偏 task。

## 10. 实施记录（2026-08）

- P0 各阶段按 `docs/plans/2026-08-voice-jarvis-p0-implementation.md`（已并入本文档后删除）落地：P0a→P0b→(P0c‖P0d)→P0e。
- P1 实测发现（2026-08-05）：`response.create` 竞态（坑 #8）、回声沉降窗 300ms→1000ms（坑 #9），已随 P1 修入 `function-bridge.ts` 与 controller。
- 全量 AEC 已交付：AVAudioEngine voice processing（commit d6b6b761c，`voice.aec` 开关）。