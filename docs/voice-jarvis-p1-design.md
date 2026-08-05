# Voice Jarvis P1 设计：语音 = TUI 同等体验

> 状态：设计稿（待评审）
> 前置：`docs/voice-jarvis-p0-design.md`（P0 已交付：realtime 传输/状态机/consult 委托/硬件 AEC/防自循环）
> 动效预览：`scripts/orb-demo.ts`（`bun scripts/orb-demo.ts` 全屏播放，`--frames` 出静态帧）

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

非目标（P2+）：唤醒词常驻、gateway 语音播报、kitty graphics protocol 真彩渲染、手机端/WebRTC、视频理解。

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

## 3. 支柱一：意图分类（steer router）

realtime 前端对每条 finalized 语句分类，扩展现有 function bridge（`omp_agent_consult` 之外新增 function）：

| 意图 | 判定 | 去向 |
|---|---|---|
| `chat` | 闲聊、问候、无需工具 | realtime 模型直接答 |
| `query` | 只读查询（天气/TODO/git 状态/文件内容） | 现有 consult 路径 |
| `task` | 需要动手的指令（改代码/跑命令/发消息/建文件） | 主会话执行（支柱二） |
| `status` | 「到哪了」「还在跑吗」 | 口播当前活动 |
| `steer` | 执行中修正方向「先看 X」「换个思路」 | 注入运行中会话 |
| `cancel` | 「停」「算了」「取消」 | abort 当前轮 |

**实现要点**：
- 分类由 realtime 模型以 function call 形式发出（复用 `packages/ai/src/realtime/function-bridge.ts` 的机制），不是独立小模型——少一跳、低延迟。
- 分类 prompt 进 realtime session instructions（`live-instructions.md` 扩展），给出每类的判定例子，重点是 task 与 query 的边界：「需要改变任何文件/系统状态 → task」。
- **误触发防线**（三层）：
  1. VAD 门限（已有）——噪音不进转写；
  2. 分类置信度——realtime 模型对 task 类不确定时先口头复述：「你是要我改 X，对吧？」，用户确认后才派发；
  3. 确认门（支柱三）——即使误分类为 task，写操作还要过语音审批。

## 4. 支柱二：主会话路由（parity 的核心）

**task 直接 `sendUserMessage` 进当前 TUI session**（`VoiceModeController.#ctx.session`），不另开会话。自动获得：

- 完整 system prompt（user.md / AGENTS.md / skills / rules）
- 全量工具链与 thinking
- 完整会话历史（「继续刚才那个」天然成立）
- 持久化、memory、self-evolution 全部生效

**展示零成本**：主会话的事件流本来就被 TUI 渲染——工具调用、diff、thinking 原样上屏。语音不重复建设渲染，只做一件事：**任务执行期间 Voice Stage 让位**（见 §6 编排），TUI 工作现场升回主屏。

**结果交付**：`agent_end` 后由 realtime 模型口播一句话摘要（「改完了，两处，测试通过」），细节用户看屏幕。摘要生成走 realtime 模型对最后一条 assistant message 的转述，不额外调 LLM。

**与 consult 的边界**：`defaultSessionFactory`（`live/consult-bridge.ts`）保留不动，只服务 query。task 路径新增 `LiveTaskRouter`（新文件 `live/task-router.ts`），持有主会话引用，负责注入、事件监听、摘要回传。

**并发约束**：主会话同一时刻只跑一个任务。task 执行中再来 task → 排队提示（「上一个还在跑，先等它完成，或者说"停"」）。

## 5. 支柱三：分级确认门（安全）

只读白名单曾是无差别安全网；P1 用**按工具风险分级**替代它：

| 级别 | 工具 | 语音行为 |
|---|---|---|
| 绿 | read / search / find / ast_grep / git_status / web_search / calc | 直接执行 |
| 黄 | edit / write / notebook（文件变更） | 语音确认：「我要修改 src/foo.ts，确认吗」→「确认/做」执行，「取消」放弃 |
| 红 | bash（副作用类）/ git push / 外发消息 / 删除类 | 确认 + 要求明确措辞（「确认删除」），**超时 = 放弃，永不默认执行** |

**实现挂点**：挂进现有工具审批路径——task 执行中工具需要 approval 时，问题用**说的**（realtime 前端播报并等待语音答复）而不是 TUI 弹窗。语音答复经 ASR → 确认词匹配 → 回传审批结果。

**规则**：
- 确认按任务粘滞：一个任务内确认过一次，后续同级操作不重复问（对齐 TUI 会话级授权语义）。
- ASR 噪声防护：确认词必须清晰命中（「确认」「做」「好」白名单）；听不清 → 再问一次；两次不清 → 放弃该操作并口播。
- 确认超时 15s → 放弃。
- 红色操作的确认词不可被粘滞覆盖，每次都要。

## 6. Voice Stage：视觉与编排（P0.5，可先行）

