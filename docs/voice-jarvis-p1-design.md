# Voice Jarvis P1 设计：语音 = TUI 同等体验

> 状态：评审修订稿（待拍板）· 2026-08-05
> 修订：P0.5「Voice Stage」全屏动效移出本期范围（视觉面保持 P0 的 VoicePanel 形态）；按代码评审修正 §3–§7 的机制描述（确认门挂点、handoff 协议、并发语义、记录去重、工具分级表）
> 前置：`docs/voice-jarvis-p0-design.md`（P0 已交付：realtime 传输/状态机/consult 委托/硬件 AEC/防自循环）

## 1. 目标

P0 的语音模式是**只读查询助手**：realtime 前端负责听说，任务委托给一个硬只读的 consult 会话。这是刻意的安全收敛（环境噪音会误触发 consult，P0b E2E 已证实），但代价是语音与 TUI 体验割裂：

| 维度 | TUI | P0 语音 |
|---|---|---|
| 工具面 | 全量 25+ | 只读白名单（read/search/find/ast_grep/calc/web_search/git_status/weather） |
| 会话 | 当前 session，完整历史 | 独立 consult 会话，零历史 |
| thinking | 开 | 关（`thinkingLevel: "off"`） |
| 展示 | 工具链/diff/思考全过程 | 面板一行活动（`read: TODO.md`） |
| 写操作 | 正常执行 | 口头拒绝，提示切文字模式 |

**P1 目标一句话：语音成为「嘴打的 TUI」——任务直接进主会话，上下文/工具/thinking/展示天然对齐，安全靠分级确认门而不是阉割能力。**

非目标（P2+）：唤醒词常驻、gateway 语音播报、全屏动效/graphics protocol 渲染、手机端/WebRTC、视频理解。

## 2. 总体架构

```
                    ┌─────────────────────────────┐
  麦克风 ──AEC──▶   │  realtime 前端（qwen-realtime）│  ◀── 扬声器
                    │  听说 + 意图分类（steer router）│
                    └──────┬──────────────┬────────┘
                           │              │
              chat/query   │              │  task / steer / cancel / status
                           ▼              ▼
                  ┌─────────────┐   ┌──────────────────────┐
                  │ consult 会话 │   │  主会话（当前 TUI session）│
                  │ （只读快路径） │   │  全工具 + thinking + 展示 │
                  └─────────────┘   └──────────┬───────────┘
                                               │ 写操作
                                               ▼
                                    ┌──────────────────────┐
                                    │ 分级确认门（语音审批）    │
                                    └──────────────────────┘
```

两条执行路径并存：
- **query 快路径**保留现有只读 consult——「天气」「TODO 几条」这类问题一次调用秒回，不需要惊动主会话。
- **task 路径**是 P1 新增：真实任务直接注入主会话，获得与打字完全相同的执行语义。

视觉面不新增建设：VoicePanel 保持 P0 形态（顶部面板、七态动效不变），task 执行期间面板停留 thinking 态滚动工具活动行，工作现场由 TUI 聊天流原样渲染。

## 3. 意图分类（steer router）

realtime 前端对每条 finalized 语句分类。扩展现有 function bridge（`packages/ai/src/realtime/function-bridge.ts` 已支持多工具：`registerTool` 全量进 `session.update`，单 handler 按 `name` 分发），`omp_agent_consult` 之外新增两个 function：

| function | 参数 | 语义 |
|---|---|---|
| `omp_agent_task` | `task: string` | task 意图，派发主会话执行（§4） |
| `omp_agent_control` | `action: "status" \| "steer" \| "cancel"`, `text?: string` | 执行中控制（§6） |

意图判定表（写进分类 prompt）：

| 意图 | 判定 | 去向 |
|---|---|---|
| `chat` | 闲聊、问候、无需工具 | realtime 模型直接答 |
| `query` | 只读查询（天气/TODO/git 状态/文件内容） | 现有 consult 路径 |
| `task` | 需要动手的指令（改代码/跑命令/发消息/建文件） | 主会话执行（§4） |
| `status` | 「到哪了」「还在跑吗」 | 口播当前活动 |
| `steer` | 执行中修正方向「先看 X」「换个思路」 | 注入运行中会话 |
| `cancel` | 「停」「算了」「取消」 | abort 当前轮 |

`status`/`steer`/`cancel` 仅在 task 执行中有意义；空闲时说「停」之类按 chat 处理（回「现在没有在跑的任务」），不派发 control。

