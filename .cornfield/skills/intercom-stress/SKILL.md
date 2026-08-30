# intercom-stress

压测 pi-intercom broker 的独立程序，**象棋是载体、压测是目的**：`chess` 模式用两个真实 agent 会话下棋（每步走法都是一次 intercom ask，程序当裁判校验合法性），`load` 模式用合成会话灌负载找 broker 限流边界。两模式共用同一套指标管道（`events.jsonl`）和报告（`report.json`）。

## 前置

- bun ≥ 1.3.7、python3（PTY 包装用）
- broker 在线：`cornfield-gateway` 服务在跑（`curl http://127.0.0.1:7890/test/health` 可测），同一台机器
- worker 二进制必须内置 intercom 扩展。解析顺序：`PI_INTERCOM_PI_BIN` → `PI_BIN` → `cornfield`（PATH）→ `~/.local/bin/cornfield` → `pi`（PATH）
  - **坑**：`~/.pi/agent/bin/pi` 可能是 node 脚本包装，不带 intercom，spawn 出来永不注册。用 `file <bin>` 确认是 Mach-O/ELF 原生二进制。

## 用法

```bash
# 真实双 worker 下棋（默认）：两个真实 pi/cornfield 会话当棋手，实时 TUI 看棋盘 + 双方状态 + RTT
bun run .cornfield/skills/intercom-stress/stress.ts --mode chess

# 自检（不烧 token、不起进程）：脚本随机合法走子，验证整条链路
bun run .cornfield/skills/intercom-stress/stress.ts --mode chess --dummy

# 合成压测：8 个虚拟会话，斜坡到 150 msg/s，找限流边界
bun run .cornfield/skills/intercom-stress/stress.ts --mode load
```

### chess 模式 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--moves N` | 100 | 步数上限（plies） |
| `--games N` | 1 | 连续下 N 局（复用棋手） |
| `--timeout-ms N` | 120000 | 单步 ask 超时 |
| `--dummy` | off | 脚本走子自检 |
| `--kill-white-after N` / `--kill-black-after N` | -1 | 该方第 N 手前 SIGKILL 其 worker |
| `--respawn` | off | kill/失联后自动重建棋手继续弈 |
| `--drop-connection-at N` | -1 | 第 N 手前断控制器连接并重连 |

### load 模式 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--sessions N` | 8 | 虚拟会话数 |
| `--ramp-to N` | 150 | 目标峰值 msg/s |
| `--ramp-s N` / `--soak-s N` | 30 / 30 | 斜坡/保持秒数 |
| `--jitter-ms N` | 5 | vhost 回复延迟抖动 |
| `--max-inflight N` | 4 | 单 vhost 并发未答复上限 |
| `--aggressive` | off | 越过限流边界继续灌（直到踢连接） |

通用：`--no-tui`（非 TTY 场景强制事件流）、`--out DIR`（报告输出目录，默认 `~/.cornfield/intercom-stress/<ts>/`）、`--name NAME`（控制器会话名）。

## 输出

- 实时 TUI：棋盘（chess 模式）、双方 `idle/thinking/tool` 状态 + 上下文占用、每手耗时（含模型思考）、RTT 火花线、消息速率、事件滚动；非 TTY 输出事件流。每 250ms 快照到 `<run>/live.json` 可外部 tail。
- `<run>/events.jsonl`：全量事件（ask_sent/ask_delivered/reply/move/presence/receipt/control/throttle/fault/…）
- `<run>/report.json` + 终端表格：ask RTT p50/p95/p99、broker 链路跳数（send→broker / broker hold）、消息计数、presence 状态驻留时长、故障注入/观测结果、棋谱。

## 已知边界（实测）

- broker 按连接令牌桶限流：**突发 ~240 帧、稳态 ~120 帧/s**；一次 ask+reply 往返消耗 2 帧，**单连接对稳态 ≈ 50-60 往返/s**。`load` 模式的"限流边界"即首个 rejection 出现的目标速率。
- 原始客户端（本程序的会话）不写 `receiverReceivedAt`/`injectedAt`（那是接收端扩展埋的），因此 broker→receiver / receiver→injected / end-to-end 指标为空是预期，端到端看 askRtt（控制器本地墙钟）。
- presence 心跳 1s；会话上限 128、未注册连接 32（`broker-server.ts` 常量）。

## 安全护栏

- broker 是全局单例（`~/.cornfield/intercom/broker.sock`），gateway 可能正扛着钉钉账号。**默认保守参数**；重度隔离压测另起一个独立 `CORNFIELD_AGENT_DIR` 的 gateway（独立 socket），把 `--out` 指过去跑。
- 结束用 Ctrl-C（走优雅收尾：停 workers、写报告）；异常退出后清理遗留 worker 进程用 `pkill -f pty-helper`。

## 排查

- `ICS_DEBUG=1` 打印环节级调试（spawn/ask/回复/节拍）
- `ICS_PTY_DUMP=/path/file` 把 worker 的 pty 输出 tee 到文件（看它启动卡在哪）
- worker 120s 没注册：先 `file` 确认二进制类型，再 `ICS_PTY_DUMP` 看启动日志