---
name: squad-programming
version: 0.1.0
description: >-
  并行编排：把一个大任务拆成 MECE 子任务，在多个 git worktree 里各起一个子
  omp 并行工作，用 intercom 主从通信做求助与进度汇报。Use when the user wants
  把任务拆开同时做、并行开发、组队编程、多开几个 agent 一起干、worktree 并行、
  任务太大需要拆解并行执行。Skip for 单文件小改动、需要手工 review 的探索性任务。
mutating: true
---

<!--
  脚本与 schema 的权威源：
  - scripts/bootstrap.ts  — 集结（建 worktree、写任务包、启动子 omp）的全部机械步骤
  - #任务包 schema        — .squad.json 的字段契约，拆解阶段产出，脚本按它执行
  用户视角的使用说明见 USAGE.md（不重复本文内容）。
  改流程时 SKILL.md 与脚本一起改；SKILL.md 是唯一事实源。
-->

# squad-programming

> **squad** — 一个父 omp 当 coordinator，N 个子 omp 在隔离 worktree 里并行，波内并行、波间串行，全部经 gate 验证后回收。

## Outcome

用户的任务被拆成 MECE 子任务，每个子任务在自己的 worktree（或只读共享区）由独立子 omp 执行；子 omp 通过 intercom 向父求助/汇报；父按任务包的 gate 验证每个子任务，按 mergePolicy 合并或交人类验收；结束后 worktree 清理，任务包归档。

## 前置条件（不满足则 [blocked]）

| 条件 | 检查 |
|---|---|
| 在 Herdr 环境 | `test "${HERDR_ENV:-}" = 1` |
| herdr 可用 | `herdr worktree list` 能返回 JSON |
| pi 可执行 | `command -v pi` 非空 |
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

### Step 0.3 生成 gate（三态，见 #gate 三态）

- `derived`（默认）：code/test 自动继承仓库验证链（`bun check`、`bun test <scope>`、lint），父补业务 acceptance（如「保持对外 API 签名不变」）。
- `explicit`：用户给了明确验收 → 原样用。
- `unknown`（推导不出「什么算好」）：`mergePolicy` 强制 `human-review`，走 #report-only 降级，永不自动合并。

### Step 0.4 分配模型档位（见 #模型档位表）

按任务类型映射；`unknown` 或特殊需求可 per-subtask 覆盖 `model`/`modelTier`。编排者（父）保持当前模型不动。

### Step 0.5 产出任务包（.squad.json）

见 #任务包 schema。任务包写入每个 worktree 的 `.squad.json`（脚本执行），父保留聚合副本到 `~/.omp/squads/<squadId>/`（不污染 repo 的 git status）。

**Completion criterion**：任务包通过 schema 校验（脚本 `bootstrap.ts --check <bundle>` 可静默校验）；每条硬规则无违反。

## Phase 1 — 集结（机械工作，交给脚本）

```bash
bun run .omp/skills/squad-programming/scripts/bootstrap.ts \
  --bundle <任务包绝对路径> \
  --parent-target <父 session 名或 id> \
  --parent-session-id <父 session id> \
  [--dry-run]
```

脚本对每个 `isolation: "worktree"` 子任务：建 worktree（herdr）→ 写入该 worktree 的 `.squad.json` → split pane → `pane run` 注入 `PI_SUBAGENT_*` env（注册父 edge）+ `--model <档位模型>` 启动子 omp。`shared-read` 子任务不建 worktree，cwd 用 repo 根。

**Completion criterion**：脚本返回每个子任务的 paneId；`intercom({ action: "children" })` 能看到所有子 omp 上线（或少量已注册）。

波次调度规则（父 agent 执行）：
- 每一波 = 所有 deps 已满足的子任务；一波内并行启动，波间等待全部收尾再进下一波（barrier）。
- 并发数 ≤ `maxConcurrency`（默认 3）—— N 个 worktree 同时 build/test 会抢 CPU/磁盘。
- `deps: []` 全空 → 单波纯并行；`maxConcurrency: 1` 或 deps 成链 → 纯串行。

## Phase 2 — 执行与协作

### 子 omp 侧协议（写进启动 brief，agent 遵守）

