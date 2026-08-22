---
name: 优化 omp 项目内存使用
status: active
objective: 降低 omp 内存占用与增长：单会话（实测基线 640MB）与 gateway 子进程的峰值/增长，目标让内存有 owner、有预算、可观测。
doneWhen: |-
  - 待补充（用户未给出明确验收契约，需要时再补）
lastActivity: 2026-08-21 19:59
sessionRefs:
  - 
nextAction: 用户从 C1–C5 中选定一个候选进入 grilling（当前悬而未决）
artifacts:
  - /var/folders/59/v4zxlyg514ddl1j4kf9kv9th0000gn/T/architecture-review-20260821-195542.html
decisions:
  - 2026-08-21 — 架构审查认定：gateway 进程模型健康（ADR-0001 估算 30–60MB/账号，实测 35–45MB 吻合），不重开；根因 = Session 历史是无人拥有的裸数组，唯一重置点是 token 驱动的压缩。Top = C1（MessageStore）+ C2（图片引用化）。
openQuestions:
  - 用户未选定要挖的候选（C1 MessageStore / C2 图片引用化 / C3 TUI 派生视图 / C4 gateway 继承 / C5 流式 spill）
  - doneWhen 验收契约待补充
---

## 设计方案

架构审查产出 5 个候选（详见 artifacts 中 HTML 报告）：

- **C1（Strong）** 把 `agent.state.messages` 加深成 MessageStore module：对外 `append / recent(k) / compact() / byteBudget`，内部持有 RAM 预算、磁盘 spill、图片引用化策略；压缩触发从「仅 token」改为「RAM 或 token 任一越线」。
- **C2（Strong）** 图片 ≤20MB base64（MAX_IMAGE_INPUT_BYTES）常驻历史数组，token 计量看不见 → 历史只存 path+尺寸，provider 调用时经 loadImageInput seam 物化。
- **C3（Worth exploring）** 工具输出双份驻留（state.messages + chatContainer 组件树），UI 改为从 store 派生的纯视图。
- **C4（Worth exploring）** gateway 6 个 RPC 子进程各持有同一无界 Session 结构，C1 落地即自动继承；wire 协议不修改。
- **C5（Speculative）** 流式回复三重缓冲（provider / streamMessage / TUI），超长文本落盘 spill。

## 参考文档

- docs/compaction.md、docs/session.md、docs/memory.md
- docs/plans/2026-07-23-compaction-improvement.md
- docs/provider-streaming-internals.md
- docs/adr/0001-gateway-bridge-process-model.md（实测吻合，不重开）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

基线（2026-08-21，本机 ps）：

| 进程 | RSS |
|---|---|
| omp TUI 会话（活跃 209 CPU-min） | 640 MB |
| omp TUI 会话（活跃 ~5 min） | 72 MB |
| omp-gateway daemon | 36 MB |
| gateway RPC 子进程 ×6 | 35–45 MB/个 |

## 进度记录

- 2026-08-21 19:59 — topic 创建；架构审查报告产出 5 候选，Top = C1+C2（证据：architecture-review-20260821-195542.html；实测 ps 基线 640MB/72MB/36MB/35-45MB）
- 2026-08-21 19:59 — 排查并排除：dingtalk 去重 Map（TTL+size≥100 有界）、SessionManager 队列（depth≤100）、provider 会话状态（dispose 清理）、滚动 logger（磁盘流式）、媒体临时文件（cleanupTmpFiles）、TUI diff 缓冲（仅上一帧）、JSONL 持久化（流式 writer 追加）

## 批注

- gateway 侧无动作：ADR-0001 成本模型被实测证实（35–45MB ≈ 30–60MB），子进程 switch_session 会清态不跨会话累积。
- 640MB 的发现来自 ps，不来自产品自身 —— 无任何内存计量/遥测，这是账单的一部分。