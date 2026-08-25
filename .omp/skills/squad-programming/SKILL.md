---
name: squad-programming
version: 0.3.0
description: >-
  并行编排：把一个大任务拆成 MECE 子任务，在多个 git worktree 里各起一个子
  omp 并行工作，用 intercom 主从通信做求助与进度汇报。Use when the user wants
  把任务拆开同时做、并行开发、组队编程、多开几个 agent 一起干、worktree 并行、
  任务太大需要拆解并行执行。Skip for 单文件小改动、需要手工 review 的探索性任务。
mutating: true
---

<!--
  脚本与 schema 的权威源：
  - scripts/bootstrap.ts  — 集结（建 worktree、写任务包、启动子 omp + pane 启动检查）的全部机械步骤
  - #任务包 schema        — .squad.json 的字段契约，拆解阶段产出，脚本按它执行
  用户视角的使用说明见 USAGE.md（不重复本文内容）。
  改流程时 SKILL.md 与脚本一起改；SKILL.md 是唯一事实源。
-->

# squad-programming

> **squad** — 一个父 omp 当 coordinator，N 个子 omp 在隔离 worktree 里并行，波内并行、波间串行，全部经 gate 验证后回收。

## Outcome

用户的任务被拆成 MECE 子任务，每个子任务在自己的 worktree（或只读共享区）由独立子 omp 执行；子 omp 通过 intercom 向父求助/汇报；父按任务包的 gate 验证每个子任务并把完成结果（branch + diff 摘要）**交接给用户**；合并代码进 base 由用户自己做；结束后 worktree 清理，任务包归档。

## 前置条件（不满足则 [blocked]）

| 条件 | 检查 |
|---|---|
| 在 Herdr 环境 | `test "${HERDR_ENV:-}" = 1` |
| herdr ≥ 0.8.0 | `herdr --version`（bootstrap 结集前自动校验，tab/worktree --workspace 依赖） |
| omp 可执行 | `command -v omp` 非空（bootstrap 用 omp 启 worker，不读 PI_INTERCOM_PI_BIN） |
| **模型 provider 配了 key** | `models.yml` 的 `apiKey` 引用的环境变量非空（如 `NARWAL_PLAN_API_KEY`）；list_models 目录里有 ≠ key 有 |
| intercom 在线 | `intercom({ action: "status" })` 连通 |
| 知道自己 session id | `intercom({ action: "list" })` 中自己的 id（bootstrap 传参用） |
| 仓库干净基线 | `git status` 无未提交改动（worktree 从 base 分支切出） |

## Phase 0 — 拆解（判断工作，全部由父 agent 完成）

### Step 0.1 判定任务类型与并行收益

任务类型：`code` | `test` | `docs` | `review`/`diagnose` | `research` | `mixed`。

并行收益判断：任务能拆出 ≥2 个「文件范围不重叠、或纯只读」的子任务才值得集结；否则直接单 agent 做，不要为并行而并行。

### Step 0.2 拆成 MECE 子任务

硬规则（违反 = 拆解失败，重拆）：

1. **范围不重叠** — `code`/`test`/`docs` 子任务的 scope.files 互不相交；同文件冲突 → 合并为一个子任务或重拆。
2. **顺序依赖不并行** — T2 需要 T1 的代码产物 → 合成同一执行序列（同一 worktree 接力，脚本只起一个 agent，agent 做完 T1 继续做 T2）；只有「契约式依赖」（先定接口/签名/proto 文件，双方基于契约独立开发）才允许作为 `deps` 并行。
3. **每条 acceptance 可验证** — 能跑的命令或明确产物路径；写「做好」「完成」= 失败，重写。
4. **只读子任务（review/research）isolation 用 `shared-read`** — 不建 worktree，直接并行读 repo。
5. **worktree 路径不用手写** — 自动落在父 omp cwd 下：`<父cwd>/.worktrees/<branch 去/为->`（如 `feat/t1` → `.worktrees/feat-t1`）。任务包不写 `worktree` 字段；显式覆盖仅限特殊场景（磁盘位置、非父仓库）。

### Step 0.3 生成 gate（三态，见 #gate 三态）

