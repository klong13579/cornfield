# 多 Agent 编排设计讨论

> 日期：2026-06-23
> 状态：设计完成，待实现规划
> 模式：/grilling 审问式设计讨论

## 背景

目标：在 oh-my-pi gateway 系统中实现企业级多 agent 编排——多个 agent 自主循环运行以完成特定任务目标。

核心问题：
1. 多个钉钉 bot（各自背后是独立的 omp RPC 进程）能否互相调用？
2. 未来的"编排"主进程能否负责任务分发和编排？

## 架构决策

### 六个决策点

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 进程模型 | 混合：Orchestrator 用 warm bridge（常驻、保 cache/上下文）；Worker 用一次性 omp 进程（真并行、crash 隔离） | warm bridge 保 orchestrator 的长期上下文和 cache；一次性 worker 规避 SessionManager 串行约束，和 Hermes 一致 |
| 2 | 任务执行 | goal-mode loop | worker 自主 loop 直到达标或 budget 耗尽 |
| 3 | Orchestrator | (b) 专门的 LLM orchestrator agent | 通过 `kanban_create` + `kanban_link` 自主分解任务 |
| 4 | Worker 发现 | (b)+(c) 两者都要 | agentDir/`agent.yml`（自描述能力）+ gateway 配置 lane 声明（集中管控 + 派发路由） |
| 5 | 任务派发 | Push | dispatcher claim → spawn 一次性进程，任务作为启动参数传入 |
| 6 | Judge | (i)+(ii) | worker 自判 + budget 上限防自欺 + orchestrator override 做最终判断 |

### 架构图

```
用户在钉钉群 @orchestrator-bot "做一个完整的用户认证系统"
    │
    ▼
┌─────────────────────────────────────────────┐
│  GATEWAY 进程（常驻）                          │
│                                               │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ Orchestrator│    │  Kanban Dispatcher    │ │
│  │ Warm Bridge │    │  (gateway 内嵌, 60s   │ │
│  │ (常驻 RPC)   │    │   tick)               │ │
│  │             │    │                       │ │
│  │ LLM 自主     │    │  扫 ready 任务         │ │
│  │ 分解任务     │───→│  → claim (原子 CAS)    │ │
│  │ → kanban_   │    │  → spawn 一次性 omp    │ │
│  │   create    │    │  → 监控 PID (crash     │ │
│  │   + link    │    │   detection)          │ │
│  └─────────────┘    └──────────┬───────────┘ │
│         ▲                      │             │
│         │judge override        │ push        │
│         │                      ▼             │
│  ┌──────┴──────────────────────────────────┐ │
│  │         kanban.db (SQLite WAL)           │ │
│  │  tasks / task_runs / comments / links    │ │
│  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌─────────┐
     │ Worker 1│ │ Worker 2│ │ Worker 3│
     │ (一次性) │ │ (一次性) │ │ (一次性) │
     │ omp 进程 │ │ omp 进程 │ │ omp 进程 │
     │          │ │          │ │          │
     │ goal-mode│ │ goal-mode│ │ goal-mode│
     │ loop     │ │ loop     │ │ loop     │
     │          │ │          │ │          │
     │ 自判达标  │ │ 自判达标  │ │ 自判达标  │
     │ →complete│ │ →complete│ │ →complete│
     │ 或超budget│ │ 或超budget│ │ 或超budget│
     │ →block   │ │ →block   │ │ →block   │
     └─────────┘ └─────────┘ └─────────┘
          │           │           │
          └───────────┴───────────┘
                      │
                      ▼
         所有 child done → Orchestrator 醒来
         (i) worker 已自判 + (ii) orchestrator override
         达标 → parent done
         不达标 → comment + 重新 kanban_create 子任务
```

## 行业最佳实践对照

### 参考来源

