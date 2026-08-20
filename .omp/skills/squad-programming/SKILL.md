---
name: squad-programming
version: 0.2.0
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

### Step 0.5 产出任务包（.squad.json）

见 #任务包 schema。任务包写入每个 worktree 的 `.squad.json`（脚本执行），父保留聚合副本到 `~/.omp/squads/<squadId>/`（不污染 repo 的 git status）；集结脚本同时在这里写 `state.json`（状态底账，父中断后用于恢复，见 #父中断恢复）。

**Completion criterion**：任务包通过 schema 校验（脚本 `bootstrap.ts --check <bundle>` 可静默校验）；每条硬规则无违反。

## Phase 1 — 集结（机械工作，交给脚本）

```bash
bun run .omp/skills/squad-programming/scripts/bootstrap.ts \
  --bundle <任务包绝对路径> \
  --parent-target <父 session 名或 id> \
  --parent-session-id <父 session id> \
  [--dry-run]
```

**工作区形态（用户要求，全链验证过）**：父 omp 当前所在 workspace = 任务包 workspace（label 自动改名为 `squadId`）；每个子任务 = 一棵**任务 worktree 树节点**（`herdr worktree create --workspace <父> --label "T<n> · <title 前 18 字>"`），树节点显示名必须语义化（不能裸 T1/T2）；worker（omp）直接起在树节点的 pane 里。Spaces 面板呈现：`任务包 workspace` └─ `T1 · 任务目的` / `T2 · …` / `T3 · …`。

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
2. **worker 层（包已读 + 模型可访问）** — 每个子 omp 开场必须先过准备检查再碰任务：读任务包 → `list_models` 核对档位模型在可用列表（不在则 `switch_model` 到档内可用模型）→ 向父发 `[T<n>] STARTED: <实际生效模型>，任务包已读`。  STARTED ack 本身要经过一次真实 LLM 调用 —— 一次证明三件事：omp 活着、模型可访问、任务包已获取。
   - **STARTED 送达协议（时序问题的修复）**：子进程的 intercom 注册（连 broker + 登记自身 + 父 edge）**晚于 TUI 上线和首个 LLM 回合**（实测：flash 模型首答快，发 STARTED 时桥还没注册完，父明明在线却报 `Session not found`）。所以：① 发送前先 `intercom({ action: "status" })` 自检 Connected；② 失败/`Session not found` → 过 5s/10s/15s 退避重试 ≤3 次（这是正常启动延时，不是掉线）；③ 仍失败不阻塞任务，继续推进，后续状态消息补发；**任何终态（REVIEWING/COMPLETE/FAILED）必须送达**（同重试规则）。父以收到的最新状态消息为准（COMPLETE 蕴含包已读+模型生效）。
3. **父层 wait-gate** — 父等全部子任务的 STARTED（默认超时 90s）。**超时不能直接判 BLOCKED** —— 子可能在 intercom 注册未完成的状态下發了 STARTED，消息其实坏了。硬步骤：① 先 `intercom({ action: "list" })` 轮询，等全部子进程登记成 `child of <父>`（注册可能晚于 STARTED 数十秒，实测）；② 注册齐全后再等一轮 ack；③ 仍无 → 对该子任务 `herdr pane read` 快照（看是否已按送达协议重试、是否在干活）+ try `intercom ask` 主动拉 ack（带 to）；④ ask 也失败（Session not found 且 list 无此子）→ 才标记 `BLOCKED` 并给原因（缺模型 key / 模型名写错 / PATH 缺 omp），修复后只重集结该子任务，不整波回滚。

**Completion criterion**：每个子任务已发 STARTED 或明确 BLOCKED 并给出原因；全部 STARTED 才进入 Phase 2。

## Phase 2 — 执行与协作

### 子 omp 侧协议（写进启动 brief，agent 遵守）

1. **首件事读任务包** — 文件路径在启动 brief 里给出：worktree 场景为 `<cwd>/.squad.json`，shared 场景为 `/tmp/squad-<squadId>/<taskId>.squad.json`。任务、scope、gate、汇报协议、模型档位都在里面。读完立即做 #Phase 1.5 的准备检查汇报。
2. **模型核对** — 用 `list_models` 确认分配模型在可用列表；不在 → `switch_model` 切到档内可用模型，并按实际生效模型汇报（启动参数失效兜底）。
3. **只动 scope 内文件** — scope 外需要改动 → `ask` 求助父。
4. **求助** — `intercom({ action: "ask", to: <父 target>, message: "..." })` **必须带 to=父 target**。不带 to 的 ask 不会被自动路由到父：intercom 的路由优先 cwd 匹配（实测误投到同目录活跃的 aion-ui 会话），parent edge 只是次选。同时只允许一个 pending ask；求助期间不发重复 ask。
5. **状态汇报** — `intercom({ action: "send", to: <父 target>, message: "[<taskId>] <STATE>: <一句话>" })`，STATE ∈ `STARTED` / `BLOCKED` / `REVIEWING` / `COMPLETE` / `FAILED`。**STARTED = 准备检查通过**（任务包已读 + 模型已核对并生效），只发一次，父以全部 STARTED 作为 Phase 2 的闸门。发送遵循 #Phase 1.5 的**送达协议**：status 自检 → 失败退避重试（5s/10s/15s）→ 仍失败继续任务、后续补发，终态必达；父以收到的最新状态为准。
6. 每回合结束自动上报（agent_end 由运行时注入，无需手动）。