- `derived`（默认）：code/test 自动继承仓库验证链（`bun check`、`bun test <scope>`、lint），父补业务 acceptance（如「保持对外 API 签名不变」）。
- `explicit`：用户给了明确验收 → 原样用。
- `unknown`（推导不出「什么算好」）：`mergePolicy` 强制 `human-review`，走 #report-only 降级——标注给用户重点细审。

### Step 0.4 分配模型档位（见 #模型档位表）

按任务类型映射；`unknown` 或特殊需求可 per-subtask 覆盖 `model`/`modelTier`。编排者（父）保持当前模型不动。

**硬约束：父模型必须 >= 所有子模型的档位。**
- 父用 `narwal-plan/deepseek-v4-pro`（mid）时，子不能用 `high`（narwal-plan/glm-5.3）。
- 父用 `narwal-plan/glm-5.3`（high）时，子可以用任何档位。
- 父模型不在标准档位表（cheap/mid/high）时，假设为最高级，不拦截。
- 子模型不在标准档位表时，跳过档位比较（无法判断时不拦）。
- 集结时 `--parent-model` 传入父当前模型，脚本自动校验。

### Step 0.5 产出任务包（.squad.json）

见 #任务包 schema。任务包写入每个 worktree 的 `.squad.json`（脚本执行），父保留聚合副本到 `~/.omp/squads/<squadId>/`（不污染 repo 的 git status）；集结脚本同时在这里写 `state.json`（状态底账，父中断后用于恢复，见 #父中断恢复）。

**Completion criterion**：任务包通过 schema 校验（脚本 `bootstrap.ts --check <bundle>` 可静默校验）；每条硬规则无违反。

## Phase 1 — 集结（机械工作，交给脚本）

```bash
bun run .omp/skills/squad-programming/scripts/bootstrap.ts \
  --bundle <任务包绝对路径> \
  --parent-target <父 session 名或 id> \
  --parent-session-id <父 session id> \
  --parent-model <父当前模型> \
  [--dry-run]
```

**工作区形态（用户要求，全链验证过）**：父 omp 当前所在 workspace = 任务包 workspace（label 自动改名为 `squadId`）；每个子任务 = 一棵**任务 worktree 树节点**（`herdr worktree create --workspace <父> --label "T<n> · <title 前 18 字>"`），树节点显示名必须语义化（不能裸 T1/T2）；worker（omp）直接起在树节点的 pane 里。Spaces 面板呈现：`任务包 workspace` └─ `T1 · 任务目的` / `T2 · …` / `T3 · …`。

**依赖安装（bootstrap 自动）**：新 worktree 没有 node_modules，tsgo 的 `types: ["bun", "assets"]` 会解析失败（报「从未安装依赖」）。`bootstrap.ts` 在 `herdr worktree create` 成功后自动 `bun install`（检查 `worktreePath/node_modules`，幂等：已存在或复用已有节点则跳过；hoisted 缓存下秒级到分钟级）。不要手工补装，也不要对未装依赖的 worktree 直接开 worker。

```text
任务包 workspace（父 pane 所在，label=squadId）
├─ T1 · Artifacts 产物面板骨架   （worktree t1 · worker omp 在节点 pane）
├─ T2 · Slash 命令真源接线       （worktree t2）
└─ T3 · Queue 取消排队接线       （worktree t3）
```

脚本对每个 `isolation: "worktree"` 子任务：
1. **按任务名建 worktree** — `herdr worktree create --workspace <父ws> --branch <id小写> --base main --path .worktrees/<id小写> --label "T<n> · <title>"`。幂等：已存在则复用其 `open_workspace_id` 的 pane。**必须用 herdr worktree create**（不是 git worktree add）——它返回的展示 workspace 就是 Spaces 树的子节点（`WorkspaceInfo.worktree.is_linked_worktree`，herdr TUI 按它对主仓库下挂树）。
2. **写入该 worktree 的 `.squad.json`**（回填 parent.cwd / worktree 实值）。
3. **在树节点 pane 上起 worker** — `herdr pane run <节点pane> "bash <shell>"`，shell 内容 = `export PI_SUBAGENT_*; exec omp --model <档位模型> <brief>`。**必须 exec omp 直启**：herdr 的 agent 识别认 pane 前台进程，`script` 包装的 pane 前台是 script/bash → agents 列表永久缺位（实测）；`exec` 后前台就是 omp → 立即登记。env 注入（intercom 父 edge）走 shell export（`tab create --env` 会破坏 pane shell prompt，不用）。

