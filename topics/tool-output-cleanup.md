---
name: 工具输出清理：工具旁路补齐 + 轮次窗口化（消费后清理）
status: active
objective: 大工具输出旁路到 artifact:// 降窗口占用；历史轮次 toolResult 窗口化，减少 context rot
doneWhen: |-
  - read/search/grep/find 超阈值输出均带 artifact:// 引用且可完整拉回——✅ B 阶段完成（persistToolOutputArtifact + formatFullOutputReference footer）
  - 全部旁路路径 footer 统一——✅ read/search/find/python/ssh 统一走 formatFullOutputReference；bash/gh 保留既有等价标记
  - 轮次窗口化默认关闭上线，开关切换行为可单测断言——✅ A 阶段完成（applyWindowing + context.windowing.* 默认关 + 6 测试）
  - A/B canary（窗口化开/关同任务对比）通过——✅ 离线 canary：30 轮长会话 payload 降 >50%、配对完整、最近轮保全；真实流量开默认待用户决策
lastActivity: 2026-08-25 15:07
sessionRefs: []
artifacts: []
decisions:
  - 2026-08-25 — 调研 Codex 源码后定组合方案：抄 Codex 中间截断 + `Warning: truncated output` 可见标记，叠加自家旁路（无损落盘 + artifact:// 引用）；不重跑命令
  - 2026-08-25 — minimizer（crates/pi-natives）不动；矩阵是"bash 已有旁路且最完整，其他工具补齐"
  - 2026-08-25 — 执行顺序 B（低风险）→ A1+A2 默认关 → A3 A/B 通过后开默认
openQuestions:
  - 纯 pi-agent-core SDK 用户是否也要窗口化（当前只做 coding-agent 层，覆盖 TUI+gateway+rpc）
---

## 设计方案

### 基线事实（源码实查）

- bash 旁路已完整：native minimizer 重写输出 → `sink.replace(minimized.text)` → 无损原样存 `ArtifactManager` → 输出尾部拼 `[raw output: artifact://<id>]`（`packages/coding-agent/src/exec/bash-executor.ts:189-199`）。默认开启（`shellMinimizer.enabled=true`，`maxCaptureBytes` 默认 4MiB）。
- Artifact 机制：`session/artifacts.ts` `ArtifactManager`，存 session 文件同名目录（`{id}.{toolType}.log`），`artifact://<id>` 由 `internal-urls/artifact-protocol.ts` 解析，read 可读、bash 可展开路径，删 session 连带删。
- 已接旁路工具：bash、python、ssh、fetch（read URL）、gh、render-mermaid、ipy、async。
- **未接旁路**：read（读文件）、search、grep、find、ast-grep、sqlite-reader —— 恰恰是窗口消耗大户。
- convertToLlm 链：pi-agent-core `defaultConvertToLlm` → coding-agent `session/messages.ts convertToLlm`（处理 bashExecution 等）→ sdk.ts 包 blockImages + 混淆。TUI 与 gateway（`omp --mode rpc`）都走 coding-agent 层。

### 行业参照（2026-08 调研）

- Codex（同级目录源码 `~/Desktop/Narwal/codex`）：截断派 —— 工具输出默认 10k token 上限 + 1MiB 硬 cap，**中间截断**（保留头尾）+ 显式标记 `Warning: truncated output (original token count: N)`，无旁路（截断即丢，恢复靠模型重跑）。
- context-kernel：投影派 —— 任务诱导投影，端到端 -79% token，A/B + canary 验证答案保全。
- 结论：oh-my-pi 走"截断进上下文 + 无损旁路可恢复"，优于两者；抄 Codex 的中间截断与显式标记细节。

### Phase A：toolResult 轮次窗口化（消费后清理）

- 落点：`packages/coding-agent/src/session/messages.ts` `convertToLlm` 入口（覆盖 TUI+gateway+rpc，不碰纯内核 API）。
- 算法：最近 N 轮全量；更早轮次（user + assistant toolCall + toolResult 组）替换为一条轮次摘要（保留用户请求要点 + 工具名列表 + 每结果一行要点）。预算复用 `compaction.ts` `estimateTokens`。
- 硬约束：tool_use/tool_result 配对完整（整轮保留或整轮替换，绝不摘 toolResult 留裸 toolCall）；bashExecution 按 user 类；system prompt 与最近轮不动。
- 配置：`context.windowing.enabled`（默认 false）、`keepRecentTurns`（默认 10）、`earlyStrategy`（summarize | drop-with-pairing）。
- 闸门：A/B canary（fake-RPC 模式，同任务窗口化开/关对比完成率/失败率/回答 token 数），不通过不开默认。

### Phase B：工具旁路补齐

- B1 read 大文件：超阈值全量落盘，toolResult 放头部 + `... 完整内容: artifact://<id>`。
- B2 search/grep/find（+ast-grep 若常见大结果）：同模式，上下文留计数 + 头部 + 引用。
- B3 footer 统一：各工具旁路时都带等价 `[raw output: artifact://<id>]` 可见标记，收敛到 `tools/render-utils.ts` 统一格式化函数。

## 参考文档

- Anthropic《Effective context engineering for AI agents》 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic《The new rules of context engineering for Claude 5》(2026-07-24) — https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
- context-kernel（任务诱导投影 + 答案保全验证） — https://github.com/pinperepette/context-kernel
- Codex 源码（截断派参照） — ~/Desktop/Narwal/codex（`codex-rs/utils/output-truncation`、`core/src/compact.rs`、`rollout/src/model_context.rs`）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-25 — A 阶段完成（commit 8562d11）：applyWindowing（messages.ts 纯函数，整轮归档为一行摘要、developer/compactionSummary/branchSummary 透传、配对保证）+ context.windowing.{enabled=false,keepRecentTurns=10,earlyStrategy} schema + sdk convertToLlm 路径接入（compaction 不受影响）；6 测试全过含离线 A/B canary（30 轮：payload -50%+、无裸 toolCall、最近轮保全）；默认关闭上线，真实流量开默认待用户决策
- 2026-08-25 — B 阶段全部完成：persistToolOutputArtifact helper（output-meta.ts，32KB 阈值）+ TruncationResult.artifactId 字段；read/search/find 截断时写 artifact + footer；python（withSidecar 3 处）/ssh 补 footer；发现并利用既有渲染层（formatFullOutputReference 已在 read/search/find import）。验证：artifact-sidecar 4 测试 pass + tsgo 通过 + todo-write 9 pass + voice 69 pass
- 2026-08-25 — topic 创建；已完成 Codex 源码调研与方案定型，任务清单已出（Phase A 3 项 + Phase B 3 项）

## 批注

- 改共享路径的风险集中在 A（convertToLlm 影响所有走 coding-agent 的消费方）；B 全部为低风险单工具改动。
- 每步改前跑 GitNexus impact，收尾 detect_changes。