### 父 agent 侧盯盘

- 用 `intercom({ action: "children" })` 看子 omp 实时状态，不轮询消息。
- **每条状态消息落地 state.json**（父中断恢复的底账）：
  `bun run .omp/skills/squad-programming/scripts/squad-state.ts ~/.omp/squads/<squadId>/state.json update <taskId> <status> [一句话]`
  收到 `[T<n>] STARTED` → `started`；`BLOCKED` → `blocked`；`REVIEWING` → `reviewing`；`COMPLETE` → 先跑 gate 验证，通过才 `complete`（否则打回）；`FAILED` → `failed`。每回合至少核对一次 state 是否跟上。
- 收到子 ask → 立即 `reply` 决策或引导；`pending` 看堆积，`reply to <taskId>` 定向回复。
- 收到 `[T<n>] BLOCKED` → 判断是缺信息（补）还是缺决策（转用户拍板，绝不代拍）。

**Completion criterion**：所有子任务达到 `COMPLETE` 或 `FAILED`（由父向每个子 omp 确认一次最终状态），且 state.json 已同步为终态。

## 父中断恢复（进程重启后接续）

父 omp 进程中断（崩溃/重启/被 kill）时，子 omp 的进程和 worktree 不受影响，但父的管辖上下文（谁 STARTED、谁卡在 ask）会丢。恢复步骤：

1. `squad-state.ts <stateFile> list` 读未终态子任务（`stateFile = ~/.omp/squads/<squadId>/state.json`，集结时自动写入；找不到就搜 `~/.omp/squads/*/state.json` 按 `createdAt` 最新的）。
2. 对每个未终态子任务，用 `intercom({ action: "children" })` + `herdr pane read <paneId>`（state 里有 paneId）复核实际状态：
   - 还活着且在干活 → 保持 `started`，询问是否需要它重新发一次最新状态；
   - 发了 COMPLETE 但父没收到 → 跑 gate 验证，过了直接标 `complete`；
   - pane 死了/无响应 → 标记 `failed` 并给原因。
3. 恢复期间对子任务补发一条确认消息（intercom send），告诉它父已回来；继续 Phase 2 盯盘。

**兜底事实**：state.json 是权威底账，intercom 消息流只是事件源；两者不一致时以 state.json + 实际 pane 复核为准。

## Phase 3 — 验收交接（skill 不合并代码）

1. **验证**：对每个子任务在对应 worktree 跑 `gate.verifiers`（如 `bun check`、`bun test <scope>`）；失败 → 打回子 omp 修或标记 `FAILED` 上报用户。
2. **交接**：父 agent **不做任何 merge** —— 合并代码进 base 是用户的动作。对每个验证过的子任务整理：branch 名 + diff 摘要 + gate 结果，逐条摆给用户；用户自己 `git merge <branch>`（或打回/丢弃）。
3. **清理**（每步单独执行、确认 JSON 返回后再下一步，**禁止串行 `&&`**）：
   - 用户确认过了某个子任务的分支（合并完或拍板丢弃） → `git branch -D <branch>` + `git worktree remove --force <worktree路径>`；
   - `herdr pane close <paneId>` 逐个关掉子任务 pane（paneId 在 state.json / 集结输出里）；
   - 归档任务包从 `~/.omp/squads/<squadId>/` 移入 `archive/`。

**Completion criterion**：每个子任务已验证并交接给用户（branch + 摘要）；用户确认后的分支与 worktree 清理干净；用户看到结果摘要。

**清理权限（谁不用问你，谁必须等你）**：
- 用户明确说「合并完了 / 这分支不要了」→ 父 agent 清理该子任务的 worktree/分支；
- `FAILED` 或用户还没表态 → **不得清理**：worktree/分支保留，等用户拍板；
- pane close 只在对应子任务已终态（用户已逐条表态后）执行；只要还有待合并/待验的 worktree 在，不关 pane（防止子任务上下文和会话终端被一起回收）。

## 模型档位表

| 档位 | 默认模型 | 用途 |
|---|---|---|
| `cheap` | `narwal-plan/deepseek-v4-flash` | research / docs / test |
| `mid` | `narwal-plan/deepseek-v4-pro` | code 实现 / review |
| 禁用 | `narwal-plan/claude-opus-*`、`claude-sonnet-*` | 默认不启用；父显式在任务包指定才用 |

档位是**单点配置**：子 omp 启动后若模型不在档位，`switch_model` 切回档内模型。禁用清单只增不减 —— 子 omp 禁止使用禁用清单内的模型，用户拍板才放行新贵档。

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
  "squadId": "squad-20260818-a3f2",
  "taskType": "mixed",
  "baseBranch": "main",
  "maxConcurrency": 3,
  "modelTiers": {
    "cheap": "narwal-plan/deepseek-v4-flash",
    "mid": "narwal-plan/deepseek-v4-pro",
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
      "modelTier": "mid",                        // cheap | mid，或 "model": "<provider>/<id>"
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
然后立刻向父发 "[<taskId>] STARTED: <实际生效模型>，任务包已读" —— 父等全部 STARTED 才正式开工。
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
- **intercom ask 不带 to** — 按 cwd 优先路由，实测误投同目录活跃的其他会话（aion-ui）；ask 必须显式 to=父。
- **agent.start 启动 omp** — agent_pane_busy / timeout / 名字不登记（本环境 5 轮反复失败）；pane run + exec omp 稳定。