`shared-read` 子任务不建 worktree：父 workspace 内 tab create + 同一 worker 启动方式。

启动后脚本自动做 **agent 登记检查**：轮询 `herdr agent list` 确认每个 pane 的 omp 已登记（默认超时 60s，`--verify-timeout <ms>` 可调），失败带 pane 快照退出码 1。确认只是同步慢可 `--skip-verify` 绕过，父用 intercom 复核。

**Completion criterion**：脚本返回每个子任务的 paneId 且 agent 登记检查通过；接下来走 #Phase 1.5 的 worker/父两层 gate。

波次调度规则（父 agent 执行）：
- 每一波 = 所有 deps 已满足的子任务；一波内并行启动，波间等待全部收尾再进下一波（barrier）。
- 并发数 ≤ `maxConcurrency`（默认 3）—— N 个 worktree 同时 build/test 会抢 CPU/磁盘；**也受模型配额约束**（同 provider 多并发会 429：见 #模型使用纪律）。
- `deps: []` 全空 → 单波纯并行；`maxConcurrency: 1` 或 deps 成链 → 纯串行。

## 模型使用纪律（实测教训）

- **选档位模型时必须确认该 provider 已配置 API key**（`models.yml` 的 `apiKey` 环境变量存在，如 `NARWAL_PLAN_API_KEY`）。`list_models` 只证明模型在目录里，**不证明 key**（实测 kimi-code/bailian 目录有模型但无 key，子 omp 直接 `No API key found for kimi-code`）。
- 多子任务并发同一 provider 会命中分钟级 TPM 配额（`429 insufficient_quota`，narwal/alibaba 都实测踩过）——降 `maxConcurrency` 或分档（mid/pro 与 cheap/flash 错峰）。
- 档位模型按子任务类别分：重实现（UI/逻辑）用 mid，轻任务（简单接线/文档）用 cheap，不一刀切。

## Phase 1.5 — 准备检查（readiness gate）

集结后**不许直接开工**。本阶段把「子 omp 正常打开 / 模型可访问 / 任务包已获取」三个前提全部验证绿灯，才进 Phase 2。三层检查：

1. **脚本层（omp 活着）** — bootstrap 启动每个子任务后自动轮询 `herdr agent list`（默认 60s，`--verify-timeout <ms>` 可调）：pane 出现在 agent 列表 = omp TUI 已上线（✓）；
   - pane 输出出现启动失败信号（`command not found` / `No such file or directory` / `Cannot find module`）→ 立即失败并给快照；
   - 超时未上线 → 打印各 pane 输出快照并以退出码 1 失败，不静默继续。确认只是 herdr 探测延迟后，可 `--skip-verify` 重跑绕过，父再用 intercom 复核。
2. **worker 层（包已读 + 模型可访问）** — 每个子 omp 开场必须先过准备检查再碰任务：读任务包 → `list_models` 核对档位模型在可用列表（不在则 `switch_model` 到档内可用模型）→ 尝试向父发一次 `[T<n>] STARTED`。STARTED ack 本身要经过一次真实 LLM 调用 —— 一次证明三件事：omp 活着、模型可访问、任务包已获取。**但 STARTED 的确认以父 ask 拉动为准**（见下方父层 pull 机制）：
   - **已知现象（实测复现）**：子进程主动 `send` 给父，在启动窗口期（首轮几十秒内）会报 `Session not found`——broker 的目标解析在子进程注册传播完成前不可用；窗口过后 send 恢复正常（批次一 T2/T3 延时消息均送达）。`ask`（父→子）不受影响，双向链路始终可靠。
   - **子侧行为**：STARTED 尝试 send 一次；报 `Session not found`/失败 → **不要重试刷屏、不要中断任务**，继续干活；收到父的 ask 确认时如实回复。终态（REVIEWING/COMPLETE/FAILED）与求助消息都在窗口期后，send 可靠送达。
