# Gateway 二进制拆分计划

> Status: approved 2026-08-15 — implementation on feat/gateway-binary-split.
> Owner: gateway-core
> Date: 2026-08-13
>
> Review amendments (2026-08-15): hard cutover — legacy `omp` is NOT
> backward-compatible at the RPC handshake, `resolveStableRuntime` has no
> `omp` fallback. Sections 5.2/5.3/5.4 reflect the approved design.

## 1. Background

`~/.local/bin/omp` 当前是单一二进制，包含两套逻辑：

- **coding-agent 侧**：交互式 TUI、print mode、`--mode rpc`、25+ 工具、slash commands、self-evolution
- **omp-gateway 侧**：IM 通道（DingTalk Stream）、cron scheduler、agent bridge、heartbeat、launchd plist

两者通过 `packages/coding-agent/src/commands/gateway.ts:106-525` 的 10 个 action（start/stop/status/reload/doctor/cron/service/setup/test-longtask/help/config）in-process 调用同一个 binary 内的 `Gateway` 类。gateway 进程本身就是 `omp`（`packages/coding-agent/src/commands/gateway.ts:230-235`，`packages/omp-gateway/src/service-installer.ts:264-274`）。

后果：改 `packages/coding-agent/src/**` 任意源文件 → `bun run build` 必须重启 gateway 才能生效，因为 gateway 进程就是这同一个 binary。改 DingTalk 适配器也一样要重启 agent session。

## 2. Goal

把 `~/.local/bin/omp` 拆成两个独立二进制：

- `~/.local/bin/omp` — coding-agent（TUI / print / rpc mode）
- `~/.local/bin/omp-gateway` — gateway（IM + cron + agent bridge + service installer）

两者各自独立 build、独立发布。改一个不影响另一个。`omp-gateway` 进程是真正的 daemon host，agent 子进程仍然通过 `Bun.spawn([ompPath, "--mode", "rpc"])` 启动（`packages/omp-gateway/src/agent-transport.ts:333-342`）。

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
~/.local/bin/omp-gateway    ← packages/omp-gateway/src/cli.ts (新建)
```

`omp-gateway` 不嵌入 natives。natives 是给 agent 跑 tool 用的（grep/shell/clipboard/text），由 `omp --mode rpc` 子进程自带的 omp 提供。`omp-gateway` 自己不直接调 native。

### 5.2 ompPath 默认值

`packages/omp-gateway/src/agent-transport.ts` 当前注释 "default: 'omp'"，逻辑是从 PATH 找 `"omp"`。

拆完后：

- `agent-transport.ts` 导出 `resolveDefaultOmpPath()`：`~/.local/bin/omp` 存在且可执行（X_OK）→ 返回它；否则返回 `"omp"`（PATH fallback，dev 环境用）
- `config.ts` 的 `DEFAULT_CONFIG.agent.ompPath` 硬默认 `"omp"` 删除——未配置时保持 `undefined`，由消费点统一 fallback，避免硬默认遮蔽 stable-path 逻辑
- 消费点（3 处）全部 `?? resolveDefaultOmpPath()`：`RpcTransport.#spawnAndWaitReady`、`doctor.ts`、`gateway-cron-lifecycle.ts`

约定：`~/.local/bin/omp` 优先。这跟 `scripts/install.sh` 的安装位置对齐。用户在 `gateway.json` 里显式配 `agent.ompPath` 的，保留尊重（优先级最高）。

### 5.3 launchd plist

`packages/omp-gateway/src/service-installer.ts` 的 `resolveStableRuntime` / `buildServiceArgv` 改写：

