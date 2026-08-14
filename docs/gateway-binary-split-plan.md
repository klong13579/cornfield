# Gateway 二进制拆分计划

> Status: proposal awaiting approval.
> Owner: gateway-core
> Date: 2026-08-13

## 1. Background

`~/.local/bin/omp` 当前是单一二进制，包含两套逻辑：

- **coding-agent 侧**：交互式 TUI、print mode、`--mode rpc`、25+ 工具、slash commands、self-evolution
- **pi-gateway 侧**：IM 通道（DingTalk Stream）、cron scheduler、agent bridge、heartbeat、launchd plist

两者通过 `packages/coding-agent/src/commands/gateway.ts:106-525` 的 10 个 action（start/stop/status/reload/doctor/cron/service/setup/test-longtask/help/config）in-process 调用同一个 binary 内的 `Gateway` 类。gateway 进程本身就是 `omp`（`packages/coding-agent/src/commands/gateway.ts:230-235`，`packages/pi-gateway/src/service-installer.ts:264-274`）。

后果：改 `packages/coding-agent/src/**` 任意源文件 → `bun run build` 必须重启 gateway 才能生效，因为 gateway 进程就是这同一个 binary。改 DingTalk 适配器也一样要重启 agent session。

## 2. Goal

把 `~/.local/bin/omp` 拆成两个独立二进制：

- `~/.local/bin/omp` — coding-agent（TUI / print / rpc mode）
- `~/.local/bin/omp-gateway` — gateway（IM + cron + agent bridge + service installer）

两者各自独立 build、独立发布。改一个不影响另一个。`omp-gateway` 进程是真正的 daemon host，agent 子进程仍然通过 `Bun.spawn([ompPath, "--mode", "rpc"])` 启动（`packages/pi-gateway/src/agent-transport.ts:333-342`）。

## 3. Non-goals

- 不引入 hub-spoke / Cline 那种 WebSocket fan-out
- 不引入 capability broker / capability advertisement
- 不重做 RPC wire protocol 数据格式（仅加一个 `protocol_version` 握手字段）
- 不动 `~/.omp/agent/sessions/` 落盘格式
- 不动 cron / IM channel 业务逻辑
- 不并行化 CI release_binary matrix（本次先接受 5-target × 2 binary ≈ 10 分钟）

## 4. Reference architectures

业界先例已确认这种拆法是 common practice：

- **Cline**：hub-spoke 架构（`https://docs.cline.bot/sdk/architecture/hub-spoke`），singleton daemon + WebSocket + spokes。本次不做 hub-spoke，仅借鉴"agent runtime 跟 IM 集成必须分进程"的论据。
- **Claude Code bridge layer**（`https://y-agent.github.io/inside-claude-code/16-remote-runtime-bridge.html`）：31 文件专门做 IDE/IM 跨进程集成，WorkSecret 显式带 `version` 字段防契约漂移。本次借鉴其"跨进程必须有 version 握手"的做法。
- **Discordeno**（`https://discordeno.js.org/docs/architecture`）：Gateway（WebSocket 长连接）/ Bot（业务逻辑）/ Rest（HTTP）三进程分层，各自独立 restart。每个进程独立扩缩容。

本次拆分粒度对齐 Discordeno 风格：omp = 单进程 agent runtime，omp-gateway = daemon host，两者通过 stdio JSONL 跨进程通信。

## 5. Design

### 5.1 物理拆分

```
~/.local/bin/omp            ← packages/coding-agent/src/cli.ts
~/.local/bin/omp-gateway    ← packages/pi-gateway/src/cli.ts (新建)
```

`omp-gateway` 不嵌入 natives。natives 是给 agent 跑 tool 用的（grep/shell/clipboard/text），由 `omp --mode rpc` 子进程自带的 omp 提供。`omp-gateway` 自己不直接调 native。

### 5.2 ompPath 默认值

`packages/pi-gateway/src/agent-transport.ts:137` 当前注释 "default: 'omp'"，逻辑是从 PATH 找 `"omp"`。

拆完后改成：

```ts
function resolveDefaultOmpPath(): string {
  const stable = "~/.local/bin/omp";
  if (existsSync(stable)) return stable;
  return "omp"; // PATH fallback
}
```

约定：`~/.local/bin/omp` 优先。这跟 `scripts/install.sh` 的安装位置对齐。用户在 `gateway.json` 里显式配 `agent.ompPath` 的，保留尊重。

### 5.3 launchd plist

`packages/pi-gateway/src/service-installer.ts:243-274` 的 `resolveStableRuntime` / `buildServiceArgv` 改写：