**实现要点**：
- 分类由 realtime 模型以 function call 形式发出，不是独立小模型——少一跳、低延迟。
- 分类 prompt 进 realtime session instructions（`live-instructions.md` 扩展），给出每类的判定例子，重点是 task 与 query 的边界：「需要改变任何文件/系统状态 → task」。
- **误触发防线**（三层）：
  1. VAD 门限（已有）——噪音不进转写；
  2. **提示词级不确定确认**：realtime function call 没有置信度信号，「不确定先复述」只能作为 prompt 策略——task/query 边界模糊时要求模型先口头确认（「你是要我改 X，对吧？」），用户肯定后才发 `omp_agent_task`。该确认轮本身按 chat 处理，不得触发派发，防止确认话术被二次误分类；
  3. 确认门（§5）——即使误分类为 task，写操作还要过语音审批。

## 4. 主会话路由（parity 的核心）

**task 直接 `sendUserMessage` 进当前 TUI session**（`VoiceModeController.#ctx.session`），不另开会话。自动获得：

- 完整 system prompt（user.md / AGENTS.md / skills / rules）
- 全量工具链与 thinking
- 完整会话历史（「继续刚才那个」天然成立）
- 持久化、memory、self-evolution 全部生效

**展示零成本**：主会话的事件流本来就被 TUI 渲染——工具调用、diff、thinking 原样上屏。语音侧不重复建设渲染：VoicePanel thinking 态滚动工具活动行（P0 已有能力），任务细节用户看屏幕。

**结果交付（两段式，复用 consult 的 handoff 机制）**：
- 派发 task 的 function call **不得挂起等任务跑完**（task 可达数分钟）：复用 controller 的 `#consultWithHandoff`——3s 内没结果就先回填充文本，模型口播「正在处理，稍等」，function call 即刻了结。handoff 前的 ≤3s 窗口内 status/steer/cancel 无法被响应，可接受。
- `agent_end` 后的一句话摘要以 **deferred conversation turn** 送达（`deliverBackgroundResult` 路径），不是 function_call_output。
- 摘要素材 = 最后一条 assistant message，进 realtime 会话前截断（~500 字，参考 `live/instructions.ts` 的 clip 模式），防止 realtime 上下文膨胀。

**并发约束**：
- busy 判据是 `session.isStreaming`（**任意来源**，不只是语音 task 自身）：打字轮在跑时来了 task → 与 task 撞 task 相同的排队提示（「上一个还在跑，先等它完成，或者说"停"」）。不带 `deliverAs` 的 `sendUserMessage` 在 streaming 中会抛 `AgentBusyError`，路由前必须先查。
- task 执行中用户打字：沿用 TUI 既有语义（steer/followUp 队列），不做特殊处理；与确认门作用域的交互见 §5。
- consult query 与 voice task 分属两个会话，允许并行。

**LiveTaskRouter**（新文件 `live/task-router.ts`）：持有主会话引用，负责 busy 检查、注入、事件监听（`subscribe` agent_end / tool_execution_start，与 consult 桥同款）、摘要回传、维护「voice task in flight」标志（§5 确认门的作用域）、与 transcript recorder 的去重协作（§7）。`defaultSessionFactory`（`live/consult-bridge.ts`）保留不动，只服务 query。

## 5. 分级确认门（安全）

**机制事实**：TUI 目前没有 per-execution 工具审批路径（`Settings.isToolAllowed` 只是会话级工具可用性）。确认门是**新机制**，落在既有的 `tool_call` extension hook 上：extensionRunner 存在时主会话所有工具都被 `ExtensionToolWrapper` 包裹（`sdk.ts`），`tool_call` handler 可以 `block` 并附理由，`emitToolCall` 无超时限制（注释原话 "user prompts can take as long as needed"）——语音确认的往返时延天然被容纳。实现为 voice 模式激活时注册的内部 handler，随 alt+v 进出注册/注销。

**作用域**：handler 只在「voice task in flight」标志置位时介入（LiveTaskRouter 注入时置位、agent_end 后清除）。打字轮、consult 会话一律不触发语音确认。边界情形：task 执行中用户打字插入的 steer/followUp 落在同一轮内，其工具调用仍在门内——接受，不做区分。

**分级表**（默认拒绝原则：不在绿表的工具一律 ≥ 黄；未知/MCP/extension 工具默认红）：

| 级别 | 工具 | 语音行为 |
|---|---|---|
| 绿 | read / search / find / ast_grep / lsp / git_status / web_search / calc / list_models / weather | 直接执行 |
| 黄 | edit / write / ast_edit / notebook / task（确认子 agent 任务描述） | 语音确认：「我要修改 src/foo.ts，确认吗」→「确认/做」执行，「取消」放弃 |
| 红 | bash / python / debug / puppeteer / resolve 及其余副作用类 | 确认 + 要求明确措辞（「确认删除」），**超时 = 放弃，永不默认执行** |