3. **父层 wait-gate（pull 模式）** — 父 **不干等** STARTED 消息，主动驱动确认：① 先 `intercom({ action: "list" })` 轮询，等全部子进程登记成 `child of <父>`（注册可能晚于启动数十秒，实测）；② 注册齐全后对每个子任务 `intercom({ action: "ask", to: <子>, ... })` 拉 STARTED 确认（ask 双向始终可靠，实测 100% 成功率）；③ ask 无响应 → `herdr pane read <paneId>` 快照定位（是否在干活 / 启动报错）；④ ask 失败且 pane 死 → 才标记 `BLOCKED` 并给原因（缺模型 key / 模型名写错 / PATH 缺 omp），修复后只重集结该子任务，不整波回滚。

**Completion criterion**：每个子任务经父 ask 确认 STARTED 或明确 BLOCKED 并给出原因；全部确认才进入 Phase 2。

## Phase 2 — 执行与协作

### 子 omp 侧协议（写进启动 brief，agent 遵守）

1. **首件事读任务包** — 文件路径在启动 brief 里给出：worktree 场景为 `<cwd>/.squad.json`，shared 场景为 `/tmp/squad-<squadId>/<taskId>.squad.json`。任务、scope、gate、汇报协议、模型档位都在里面。读完立即做 #Phase 1.5 的准备检查汇报。
2. **模型核对** — 用 `list_models` 确认分配模型在可用列表；不在 → `switch_model` 切到档内可用模型，并按实际生效模型汇报（启动参数失效兜底）。
3. **只动 scope 内文件** — scope 外需要改动 → `ask` 求助父。
4. **求助** — `intercom({ action: "ask", to: <父 target>, message: "..." })` **必须带 to=父 target**。不带 to 的 ask 不会被自动路由到父：intercom 的路由优先 cwd 匹配（实测误投到同目录活跃的 aion-ui 会话），parent edge 只是次选。同时只允许一个 pending ask；求助期间不发重复 ask。
5. **状态汇报** — `intercom({ action: "send", to: <父 target>, message: "[<taskId>] <STATE>: <一句话>" })`，STATE ∈ `STARTED` / `BLOCKED` / `REVIEWING` / `COMPLETE` / `FAILED`。**STARTED = 准备检查通过**（任务包已读 + 模型已核对并生效），send 一次即可，**确认由父 ask 拉动**（见 #Phase 1.5 pull 机制）；启动窗口期 send 失败不要重试刷屏，窗口后 send 可靠（终态必达）。
6. 每回合结束自动上报（agent_end 由运行时注入，无需手动）。

### 父 agent 侧盯盘

- **健康扫描（父探活机制，防静默挂掉）** — 父不干等消息。每个工作轮次（收到消息后/间隙），对未终态子任务跑一次体检：
  ```bash
  bun run .omp/skills/squad-programming/scripts/probe.ts ~/.omp/squads/<squadId>/state.json
  ```
  状态/新鲜度**直连 intercom broker 拿**（不绕 herdr——broker 是 omp 自身状态机，herdr 只是镜像；probe 走 `~/.omp/intercom/broker.sock` 注册+list 协议，`SessionInfo.status` + `lastActivity` 即权威）：进程存活（ps 按 worktree 路径匹配 omp）→ broker 注册态（会话在否/status）→ `lastActivity` 新鲜度 + pane 错误签名（**静默挂起**：`lastActivity` 长时间不更新——模型 API 响应挂起时 pid 在、pane 有残影，但已死机，实测 187s 静默案例；`PROBE_STALL_AFTER_S` 默认 240s）。输出 `[OK]/[WARN]`，有 WARN 退出码 1。
  **WARN 处置阶梯（不直接判死）**：① 先看是否自愈——API 断连（`socket connection was closed` 等）是 provider 并发高时的常见噪声，omp 自带重试，worker 通常继续推进；② **静默挂起先用 ask 唤醒**（实测 ask 到达后 worker 立即恢复——ask 双向可靠，本身就是唤醒信号）；③ ask 无响应 + pane 无进展 → 记 `stalled` → 转用户拍板（重启该子任务 / 等 / 打回）。
