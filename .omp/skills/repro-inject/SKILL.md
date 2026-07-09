---
name: repro-inject
description: >-
  When the user wants to inject a synthetic DingTalk message to reproduce a real
  user-facing issue — bug report, cron verification, e2e round-trip check —
  drive the repro-inject script end-to-end: bring the gateway test endpoint up,
  pick a webhook source, inject the message, verify the agent reply. Skip for
  unit tests (those use FakeDingTalkChannel with captureOutbound), gateway
  pipeline tests, interactive omp sessions, or anything that doesn't need a
  real DingTalk round-trip.
---

<!--
  Co-located with the script: .omp/skills/repro-inject/repro-inject.ts
  Edit both together when the flow changes; the script's --help and the
  script's own header comment are the canonical flag list and contract.
  This skill encodes the decision tree and side-effect warnings, not the
  flag reference.
-->

# repro-inject

> **replay** — synthetic message riding the real `injectTestMessage` path so the round-trip is identical to a genuine user DM.

## Outcome

A synthetic `DingTalkRawMessage` is delivered to the gateway's `POST /test/inject`, treated as real by `MessageHandler`, dispatched through the real `AgentBridge` and `DingTalkChannel.sendMessage`, and the agent's response is captured in `<agentDir>/sessions/<safeConvId>.jsonl`.

## Procedure

### Step 1 — Bring the gateway test endpoint up

Confirm `OMP_GATEWAY_TEST_MODE=1` is on the running gateway, and `/test/health` answers.

```bash
curl http://127.0.0.1:7890/test/health
# → {"ok":true,"mode":"test-injection"}
```

**If not live**, pick a restart strategy. Both paths are graceful (write restart-sentinel, drain active sessions).

**Service-managed** (preferred, plist has the env):

```bash
omp gateway service stop
sleep 5
omp gateway service start
curl -s http://127.0.0.1:7890/test/health
```

**Foreground** (dev, detached, or plist missing the env):

```bash
pkill -TERM -f "omp gateway start" ; sleep 4
OMP_GATEWAY_TEST_MODE=1 OMP_GATEWAY_TEST_PORT=7890 \
  nohup omp gateway start --foreground > /tmp/gateway-foreground.log 2>&1 &
curl -s http://127.0.0.1:7890/test/health
```

**Stale pid** — `Gateway already running (PID xxx)` means a leftover `~/.omp/gateway-data/gateway.pid`. `rm` it and re-launch (don't `kill -9` the listed PID, the previous run already exited).

**Verify after restart:**

```bash
cat ~/.omp/gateway-data/gateway.pid
cat ~/.omp/gateway-data/gateway.status.json | python3 -m json.tool | head -20
tail -20 ~/.omp/gateway-data/logs/service.log | grep -E "BOOT|service start"
```

**Never `launchctl kickstart -k`** — SIGKILL bypasses `gateway.stop()`, the restart-sentinel is never written, in-flight IM messages are lost. If `service stop` doesn't exit in 30s, only then escalate.

Completion criterion: `mode: "test-injection"` is in the `/test/health` response.

### Step 2 — Pick the webhook source

Default is the `sessions.db` path. Override only when it won't work. (For a non-default data dir, pass `--gateway-data-dir <path>`; default `~/.omp/gateway-data/`.)

| Scenario | Flag |
|---|---|
| Normal — `sessions.db` has the row for this `account_id` | *(none)* |
| Cold start — db is empty for this account | `--grab-webhook` |
| CI / pure-replay — refuse to grab, exit 4 | `--no-grab-fallback` |
| One-off — a webhook URL you already have on hand | `--webhook <url>` |

The script's header comment (`repro-inject.ts:1-49`) spells out the full 4-level priority and the soft-expiry note.

**Webhook freshness is a soft hint, not a hard deadline.** Hours-old webhooks usually still 200 OK. On `errcode 300001`, `DingTalkChannel.sendMessage` falls back to OAuth DM targeting the cached `senderStaffId` — stale row is recoverable, re-grab only if both routes fail.

**Stale grab recovery.** The grab path caches into `~/.omp/repro-state.json` (5min TTL). If a grab went stale, `--clear` empties the cache so the next inject re-grabs from scratch.

Completion criterion: one source is selected and the chosen flag (if any) is in the argv.

### Step 3 — Inject and verify

```bash
bun run .omp/skills/repro-inject/repro-inject.ts \
  --account <id> --text "<reproduction step>" --verify
```

Without `--verify`, the script returns immediately after HTTP 200; the reply is in DingTalk and in the JSONL but not surfaced in the terminal.

`--agent-dir` auto-fills from `gateway.json`'s `accounts.<id>.agentDir` when present. CI runners that bypass gateway.json must pass `--agent-dir` explicitly.

**Cron task sub-flow.** Use the `cron` host tool with `action: "test-run"`, then capture with `--verify`. Use `--verify-timeout` ≥ 90000 (1.5x the default 60s gateway tick) so a slow tick + agent turn fits inside the wait; smaller values race the scheduler reload and give a false timeout. See `packages/pi-gateway/src/scheduler/test-run.ts` for the cron-tool contract.

Completion criterion: HTTP 200 from `/test/inject`; if `--verify`, an assistant text block is printed within `--verify-timeout` (default 90s).

### Step 4 — Confirm side effects

- **User's DingTalk** (primary signal): the bot's reply arrives as an AI Card (DM) or markdown (V1).
- **OAuth DM fallback** (when `errcode 300001`): the reply lands in the user's 1-on-1 with the bot, not in the original thread. See Step 2 freshness note.
- **`sessions.db`**: real convId row's `updated_at` is touched; test convId row (`algo-prod-test-...` / `repro-...` etc.) is auto-`DELETE`d post-inject. Real users (`cidH...` style) are untouched.
- **`<agentDir>/sessions/<safeConvId>.jsonl`**: agent's full turn. The script's `--verify` reads from this file.

## Pitfalls

- **Don't pre-create a session for the test convId** — the inject path will go through `MessageHandler.getSession` → `createSession` if missing. Pre-creating interferes with the auto-cleanup that runs after inject.
- **Webhook is real, sendMessage is real** — the bot reply is *actually delivered* to the user's DingTalk. For smoke tests, prefer fake webhook + fake sender so `sendMessage` fails closed.
- **The injected messageId has `repro-` prefix** — residue filters should key on `conversationId` (which this script does), not messageId.
- **`--verify-timeout` is per-call, not per-turn** — a long agent turn that takes >90s with no intermediate text will time out and print a partial state. For cron runs, 1.5x tick is the floor, not the ceiling.
- **Cold-start grab races the gateway** — both the script and the running gateway have a DWClient open. If the gateway wins, the script times out and you retry.
