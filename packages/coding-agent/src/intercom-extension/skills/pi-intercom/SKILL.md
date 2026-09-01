---
name: pi-intercom
description: |
  Streamline session-to-session coordination with pi-intercom. Send messages,
  delegate tasks, and coordinate work across multiple pi sessions on the same
  machine. Use for planner-worker workflows, cross-session context sharing,
  and real-time collaboration between sessions.
---

# Pi Intercom Skill

Use this skill when you need to coordinate work across multiple pi sessions
running on the same machine. Pi-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

When you are supervising `pi-subagents`, delegated child agents can escalate to
you via `contact_supervisor` if `pi-subagents` supplied child bridge metadata.
This skill covers how to handle those orchestrator-side escalations.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)
- **Cross-codebase peer messages**: Message an explicit live peer in another project, or open a visible Herdr project pane when a long-lived conversation is needed

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/name planner    # Terminal 1
/name worker     # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (blocks until answer):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns the planner's reply as the result
```

**Worker reports completion**:
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?"
})
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" })
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 2b: Parent-Child Orchestration (monitoring children)

When a session declares a parent (a child omp launched via `send`/`ask` with
`openProjectPaneIfMissing: true` registers automatically as your child, and
any session launched with `PI_SUBAGENT_ORCHESTRATOR_*` env does too):

```typescript
intercom({ action: "children" })
// → Lists only YOUR child sessions with live status — monitor them without
//    scanning the full roster. Rows show the same presence data as list.
```

Child sessions behave differently toward you automatically:

- **Completion reports**: a child sends a structured `Subagent completed its
  task round.` message to you after each task round (run id + agent + child
  index). Treat it as a status update, not an ask.
- **Ask without `to`**: a child's `intercom({action:"ask", message:"..."})`
  with no `to`/`cwd` routes to you by default. Reply the same way you reply
  to any ask.
- **Decision escalations**: a child may escalate via `contact_supervisor`
  with `reason: "need_decision"` / `"interview_request"` / `"progress_update"`
  — you receive the structured request and decide.

When you spawn a child yourself (the parent side), prefer
`send`/`ask` with `cwd` + `openProjectPaneIfMissing: true` so the pane
inherits the parent edge and the child auto-reports back.

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "planner", message: "Use exponential backoff starting at 100ms." })
```

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

**Multiple pending asks — verify before replying.** When more than one inbound ask is unanswered (check
`intercom({ action: "pending" })`), you MUST cross-check the `replyTo` id against the question you are
answering — the reply command embedded in each incoming message is bound to that message only. Copying
a reply command from an earlier/historical message sends your answer to the wrong ask: the intended
sender times out while a stale ask gets a mismatched reply. Rule: answer → find the inbound message
that asked it → use THAT message's embedded reply command (or `replyTo` id).

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom({ action: "send", to: w, message: task })
);
```

### Pattern 5: Send with Attachments

Share code snippets, files, or context — but ONLY content under ~1KB inline
(see 长内容传输（Large Payload） for the threshold):

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

Content larger than ~1KB (full files, long diffs, reviews): write it to a file
first, then send only the absolute path + one-line summary — see
长内容传输（Large Payload）. Never inline the full body.

### Pattern 6: Cross-Codebase Peer Messages

Use `to` alone to message any explicit live peer on the machine, even when it is
in another codebase. Use `cwd` alone when there should be exactly one live peer
in that repo. Use `to` plus `cwd` when the directory is a safety guard.

```typescript
intercom({
  action: "ask",
  cwd: "/path/to/other-repo",
  to: "workbench-agent",
  message: "Which module owns workbench source slices?"
})
```

Only open a Herdr project pane when you need a durable visible peer session in
that repo. For bounded work, prefer `pi-subagents` with an explicit `cwd`; the
child can use `contact_supervisor` for owner decisions and regular `intercom`
for explicit peer coordination.

```typescript
intercom({
  action: "send",
  cwd: "/path/to/other-repo",
  openProjectPaneIfMissing: true,
  message: "Let's discuss the workbench API ergonomics in this repo."
})
```

If a live session already exists in that `cwd`, intercom reuses it. If multiple
sessions are active there, pass `to` to select one by name or session ID.

### Pattern 7: Handle Subagent Escalations (Orchestrator Side)

When `pi-subagents` spawns a delegated child and supplies child bridge metadata,
that child can reach you through `contact_supervisor`. You receive a formatted
message that includes run metadata:

```
**From subagent-worker-78f659a3-1**