- bash 按 `input.command` 静态分类（tool_call 事件携带 input，无需额外解析设施）：命中破坏性模式（rm、git push、git reset --hard、kill、mkfs、drop、覆盖重定向等，模式表在代码维护）为红，其余为黄。
- plan mode 会话：task 路径直接拒绝（plan 审批是 TUI 交互，语音无法参与），口头提示切文字模式。

**规则**：
- 粘滞：一个 task 内黄级确认过一次，后续同级操作不重复问。**这是语音独有的新语义**（TUI 无对应物，不是「对齐既有授权」）。红级永不粘滞，每次都问。
- 拒绝/超时的回传：block 携带 agent 可读的理由（如「用户在语音确认环节取消了该操作」），agent 据此调整后续行为而不是盲目重试。
- ASR 噪声防护：确认词必须清晰命中（「确认」「做」「好」白名单）；听不清 → 再问一次；两次不清 → 放弃该操作并口播。
- 确认超时 15s → 放弃。
- **fail-closed**：extensionRunner 不存在（如 `--no-extensions`）时 tool_call 拦截不可用，task 路径拒绝执行，退回只读 consult 并口头说明。确认门是 task 路径的硬前提，不是可选项。

## 6. 执行中插话（steer / cancel / status）

task 跑着的时候用户说话，分类为控制指令：

| 指令 | 例子 | 动作 |
|---|---|---|
| status | 「到哪了」 | 口播当前活动 |
| steer | 「方向不对，先看 X」 | 作为 user message 注入运行中会话，agent 中途看到 |
| cancel | 「停」 | abort 当前轮，口播确认 |

这是 TUI「执行中打字 / Esc」的语音等价物：
- steer 注入用 `sendUserMessage(text, { deliverAs: "steer" })`——即 TUI 执行中打字的既有机制，agent loop 语义已被 TUI 日常验证，**不需要 spike**。
- status 素材取自 `subscribe` 的最新 `tool_execution_start`；尚无工具事件（LLM 思考期）→ 口播「刚开始，正在思考」兜底。
- cancel → `session.abort()`。

## 7. 上下文统一

- task 在主会话内执行 → 上下文**构造上**统一，无需摘要注入。
- **去重规则：一条话语只允许一条记录进主会话。** task/steer 意图以注入的 user message 为准，recorder 对应转写抑制；query/chat/status/cancel 意图由 recorder 照常记录（它们的执行不在主会话内）。实现：finalized 用户转写先进待决缓冲，意图 function call 到达后路由；若 realtime 模型直接口头回答（无 function call）或缓冲超过 ~5s，回落为记录。assistant 侧不变（口播摘要与主会话工作记录是两条不同性质的记录，P0 即如此）。
- realtime 前端的 6 轮摘要注入（`live/instructions.ts`）保留，只服务 chat/query 的连贯性。

## 8. 分期

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| P1a | 意图分类 + 主会话路由 + 确认门（§3–5） | — | 见下 |
| P1b | steer / cancel / status（§6） | P1a | 任务执行中「停」能 abort，「到哪了」能口播进度 |
| P2 | 唤醒词、gateway 语音、全屏动效 | — | — |

**P1a 验收（全覆盖，不只 happy path）**：
1. 语音「把 TODO.md 第一条标完成」→ 黄级口头确认 → 执行 → 口播摘要；TUI 聊天流展示全过程。
2. 确认环节说「取消」→ 工具被 block，agent 收到理由并口头回应，不执行。
3. 确认环节沉默 15s → 自动放弃，口播告知。
4. 红级操作（bash 破坏性命令）要求明确措辞，粘滞不生效。
5. 打字轮不受确认门影响（语音静默）；打字轮在跑时来 task → 排队提示。
6. `--no-extensions` 场景 task 路径拒绝执行（fail-closed）。
7. session JSONL 中 task 话语无重复记录。

## 9. 风险与开放问题

1. **realtime 端点稳定性**：narwal-plan realtime 服务偶发抖动（音频帧服务端丢弃）。分类 function call 依赖该链路，抖动期间 task 派发会失败——需要降级提示（「语音通道不稳，先用文字」）。
2. **确认门延迟**：黄色操作多一轮语音往返（~2-3s）。可接受，但粘滞规则必须生效，否则多文件编辑体验崩坏。
3. **ASR 确认词可靠性**：fun-asr 对短确认词（「做」「好」）的识别率需要实测。冗余按键通道（TUI 按键确认）需要确认挂起期间的显式按键拦截（当前编辑器持有焦点，空格只会打进编辑器），P1 不做，留 P2 评估。
4. **误分类代价不对称**：query 误判为 task → 多一轮确认（低成本）；task 误判为 query → 只读会话拒绝执行（用户重说）。分类 prompt 宁可偏 task。