- `resolveStableRuntime()` 只认 `~/.local/bin/omp-gateway`（存在且可执行）。**不 fallback 到 `~/.local/bin/omp`**——硬切：`omp` 是 agent runtime，不能当 daemon host。找不到返回 null，走 dev/prod 检测
- `buildServiceArgv()` 拼 `[omp-gateway, start, --foreground]` / dev `[bun, entry.ts, start, --foreground]` / prod `[binary, start, --foreground]`（root 子命令，无 `gateway` 中间层）
- dev mode 检测逻辑不变（仍 `argv[1]` endsWith `.ts`/`.js`；prod 时 argv[1] 是子命令名如 `"service"`）
- 顶部注释从 "omp gateway start --foreground" 全面改成 "omp-gateway start --foreground"

`SERVICE_NAME = "com.narwal.pi-gateway"` 保持不变（plist 文件名兼容，单纯 argv 内容变化）。

### 5.4 跨进程 RPC 握手

`packages/omp-gateway/src/agent-transport.ts` 当前 spawn `omp --mode rpc` 后直接等 `{type: "ready"}`。改为：

1. spawn 后第一个 stdout frame 必须是 `{"type": "ready", "protocol_version": 1, "agent": "omp"}`
2. **硬切（harden 不兼容 legacy）**：`protocol_version` 缺失（旧 omp）或 ≠ 1 → kill 子进程 + `start()` reject `RpcTransportError`，错误信息直接说人话（"Agent RPC handshake failed ... Upgrade omp"），bridge 走 crash recovery（有 maxCrashRetries 上限，不会无限 crash loop）
3. omp 端在 `--mode rpc` 启动时打印这个 frame，几乎零成本

升级顺序无约束（配套发布，正常路径不触发）：

| omp \ omp-gateway | 旧 gateway | 新 gateway |
|---|---|---|
| 旧 omp（无 protocol_version） | 照旧 | 握手 reject + 明确升级指引 |
| 新 omp（v1） | 天然兼容（旧 transport 忽略多余字段） | v1 接受 |

为什么不加更重的协议版本号：99% 的改 agent 不会动 RPC frame 形状。如果将来 break，bump `RPC_PROTOCOL_VERSION`（transport 侧常量，rpc-mode.ts 同值），旧 omp 被直接拒、用户升级 omp 即恢复；这步不必现在做。

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

1. `packages/omp-gateway/scripts/build-binary.ts` — 复用 coding-agent 同款 build 流程，entrypoint `packages/omp-gateway/src/cli.ts`，不嵌 natives
2. `packages/omp-gateway/src/cli.ts` — 命令表 entrypoint，挂 10 个 action
3. `packages/omp-gateway/src/commands/gateway.ts` — 搬 coding-agent 同名文件过来
4. `packages/omp-gateway/test/omp-gateway-cli.test.ts` — 新 binary 的 smoke 测试

### 删除（2）

5. `packages/coding-agent/src/commands/gateway.ts`（717 行）
6. `packages/coding-agent/src/cli.ts:60` gateway 那一行 load

### 改动（10）

