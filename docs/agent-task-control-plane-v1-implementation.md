# Agent 持久任务控制面 v1：实现规格

> 本文是基于当前仓库结构的 v1 实现边界。功能定义见 `docs/agent-task-control-plane-v1.md`。

## 1. 接入边界

当前已有能力：

- `packages/coding-agent/src/task/`：已有 Agent discovery、TaskTool、并行执行、输出 schema、事件总线和 isolation/worktree 能力。
- `packages/coding-agent/src/task/types.ts`：已有 `TaskParams`、`AgentDefinition`、`AgentProgress`、`SingleResult` 及子 Agent 事件类型。
- `packages/coding-agent/src/task/executor.ts`：已有子 Agent 执行、事件转发、取消信号、session/artifact 参数。
- `packages/coding-agent/src/session/`：已有 session 持久化、恢复和 JSONL writer。
- `packages/coding-agent/src/session/agent-storage.ts`：已有 Bun SQLite、WAL、schema version、按数据库路径 singleton。
- `packages/coding-agent/src/live/task-router.ts`：已有运行中任务的 status/steer/cancel 语义，但它是语音主会话路由，不应直接承担持久 Task 控制面。
- `docs/agent/task-discovery.md`：已有 AgentDefinition 发现和执行时约束说明。

v1 新增控制面应作为独立模块接入，不重写现有 TaskTool。现有 TaskTool 继续服务 session 内即时 subagent；其 Agent discovery、输出 schema 和事件契约可复用，但现有 `executor.ts` 是进程内执行器，不能冒充已确定的独立进程 TaskRun 边界。default Agent 的业务 agentDir/workspace 统一为 `~/cf-workspace`，通过现有 skeleton 初始化；全局用户配置目录不再作为 default Agent 的业务 workspace。
- 当前 skeleton 初始化：`packages/coding-agent/src/skeleton/assets.ts` / `ensure.ts` / `dirs.ts` 提供 Agent 文件和目录骨架；TODO.md 已存在，`topics/` 尚未列入目录骨架。

## 2. 模块边界

建议新增目录：

```text
packages/coding-agent/src/task-control/
  types.ts              # domain unions and DTOs
  state-machine.ts      # legal transitions and guards
  store.ts              # repository interface
  sqlite-store.ts       # SQLite implementation/migrations
  events.ts             # append-only event contracts
  source-sync.ts        # TODO/topic → triage idempotent sync
  proposals.ts          # Organizer proposal lifecycle
  preflight.ts          # readiness checks
  dispatch.ts           # manual worker assignment/start
  runs.ts               # TaskRun lifecycle and reports
  verification.ts       # verifier lifecycle
  recovery.ts           # resume/stale inspection; no auto reclaim
  index.ts              # public exports
```

CLI/TUI/Web adapters should depend on the domain/store interfaces, not SQL. The first implementation can expose CLI/SDK operations before adding a visual board.
- `~/cf-workspace` 按 skeleton 初始化，且 skeleton 必须增加 `topics/` 目录；TODO.md 使用 skeleton 模板。
- 不自动执行 `git init`；代码 Task 另行绑定用户选择的 `repositoryRoot + baseRevision`。
- `~/cf-workspace/.cornfield/config.yml` 是 default Agent 的模型配置来源；不创建 Task/Worker 第二份模型配置。
- `~/cf-workspace/.cornfield/config.yml` 是 default Agent 的模型和运行配置来源；首次初始化将旧 `~/.cornfield/agent/config.yml` 合并迁移，旧文件只作备份，不再作为 default Agent 运行时真源。其他 Agent 继续使用各自 agentDir 配置。

## 3. Domain types

Use discriminated unions and string literal unions; do not collapse Task, Run, and Verification status.

```ts
export type TaskStatus =
  | "triage" | "organizing" | "proposal_ready" | "draft" | "preflight"
  | "incomplete" | "blocked" | "awaiting_approval" | "ready" | "claimed"
  | "running" | "review" | "rework" | "paused" | "stale" | "accepted"
  | "rejected" | "cancelled";

export type TaskRunStatus = "queued" | "starting" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";
export type VerificationStatus = "unverified" | "verifying" | "passed" | "rejected";
export type DependencyType = "blocks" | "informs";
export type WorkspacePolicy = "shared" | "worktree" | "none";
export type Priority = "P0" | "P1" | "P2" | "P3";
```