Subagent needs a supervisor decision.
Run: 78f659a3
Agent: worker
Child index: 0

Which API should I use?
```

**Reply using `reply`:**

```typescript
// The reply hint in the incoming message will show the exact call:
intercom({ action: "reply", message: "Use the stable v2 API." })
```

This works because `reply` resolves the correct sender and message ID automatically (when unambiguous — with multiple pending asks it fails loud and requires `to`/`replyTo`).

**Three types of escalations to expect:**

| Type | What it means | How to respond |
|------|---------------|----------------|
| `need_decision` | Subagent is blocked and waiting for your answer. Uses the shared ask timeout: 10 minutes by default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`. | Reply promptly with a clear decision. If you need more context, ask follow-up questions via `reply`. |
| `interview_request` | Subagent needs multiple structured answers in one blocking exchange. Uses the shared ask timeout: 10 minutes by default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`. | Reply with plain JSON or a fenced `json` block using the provided `{ "responses": [...] }` shape. |
| `progress_update` | Subagent is sharing meaningful progress or a plan-changing discovery. Not blocking. | Read and acknowledge. No reply required unless you want to redirect. |

**When a subagent asks:**

```typescript
// In the turn triggered by the incoming ask:
intercom({ action: "reply", message: "Use exponential backoff, max 3 retries." })
```

**When a subagent sends an interview request:**

Read the rendered questions in the incoming message and reply with the exact ids in JSON. `info` questions are context-only and do not need response entries:

```typescript
intercom({
  action: "reply",
  message: "```json\n{\n  \"responses\": [\n    { \"id\": \"api\", \"value\": \"Stable API\" },\n    { \"id\": \"constraints\", \"value\": \"Keep the public error shape unchanged.\" }\n  ]\n}\n```"
})
```

**If you receive multiple pending asks from different subagents:**

```typescript
intercom({ action: "pending" })
// → Shows all unresolved inbound asks with sender, elapsed time, and preview

intercom({ action: "reply", to: "subagent-worker-78f659a3-1", message: "Use the v2 API." })
```

**Important:** Only sessions where `pi-subagents` supplied child bridge metadata
get the `contact_supervisor` tool. Normal sessions use the regular `intercom`
tool. If you see the formatted supervisor decision/progress update message, treat
it as a `contact_supervisor` escalation. A subagent may use regular `intercom` for
peer coordination, including peers in other directories, but owner decisions and
new visible project panes should go through the supervisor.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget; infers the sole pending ask as its reply | You don't need a response |
| `ask` | Blocks until reply (10 min default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`) | You need an answer to continue |
| `reply` | Resolves by explicit `replyTo`, or the unique pending ask; multiple pending asks fail loud and require `to`/`replyTo` | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `history` | Returns recently received/sent messages | You missed a `send` while busy; async recovery |
| `list` | Returns all sessions with live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |

## Visible Peer Sessions

For bounded cross-codebase work, prefer `pi-subagents` with an explicit `cwd`.
Use `intercom({ action: "send", cwd: "/path", openProjectPaneIfMissing: true, ... })`
only when a long-lived visible peer session is useful.

If Herdr is unavailable, do not invent a terminal fallback inside this workflow.
Ask the user before opening another visible surface manually.

## Important Constraints

### `ask` Limitations

