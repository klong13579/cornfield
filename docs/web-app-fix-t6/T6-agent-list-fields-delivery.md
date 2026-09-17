# T6 · Agent 列表字段补真 —— 交付说明

squad: squad-20260917-webapp-fix · 分支: squad/webapp-fix-t6 · 模型: narwal-plan/deepseek-v4-pro

## 范围

- `packages/coding-agent/src/skeleton/workspace.ts`（+`domain` 类型声明）
- `packages/coding-agent/src/server/session-registry.ts`（`role` 从 domain 输出）
- `packages/pi-wire/src/frames.ts` / `results/agents.ts`（协议/文案语义澄清）
- `packages/coding-agent/test/diag-agent-list-fields.integration.test.ts`（新增）

未动 `packages/web-app/**`（scope 纪律）。

## 字段级前后对照

| 字段 | 位置 | 前 | 后 | 归类 |
|---|---|---|---|---|
| `role` | wire `SessionListEntry`（pi-wire frames.ts） | 类型已声明但 serve 从不输出 → web-app 恒回落「默认工作区」，一桶 | `buildSessionList` 输出 `meta.role`（= workspace.json `domain`），真分组 | 补真 |
| `domain` | `WorkspaceDeclaration`（workspace.ts） | 盘上各 agent 的 workspace.json 已有 `domain` 字段，但 TS 类型未声明、读不到 | 类型声明 `domain?: string`，`loadAgentMetas` 读 `workspace?.domain` | 新增（类型层）/ 补真 |
| `active`（wire） | pi-wire frames.ts | 注释「与当前连接的焦点相关」未明说非进程状态 | 明说 **不是进程状态**：UI 文案由 active（焦点）+ attached（挂载）推导 | 语义澄清 |
| `active` / `attached` / `status`（DTO） | pi-wire results/agents.ts | `status` 无注释，`active`/`attached` 注释模糊 | `AgentStatus` 补注释：online=焦点 / busy=执行中相位 / idle=已挂载非焦点 / stopped=未挂载——**本连接视角投影，非进程状态** | 语义澄清 |
| `cronCount`（DTO） | pi-wire results/agents.ts | 声明但恒 undefined（适配层从不填充） | 标注【无数据源】：调度器在 gateway 进程，serve `list_agents` 拿不到 | 删除（交接说明，见下） |
| `lastAction`（DTO） | pi-wire results/agents.ts | 声明但恒 undefined | 标注【无数据源】：无 wire 字段 + 适配层不填充 | 删除（交接说明，见下） |

## 三条验收判据的落地

1. **工作区分组**：`role` = workspace.json `domain`。真实 HOME 快照（`loadAgentMetas` 只读）证明 7 个 agent 落到 7 个 distinct 分组 —— `HR / 算法 / 产品 / 数据分析 / 软件 / coding / default`，>1 组可观察。web-app 侧 `mapAgentEntry` 已按 `s.role` 分组（`workspace: s.role ?? "默认工作区"`），**无需改 UI**。

2. **卡片死字段 cronCount/lastAction**：这两个是 web-app 的 `AgentInfoDto` 字段，wire 的 `SessionListEntry` 本就**没有**它们，web-app 适配层 `mapAgentEntry` 也从来不填 → 恒 undefined。判定：
   - `cronCount`：调度数据属于 gateway 进程，serve 无数据源，不该存在；
   - `lastAction`：无 wire 字段 + 无适配层映射，恒空。
   两者删除都会破坏 web-app 消费方（`AgentsView` / `ComposerBar` / `AgentDetailView` / `HomeView` 都引用），且 web-app 不在本票 scope。做法：在 pi-wire DTO 上标注【无数据源】+ 本说明建议 web-app follow-up（移除这两个字段，或为 `lastAction` 接一个真数据源）。**未改 UI**（遵守父 brief）。集成测试锁「wire 回包不下发 cronCount/lastAction/status」这一半契约。

3. **运行中/空闲语义**：协议（frames.ts）与 DTO（results/agents.ts）注释说清 `active` = 本连接焦点、`attached` = 已 lazy attach，`status`(online/idle/stopped/busy) 是适配层从 active/attached/phase 推导的「本连接视角」投影，**与 agent 进程是否在跑无关**。

## 证据

### 集成测试（gate 之一）

`bun test packages/coding-agent/test/diag-agent-list-fields.integration.test.ts` → 2 pass / 0 fail / 31 expect。
覆盖：`loadAgentMetas` 把 domain 读到 role（无 domain 则 undefined）；真 serve 子进程的 `list_agents` 回包里 `role` 真下发、wire 不下发 `cronCount`/`lastAction`/`status`/`workspace`、`active`/`attached` 是布尔。

### 真实 HOME `list_agents` 字段快照（只读）

```
{"id":"hr","role":"HR"}
{"id":"algorithm","role":"算法"}
{"id":"me","role":"产品"}
{"id":"dataAgent","role":"数据分析"}
{"id":"sw","role":"软件"}
{"id":"mcode","role":"coding"}
{"id":"default","role":"default"}
```

### 真页面复跑验证（可选，需前端 4173 已起）

```bash
bun packages/coding-agent/src/cli.ts serve --port 7906 --host 127.0.0.1 --no-extensions
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/agents' --out <证据目录> --name t6 --base http://127.0.0.1:4173 --ws ws://127.0.0.1:7906/ws
# 看 ws.txt 里 list_agents 回包帧的 role；真页面应出现 >1 个工作区分组。
```

## Gate

- `bun run --cwd=packages/coding-agent check` → 通过（biome + tsgo）
- `bun run --cwd=packages/pi-wire check` → 通过（biome + tsgo）
- `bun test packages/coding-agent/test/diag-agent-list-fields.integration.test.ts` → 通过
- 回归：`serve-session-factory.test.ts` + `session-registry-dingtalk.test.ts` → 13 pass / 0 fail

## 既有消费方影响

wire `SessionListEntry` 只新增了一个可选 `role`（老客户端忽略），`active`/`attached`/`agentDir`/`skillCount`/`dingtalk` 逐字节不变；web-app 适配层与分组代码未动。DINGTALK 绑定、多 Agent 边界（绑 Project 附件不冒充 agent 行）等既有测试全绿。