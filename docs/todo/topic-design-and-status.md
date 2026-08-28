# TODO Topic 设计进展 — 2026-08-16

> 状态：**方案已拍板、一期功能已落地（skill 层），面板可见性缺口已暴露、实现路径待下次拍板**。
> 本文档是今日进展的快照 + 改天继续的接力点。

## 背景与动机

用户对 CornField 的 TODO 面板（`<projectRoot>/TODO.md`，TUI 顶部渲染）有三个痛点：

1. 只有一行待办名字，**不知道目标是什么、参考对象是什么**；
2. **不知道之前对话到什么程度，能不能继续**之前的对话；
3. 待办更像一个 **topic**（主题容器），而不仅仅是名字。

同期对 pi 生态插件 `pi-goal-list-loop-audit`（glla，pkg: pi-goal-list-loop-audit）做了深度研究
（README/PLAN/DESIGN/CHANGELOG/npm 元数据/下载量/GitHub 活跃度）。结论：

- **不集成 glla 插件本体**：强耦合 `@earendil-works/pi-*` 扩展 API（CornField 是其 fork 后的独立演进，
  14.x vs 0.84），跑不了 CornField；单人项目、AGPL、API 持续漂移，不宜成为 CornField 的承诺面。
- **移植其思想三层**：① 验证契约（todo 固化成可机械验证的 `Done when:`）；② 执行与验证分离
  （glla 用独立无扩展审计进程验货）；③ 证据强制（验收必须附原始命令输出，无证据的批准判不通过）。
- 第一层（验证契约 + topic 上下文）**今日已落地**；第二、三层（独立验证者）是后续大件，
  已作为 `topics/independent-verifier.md` 立项。

## 已拍板决策（2026-08-16，用户确认）

| # | 决策 | 选择 |
|---|---|---|
| 1 | topic 本体放哪 | **A. `topics/<slug>.md` 文件 + YAML frontmatter**；TODO.md 行挂 `→ topics/<slug>.md` 链接做索引（否决 B. SQLite，无关系查询需求） |
| 2 | "当前进度"语义 | **状态机事实为主**（时间+变更+证据 的不可变记录），**叙述为辅**（agent 批注，不进状态） |
| 3 | 文件名 | 英文 slug（小写 ASCII，空格/标点转 `-`，中文转译/拼音），`name` 字段存中文 |
| 4 | 哪些 todo 升级 topic | a) 手动指定 + b) 设计方案类自动（裸任务不强制） |
| 5 | 续接入口 | 先不加 slash command；TUI 面板链接 + 对话触发（"继续 X"），command 留给二期 |
| 6 | 集成 glla 插件 | 不集成，移植思想（见背景） |

### Topic 字段清单（需求共识，含用户原始 6 项）

`name` / `objective` / `doneWhen:`（验证契约，可机械验证）/ `设计方案` / `参考文档` /
`当前进度`（状态机事实 + 证据）/ `测试验收情况`（时间/命令/结果表）/ `nextAction`（续接点）/
`sessionRefs`（最近会话锚点，最多 3 条）/ `artifacts` / `decisions`（拍板记录）/
`openQuestions` / `lastActivity` / `status`（drafting/active/paused/waiting/done/aborted）。

## 今日交付

### 已提交（commit `86fe4a8a8e`）

- `~/.cornfield/agent/skills/project-todo/SKILL.md`（用户级，即时生效）：新增 **Create topic /
  Update topic / Resume topic** 分支 + topic 模板 + slug 规则 + 边界规则
  （进度是事实不是散文；topic 永不注入 always-on 上下文；不碰 `todo_write`/`/todo` phases；
  删除待办不删 topic 文件；不发明 `doneWhen` 契约）。
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md`："任务追踪纪律"补 topic
  同步/续接规则（编译进二进制，需 rebuild 生效）。
- `packages/coding-agent/src/skeleton/assets/TODO.md`：模板补 topic 链接说明注释。
- `packages/coding-agent/CHANGELOG.md`：Unreleased Added 条目。
- 实弹样例：`topics/session-diagnosis-loop.md`、TODO.md 挂链。

### 未提交增量（工作树）

- `topics/independent-verifier.md`（独立验证者 QA 层立项：objective/decisions/openQuestions/
  参考文档已填实，doneWhen 留"建议候选待拍板"）+ TODO.md 挂链（sessionRefs 已补当前会话）。

## 今日验证结论

- **Create topic 流程（skill）经两个实弹用例验证通过**：slug 规则、幂等、frontmatter、挂链均正常。
- **Update topic / Resume topic 未经实战验证**（等后续真正推进 topic 时验证）。
- **暴露缺口**：TUI 面板仍旧只渲染一行名字——topic 内容存在文件里，行文本只有链接字面量，
  打开 cornfield 看不到 status/进度/摘要。用户明确指出"topic 还是不清晰，只有一个名字"。

## 遗留与下一步（改天继续，按序）

1. **P0 路径拍板**：实现"完整 topic 功能"的三条路已核实边界 ——
   - skill 实现：只能管 agent 流程约定，做不出面板可见性/命令/校验；
   - 自定义插件：CornField 扩展系统给了 slash command + 工具 + session 生命周期 hooks，
     **但没有 welcome 右栏 UI 注入点、没有 turn 级（agent_end）钩子**——面板仍旧只有一行名字
     （glla 在 pi 上撞的同一堵宿主墙）；
   - **内置到 coding-agent（推荐）**：todo.ts/welcome 是宿主代码，全接口在手。
   - 用户 2026-08-16 表态"今天先不做"，路径待拍板。
2. **一期（可见性补齐，小改）**：`todo.ts` parser 解析 `→ topics/<slug>.md` 并加载 frontmatter；
   `welcome.ts` 渲染 `[status] 摘要` 徽标；补 frontmatter/链接一致性校验脚本。需 rebuild 生效。
3. **二期（产品级）**：`/topic` 命令族（list/show/new/jot/archive）+ 生命周期钩子注入 topic 摘要。
4. **待验证**：Update topic / Resume topic 实战（说"继续 X"从 nextAction 起步）。
5. **待拍板**：两个活 topic 的 `doneWhen` 验收契约（`topics/session-diagnosis-loop.md`、
   `topics/independent-verifier.md` 均留了候选，等用户确认）。

## 参考

- glla 研究：README / PLAN.md / docs/DESIGN.md（GitHub: DraconDev/pi-goal-list-loop-audit）
- 独立审计设计：`audit/AUDITOR-AS-SUBAGENT-DESIGN.md`；证据强制：`extensions/goal-loop-shield.ts`
- 本仓库任务板：`TODO.md`；样例 topic：`topics/`