- `resolveStableRuntime()` 优先返回 `~/.local/bin/omp-gateway`，找不到再找 `~/.local/bin/omp`（向后兼容过渡期，但不依赖）
- `buildServiceArgv()` 默认拼 `[omp-gateway, start, --foreground]`
- dev mode 检测逻辑不变（仍 `argv[1]` endsWith `.ts`/`.js`）
- 顶部注释从 "omp gateway start --foreground" 全面改成 "omp-gateway start --foreground"

`SERVICE_NAME = "com.narwal.pi-gateway"` 保持不变（plist 文件名兼容，单纯 argv 内容变化）。

### 5.4 跨进程 RPC 握手

`packages/pi-gateway/src/agent-transport.ts:333-342` 当前 spawn `omp --mode rpc` 后直接等 `{type: "ready"}`。改为：

1. spawn 后第一个 stdout frame 必须是 `{"type": "ready", "protocol_version": 1, "agent": "omp"}`
2. `protocol_version` 不匹配 → throw `RpcTransportError`，bridge 走 crash recovery
3. omp 端在 `--mode rpc` 启动时打印这个 frame，几乎零成本

为什么不加更重的协议版本号：99% 的改 agent 不会动 RPC frame 形状。如果将来 break，bump `protocol_version`，加 warning；这步不必现在做。

### 5.5 CLI 命令迁移

| 旧命令 | 新命令 |
|---|---|
| `omp gateway start --foreground` | `omp-gateway start --foreground` |
| `omp gateway start` | `omp-gateway start` |
| `omp gateway stop` | `omp-gateway stop` |
| `omp gateway status` | `omp-gateway status` |
| `omp gateway reload` | `omp-gateway reload` |
| `omp gateway doctor` | `omp-gateway doctor` |
| `omp gateway config` | `omp-gateway config` |
| `omp gateway cron ...` | `omp-gateway cron ...` |
| `omp gateway service ...` | `omp-gateway service ...` |
| `omp gateway setup` | `omp-gateway setup` |
| `omp gateway test-longtask` | `omp-gateway test-longtask` |
| `omp gateway help` | `omp-gateway help` |

**不保留 shim**。`omp gateway` 子命令在 omp 里直接返回 "command not found"。破坏性升级，CHANGELOG 写明。

### 5.6 安装流程

`scripts/install.sh` + `scripts/install.ps1` 改造：

- 下载两个 binary
- 装到 `~/.local/bin/omp` + `~/.local/bin/omp-gateway`
- `chmod +x` 两个

不做旧 plist 自动迁移。文档强提示重跑 `omp-gateway service install`。

## 6. File changes

### 新增（4）

1. `packages/pi-gateway/scripts/build-binary.ts` — 复用 coding-agent 同款 build 流程，entrypoint `packages/pi-gateway/src/cli.ts`，不嵌 natives
2. `packages/pi-gateway/src/cli.ts` — 命令表 entrypoint，挂 10 个 action
3. `packages/pi-gateway/src/commands/gateway.ts` — 搬 coding-agent 同名文件过来
4. `packages/pi-gateway/test/omp-gateway-cli.test.ts` — 新 binary 的 smoke 测试

### 删除（2）

5. `packages/coding-agent/src/commands/gateway.ts`（717 行）
6. `packages/coding-agent/src/cli.ts:60` gateway 那一行 load

### 改动（10）

7. `packages/pi-gateway/src/service-installer.ts` — `resolveStableRuntime` / `buildServiceArgv` 改，注释全面更新
8. `packages/pi-gateway/src/agent-transport.ts` — 新增 `protocolVersion`、`resolveDefaultOmpPath`、`#spawnAndWaitReady` 解析新字段
9. `packages/pi-gateway/src/agent-bridge.ts` — `AgentBridgeOptions` 增 `defaultOmpPath`
10. `packages/pi-gateway/src/cli.ts` — gateway config resolve 路径注入 `defaultOmpPath`
11. `packages/pi-gateway/src/types.ts` — `GatewayConfig.agent.ompPath` 解析逻辑（如果单独抽出）
12. `packages/coding-agent/src/modes/rpc/rpc.ts`（或等价文件） — `--mode rpc` ready frame 加 `protocol_version` + `agent`
13. `packages/coding-agent/scripts/build-binary.ts` — 注释更新
14. `packages/pi-gateway/src/index.ts` — 架构注释更新
15. `packages/pi-gateway/src/agent-bridge-types.ts` — 类型增 `ompPath?` 字段

### 文档 / CHANGELOG（5）

16. `AGENTS.md` — "Restart gateway" + "Build & deploy model" 段更新
17. `README.md:1186-1248` — 命令替换
18. `docs/pi-gateway-cron-host-tool.md` — 命令替换
19. `packages/coding-agent/src/skeleton/assets/.omp/SYSTEM.md:127-130` — 命令替换
20. `packages/*/CHANGELOG.md`（7 个 packages） — 各自加 Breaking Change 条目

### CI / release（3）