7. `packages/omp-gateway/src/service-installer.ts` — `resolveStableRuntime`（只认 omp-gateway）/ `buildServiceArgv` 改，注释全面更新
8. `packages/omp-gateway/src/agent-transport.ts` — 新增 `RPC_PROTOCOL_VERSION`、`resolveDefaultOmpPath`、ready 握手硬校验
9. `packages/omp-gateway/src/config.ts` — `DEFAULT_CONFIG.agent.ompPath` 硬默认删除（未配置保持 undefined）
10. `packages/omp-gateway/src/doctor.ts` + `gateway-cron-lifecycle.ts` — `?? resolveDefaultOmpPath()` 统一 fallback（原计划 9/10/11 的 ompPath 解析冗余合并到此处：AgentBridgeOptions.ompPath 已存在，默认在 transport 层解析，不新增 defaultOmpPath 字段）
11. `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — `--mode rpc` ready frame 加 `protocol_version` + `agent`
12. `packages/coding-agent/scripts/build-binary.ts` — 注释更新（omp = agent runtime half）
13. `packages/omp-gateway/src/index.ts` — 架构注释更新
14. `packages/omp-gateway/package.json` — `build` script（打包 omp-gateway）、`start` 指向自包 cli.ts

### 文档 / CHANGELOG（5）

16. `AGENTS.md` — "Restart gateway" + "Build & deploy model" 段更新
17. `README.md:1186-1248` — 命令替换
18. `docs/omp-gateway-cron-host-tool.md` — 命令替换
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
- 本地 build：`bun --cwd=packages/coding-agent run build` + `bun --cwd=packages/omp-gateway run build`
- `~/.local/bin/omp-gateway --version` 正常
- `~/.local/bin/omp-gateway service install` 写出正确 plist（argv 含 `omp-gateway`，不含 `gateway`）
- 改 `packages/coding-agent/src/...` → 不重启 gateway，新代码生效（重启 omp 即可）
- 改 `packages/omp-gateway/src/...` → 重启 omp-gateway，agent session 不动

### PR 2 — release / install / 命令文档迁移

- 改动 16-19（命令文档）
- 改动 21-23（CI / install）

**验收**：

- `bun scripts/ci-release-build-binaries.ts --dry-run` 出 10 个 binary 路径
- release tag 跑通，`~/.local/bin/omp` 和 `~/.local/bin/omp-gateway` 都装到本地
- README / AGENTS / SYSTEM.md 命令全部替换完，无残留 `omp gateway *`
- `gitnexus detect_changes()` 改动面收敛

## 8. Risks

1. **`isGatewayProcess()` ps 检测**（`packages/omp-gateway/src/gateway-daemon.ts`）。新 binary argv 是 `[omp-gateway, start, --foreground]`，但 `"omp-gateway"`/`"packages/omp-gateway"` 都含 `"gateway"` 子串，现逻辑 `args.includes("gateway") && includes("--foreground")` 对旧 prod / 新 prod / 新 dev 三种 argv 形状全部命中——**实现零改动**，PR 1 补单元测试锁三种形状。

2. **`installService` 的 dev mode 检测**（`service-installer.ts`）。拆完新 binary argv[1] 是子命令名（"service"/"start"/…），不 endsWith .ts/.js → prod；dev 跑 `bun packages/omp-gateway/src/cli.ts service install` argv[1] endsWith .ts → dev。检测逻辑不变，两条路径都要测试。

3. **`OMP_GATEWAY_TEST_MODE` 注入逻辑**（`service-installer.ts:91`）。plist 字段保留，env 名不变。这条不大，但要写测试覆盖。

4. **`agent.ompPath` 改默认** — 现状默认 PATH 上 "omp"。改完默认 `~/.local/bin/omp`。在 PATH 上有 omp 的用户行为不变（按设计 install.sh 装的位置就是这里）。

5. **cross-compile 时间** — `release_binary` job 从 ~5 分钟到 ~10 分钟。本次接受，不并行化。

6. **install.sh 多平台分发** — release artifact 从 5 个变 10 个，tarball 内文件列表变了。install.sh 的 URL fetch / extract 逻辑跟着改。

7. **e2e 测试需要两个 binary** — `real-omp-model-hotswap.test.ts`（唯一依赖真实 omp 的测试，ompPath "omp" PATH 查找）拆完行为不变。新增握手互操作验证：fixture helper 指向两个 dev build 产物，CI 前置 build。restart-sentinel.e2e 用的是 fake RPC script，不依赖真实 binary（原计划引用有误）。

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
8. 改 omp-gateway 源 → 重 build omp-gateway → 重启 omp-gateway，agent session 不动
9. CHANGELOG 写明 breaking，README / AGENTS / SYSTEM.md 命令全部替换
10. `gitnexus detect_changes()` 改动面收敛

## 10. Open questions

无（截至本版本）。实施中遇到的具体决策（如 `isGatewayProcess` 检测逻辑是否同步改）走 PR 1 验收时决定。