| 来源 | 核心结论 | 和本方案的关系 |
|---|---|---|
| **LangChain** — 四种多 agent 架构 | Subagents（supervisor+specialists）、Skills、Handoffs、Router。生产中最可靠的是 Subagents。 | 本方案 = Subagents 模式。选对了。 |
| **Turion 生产教训** — 十几个生产部署总结 | Supervisor+Specialists 是生产中最可靠的模式。完全涌现式协作不工作。硬 budget 是必须的。 | 本方案是 supervisor+specialists。但 goal-mode loop 如果没有硬 budget，就是"unbounded tool chaining"——200 次 LLM 调用、$40 token、agent 在第 40 轮开始犯混。 |
| **Anthropic 多 agent 研究系统** | Lead agent + 并行 subagents。token 使用量解释了 80% 的性能差异。多 agent 比单 agent 好 90.2%，但 token 消耗是 chat 的 15 倍。关键教训：教 orchestrator 如何委派（详细任务描述）。 | orchestrator 需要同样的委派质量。如果 orchestrator 给 worker 的 prompt 太模糊，worker 会重复工作或偏离方向。 |
| **Durable Execution（tianpan.co）** | async queue 对长时间运行的 agent 会崩。worker crash 后从头重跑，浪费已花的 token；side effect 不可安全重试。解法：stateless planner + stateful substrate，每步 checkpoint + idempotency key 从 workflow context 派生。 | 这是本方案最大的缺口。kanban 有 task_run 级别的 crash recovery，但没有 step 级别的 checkpoint。 |
| **Zylos 编排模式** | 三大学派：DAG、Event-driven、Actor。五种主要失败：语义错误、级联上下文污染、循环委派死锁、失控成本、静默状态丢失。 | DAG 依赖图解决了循环委派。但其余四种失败没有显式防御。 |

### 本方案在行业光谱中的位置

```
完全涌现式（不工作）
    │
    ├── CrewAI "agents figure it out" ← Turion 明确说不行
    │
    ├── Peer-to-peer equal agents ← Turion 明确说不行
    │
    ════════════════════════════════════════════ ← 分界线
    │
    ├── 本方案：Supervisor + Specialists + Kanban DAG + Durable DB
    │   （Subagents 模式 + 持久化任务队列 + crash recovery）
    │
    ├── Hermes Kanban（本方案的直接原型）
    │
    ├── Anthropic Research（in-process subagents，无持久化）
    │
    └── Temporal + LangGraph（最重但最可靠的生产级方案）
```

本方案处于"已被验证可靠"的区间内。Supervisor+Specialists + 持久化队列是 Turion 和 Hermes 都验证过的。

## 参考系统对比

### OpenClaw

- 核心层：不做 agent 互调。multi-agent 是路由隔离，不是编排。每个 agent 完全隔离——独立 workspace、agentDir、session store、auth profiles。
- 社区 PR #27382 尝试做 Teams（`TeamCreate`、`SendMessage`、`teammate_spawn`），被维护者关闭。明确表态：多 agent 编排框架不属于核心。
- 结论：agent 隔离，不互调，编排留给外层。

### Hermes Kanban

- 是最接近本方案的原型。durable work queue，不是 RPC。
- 区分两种原语：`delegate_task`（RPC 调用，fork→join）vs Kanban（持久化消息队列 + 状态机）。
- 架构：gateway 内嵌 dispatcher（每 60s tick）+ SQLite WAL 看板 + 一次性 OS 进程 worker。
- Worker 通过 `kanban_*` 工具集与看板交互，不是 agent-to-agent 直接调用。
- 任务生命周期：`triage → todo → ready → running → blocked/done/archived`
- Crash 检测：PID 消失 → reclaim → 回到 ready。
- 熔断器：连续 N 次 spawn 失败 → auto-block。
- Per-profile 并发上限（PR #34244）：`max_in_progress_per_profile`。
- Goal-mode：worker 跑到 judge 认可才停。
- Hermes 有常驻进程——但常驻的是 gateway + dispatcher，不是 worker。worker 是一次性的。

### Anthropic 多 agent 研究系统

- Lead agent + 并行 subagents（in-process，非独立进程）。
- token 使用量解释 80% 性能差异。多 agent 比 single agent 好 90.2%，但 token 是 chat 的 15 倍。
- 关键教训：教 orchestrator 如何委派、scale effort to query complexity、parallel tool calling、subagent 输出直接写文件系统避免"game of telephone"。
- 生产挑战：agents are stateful and errors compound、需要 durable execution + checkpoint、rainbow deployments。