21. `scripts/ci-release-build-binaries.ts` — 同时 build `omp` + `omp-gateway`，每个 target 出两个 artifact
22. `scripts/install.sh` — 下载 + 安装两个 binary
23. `scripts/install.ps1` — 下载 + 安装两个 binary

## 7. PR breakdown

### PR 1 — 物理拆分 + 契约握手

- 新增 1, 2, 3, 4
- 删除 5, 6
- 改动 7-15
- 文档 20（CHANGELOG）

**验收**：

- `bun run check:ts` 全绿
- `bun run test:ts` 全绿（新增 smoke 通过）
- 本地 build：`bun --cwd=packages/coding-agent run build` + `bun --cwd=packages/pi-gateway run build`
- `~/.local/bin/omp-gateway --version` 正常
- `~/.local/bin/omp-gateway service install` 写出正确 plist（argv 含 `omp-gateway`，不含 `gateway`）
- 改 `packages/coding-agent/src/...` → 不重启 gateway，新代码生效（重启 omp 即可）
- 改 `packages/pi-gateway/src/...` → 重启 omp-gateway，agent session 不动

### PR 2 — release / install / 命令文档迁移

- 改动 16-19（命令文档）
- 改动 21-23（CI / install）

**验收**：

- `bun scripts/ci-release-build-binaries.ts --dry-run` 出 10 个 binary 路径
- release tag 跑通，`~/.local/bin/omp` 和 `~/.local/bin/omp-gateway` 都装到本地
- README / AGENTS / SYSTEM.md 命令全部替换完，无残留 `omp gateway *`
- `gitnexus detect_changes()` 改动面收敛

## 8. Risks

1. **`isGatewayProcess()` ps 检测**（`packages/pi-gateway/src/gateway-daemon.ts:67-81`）。新 binary argv 是 `[omp-gateway, start, --foreground]`，"gateway" 子串不在。需要决定：改检测逻辑（`args.includes("omp-gateway")`），还是接受 dev 模式仍检测 "gateway"（dev argv 是 `[bun, entry.ts, gateway, start, --foreground]`，"gateway" 还在）。PR 1 验收时手动验证。

2. **`installService` 的 dev mode 检测**（`service-installer.ts:222-225`）。拆完新 binary argv[1] 是空，但 `process.argv[0]` 是 `omp-gateway`。dev 跑 `bun packages/pi-gateway/src/cli.ts service install` 仍识别为 dev（argv[1] endsWith .ts）；prod 跑 `~/.local/bin/omp-gateway service install` 识别为 prod。两条路径都要测试。

3. **`OMP_GATEWAY_TEST_MODE` 注入逻辑**（`service-installer.ts:91`）。plist 字段保留，env 名不变。这条不大，但要写测试覆盖。

4. **`agent.ompPath` 改默认** — 现状默认 PATH 上 "omp"。改完默认 `~/.local/bin/omp`。在 PATH 上有 omp 的用户行为不变（按设计 install.sh 装的位置就是这里）。

5. **cross-compile 时间** — `release_binary` job 从 ~5 分钟到 ~10 分钟。本次接受，不并行化。

6. **install.sh 多平台分发** — release artifact 从 5 个变 10 个，tarball 内文件列表变了。install.sh 的 URL fetch / extract 逻辑跟着改。

7. **e2e 测试需要两个 binary** — `packages/pi-gateway/test/restart-sentinel.e2e.test.ts` 这种依赖真实 omp 二进制的测试，CI 跑前需要 install 步骤或测试 fixture 改 inline build。

8. **gitnexus detect_changes 影响面** — coding-agent cli.ts 减 1 行 + 删 1 个 717 行文件，影响面中等；service-installer.ts 改 argv 生成 + protocol_version handshake 是新代码，风险等级待跑 detect_changes 后定。

## 9. Verification checklist

完成以下才算 PR 全部完成：

1. `bun run check:ts` 全绿
2. `bun run test:ts` 全绿（含新增 smoke）
3. 本地 build 出两个 binary
4. `~/.local/bin/omp --version` + `~/.local/bin/omp-gateway --version` 都正常
5. `~/.local/bin/omp-gateway service install` 写出的 plist argv 含 `omp-gateway`
6. `~/.local/bin/omp-gateway service start` 后 `omp-gateway status` 返回 running
7. 改 coding-agent 源 → 重 build omp → 不重启 omp-gateway，新 omp 生效
8. 改 pi-gateway 源 → 重 build omp-gateway → 重启 omp-gateway，agent session 不动
9. CHANGELOG 写明 breaking，README / AGENTS / SYSTEM.md 命令全部替换
10. `gitnexus detect_changes()` 改动面收敛

## 10. Open questions

无（截至本版本）。实施中遇到的具体决策（如 `isGatewayProcess` 检测逻辑是否同步改）走 PR 1 验收时决定。