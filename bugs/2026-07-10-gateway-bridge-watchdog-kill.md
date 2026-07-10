# Gateway Bridge Watchdog 误杀 hr agent（二次发生）

**状态**: 🟡 已知 bug，二次发生，待修复
**严重性**: 中（用户体感 hr 不回复）
**首次发生**: 2026-07-09 14:32（已有专门复现测试）
**本次发生**: 2026-07-10 06:43:29 (Asia/Shanghai)
**触发操作**: 用户让 hr 装 mlx-whisper，跑 GB 级 `pip install`

---

## 现象（用户视角）

hr agent 跑 `pip install mlx-whisper` 这种重活时 62 秒没吐 session event，gateway streaming watchdog（60s）把它强制 abort。用户后续发的"执行的怎么样了"收到 `"Agent is already processing"` 错误，钉钉 AI 卡片里渲染成空白 → 体感"空消息"。

## 时间线（2026-07-10）

| 时间 | 事件 |
|---|---|
| 06:40:36 | 用户发"下载mlx-whisper以及依赖"，hr session 归档，新 session 开始 |
| 06:42:10 | hr 调 bash #1（查架构） |
| 06:42:13 | hr 调 bash #2（查目录） |
| 06:42:17 | hr 调 bash #3（装 mlx-whisper） |
| 06:42:25 | hr 调 bash #4（建 venv） |
| 06:42:26 | 4 个 tool card 都 patch 完成 |
| 06:42:26 ~ 06:43:29 | **62.087s 无 session event**（实际跑 `pip install`） |
| **06:43:29** | **ERROR: Agent RPC inactive for 62087ms** → bridge 强制 abort |
| 06:44:57 | 用户再发"执行的怎么样了" |
| 06:44:57 | **ERROR: Agent is already processing** → 这就是用户看到的"空消息" |

## 根因

**源码位置**: `packages/pi-gateway/dist/agent-bridge.js:413` 有 streaming watchdog，默认阈值 60000ms。

**设计意图**（源码注释原文）:
> "Without this, a streaming LLM that hangs after the thinking block (e.g. 60s of silence) holds the entire IM queue hostage behind a `runExclusive` waiting for an `agent_end` that will never come."

**矛盾点**:
- 不能简单删 watchdog（死流会卡整个 IM 队列）
- 但 60s 对装包这种重活太短
- hr agent 跑长任务没进度回报机制

## 证据

**日志**:
- `~/.omp/logs/omp.2026-07-10.log`（grep 06:43:29 / 06:44:57 两条 error）

**Session**:
- `hr3/sessions/cidz1b3B6_01GDW_OQU_6RjiWbhu83I6Vlr6WJkl06VJDo_.20260709_224036.jsonl`

**源码**:
- `packages/pi-gateway/dist/agent-bridge.js:413` — watchdog 实现
- `packages/pi-gateway/test/gateway-crash-2026-07-09-repro.test.ts` — 昨天的复现测试，注释明确写 `"exact pattern from the 2026-07-09 14:31:22 → 14:32:28 production sequence"`

**配置**:
- `~/.omp/gateway.json` 的 `agent.timeoutMs: 300000` 是 prompt 整体超时（5min），**不是 streaming watchdog 阈值**
- `streamingWatchdogMs` 字段是否可配 / 怎么配 → 待查

## 明天 debug 待办

1. **查 `streamingWatchdogMs` 配置路径**
   ```
   cd /Users/sz-0203015357/Desktop/Narwal/oh-my-pi
   grep -rn "streamingWatchdogMs" packages/pi-gateway/src/
   ```
   确认能否通过 `gateway.json` 或 `accountConfig` 调到 180s+

2. **跑昨天的复现测试**:
   ```
   bun test packages/pi-gateway/test/gateway-crash-2026-07-09-repro.test.ts
   ```
   验证 4 个 case 是否还 pass、各自覆盖什么路径

3. **三选一修复方向**:
   - **A. 提 watchdog 阈值**（60s → 180s）— 治标，装更大包还会挂
   - **B. 重活不让 agent 做**（mlx-whisper 用户本机装好，告诉 hr 已装）— 最稳妥
   - **C. agent 拆步跑**（每步 < 30s，带进度回报）— 治本，要改 system prompt / skill

4. **临时缓解**: 在 hr3 的 `.omp/SYSTEM.md` 加规则 —— 禁止直接跑 > 30s 的 bash（必须 background + 进度回报，或拆小步）