**核心概念**：语音模式接管全屏，中央一颗「呼吸球」是情绪中心。球 = 状态与情绪，TUI = 工作现场，两者按当前发生的事**交替主导屏幕**。

### 6.1 渲染载体

- 球体：半块字符（`▀▄█`）真彩渲染——每字符格 2 像素且逐格上色，像素网格近似正方形，径向渐变 + 光晕。
- 涟漪/波形：braille（每格 2×4 点）细线。
- 纯 ANSI，现有 diff renderer 直接承载，任何 truecolor 终端可跑。P2 可在 ghostty/kitty 升级 graphics protocol 真抗锯齿。
- 帧预算：20fps tick，只失效球区域（~800 格/帧），成本可忽略。

### 6.2 状态编舞

| 状态 | 球的行为 | 颜色 |
|---|---|---|
| connecting | 从中心一点绽放（easeOutCubic），边缘闪烁不定 | 蓝 |
| listening | 缓慢呼吸（半径 ±2%），麦克风涟漪随用户声音从球心外扩 | 青 |
| thinking | 微收缩（专注手势），粒子轨道绕球，速度随工具调用加快；下方滚动活动行 | 琥珀 |
| speaking | 随播报音频包络搏动（快攻击 50ms / 慢释放 300ms），外圈声波环 | 紫 |
| barge-in | 声波环碎裂成向内涟漪，300ms 切回 listening | 白闪→青 |
| error | 边缘撕裂、去饱和 | 红 |
| idle 30s | 缩小沉到右下角成「小太阳」，TUI 回主屏 | 暗金 |
| **task 执行中** | **球缩小沉到右上角，TUI 工作现场升回主屏**，球在角落随播报搏动 | 琥珀 |

### 6.3 动效原则

1. 一切过渡带缓动，状态切换是「变形」不是「换图」。
2. 电平映射走包络（attack/decay）——球跟着声音跳舞，不是抖动。
3. 静默时保留微噪声扰动——它是活的，不是贴图。

### 6.4 实现映射

- `VoicePanel`（`modes/components/voice-panel.ts`）→ `VoiceStage`：新组件 `OrbRenderer` + 50ms tick。
- 输入源已存在：`onLevels` / `onPhase` 回调直接喂给球；新增包络器。
- 参考实现：`scripts/orb-demo.ts`（独立可跑的状态机 + 渲染器原型）。

## 7. 执行中插话（steer）

task 跑着的时候用户说话，分类为控制指令：

| 指令 | 例子 | 动作 |
|---|---|---|
| status | 「到哪了」 | 口播当前活动（从 agent 事件流取最新 tool_execution_start） |
| steer | 「方向不对，先看 X」 | 作为 user message 注入运行中会话，agent 中途看到 |
| cancel | 「停」 | abort 当前轮，口播确认 |

这是 TUI「执行中打字 / Esc」的语音等价物。steer 注入复用主会话的 `sendUserMessage`（agent loop 本身支持轮间插入）。

## 8. 上下文统一

- task 在主会话内执行 → 上下文**构造上**统一，无需摘要注入。
- 语音轮继续按 P0 §3.5 落 session JSONL（`source: "voice"`），打字轮与语音轮共享历史。
- realtime 前端的 6 轮摘要注入（`live/instructions.ts`）保留，只服务 chat/query 的连贯性。

## 9. 分期

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| P0.5 | Voice Stage 视觉（§6） | 独立，可先做 | alt+v 进入全屏球，状态切换动效符合编舞表 |
| P1a | 意图分类 + 主会话路由 + 确认门（§3-5） | — | 语音说「把 TODO.md 第一条标完成」→ 口头确认 → 执行 → 口播摘要；TUI 展示全过程 |
| P1b | steer / cancel / status（§7） | P1a | 任务执行中「停」能 abort，「到哪了」能口播进度 |
| P2 | graphics protocol 渲染、唤醒词、gateway 语音 | — | — |

## 10. 风险与开放问题

1. **realtime 端点稳定性**：narwal-plan realtime 服务偶发抖动（音频帧服务端丢弃）。分类 function call 依赖该链路，抖动期间 task 派发会失败——需要降级提示（「语音通道不稳，先用文字」）。
2. **确认门延迟**：黄色操作多一轮语音往返（~2-3s）。可接受，但粘滞规则必须生效，否则多文件编辑体验崩坏。
3. **ASR 确认词可靠性**：fun-asr 对短确认词（「做」「好」）的识别率需要实测；备选：确认也接受 TUI 按键（空格=确认）作为冗余通道。
4. **steer 注入时机**：agent loop 轮间插入的语义需要验证——工具执行中途注入的 message 何时被看到。P1b 开工前先做 spike。
5. **误分类代价不对称**：query 误判为 task → 多一轮确认（低成本）；task 误判为 query → 只读会话拒绝执行（用户重说）。分类 prompt 宁可偏 task。