- 用 `intercom({ action: "children" })` 看子 omp 实时状态，不轮询消息。
- **每条状态消息落地 state.json**（父中断恢复的底账）:
  `bun run .omp/skills/squad-programming/scripts/squad-state.ts ~/.omp/squads/<squadId>/state.json update <taskId> <status> [一句话] [--force]`
  - 转移矩阵：`assembled -> started`（正常流程），`started -> blocked / reviewing / complete / failed`，`blocked/reviewing -> started / complete / failed`。
  - 终态（`complete` / `failed`）不可逆，非法转移被拒绝。
  - `--force` 跳过转移校验，仅父中断恢复场景使用（见 #父中断恢复）。
  - 同一状态重复设置是幂等的（仅更新 timestamp）。
  收到 `[T<n>] STARTED` → `started`；`BLOCKED` → `blocked`；`REVIEWING` → `reviewing`；`COMPLETE` → 先跑 gate 验证，通过才 `complete`（否则打回）；`FAILED` → `failed`。每回合至少核对一次 state 是否跟上。
- 收到子 ask → 立即 `reply` 决策或引导；`pending` 看堆积，`reply to <taskId>` 定向回复。
- 收到 `[T<n>] BLOCKED` → 判断是缺信息（补）还是缺决策（转用户拍板，绝不代拍）。

**Completion criterion**：所有子任务达到 `COMPLETE` 或 `FAILED`（由父向每个子 omp 确认一次最终状态），且 state.json 已同步为终态。

## 父中断恢复（进程重启后接续）

父 omp 进程中断（崩溃/重启/被 kill）时，子 omp 的进程和 worktree 不受影响，但父的管辖上下文（谁 STARTED、谁卡在 ask）会丢。恢复步骤：

1. `squad-state.ts <stateFile> list` 读未终态子任务（`stateFile = ~/.omp/squads/<squadId>/state.json`，集结时自动写入；找不到就搜 `~/.omp/squads/*/state.json` 按 `createdAt` 最新的）。
2. 对每个未终态子任务，用 `intercom({ action: "children" })` + `herdr pane read <paneId>`（state 里有 paneId）复核实际状态：
   - 还活着且在干活 → 保持 `started`，询问是否需要它重新发一次最新状态；
   - 发了 COMPLETE 但父没收到 → 跑 gate 验证，过了直接标 `complete`（用 `--force` 跳过 assembled → complete 校验）；
   - pane 死了/无响应 → 标记 `failed` 并给原因（用 `--force` 跳过 assembled → failed 校验）。
3. 恢复期间对子任务补发一条确认消息（intercom send），告诉它父已回来；继续 Phase 2 盯盘。

**兜底事实**：state.json 是权威底账，intercom 消息流只是事件源；两者不一致时以 state.json + 实际 pane 复核为准。

## Phase 3 — 验收交接（skill 不合并代码）