- **Connected targets only**: `ask` fails immediately when the target is not in the live intercom roster. Use `list` before asking when liveness is uncertain; use `send` for non-blocking mailbox delivery.
- **Configurable timeout**: If no reply arrives before the shared ask timeout, the ask fails. The default is 10 minutes; set `PI_INTERCOM_ASK_TIMEOUT_MS` to a positive millisecond value to change it.
- **No global single slot**: asks to *different* targets run in parallel (each reply resolves its own ask id, multi-slot waiters). The only refusal is the broker's symmetric-deadlock guard: when the target already has an open ask waiting on YOU, your ask comes back `Mutual ask refused` — answer the target's pending ask first (unless the pending-routing says otherwise), then ask again.
- **Cannot self-target**: A session cannot ask itself, including through disconnected-mailbox remapping

```typescript
// Parallel asks to DIFFERENT targets are fine (multi-slot waiters, each reply
// resolves its own ask id). This guard only trips on the symmetric-deadlock
// case (the target is already waiting on a reply from you): answer the
// target's pending ask first, then ask again.
const result = await intercom({ action: "ask", to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Mutual ask refused")) {
  // Reply to the planner's open ask, then retry your ask.
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Sole pending ask inference**: If the destination has exactly one pending inbound ask, `send` attaches its `replyTo` and reports `Reply sent to <target> (inferred from pending ask)`
- **Ambiguity stays unthreaded**: Zero or multiple matching asks leave the send as an ordinary message
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions confirm ordinary and inferred sends
- **Explicit replies skip confirmation**: A caller-supplied `replyTo` skips the dialog

## 长内容传输（Large Payload）

长内容一律不直接发正文。实测事故：一个 cornfield agent 用 `send` + attachment 全文发送 16KB review，`send` 是 fire-and-forget，主会话当时在等待循环、没有新轮次接收，消息直接丢失。约定：payload 进文件，intercom 只发「文件绝对路径 + 一句话摘要」。

### 阈值（Threshold）

- message 正文 + attachment 内容合计超过约 **1KB**：一律不直接发正文（整文件内容、长 diff、长 review、长日志都算）。
- 1KB 以下的小片段可走 inline snippet（见 Pattern 5）。

### 文件先行（File First）

1. 先用 `Bun.write` 把全文写到临时文件：目录用 `/tmp/` 或 `~/.cornfield/intercom/`（`Bun.write` 自动建父目录）；文件名带目标会话名 + 时间戳，例如：
   `/tmp/intercom-arch1-20260901-153000.md`
2. intercom 只发：**文件绝对路径 + 一句话摘要**。message 和 attachment 里都不贴正文。

### attachment 携带路径，不携带正文

intercom 的 attachment schema 没有独立的 `path` 字段（`Attachment = { type, name, content, language? }`），且 `content` 无论什么 type 都会注入接收方可见正文。所以 `type: "file"` 用 `name` 放绝对路径，`content` 只放一句话摘要——正文留在文件里，接收方按需 `read`：

```typescript
// GOOD: content 只有摘要；正文在文件里，接收方 read 取全文（不注入正文）
intercom({
  action: "send",
  to: "arch1",
  message: "Review 完成",
  attachments: [{
    type: "file",
    name: "/tmp/intercom-arch1-20260901-153000.md",   // 绝对路径
    content: "16KB review: intercom 长内容传输约定"     // 一句话摘要，不是正文
  }]
})
```

```typescript
// BAD: 大段正文塞进 content —— 注入接收方正文，且 send 可能丢消息
attachments: [{ type: "file", name: "review.md", content: "<大段正文>" }]
```

### 传结论用 `ask`，`send` 仅限无需回应的通知

| 目的 | 用 | 原因 |
|------|----|------|
| 传结论 / 需要确认对方收到 | `ask`（阻塞等回复，默认 10 分钟超时，可配 `PI_INTERCOM_ASK_TIMEOUT_MS`） | `send` 是 fire-and-forget，接收方忙/在等待循环时没有新轮次取件，消息会丢 |
| 无需回应 / 通知、进度更新 | `send` | 不阻塞发送方 |

review、任务结果、结论这类「送达即完成」的传递一律 `ask`；`send` 只能用于丢了也无妨的通知。

### 接收方约定（Receiver Contract）

- 收到 `type: "file"` attachment 或正文里的绝对路径：先 `read` 取全文，再回复。
- 路径读不到 / 不确定指什么：先 `ask` 对方确认，不猜、不复述。

## 历史消息查询（History）

`send` 丢的消息不是永久丢失——broker 会持久化每条已接受的消息到 `~/.cornfield/intercom/journal.jsonl`，任意会话可通过 `history` action 查询最近的收/发记录，用于异步恢复。

```typescript
// 查询最近 20 条发给我的消息（默认按时间倒序）
intercom({ action: "history" })
// → [14:30:00] ← worker: review complete (📄/tmp/...)
// → [14:25:00] ← planner: check if PR is ready