### Claude Code（内置 task 工具 / swarm-extension）

- `runSubprocess`（`task/executor.ts:447`）名字叫 "subprocess"但实际是 in-process——同一个 Bun 进程内创建 AgentSession，共享 event loop、共享内存。
- 内置 subagent 是主 agent 的手——匿名、临时、共享一切。
- 多进程 omp 是独立的人——有名、有记忆、有边界。
- 最终设计：保留内置 subagent 作为 worker 内部的并行加速器。两者不冲突，是不同层级。

## 内置 subagent vs 多进程 omp 的核心区别

| 维度 | 内置 subagent（task 工具 / swarm） | 多进程 omp（gateway AgentBridge） |
|---|---|---|
| 进程模型 | 同一个 Bun 进程，共享 event loop | 独立 OS 进程（`omp --mode rpc`） |
| 隔离边界 | 无。共享内存，一个 subagent 的未捕获异常可以炸掉主 agent | OS 级。一个进程 crash 不影响其他 |
| 身份/记忆 | 无。匿名、临时、做完即销毁 | 有。独立 agentDir、mission.md、session 历史 |
| 凭证/权限 | 继承父 agent | 独立。每个 agentDir 有自己的凭证 |
| 文件系统 | 共享父 agent 的 cwd | 独立 cwd（agentDir） |
| IRC（agent 间通信） | 可用。`AgentRegistry` 进程全局单例 | 不可用。每个 RPC 进程有独立的 `AgentRegistry` |
| 启动成本 | 极低 | 高。但 warm bridge 摊薄了成本 |
| 并发 | 共享 event loop | 真 OS 级并行 |
| 生命周期 | 随父 agent 生灭，不可恢复 | 独立生命周期，session 持久化，可 resume |

### 何时用哪个

- **需要持久身份、独立凭证、crash 隔离** → 多进程 omp
- **需要快速并行、不需要身份、随父生灭** → 内置 subagent

本方案的编排分层：
1. **Orchestrator（gateway warm bridge）**：决定派什么任务给谁。持久上下文。
2. **Worker（多进程 omp，一次性）**：独立 agent，goal-mode loop，持久身份。
3. **Worker 内部的 subagent（内置 task 工具）**：worker 执行过程中的并行加速器。快、便宜、不需要身份。

## Push vs Pull 派发模型分析

### 核心冲突：常驻进程的串行性 vs 并发任务需求

**一次性进程（Hermes 模式）**：dispatcher claim task → spawn 新进程 → 任务作为启动参数传入 → 跑完 → 进程退出。进程不存在"忙"的状态，天然 push，没有冲突。

**常驻进程（warm bridge）**：bridge 启动一次，永远活着。只能同时处理一个 prompt（SessionManager 不变量："One account bridge processes at most one prompt at a time"）。

### 为什么选了方案 2（混合）

方案 2 彻底解决串行冲突——worker 是一次性进程，不存在 warm bridge 的串行约束，dispatcher 随时 spawn，天然 push，天然并行。和 Hermes 模型完全一致。Orchestrator 走 warm bridge 保上下文和 cache。

### 三条出路的比较（已决策选方案 2）

| 出路 | 描述 | 优缺点 |
|---|---|---|
| 1. 接受串行，push + 队列 | per-bridge 队列，bridge 空闲时取下一个 | 最简单，同 worker 任务串行 |
| 2. 混合——常驻 bridge 做 orchestrator，一次性进程做 worker | **已选** | 兼顾 cache 复用和并行能力 |
| 3. 多 bridge 实例 | 同一 agentDir 起 N 个 warm bridge | 真并行 + cache 复用，但 session 文件冲突 |

## Judge 模型

### 选择：(i) Worker 自判 + (ii) Orchestrator override

- **(i) Worker 自判**：worker 跑完一轮后自问"goal 达成了吗"，达成就 `kanban_complete`，没达成继续跑。简单，可能自欺。
- **(ii) Orchestrator 判**：worker 完成后结果回看板，orchestrator agent 评估是否达标，达标标记 done，没达标 comment + 重新派发。更可靠，但 orchestrator 也是 LLM。
- **Budget 上限**：防 worker 无限自欺跑下去。
- **Orchestrator override**：parent task 的 assignee 在所有 child 完成后醒来做最终判断。