1. **提交检查**：交接前每个子任务必须已在分支**提交**（worker 收尾铁律，见启动 brief；未提交的交付父可代提交——只在 worktree 内 add/commit 源文件，排除 .squad.json/node_modules）。提交后 `git log <base>..<branch>` 应恰好是本次交付。
2. **单任务验证**：对每个子任务在对应 worktree 跑 `gate.verifiers`（如 `bun check`、`bun test <scope>`）；失败 → 打回子 omp 修或标记 `FAILED` 上报用户。
3. **整体验证（integration worktree）— 强制门禁，≥2 个 complete 子任务时必须执行**：子任务**分开验了还不够**。任何 squad 有 ≥2 个子任务达到 complete，父**必须**把全部已完成分支合到一个 integration worktree 做合体验证——**无论子任务是否同域、文件是否相交**。判定依据不是「文件是否重叠」，而是「**合体后的产物才是交付物**」：
   - **契约式依赖也必须合体**：T1 定义类型/接口/加载逻辑，T2 消费/打包——即使各自改不同文件（单任务 gate 全绿），合体产物可能缺 T1 改动。实测案例（2026-08-21 打包 squad）：T1 改 `main.ts` 生产加载（`isPackaged → loadFile(renderer)`）、T2 改打包链路，单 worktree 验收各自通过；但打包只用 T2 worktree（不含 T1 改动）→ 产物 `main.js` 无 `isPackaged` 分支 → 装机白屏（占位页）。根因：验收没有走 integration worktree 合体。
   - **唯一豁免**：squad 只有 1 个子任务（无合体意义），或全部子任务为纯只读 research（无产物）。豁免必须能在交接清单里显式说明理由。
   - **建法（机械活交给脚本）**：
     ```bash
     bun run .omp/skills/squad-programming/scripts/integrate.ts ~/.omp/squads/<squadId>/state.json [--link-node-modules] [--dry-run]
     ```
     生成 `.worktrees/<squadId>-integ`（分支 `<squadId>-integ`，base = baseBranch）；按子任务数组序逐个 merge **status=complete** 的分支；web 类项目加 `--link-node-modules`（软链主仓库 node_modules）。纯 git worktree，**无 herdr pane/agent** —— 验证区不占子 agent。
   - **冲突处理**：merge 冲突/失败即停（不自动解决、不继续后续分支）——冲突 = 子任务边界侵入，**打回该子任务修**，不在这里打补丁；修好后 `--force` 重建 integration 重来。
   - **验证内容**：每个子任务 gate.verifiers 的并集 + 整体功能冒烟（web → `bun run dev` + 浏览器过一遍受影响页面；CLI → 冒烟命令/端到端）。
   - **打回规则**：整体验证失败 → 定位到回归/冲突的子任务打回，**不使用 integration worktree 当工作区改代码**（它是验证区，改了就没法重来）。
   - **通过** → 交接清单附 integration 分支与整体验证结果；用户 merge 正式分支后，integration worktree 与分支一并清理（见步骤 5，用户确认才删）。
4. **交接**：父 agent **不做任何 merge** —— 合并代码进 base 是用户的动作。对每个验证过的子任务整理：branch 名 + diff 摘要 + gate 结果 + 整体验证结论，逐条摆给用户；用户自己 `git merge <branch>`（或打回/丢弃）。
5. **清理**（每步单独执行、确认 JSON 返回后再下一步，**禁止串行 `&&`**）——顺序铁律：**先关 agent，再删 git worktree，最后归档**。
   - **① 关 agent（容易漏，本次实测教训）**：子任务的 agent 节点 = herdr 树 workspace（`w57`/`w5A`…），里面跑的 omp 进程**不随 `git worktree remove` 消失**——实测删完 worktree 还残留 7 个 idle omp。逐个 `herdr workspace close <nodeWorkspaceId>`（= 关 pane + 杀进程 + 注销 intercom 会话）；之后验证判据三条：`ps aux | grep "omp --model"` 无残留、`herdr workspace list` 无 linked worktree 节点、`intercom({action:"list"})` 无该 squad 的子会话。
   - **② 删 worktree + 分支**：`git worktree remove --force <worktree路径>` + `git branch -D <branch>`（用户已确认合并/丢弃）；integration worktree 同法（`.worktrees/<squadId>-integ` + `git branch -D <squadId>-integ`）。
   - **③ 归档**：任务包移到 `~/.omp/squads/archive/<squadId>/`；清 `/tmp/squad-*.json` bundle。
   - **④ 还原父 workspace 名**：`herdr workspace rename <父wsId> <原名>`（集结时被 rename 为 squadId）。

**Completion criterion**：每个子任务已验证并交接给用户（branch + 摘要）；用户确认后的分支与 worktree 清理干净；用户看到结果摘要。