5. **测试更新**: 把 2026-07-10 的 `pip install` 模式加到 `gateway-crash-2026-07-09-repro.test.ts`（新 case 或注释）

## 第一次发生（2026-07-09 14:32）上下文

复现测试 `gateway-crash-2026-07-09-repro.test.ts` 头部注释:
> "Production context: gateway pid 71070 died silently after the bridge watchdog fired (60s no session event). No crash report, no error log, no kernel kill signal. Crash handlers in commands/gateway.ts:149-188 were registered but never logged anything."

> "These tests target the suspected crash paths at the bridge level. If a test triggers an uncaughtException or unhandledRejection, we found the root cause path. If all four pass clean, the bridge is not the culprit and the root cause is in the channel layer (DingTalk SDK 'error' event hypothesis)."

明天 debug 提示:
- 如果 4 个 case 都通过 → 查 DingTalk SDK 是否有 'error' event（channel 层嫌疑）
- 如果某 case 触发 uncaughtException → 锁定根因路径

---

## 参考方案: Hermes Agent（抄作业）

NousResearch 的 `hermes-agent` 跟我们碰到完全一样的问题（streaming + idle timeout 冲突），**修复方向 C（agent 拆步+进度回报）的具体实现就是抄它**。

### 核心实现：timer-based heartbeat

`_notify_long_running()` in `gateway/run.py` (line ~10248)
- 工具运行超过阈值后，定期推送到 gateway 用户（不是推到 IM 队列）
- 输出格式：`⏳ Still working... (N min elapsed — iteration K/90, running: <tool_name>)`
- **默认 180s 间隔**（从 600s 缩减，见 commit `97b9b3d6a`）
- 配置文件：`agent.gateway_notify_interval` in `~/.hermes/config.yaml`（设 `0` 禁用）
- 环境变量：`HERMES_AGENT_NOTIFY_INTERVAL`
- Shipped in v2026.4.23（commit `97b9b3d6a`，PR #14736，原始引入 commit `a4593f8b2`）

### 互补功能

- per-tool progress via `display.tool_progress_command`（工具名+args 实时显示给 Telegram/Discord/Feishu 用户）
- Hermes 还有 `_process.poll()` 心跳轮询，不光靠 setInterval

### 同类问题（确认是普遍问题，不是 OMP 个例）

- Issue #14425 — feature request "heartbeat/progress for long-running tools"，**已 close（已实现）**
- Issue #8760 — cron 长时间 streaming 被 600s idle timeout 误杀（**跟我们 7-10 case 几乎一样**：stream 还在跑，被 inactivity 判死）
- Issue #26410 — long-running tasks 缺乏 durable stall detection
- PR #5389 — `replace wall-clock agent timeout with inactivity-based timeout`（设计范式）
- Issue #4815 — gateway agent timeout 配置（`HERMES_AGENT_TIMEOUT`）kills slow streams
- Issue #10274 — gateway freezes when agent blocked on model API call

### 给 OMP 移植的最小改动

1. `packages/pi-gateway/src/agent-bridge.ts` 在 streaming watchdog 旁加 `setInterval` heartbeat
2. 触发条件：tool 调用 > 60s（watchdog 阈值的一半，留余量）
3. 推送路径：复用现有 DingTalk AI card patch 通道（`patchAICardBlocks`）
4. 配置：`gateway.json` 加 `agent.notifyIntervalMs: 180000`
5. 心跳文本模板：`⏳ 还在跑 (Xs): <tool_name> <args 摘要>`
6. 关键约束：心跳事件 **也** 要 reset streaming watchdog 的 idle 计时（不然心跳本身也救不了）

### 移植后的预期效果

重做 7-10 case 的时间线：
- 06:42:26 开始装包
- 06:45:26 第一条心跳（⏳ 180s 还在跑: bash pip install mlx-whisper）
- 用户看到 → 不会问"执行的怎么样了"
- 即使 06:43:29 仍被 watchdog 杀，至少**有痕迹可查**，不会"空消息"体感

### 链接

- https://github.com/NousResearch/hermes-agent/issues/14425 （heartbeat feature，已实现）
- https://github.com/NousResearch/hermes-agent/commit/97b9b3d6a （实际 PR #14736，faster still-working pings）
- https://github.com/NousResearch/hermes-agent/issues/8760 （同类 bug，cron streaming 被杀）
- https://github.com/NousResearch/hermes-agent/issues/26410 （durable stall detection）
- https://github.com/NousResearch/hermes-agent/pull/5389 （wall-clock → inactivity）