和 Hermes 一致：worker 自判 + budget 上限防自欺 + orchestrator override 兜底。

## 已有零件 vs 要造的零件

### 已有（可直接复用）

| 零件 | 位置 | 对应角色 |
|---|---|---|
| `AgentBridge` warm bridge | `pi-gateway/src/agent-bridge.ts` | Orchestrator 的执行载体 |
| `SessionManager` | `pi-gateway/src/session-manager.ts` | Orchestrator 的 prompt 串行化 |
| `SchedulerEngine` | `pi-gateway/src/scheduler/engine.ts` | Dispatcher 的 tick 基础设施 |
| `SchedulerDbStorage` | `pi-gateway/src/scheduler/storage.ts` | SQLite 持久化基础 |
| `runSubprocess` | `coding-agent/src/task/executor.ts` | 一次性 worker spawn 机制 |
| `swarm-extension` DAG | `swarm-extension/src/dag.ts` | 任务依赖图（parent→child promotion） |
| DingTalk account → agentDir 绑定 | `gateway.json` channels 配置 | lane 声明的基础 |

### 要造

| 零件 | 干什么 | 复杂度 |
|---|---|---|
| **kanban.db schema** | tasks / task_runs / comments / links 表，SQLite WAL | 中。参照 Hermes schema |
| **任务状态机** | `triage → todo → ready → running → blocked → done` + 依赖 promotion | 中 |
| **Dispatcher** | gateway 内嵌，tick 扫 ready → 原子 claim → spawn omp 进程 → PID 监控 → crash reclaim | 高。但 `SchedulerEngine` 的 tick 框架可复用 |
| **Worker spawn 机制** | `Bun.spawn(["omp", ...])` + `OMP_KANBAN_TASK` 环境变量注入 + `kanban_*` 工具集翻转 | 中。`runSubprocess` 已有 spawn 能力 |
| **`kanban_*` 工具集** | `kanban_show` / `kanban_list` / `kanban_complete` / `kanban_block` / `kanban_heartbeat` / `kanban_comment` / `kanban_create` / `kanban_link` | 高。需从零起建，无现有工具可复用 |
| **Lane 声明 + agent.yml** | gateway 配置加 lanes 段 + 每个 agentDir 加 `agent.yml` 能力声明 | 低 |
| **Goal-mode** | worker prompt 注入 goal + budget 上限 + 自判逻辑 | 中。prompt 工程 + budget 计数器 |
| **Orchestrator judge** | parent task 的 assignee 在所有 child done 后醒来，评估 + override | 中 |
| **Per-profile 并发上限** | dispatcher 跟踪 per-assignee running count，超过 cap 则 defer | 低。参照 Hermes PR #34244 |
| **Circuit breaker** | 连续 N 次 spawn 失败 → auto-block | 低 |
| **Crash detection** | `kill(pid, 0)` 轮询，PID 消失 → reclaim → 回 ready | 中 |

## 潜在问题

### P1 — 没有 step 级 checkpoint，crash 重跑浪费巨大（严重）

**问题**：worker 是一次性 omp 进程，跑 goal-mode loop 可能几十轮、十几分钟、花 $20+。如果 worker 在第 15 轮 crash，dispatcher 检测到 PID 消失 → reclaim → 任务回 ready → 下个 tick 重新 spawn → 从头开始。前 15 轮的工作和 token 全部浪费。

kanban 有 `task_runs`（任务级别的 crash recovery），但没有 step 级别的 checkpoint。worker 内部的每一轮 LLM 调用、每一次 tool call、每一个中间结论，都没有持久化。

Hermes 有一个缓解措施：`build_worker_context` 会把 prior attempts 的 summary 给 retry worker 看。但如果 prior attempt 没 `kanban_complete` 就 crash 了，没有 summary——新 worker 完全失明。

**行业解法**：durable execution——每个 step checkpoint，crash 后从上一个 checkpoint 恢复。但 worker 是 omp 进程，内部 loop 不受 gateway 控制。