// 查询我发出去的消息
intercom({ action: "history", direction: "out" })

// 查询双方消息
intercom({ action: "history", direction: "both", limit: 50 })

// 查询某个时间点之后的消息（e.g., 我上次 check 的时间戳）
intercom({ action: "history", since: 1725180000000 })
```

### 何时使用

- 怀疑 `send` 的消息在对方忙时丢失时
- 自己完成一个长任务后，想检查其间有没有人发消息过来
- 故障排查：`history` 比询问对方更快

### 注意事项

- 仅返回当前会话（sessionId）相关的消息，不会跨会话读取
- 日志保留 7 天，最多 2000 条；超限时自动压缩
- 仅记录 broker 接受的 send（被 `isFrameDeliverable` 拒绝的过大消息不会记录）
- `queued` 标记表示消息发送时对方已离线，已进入邮箱队列

## Best Practices

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
const reply = await intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// Continue with the answer...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Name sessions meaningfully

Use `/name` so others can target you easily:

```
/name api-worker
/name frontend-dev
/name planner
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**
```typescript
// Only a same-ask-id re-registration trips this (defensive; the tool generates
// a fresh id per ask). Different targets ask fine in parallel.
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });

// Option 2: Wait for the current ask to complete first
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```

**"Message sent but never received"**
`send` is fire-and-forget; if the recipient was busy (in a wait loop, no new turn), the message may be lost. Check `intercom({ action: "history" })` to see queued or delivered-but-unprocessed messages. If the entry exists with `queued: false`, it was delivered to the recipient's runtime — the recipient may need to check its incoming queue. If `queued: true`, the recipient was offline and the message will be delivered on reconnect.
```
Replies to recently disconnected explicitly named senders can be queued by the broker and delivered if that sender reconnects with the same name and directory. Runtime-only `subagent-chat-...` aliases are not reconnect identities. New `send` calls may target a known live or recently disconnected session; blocking `ask` calls require a live target.

**Ask timeout**
```typescript
// The ask will reject with a timeout error
// Default: 10 minutes
// Override: set PI_INTERCOM_ASK_TIMEOUT_MS to a positive millisecond value
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded pi-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

```typescript
intercom({ action: "status" })
// Check if broker is running and restart if needed
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code — short diff (<1KB) inline is fine;
// larger findings: write the file first, send only path + summary
// (see 长内容传输（Large Payload）)
intercom({
  action: "send",
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom({
  action: "ask",
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom({
  action: "reply",
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom({ action: "send", to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom({ action: "send", to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom({ action: "send", to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For tasks that might exceed the ask timeout, use send + periodic asks

// 1. Initial send with context (keep ≤ ~1KB; larger context: file path + summary,
//    see 长内容传输（Large Payload）)
intercom({
  action: "send",
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom({ action: "send", to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with decision...
```