1. **首件事读任务包** — 文件路径在启动 brief 里给出：worktree 场景为 `<cwd>/.squad.json`，shared 场景为 `/tmp/squad-<squadId>/<taskId>.squad.json`。任务、scope、gate、汇报协议、模型档位都在里面。
2. **模型核对** — 当前模型不在任务包的 `modelTier` 档位内 → 先 `switch_model` 切过去（启动参数失效兜底）。
3. **只动 scope 内文件** — scope 外需要改动 → `ask` 求助父。
4. **求助** — `intercom({ action: "ask", message: "..." })` **不带 to**（自动路由到父）。同时只允许一个 pending ask；求助期间不发重复 ask。
5. **状态汇报** — `intercom({ action: "send", to: <父 target>, message: "[<taskId>] <STATE>: <一句话>" })`，STATE ∈ `STARTED` / `BLOCKED` / `REVIEWING` / `COMPLETE` / `FAILED`。
6. 每回合结束自动上报（agent_end 由运行时注入，无需手动）。

### 父 agent 侧盯盘

- 用 `intercom({ action: "children" })` 看子 omp 实时状态，不轮询消息。
- 收到子 ask → 立即 `reply` 决策或引导；`pending` 看堆积，`reply to <taskId>` 定向回复。
- 收到 `[T<n>] BLOCKED` → 判断是缺信息（补）还是缺决策（转用户拍板，绝不代拍）。

**Completion criterion**：所有子任务达到 `COMPLETE` 或 `FAILED`（由父向每个子 omp 确认一次最终状态）。

## Phase 3 — 回收

1. **验证**：对每个子任务在对应 worktree 跑 `gate.verifiers`（如 `bun check`、`bun test <scope>`）；失败 → 打回子 omp 修或标记 `FAILED` 上报用户。
2. **合并**：
   - `mergePolicy: "auto"` 且验证全过 → 合并到 base 分支（`git merge <branch>`），跑一次集成 `bun check`。
   - `mergePolicy: "human-review"`（gate `unknown` 或产品/业务验收）→ **不合并**，整理 diff 摘要 + gate 分析给用户验收，用户点头才合。
3. **清理**：`herdr worktree remove <path>`（或 `git worktree remove`）；归档任务包从 `~/.omp/squads/<squadId>/` 移入 `archive/`。

**Completion criterion**：每个子任务处于「已合并」或「等待人验收」之一；worktree 全部清理；用户看到结果摘要。

## 模型档位表

| 档位 | 默认模型 | 用途 |
|---|---|---|
| `cheap` | `narwal-plan/deepseek-v4-flash` | research / docs / test |
| `mid` | `narwal-plan/deepseek-v4-pro` | code 实现 / review |
| 禁用 | `narwal-plan/claude-opus-*`、`claude-sonnet-*` | 默认不启用；父显式在任务包指定才用 |

档位是**单点配置**：子 omp 启动后若模型不在档位，`switch_model` 切回档内模型。禁用清单只增不减 —— 子 omp 禁止使用禁用清单内的模型，用户拍板才放行新贵档。

## Gate 三态

| 档位 | 来源 | mergePolicy |
|---|---|---|
| `derived` | 父按任务类型从仓库验证链自动推导（工程 gate：check/test/lint；业务 gate：父补写 acceptance） | `auto` |
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
  "parent": { "target": "planner", "sessionId": "...", "cwd": "/path/to/repo" },
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
        "mergePolicy": "auto"                    // unknown 时强制 human-review
      },
      "modelTier": "mid",                        // cheap | mid，或 "model": "<provider>/<id>"
      "branch": "feat/t1",
      "worktree": "/path/to/repo/.worktrees/t1",
      "budgetTokens": 200000                     // 可选：超预算强制上报父
    }
  ],
  "reportProtocol": { "status": "send", "ask": "ask-without-to" }
}
```

## worker 启动指令模板（Phase 1 传给子 omp 的开场）

```
你是 <taskId>（<title>）的实现者，属于 squad <squadId> 的 worker。
第一步：读启动 brief 里给出的任务包路径（worktree 场景 = 当前目录 .squad.json，
shared 场景 = /tmp 绝对路径），完整理解任务、scope、gate、汇报协议、模型档位。
规则：模型不在档位内先 switch_model；只改 scope 内文件；求助用 intercom ask（不带 to，
自动路由父）；状态用 intercom send 给 <parent.target>，格式 "[<taskId>] <STATE>: 一句话"。
完成标准即 .squad.json 中 acceptance。开始。
```

## 反模式

- **顺序依赖拆并行** — T2 靠 T1 产物仍拆两个并行 worktree → 合并冲突/串内容；正确做法：同一 worktree 接力。
- **unknown gate 还 auto merge** — 推导不出验收标准就自动放行 = 帮你做决定；必须 human-review。
- **为并行而并行** — 单一连续任务硬拆成 N 个子任务，集结/回收开销大于收益。
- **贵模型默认跑** — 子 omp 没显式指定模型就随缘；必须按档位表赋值。
- **父 agent 代拍板** — gate 未知或产品类验收，父只整理摘要，决策权交回用户。