TaskSpec must include stable `taskId`, title, kind=`code`, `agentId` (v1 fixed to `default`), bound repository root and base revision, priority, source references, `sourceRevision`, `taskRevision`, `specSnapshot`, workspace policy, dependencies, completion contract, and audit timestamps. TaskRun must include taskId, attempt, session/process references, resolved cwd, effective model snapshot, status, timestamps, worktree path, structured result, and error. Verification must include taskId/runId, verifier identity, checks, evidence, status, and decision timestamps.

Do not add Task-level permissions, deadline, budget, network, or multi-repository fields in v1.

## 4. SQLite schema

Use a dedicated task-control database path under the agent data directory, opened through one singleton per path. Enable WAL, busy timeout and schema version migration, following `AgentStorage` conventions. Proposed tables:

```sql
CREATE TABLE task_control_schema (version INTEGER PRIMARY KEY);
CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('todo','topic')),
  source_path TEXT NOT NULL,
  source_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_type, source_key)
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source_item_id TEXT REFERENCES source_items(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'code'),
  repository TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  status TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  spec_snapshot_json TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (agent_id = 'default'),
  workspace_policy TEXT NOT NULL,
  claim_json TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  dependency_type TEXT NOT NULL CHECK (dependency_type IN ('blocks','informs')),
  PRIMARY KEY(task_id, depends_on_task_id)
);
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (agent_id = 'default'),
  effective_model TEXT NOT NULL,
  session_id TEXT,
  process_id INTEGER,
  workspace_path TEXT,
  result_json TEXT,
  error_json TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, attempt)
);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  status TEXT NOT NULL,
  verifier_profile TEXT,
  checks_json TEXT NOT NULL,
  evidence_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

All status writes occur in transactions that validate the transition and append an event. Claim must use a conditional update (`status='ready'`) so two callers cannot claim the same Task. History rows are append-only; no destructive update of Run or Verification facts.

## 5. Source synchronizer

`source-sync.ts` reads only default Agent workspace files `~/cf-workspace/TODO.md` and linked `~/cf-workspace/topics/` (not the currently selected code repository), following `project-todo` scope rules. It must:

1. Resolve project root using existing project conventions.
2. Assign stable IDs without using title/path/hash as identity; persist the mapping in `source_items` and add topic IDs only when the source format supports it.
3. Create/update one triage candidate idempotently per source item.
4. Never start a model, claim, or create a ready Task during sync.
5. Detect source revision changes and apply `needs_review` rules.
6. Never delete user-authored Topic content.

Source parsing and Markdown edits must reuse the project-todo discipline; do not rewrite TODO.md wholesale.

## 6. Proposal lifecycle

`proposals.ts` exposes:

```text
startOrganization(sourceId) → organizing
saveProposal(proposal)      → proposal_ready
acceptProposal(proposalId)  → atomically create Task set + dependencies
rejectProposal(proposalId)  → rejected
```

`startOrganization` is explicit and invokes the existing task/subagent mechanism with a proposal output schema. The Organizer cannot call dispatch/start APIs. `acceptProposal` validates the entire proposal, creates all Tasks in one transaction, and leaves each Task in `draft`; partial creation is forbidden.

## 7. Preflight and state machine

`preflight.ts` checks:

- repository is one Git repository;
- objective/taskPrompt/outcome/verifiers/evidence are present;
- On first client access, call the existing skeleton ensure path for `~/cf-workspace`; the ensure operation must be additive/idempotent and create the skeleton `TODO.md`, `topics/`, and runtime files.
- Do not run `git init` during workspace initialization.
- `agentId` is `default` and the live serve default session is available;
- code Tasks bind an explicit Git repository root and creation-time base revision;
- a code Task without a Git repository remains incomplete;
- workspace policy is valid;
- blocking dependencies are accepted;
- high-risk policy requires approval when applicable;
- verifier configuration is executable or explicitly human review.

Return a typed result, not a boolean:

```ts
type PreflightResult =
  | { kind: "ready" }
  | { kind: "incomplete"; missing: string[] }
  | { kind: "blocked"; reasons: string[] }
  | { kind: "awaiting_approval"; reasons: string[] };
