# omp Jarvis 实时语音 · P0 实施计划

> 架构依据：`docs/voice-jarvis-p0-design.md`（含摸底实测数据与协议坑清单）。
> 本计划只回答「怎么落」：动哪些文件、依赖顺序、验收命令。

## 基线（开工前）

- [ ] 工作区 sync 到含 `src/live/` 骨架的最新 main（本地落后约 1.4 万提交）
- [ ] 确认 `packages/coding-agent/src/live/`（controller/visualizer/transport/protocol/voices/prompts）在树内
- [ ] 确认 pi-natives `AudioCapture` 绑定可用（PR #6849 CoreAudio）
- [ ] 开分支 `feat/voice-jarvis`
- [ ] 基线 `bun check:ts` 通过

## Phase P0a — RealtimeWsTransport（pi-ai）

**新建**
- `packages/ai/src/realtime/transport.ts` — WSS 连接：握手/鉴权头/指数退避重连/心跳/事件分发
- `packages/ai/src/realtime/protocol.ts` — 双向事件类型。必须兼容实测坑：音频增量双命名（`response.audio.delta` + `response.output_audio.*`）、fun-asr 转写 `stash/text` 字段
- `packages/ai/src/realtime/audio.ts` — PCM16 base64 编解码、24kHz 常量、静音帧生成
- `packages/ai/src/realtime/function-bridge.ts` — function 注册 / `function_call_arguments.done` 收参 / `function_call_output` 回注 + `response.create`
- `packages/ai/src/realtime/index.ts` — barrel export

**编辑**
- `packages/ai/src/provider-models/descriptors.ts` — narwal-plan 加 realtime 端点声明（`wss://coder.narwal.com/v1/realtime`，openai-realtime-v1 协议）
- `packages/ai/src/index.ts` — 导出

**测试** `packages/ai/test/realtime-transport.test.ts`
- 协议解析：双命名音频事件、stash/text 转写增量、function call 序列
- PCM 编解码 + 静音帧
- 重连退避（起本地 WS 假服务器，真连接，不用 mock.module）

**验收**：`bun test packages/ai/test/realtime-transport.test.ts` 绿 + 用新模块重写 bench phase 3 脚本对 narwal-plan 实测通

**依赖**：无（后续全部依赖它）

## Phase P0b — 会话控制器（coding-agent + pi-natives）

**编辑**（先跑 GitNexus impact）
- `live/transport.ts` — 抽象 `LiveTransport` 接口（connect/sendAudio/sendEvent/close + 事件回调），CodexLiveTransport 收编为实现之一，行为不变
- `live/controller.ts` — 状态机加 `thinking`/`interrupted` 相位；采集常开 + 静音帧续流（server_vad 判停前提）；barge-in：`speech_started` → `response.cancel` + 清播放缓冲 + ≤100ms UI 反馈；speaking 期电平仲裁（复用 `OUTPUT_ECHO_RATIO`）

**新建**
- `live/realtime-ws-transport.ts` — pi-ai realtime transport → LiveTransport 适配器
- pi-natives 音频播放绑定（评估现有绑定缺口；兜底 `afplay` 子进程）

**测试** `packages/coding-agent/test/live-controller.test.ts`
- 状态机迁移（listen→think→speak→interrupted→listen）
- 打断仲裁：清缓冲 + cancel 发送顺序
- 静音帧续流逻辑

**验收**：单测绿 + 真人对着 Mac 说话 → 语音回答；播报中插话声音 ≤300ms 停

**依赖**：P0a。**出口冻结契约**：`LiveTransport` + `LiveSessionCallbacks`（onPhase/onLevels/onTranscript/onTerminal）两个接口冻结，P0c/P0d 据此并行

## Phase P0c — omp_agent_consult 委托桥（与 P0d 并行）

**新建**
- `live/consult-bridge.ts` — 唯一 function 注册；任务注入 AgentSession（复用 `LIVE_DELEGATION_MESSAGE_TYPE`）；结果回注；consult 超 3s 注入「还在处理」上下文；超时 60s 降级话术

**编辑**
- `live/controller.ts` — 接线
- `live/prompts/live-instructions.md` — Jarvis 指令（闲聊直答/干活必调 consult/不念 JSON/被打断注记），Handlebars 动态部分
- 工具面收敛：voice session 只读 profile（read/search/find/lsp/git status 类），写操作口头拒绝并引导切文字

**测试** `packages/coding-agent/test/live-consult.test.ts`
- 真实 consult-bridge + 全接口 stub AgentSession（无手写 mock 子集）
- 3s 填充注入时机、超时降级、结果回注格式

**验收**：单测绿 + E2E：语音「TODO.md 有几条待办」→ 真实工具调用 → 语音报出正确答案

**依赖**：P0b（接口契约）

## Phase P0d — VoicePanel TUI（与 P0c 并行）

**新建**
- `modes/components/voice-panel.ts` — 七态面板（connecting/listening/thinking/speaking/interrupted/muted/error），布局：徽章行+字幕区+状态栏

**编辑**
- `live/visualizer.ts` — 电平平滑/缓存逻辑被 voice-panel 复用，不重复造
- `modes/interactive-mode.ts` — 面板挂载/卸载
- 按键：Ctrl+V 进出/重连、Esc 退出/静音本轮、Ctrl+M mute

**规格**（设计文档 4.3）：电平/声纹 20fps、spinner 12fps、呼吸 8fps、空闲零重绘；partial 灰/final 白/播报逐句点亮；`replaceTabs`/`truncateToWidth` 消毒；NO_COLOR 降级

**测试** `packages/coding-agent/test/voice-panel.test.ts`
- 状态→帧内容映射（fake terminal buffer 断言）
- 打断帧 ≤100ms 呈现

**验收**：单测绿 + 目检六态动效

**依赖**：P0b（接口契约）

## Phase P0e — session 合并 + settings（收尾）

**编辑**
- session 持久化：语音轮 transcript（user+assistant）写 JSONL，打 `source: "voice"` 标
- `config/settings.ts` + `settings-schema.ts` — voice 块（enabled/model/voice/interrupt/vadSilenceMs/consultProfile）
- 进语音模式时注入当前 session 最近 N 轮摘要到 realtime instructions（500 字节分块模式）

**测试**
- settings schema 校验
- JSONL round-trip：语音轮写入→重进会话→上下文连续

**验收（总验收场景一条过）**：进语音模式 →「你好」直答 →「看下 git status」consult 触发 → 播报中插话打断续答 → Esc 退出 → JSONL 四轮 transcript 齐全

**依赖**：P0c

## 顺序与并行

```
P0a → P0b →┬→ P0c ─┐
           └→ P0d ─┴→ P0e → 总验收
```
- P0b 出口冻结两个接口契约，P0c/P0d 可并行（可派 subagent）
- 每个 Phase 完成后：`bun test`（只跑新增/改动）+ `biome check` + `detect_changes()` 确认影响面 → 提交

## 硬约束执行清单

- 改 `controller.ts`/`visualizer.ts` 任何符号前先 GitNexus `impact`，HIGH/CRITICAL 必须报告
- `packages/coding-agent` 内禁 `console.log`，用 pi-utils logger
- 提示词全部 `.md` 文件（`live/prompts/`），Handlebars 注入动态内容，禁 TS 字符串拼接
- 禁 `mock.module()`；测试用真实现（真 WS 服务器/真临时目录/真 JSONL）
- models.json 不手改，走 descriptors + generate-models
- 每 Phase commit 前 `detect_changes()`