**清理权限（谁不用问你，谁必须等你）**：
- 用户明确说「合并完了 / 这分支不要了」→ 父 agent 清理该子任务：**先 `herdr workspace close` 关 agent 节点**（非仅 git worktree）→ worktree/分支 → integration；
- `FAILED` 或用户还没表态 → **不得清理**：worktree/分支/agent 节点全保留（agent 还可能在等用户反馈），等用户拍板；
- pane close 只在对应子任务已终态（用户已逐条表态后）执行；只要还有待合并/待验的 worktree 在，不关 pane（防止子任务上下文和会话终端被一起回收）。

## 模型档位表

| 档位 | 默认模型 | 用途 |
|---|---|---|
| `cheap` | `narwal-plan/deepseek-v4-flash` | research / docs / test |
| `mid` | `narwal-plan/deepseek-v4-pro` | code 实现 / review |
| `high` | `narwal-plan/glm-5.3` | 重任务（复杂重构/跨模块改动），显式指定时使用 |
| 禁用 | `narwal-plan/claude-opus-*`、`claude-sonnet-*` | 默认不启用；父显式在任务包指定才用 |

档位是**单点配置**：子 omp 启动后若模型不在档位，`switch_model` 切回档内模型。禁用清单只增不减 —— 子 omp 禁止使用禁用清单内的模型，用户拍板才放行新贵档。

## 版本管理

任务包 schema 有版本号 `squadVersion`，与脚本的版本校验逻辑绑定。

| 字段 | 说明 |
|---|---|
| `squadVersion` | 任务包 schema 版本号（当前 `1`）。bootstrap 启动时校验版本匹配，不匹配则拒绝执行。 |
| `SKILL.md` frontmatter `version` | Skill 自身的发布版本（`0.3.0`）。记录流程/脚本的变更历史。 |

### 版本兼容规则

| 场景 | 行为 |
|---|---|
| `squadVersion` 未填写 | 拒绝（`bundle.squadVersion` 缺失） |
| `squadVersion` 不等于 `CURRENT_SQUAD_VERSION` | 拒绝（版本不匹配，提示当前版本号） |
| `squadVersion` 非数字 | 拒绝（`squadVersion` 必须是整数） |

### 升级流程

当任务包 schema 发生不兼容变更（新增必填字段、删除字段、修改字段语义）时：
1. 递增 `CURRENT_SQUAD_VERSION`（`bootstrap.ts` 顶部常量）
2. 更新 `validateBundle()` 中的校验逻辑
3. 更新 `SKILL.md` 中的 schema 文档
4. 旧版本任务包应被新脚本拒绝（不改旧包，显式报错让用户重产）

## Gate 三态

| 档位 | 来源 | mergePolicy（验收提示） |
|---|---|---|
| `derived` | 父按任务类型从仓库验证链自动推导（工程 gate：check/test/lint；业务 gate：父补写 acceptance） | `auto`（验证过即可交接，用户自行 merge） |
| `explicit` | 用户明确给出验收标准 | `auto` |
| `unknown` | 推导不出 | 强制 `human-review`，走 report-only |

**report-only 降级**：unknown gate 的子任务，子 omp 只分析/产出报告，不 merge、不碰共享范围；父把结果 + 关键差异摆给用户，用户验收后才进下一波。安全不靠人懂，靠护栏（不合并是默认）。

## 任务包 schema（.squad.json）