**缓解方案**：
- worker 定期调 `kanban_heartbeat(note="已完成X，正在做Y")` 把中间进度写进 kanban.db。crash 后新 worker 读 heartbeat 知道前一个做到哪了。
- 不是真正的 step 级 checkpoint（无法恢复中间状态），但至少新 worker 不完全失明。
- 代价：依赖 prompt 工程让 agent 养成调 heartbeat 的习惯。

### P2 — Side effect 不可安全重试（严重）

**问题**：worker 在执行过程中可能做了不可逆操作——发了钉钉消息、写了数据库记录、部署了代码、调了外部 API。crash 后 retry，新 worker 不知道这些操作已经执行过，会再做一次。

LLM 是非确定性的——retry 时 worker 可能选择完全不同的路径，也可能选择相同路径（重复执行 side effect）。kanban.db 的 task_runs 记录了"这个任务跑过一次"，但不记录"这次跑里执行了哪些 side effect"。

**行业解法**：
- Saga 模式：每个 side effect 配一个补偿操作。
- Idempotency key 从 workflow context 派生（task_id + step_number），不是从 LLM 参数派生。

**缓解方案**：
- worker 的 side effect 工具（发消息、写数据库等）应该接受 idempotency key（从 `OMP_KANBAN_TASK` + step 派生），在工具层做去重。
- 需要改 omp 的工具层。

### P3 — Orchestrator 是串行瓶颈（中等）

**问题**：orchestrator 是 warm bridge，受 SessionManager 约束——同时只处理一个 prompt。如果 orchestrator 正在判断 task A 的完成结果，此时 task B 和 task C 都完成了、需要 orchestrator 判断——它们只能排队。用户在钉钉群发新消息也要排队。

**缓解方案**：
- 接受串行。orchestrator 的判断通常比 worker 执行快得多。只要判断速度 > 任务完成速度，队列不会堆积。
- 如果堆积了，可以给 orchestrator 起多个 bridge 实例（但 session 一致性成问题）。

### P4 — 级联上下文污染（中等）

**问题**：worker A 完成任务，summary 里有事实错误。worker B 读 A 的 summary 作为 parent handoff，在错误基础上继续工作。worker C 读 B 的输出，错误进一步放大。

Anthropic 的经验：subagent 的输出如果经过 lead agent 中转，信息会丢失（"game of telephone"）。他们的解法是 subagent 直接写文件系统，只传引用回 lead agent。

**缓解方案**：
- 鼓励 worker 在 `metadata` 里放结构化数据（changed_files、test_results、decisions）。
- orchestrator 的 judge prompt 需要明确要求"验证 parent summary 中的关键事实，不要盲信"。
- 依赖 prompt 工程，不是结构保证。

### P5 — Token 成本失控（中等）

**问题**：多 agent 系统的 token 消耗是 chat 的 15 倍（Anthropic 数据）。一个用户请求可能触发 orchestrator 分解 + 5 个 worker goal-mode loop + orchestrator judge = 7+ 个完整 LLM session。

**缺口**：
- orchestrator 没有预算上限——可以无限分解子任务
- 没有 total-task budget——5 个 worker 各自达标但总成本超了
- 没有 loop detection——orchestrator 反复"不达标→重新创建子任务"的循环

**缓解方案**：
- Total task budget：从 orchestrator 分解时就设定，所有 worker + orchestrator 的 token 总和不超过上限。
- Orchestrator retry 上限：judged "不达标" 后最多重新创建 N 次子任务，超过就 block + 人工介入。
- Loop detection：同一个子任务被创建+失败 3 次 → auto-block。

### P6 — Worker 冷启动成本（低-中）

**问题**：每个 worker 是一次性 omp 进程——加载所有模块、初始化工具、建立 API 连接。冷启动可能要几秒到十几秒。

**缓解方案**：
- 任务粒度不要太小。小任务走内置 subagent。
- 看板 worker 应该是"需要 goal-mode loop、可能跑多轮"的中大型任务。

### P7 — 部署时 running agent 的代码版本不一致（低）

**问题**：orchestrator warm bridge 是长驻的——更新了 omp 代码，orchestrator 还在跑旧代码，直到重启。重启会丢 session 上下文。

