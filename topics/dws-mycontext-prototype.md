---
name: 用 dws CLI 实现 MyContext 业务流原型
status: active              # drafting/active/paused/waiting/done/aborted
objective: 用现有 dws CLI + 模型网关跑出一条能把「一个人」完整刻画出来的 context 画像流水线（知道什么/跟谁协作/在做什么/怎么说话/怎么决策），用真实钉钉数据产出一份可读、可验证、可被 agent 消费的画像产物。手段是参考 MyContext 业务流；目标是完整了解使用者 context（含 MyContext 方法论的验证）。
doneWhen: |-
  - 待补充（用户未给验收契约；方案中的建议验收：真实数据跑出画像产物 + 一次"来新消息→判定→起草"演示，待用户确认）
lastActivity: 2026-08-18 05:35
sessionRefs: []
nextAction: 等用户拍板范围/窗口/落盘位置三个默认值 → 写 L1 采集脚本（dws 拉聊天/日程/审批/待办 → SQLite 落库带水位）
artifacts: []
decisions: []
openQuestions:
  - 做到什么程度（4 档）：①画像快照（风格/关系/职责）②决策策略（+答复率/风险类/rules.json，推荐）③知识结构（+轻量图谱）④实时分身（+轮询判定/起草，不发送）——待用户选档
  - 范围：L1+L2+L3（采集+蒸馏+分身判定）全做，还是只做 L2 画像蒸馏先出效果？
  - 数据窗口：默认 90 天（与 user-distill 一致）？
  - 落盘位置：~/.omp/agent/skills/dws-persona/demo/（延续 user-distill 模式）？
---

## 设计方案

**参考对象**：openTrinity/mycontext（已 clone 到 `~/Desktop/Narwal/mycontext`，与 oh-my-pi 平级）

**业务流对照**（MyContext → 我们的 dws 实现）：

| MyContext 层 | 我们用什么实现 | 备注 |
|---|---|---|
| ingest（采集） | dws CLI 拉 chat/calendar/todo/oa，SQLite 落库 + 水位 | 复用 user-distill fetch 思路升级成增量 |
| forge（零 LLM 测量） | Python/Bun 统计：句长/短回复/活跃时段/答复率按 askKind/核心协作者/tone band | 产出 style.md / decisions.md / people.md |
| distill（LLM 抽取） | 模型网关抽取 role/workflow/knowhow | 产出 work.md |
| kl-graph 图谱 | **跳过**（Qdrant/社区检测是重资产，与看效果目标不符） | |
| persona（分身） | 简化判定 demo：风险类→草稿、答复率低→草稿、纯客套→静默 + 起草 | 照抄 12 条降级核心几条，不做 opencode 沙箱 |

**产物模板**：照抄 forge 结构——SKILL.md（六步命令流）+ references/{style,decisions,people,work,limits,fidelity}.md + rules.json（机器可读判据）。模板定义在 `~/Desktop/Narwal/mycontext/vendor/forge/forge/compose.py` 的 render_* 函数和 `vendor/forge/templates/persona/SKILL.md`。

**已验证的环境事实**：node 22.21.0 + pnpm 10.13.1 可用；MyContext 仓库 clone 完整、4900 单测全绿、可打包可启动。dws v1.0.57 二进制在 MyContext 的 resources/bin/ 和 OMP 的 dws skill 依赖里都有。

## 参考文档

- MyContext 源码: `~/Desktop/Narwal/mycontext/`
- forge 产物模板: `~/Desktop/Narwal/mycontext/vendor/forge/forge/compose.py`, `vendor/forge/templates/persona/SKILL.md`
- 采集水位设计: `~/Desktop/Narwal/mycontext/packages/ingest/src/scheduler.ts`
- 数据源字段映射: `~/.omp/agent/skills/user-distill/references/data-sources.md`
- OMP 侧既有技能: `~/.omp/agent/skills/user-distill/`（fetch.py/distill.py 可复用）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-18 05:35 — objective 重定义：复刻看效果 → 完整了解使用者 context（用户澄清）；新增「做到什么程度」四档选项待选
- 2026-08-18 05:20 — topic 创建；已完成 MyContext 深度研究（业务流九步 + 潜在问题 + 产物模板分析），方案待用户拍板

## 批注

- 用户原话：参考 mycontext 的业务流，使用 dws cli 工具实现它的功能，看下效果。
- doneWhen 未从用户处获得明确验收契约（用户以"看下效果"为目标），按 skill 规则留待补充，不代为发明验收项。
- 拍板点（方案第 2 步）：范围 L1/L2/L3、数据窗口、落盘位置。用户确认后进入执行。