```jsonc
{
  "squadVersion": 1,                           // 任务包 schema 版本（必填，当前 1）
  "squadId": "squad-20260818-a3f2",
  "taskType": "mixed",
  "baseBranch": "main",
  "maxConcurrency": 3,
  "modelTiers": {
    "cheap": "narwal-plan/deepseek-v4-flash",
    "mid": "narwal-plan/deepseek-v4-pro",
    "high": "narwal-plan/glm-5.3",               // 重任务档位，显式指定时使用
    "banned": ["narwal-plan/claude-opus-*", "narwal-plan/claude-sonnet-*"]
  },
  "parent": { "target": "planner", "sessionId": "...", "name": "可选可读展示名" },  // cwd 可选：缺省 = bootstrap 运行目录（父 omp 会话 cwd），worktree 落 <父cwd>/.worktrees/；name 仅展示（worker brief 用），路由仍走 target
  "subtasks": [
    {
      "id": "T1",
      "title": "重构 auth 模块",
      "kind": "code",                            // code | test | docs | review | research
      "isolation": "worktree",                   // worktree | shared-read | shared-write
      "scope": { "files": ["packages/foo/src/auth/**"] },
      "deps": [],                                // 契约式依赖才允许；空 = 可并行
      "acceptance": "可验证的描述或命令",
      "gate": {
        "kind": "derived",                       // derived | explicit | unknown
        "verifiers": ["bun check", "bun test packages/foo"],
        "acceptance": "保持对外 API 签名不变",
        "mergePolicy": "auto"                    // 仅验收提示（skill 不自动 merge）：unknown 时强制 human-review
      },
      "modelTier": "mid",                        // cheap | mid | high，或 "model": "<provider>/<id>"
     "branch": "feat/t1",                       // worktree 目录按此自动推导（<父cwd>/.worktrees/feat-t1）
     "worktree": "/path/to/repo/.worktrees/t1"  // 可选：省略则自动落在 <父cwd>/.worktrees/<branch 去/为->；仅特殊场景显式覆盖
      "budgetTokens": 200000                     // 可选：超预算强制上报父
    }
  ],
  "reportProtocol": { "status": "send", "ask": "ask-without-to" }
}
```

## worker 启动指令模板（Phase 1 传给子 omp 的开场）

```
你是 <taskId>（<title>）的实现者，属于 squad <squadId> 的 worker。
第一步（准备检查）：读启动 brief 里给出的任务包路径（worktree 场景 = 当前目录 .squad.json，
shared 场景 = /tmp 绝对路径），完整理解任务、scope、gate、汇报协议、模型档位；
用 list_models 确认分配模型在可用列表（不在则 switch_model 到档内模型并汇报实际生效模型）；
然后立刻向父发 "[<taskId>] STARTED: <实际生效模型>，任务包已读"；
【硬约束】收到父的开工确认（parent ask 回复「GO」或「开工」）前不得开始实现，只做准备检查。父等全部 STARTED 后才统一发开工确认。
规则：只改 scope 内文件；求助必须用 intercom ask 且带 to=<parent.target>（不带 to 会被按 cwd 路由到同目录其他会话，收不到）；状态用 intercom send 给
<parent.target>，格式 "[<taskId>] <STATE>: 一句话"（STATE ∈ STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED）。
完成标准即 .squad.json 中 acceptance。开始。
```

## 反模式

- **顺序依赖拆并行** — T2 靠 T1 产物仍拆两个并行 worktree → 合并冲突/串内容；正确做法：同一 worktree 接力。
- **unknown gate 还 auto merge** — 推导不出验收标准就自动放行 = 帮你做决定；必须 human-review。
- **为并行而并行** — 单一连续任务硬拆成 N 个子任务，集结/回收开销大于收益。
- **贵模型默认跑** — 子 omp 没显式指定模型就随缘；必须按档位表赋值。
- **父 agent 代拍板** — gate 未知或产品类验收，父只整理摘要，决策权交回用户。
- **worktree 用 git worktree add 绕过 herdr** — 不产生树节点（Spaces 面板挂不上）；必须 `herdr worktree create`。
- **script -q 包装启动 omp** — pane 前台进程是 script/bash，herdr agent 识别缺位（agents 列表看不到）；必须 `exec omp` 直启。
- **拿单 worktree 产物当整体验收**（2026-08-21 实测）— 契约式依赖（T1 改接口/加载逻辑、T2 消费/打包）下，子任务文件不相交、单任务 gate 全绿，就跳过 integration 合体直接拿其中一个 worktree 的构建/打包产物验收 → 产物缺另一半改动，装机才暴露（实测：T2 worktree 打包缺 T1 的 `main.ts isPackaged` 分支 → 白屏）。**≥2 个 complete 子任务必须走 integrate.ts 合体验证，产物以合体后为准**。
- **intercom ask 不带 to** — 按 cwd 优先路由，实测误投同目录活跃的其他会话（aion-ui）；ask 必须显式 to=父。
- **agent.start 启动 omp** — agent_pane_busy / timeout / 名字不登记（本环境 5 轮反复失败）；pane run + exec omp 稳定。