**缓解方案**：
- 接受。orchestrator 的状态在 kanban.db 里，不依赖 session 内存。重启后可从看板恢复。
- prompt cache 会丢——重启后第一次 LLM 调用是冷请求。

### P8 — 可观测性缺失（低-中）

**问题**：缺少跨进程的分布式追踪——orchestrator → worker → tool call → external API 的完整调用链。

**缓解方案**：
- 给每个 task 分配 trace_id，worker 进程启动时注入 `OMP_TRACE_ID` 环境变量。
- kanban.db 的 task_runs 表加 `trace_id` 列。
- 排查时用 trace_id 关联 kanban 状态和 omp 日志。

### 问题严重度总览

| 严重度 | 问题 | 状态 |
|---|---|---|
| 严重 | P1 — crash 重跑无 step checkpoint | 可用 heartbeat 缓解，不是真正解法 |
| 严重 | P2 — side effect 不可安全重试 | 需要工具层 idempotency key |
| 中等 | P3 — orchestrator 串行瓶颈 | 可接受，判断速度通常 > 任务完成速度 |
| 中等 | P4 — 级联上下文污染 | 靠结构化 metadata + judge prompt 缓解 |
| 中等 | P5 — token 成本失控 | 需要 total budget + retry 上限 + loop detection |
| 低-中 | P6 — worker 冷启动成本 | 任务粒度控制 |
| 低 | P7 — 部署版本不一致 | 接受，kanban.db 可恢复状态 |
| 低-中 | P8 — 可观测性缺失 | trace_id 贯穿 kanban + omp 日志 |

P1 和 P2 是必须在设计阶段就回答的——不是"以后优化"，是"不解决就上不了生产"的结构性问题。

## 关键代码引用

| 组件 | 位置 | 说明 |
|---|---|---|
| `AgentRegistry` | `packages/coding-agent/src/registry/agent-registry.ts` | 进程全局单例，IRC 路由核心，跨进程通信的阻断点 |
| `respondAsBackground` | `packages/coding-agent/src/session/agent-session.ts:6087` | Side-channel turn，不阻塞 recipient 主循环，已解决 in-process IRC 死锁 |
| `SessionManager` 不变量 | `packages/pi-gateway/src/session-manager.ts:4-7` | "One account bridge processes at most one prompt at a time" |
| Cron 路径禁用工具 | `packages/pi-gateway/src/gateway.ts:1159` | 禁用 `["cronjob", "messaging"]`，安全措施 |
| `swarm-extension` | `packages/swarm-extension/` | DAG 编排器，`runSubprocess` + 共享文件系统通信 |
| `runSubprocess` | `packages/coding-agent/src/task/executor.ts:447` | 实际是 in-process 执行（注释写 "Run a single agent in-process"） |
| Hermes Kanban 文档 | `https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban` | 直接原型 |
| Hermes Kanban Tutorial | `https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial` | 四种使用场景 |
| Hermes per-profile cap PR | `https://github.com/NousResearch/hermes-agent/pull/34244` | 并发上限参考 |
| Hermes Kanban PR | `https://github.com/NousResearch/hermes-agent/pull/16100` | 完整实现参考 |
| Anthropic 多 agent 研究 | `https://www.anthropic.com/engineering/multi-agent-research-system` | 行业最佳实践 |
| LangChain 多 agent 架构 | `https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture` | 四种模式对比 |
| Turion 生产教训 | `https://turion.ai/blog/multi-agent-orchestration-infrastructure-production/` | 生产部署经验 |
| Durable Execution | `https://tianpan.co/blog/2026-04-23-durable-agents-async-queue-workflow-checkpoint` | P1/P2 问题的行业分析 |
| Zylos 编排模式 | `https://zylos.ai/research/2026-04-14-agent-workflow-orchestration-patterns` | 三大学派 + 五种失败模式 |

## 下一步

1. 解决 P1 和 P2 的设计方案（heartbeat 机制 + idempotency key 机制）
2. 实现规划：分阶段拆解，优先 kanban.db schema + dispatcher + 基础 kanban_* 工具集
3. Orchestrator prompt 设计（委派质量、budget 上限、judge 逻辑）
