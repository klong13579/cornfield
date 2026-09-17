# T3 交付说明 —— ComposerBar 删除无数据源的 `cronCount` 半句

票：`.scratch/webapp-diag-fixes/issues/10-agent-card-stale-fields.md` 在 ComposerBar 的那一处
（agents 页的 4 处属票 08 = T1，本票未碰）。
分支：`squad/webapp-agents-t3`。

## 改了什么

`packages/web-app/src/pages/workspace/ComposerBar.tsx` —— agent 选择菜单里那一行：

```diff
-{a.skillsCount ?? 0} 技能 · {a.cronCount ?? 0} 定时
+{agent.skillsCount ?? 0} 技能
```

同一改动里，把这一行从 ComposerBar 的 inline `.map()` 提成同文件导出的纯展示组件
`AgentMenuItem`（与 `ModelList` / `ContextItemChip` 同一手法，菜单里渲染的就是它）。
原因是这个渲染点在静态渲染下够不到（菜单要点击才展开、effect 不跑），提出来才能让
测试断言**真实产出**而不是断言源码文本。除删掉那半句外，该行 DOM 逐字段不变：
首字母、`@名称`、状态点 + title、已停用徽标、`CODING|WORKER`、选中/停用样式全部保留。

## 为什么删，而不是换个占位

`cronCount` 在服务端**没有数据源**：调度器在 gateway 进程，serve 的 `list_agents`
拿不到它（`packages/pi-wire/src/results/agents.ts:32` 的【无数据源】标注，
`docs/web-app-fix-t6/T6-agent-list-fields-delivery.md`），适配层 `mapAgentEntry`
从不填充 → 恒 `undefined`。

于是 `?? 0` 把「不知道」渲染成了「零」。改动前的真实读数里每一行都是
`N 技能 · 0 定时`：读者会理解成「这个 agent 有 0 个定时任务」，而事实是 serve
从来不知道有多少个。换成 `—` / 「暂无」同样是在陈述一件我们并不知道的事，所以按票面
要求**只删渲染、不留占位**。有数据源的邻居 `skillsCount`（适配层 `skillCount`）原样保留，
实测值 1 / 11 / 20 / 11 / 19 / 7 / 5 都对得上。

## 改动前后同位置 DOM 读数

采集器：`/Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts`
（绝对路径调用；每次自己 launch 一个 headless Chrome）。步骤文件随证据提交：
`steps-agent-menu.json`。

- **base**：本 worktree 自己的 vite（`http://localhost:4183`），不是共享 `:4173`（那是主检出，跑的不是这份改动）。
- **serve**：主检出的 serve（`ws://127.0.0.1:7891/ws`），页面读数 `已连接 · 7 agents`。
- **改动前**状态用 `git stash push -- ComposerBar.tsx` 还原、vite HMR 生效后重采，采完 `stash pop` 复原。

同一段脚本、同一位置，菜单每行的 footer 文本：

| | 读数 |
|---|---|
| 改动前（`before.steps.txt`） | `["1 技能 · 0 定时","11 技能 · 0 定时","20 技能 · 0 定时","11 技能 · 0 定时","19 技能 · 0 定时","7 技能 · 0 定时","5 技能 · 0 定时"]` |
| 改动后（`after.steps.txt`） | `["1 技能","11 技能","20 技能","11 技能","19 技能","7 技能","5 技能"]` |

整行按钮文本（`button` innerText，同一位置）：

- 改动前：`["d@default1 技能 · 0 定时WORKER", "h@hr11 技能 · 0 定时WORKER", "a@algorithm20 技能 · 0 定时WORKER", "m@me11 技能 · 0 定时WORKER", "d@dataAgent19 技能 · 0 定时WORKER", "s@sw7 技能 · 0 定时WORKER", "m@mcode已停用5 技能 · 0 定时WORKER"]`
- 改动后：`["d@default1 技能WORKER", "h@hr11 技能WORKER", "a@algorithm20 技能WORKER", "m@me11 技能WORKER", "d@dataAgent19 技能WORKER", "s@sw7 技能WORKER", "m@mcode已停用5 技能WORKER"]`

邻居字段未受影响：`@default/@hr/@algorithm/@me/@dataAgent/@sw/@mcode`、`mcode` 的「已停用」徽标、
`WORKER`/`CODING` 标记都在原位置；skillsCount 的值逐行一致。

证据文件（本目录）：

- `before-agent-menu.png` / `after-agent-menu.png` —— 菜单展开后的截图（同一视角、同一 agent 表）
- `before.png` / `after.png` —— 整页截图
- `before.steps.txt` / `after.steps.txt` —— 每步结果原文（含上面两条 eval 的完整表达式）
- `before.dom.txt` / `after.dom.txt`、`before.controls.txt` / `after.controls.txt`、`*.console.txt`、`*.ws.txt`、`*.network.txt`、`*.summary.json`
- `steps-agent-menu.json` —— 复现步骤

注：`after.steps.txt` 里那份 span 列表还含一个 `定时任务` —— 那是左侧导航的项目名，
不是 ComposerBar 菜单行；菜单行的判据是上表的按钮文本。

## 全仓 `cronCount` 清单（本分支）

| 位置 | 性质 | 处置 |
|---|---|---|
| `packages/web-app/src/pages/workspace/ComposerBar.tsx:244` | 解释「为什么删」的注释 | 渲染点已删，注释保留 |
| `packages/web-app/test/diag-composer-no-stale-fields.test.ts` | 本票新增测试（注释 + 断言） | 新增 |
| `packages/pi-wire/src/results/agents.ts:33` | DTO 字段声明，带【无数据源】标注 | 保留（票面明确「服务端那处无数据源标注不算」；不在本票 scope） |
| `packages/web-app/src/pages/agents/AgentsView.tsx:346` | **仍在渲染**（`{agent.cronCount !== undefined && …}`） | 属 T1（票 08 的 4 处之一），本票 scope 外，未碰 |
| `packages/coding-agent/test/diag-agent-list-fields.integration.test.ts`、`docs/web-app-fix-t6/**`、`docs/web-app-functional-diagnosis-2026-09-17/**`、`.squad.json` | 文档 / 测试名 / 任务包文字 | 非渲染点 |

结论：**本票 scope 内的 UI 渲染点已清零**；全仓还剩的渲染点是 agents 页那一处，
按票面归 T1，本票不动它。

## 门禁

```
$ bun run --cwd=packages/web-app check
Checked 181 files in 599ms. No fixes applied.
$ tsgo -p tsconfig.json --noEmit          # 无输出 = 通过

$ bun test packages/web-app/test/diag-composer-no-stale-fields.test.ts
 8 pass / 0 fail / 20 expect()

$ bun test packages/web-app/test/diag-workspace-composer.test.ts packages/web-app/test/composer-model-groups.test.ts
 20 pass / 0 fail / 48 expect()      # 直接消费 ComposerBar 的既有测试，确认提取组件未回归
```

新增测试断言的口径：skillsCount 真值/缺省都渲染；填了 `cronCount` 也不渲染；
缺值处不出现 `—`/`暂无`/`定时` 这类占位；名称/首字母/状态文案/类别/停用·选中态未受影响；
源码去注释后不含 `cronCount`、仍含 `skillsCount`。

## 未做（scope 外）

- agents 页 4 处（`AgentsView.tsx` 的 cronCount/lastAction、`AgentDetailView.tsx` 两处 lastAction）—— T1
- `pi-wire` 的 DTO 字段删除 —— 服务端侧，票面列为「可一并清掉」但本票 scope 只有 ComposerBar + 自己的测试