```

Centralize legal transitions in `state-machine.ts`; adapters must not set status strings directly. `accepted`, `cancelled`, and `rejected` are terminal. `paused` is resumable. `stale` is an observable condition, not an automatic reclaim action.

## 8. Manual dispatch and Worker protocol

`dispatch.ts` only supports explicit human/Lead operations:

```text
assignDefault(taskId)
claim(taskId, actor)
startRun(taskId, actor)
pause(taskId, reason)
cancel(taskId, reason)
retry(taskId, reason)
resume(taskId)
```

`startRun` 创建新的 TaskRun，并以独立进程启动欢迎页 `default` Agent 的独立 AgentSession。v1 不提供 Agent/Worker Profile 选择：Task 固定 `agentId = default`，default Agent 的 agentDir/workspace 固定为 `~/cf-workspace`，模型配置复用 `~/cf-workspace/.cornfield/config.yml` 的现有解析链；代码 Task 仍使用创建时固化的 `repositoryRoot + baseRevision` 创建 worktree。只把实际生效模型写入 TaskRun。不得新建第二份模型配置文件，也不提供 Task/Run 级模型覆盖。子进程复用现有 `createAgentSession`、Agent discovery、session 持久化和事件协议，但不直接调用进程内的 `executor.ts` 作为运行边界。Task 的 `specSnapshot`、显式 `taskPrompt`、source topic/revision 和 workspace 通过静态启动协议传入。一个 Task 可有多个顺序 Run，但同一时刻只允许一个 active Run。

Worker lifecycle messages must be normalized into TaskRun events. Completion requires the structured report fields `outcome`, `summary`, `changedFiles`, `artifacts`, verification attempts/results, residual risks, blockers, and next action. A natural-language “done” is invalid as the complete report.

Heartbeat writes are periodic updates to the active Run/claim record. Lease expiry marks the Task `stale`; v1 provides inspect/release/retry commands but no automatic reclaim.

## 9. Verification and merge boundary

`verification.ts` starts a Verification only after TaskRun `succeeded` and Task enters `review`. Ordinary code Tasks use an independent verifier by default; high-risk Tasks require additional Human/Lead approval. Verifier checks the Task snapshot and the actual worktree, records command/evidence results, and may only transition to `passed` or `rejected`.

`passed` transitions Task to `accepted`; `rejected` transitions Task to `rework`. Merge is a separate explicit Lead/Human operation after accepted. Worker processes have no merge authority in the control-plane API.

## 10. Recovery

Persist TaskRun/session references before launching. On startup, scan non-terminal Runs and reconcile with session metadata/process state. Reattach/resume through existing session resume APIs where possible. Do not infer success from process exit alone. A missing transcript or ambiguous process state becomes `failed`/`stale` with an event and human action, not accepted.

## 11. Adapters and future UI

First adapters should be CLI/SDK operations and a read-only status projection. A future TUI/Web board reads the store and emits domain commands; it must not mutate SQL directly. Use `triage`, `ready`, `claimed`, `running`, `review`, `accepted` as the primary columns and expose exception filters for incomplete/blocked/approval/stale/rework.

## 12. Test matrix

Targeted tests must cover:

- source sync idempotency and TODO/topic revision changes;
- proposal validation and atomic batch creation;
- every legal and illegal status transition;
- concurrent claim allowing exactly one winner;
- blocks vs informs dependency semantics;
- one active Run invariant and sequential retry history;
- structured report validation;
- paused/resume and cancelled terminal behavior;
- stale marking without automatic reclaim;
- independent verification pass/reject and merge gating;
- SQLite migration, WAL reopen, and event append ordering;
- process/session recovery with real temporary directories and real SQLite where possible.

Do not use `mock.module()`. Use real storage and `vi.spyOn` only for narrow runtime seams.

## 13. Implementation sequence

1. Domain types, transition table, event contracts.
2. SQLite migrations and repository/store tests.
3. TODO/topic source sync and stable mapping.
4. Proposal validation and atomic Task creation.
5. Preflight and manual claim/dispatch APIs.
6. TaskRun/session bridge and structured result persistence.
7. Verification and merge gate.
8. Recovery/stale inspection.
9. CLI/read-only projection, then UI.

Before modifying any existing function/class, run references and GitNexus impact analysis; before commit run `detect_changes`. Existing TaskTool remains unchanged until a separate adapter seam is proven necessary.
