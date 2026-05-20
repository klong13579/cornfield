# Learnings (V3)

Active and pinned rules extracted from sessions. Regenerated after each archived session.

- **fact** (manual_pin, conf 5): 用户询问当前系统的 job 工作机制、与 openclaw 定时任务的机制区别以及文件系统配置的区别，表明用户需要对比分析两个系统的任务调度与文件系统配置差异。
  - id: `lrn_ib1635ttscrv` | injected 31, helped 2
- **fact** (manual_pin, conf 5): 钉钉集成方案分三阶段：Phase 1 纯 prompt 文件指导 dws CLI 调用（无 TS 工具代码），Phase 2 复用已有 RPC mode（JSON-line stdin/stdout 协议，30+ 命令类型），Phase 3 pi-gateway 切到 RpcClient 常驻进程 + dingtalk channel 修复 Token + 出站切 dws chat message send-by-bot
  - id: `lrn_28j9j7ixbod77` | injected 19, helped 1
- **fact** (manual_pin, conf 5): RPC mode 已有完整实现位于 packages/coding-agent/src/modes/rpc/，pi-gateway 现有入口在 packages/coding-agent/src/main.ts line 853，agent-bridge 和 dingtalk channel 在 packages/pi-gateway/src/
  - id: `lrn_23daipq3ubcua` | injected 19, helped 1
- **fact** (manual_pin, conf 5): dws CLI 是外部仓库 github.com/DingTalk-Real-AI/dingtalk-workspace-cli，非本仓库代码，agent 通过 bash 工具调用
  - id: `lrn_jbj4k4xv2rg` | injected 19, helped 1
- **preference** (manual_pin, conf 5): 改代码或执行破坏性命令前必须先向用户确认，同意后再加 --yes
  - id: `lrn_seed_改代码或执行破坏性命令前必须先向用户确认` | injected 19, helped 1
- **preference** (manual_pin, conf 5): 用中文回复；技术说明要简洁，避免废话
  - id: `lrn_seed_用中文回复；技术说明要简洁，避免废话` | injected 19, helped 1
- **preference** (manual_pin, conf 5): 测试用例必须主动覆盖边界条件，不要只测 happy path
  - id: `lrn_seed_测试用例必须主动覆盖边界条件，不要只测_` | injected 19, helped 1
- **procedure** (manual_pin, conf 5): 在 coding-agent 包中禁止 console.log，使用 @oh-my-pi/pi-utils 的 logger
  - id: `lrn_seed_在_coding-agent_包中禁止_` | injected 19, helped 1
- **fact** (manual_pin, conf 5): 用户希望了解项目中 ask 模块是否使用了 LLM 能力及其工作原理
  - id: `lrn_c5bui8umsr94` | injected 12, helped 1
- **fact** (manual_pin, conf 5): 项目的 ask 模块是一个交互式 TUI 提示工具，本身不调用 LLM，而是由 LLM agent 在执行过程中调用以向终端用户提问
  - id: `lrn_3jugdfx3lrwq2` | injected 12, helped 1
- **fact** (manual_pin, conf 5): ask 工具仅在交互模式下注册（session.hasUI 为 true），在无 UI 头模式下调用会抛出 ToolAbortError
  - id: `lrn_dsva7i68case` | injected 12, helped 1
- **fact** (manual_pin, conf 5): ask 工具支持单问题和多问题，用户可以通过键盘选择选项或输入自定义文本，结果以结构化文本返回给 LLM
  - id: `lrn_11p9hpt3wjkcv` | injected 12, helped 1
- **fact** (manual_pin, conf 5): 当前系统有独立的持久化定时任务守护进程（SchedulerDaemon），与会话内后台异步任务（AsyncJobManager）是两套完全独立的机制。
  - id: `lrn_3hqkhqlf1whbv` | injected 12, helped 1
- **preference** (manual_pin, conf 5): 用户希望每天早上 9 点自动查询当天钉钉日程并通过系统日志通知自己，而不是创建固定的日程事件。
  - id: `lrn_z306272okujr` | injected 12, helped 1
- **fact** (manual_pin, conf 5): OMP has 3 daemon levels: Scheduler Daemon (implemented), and two others referenced as V2/V3 concepts.
  - id: `lrn_bl3rhr4kqx5w` | injected 12, helped 1
- **fact** (manual_pin, conf 5): OMP V3 uses a SessionLearner with Hermes-style filtering: max 3 learnings per session, confidence < 4 discarded, content validated for length/source/template.
  - id: `lrn_uuwjtk315gvp` | injected 0, helped 0
- **procedure** (manual_pin, conf 5): Memory promotion uses statistical criteria: times_injected >= 3 and times_helped / times_injected >= 0.5, or manual_pin bypasses promotion check.
  - id: `lrn_3m38o8eh1q8yg` | injected 0, helped 0
- **fact** (manual_pin, conf 5): Hermes 是一个基于 Profile 机制的多 agent 系统，每个 profile 是独立 agent 实例，拥有独立配置、API key、记忆和会话历史。
  - id: `lrn_1lx0dq4vyfpso` | injected 0, helped 0
- **fact** (manual_pin, conf 5): Hermes 的看板（Kanban）功能是持久化 multi-agent 协作板，核心区别：delegate_task 是函数调用（RPC fork→join），Kanban 是工作队列（fire-and-forget），支持跨进程并行 worker。
  - id: `lrn_3psxynezdl9qc` | injected 0, helped 0
- **fact** (manual_pin, conf 5): 看板数据存储在 SQLite 数据库文件中（如 ~/.hermes/kanban.db），每个 task 是持久化记录，支持 comment/unblock/reclaim，任意 profile 或人类都可读写。
  - id: `lrn_4eycbo3qb2hs` | injected 0, helped 0

_Candidate pool: 2 | Archived: 0_