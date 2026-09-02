---
name: 复用 WikiSkill 开源项目：在 Cornfield self-evolution 中落地 Pattern → Proposal → Validation → Outcome 闭环
status: active
objective: 复用 WikiSkill 的算法与数据模型，在 Cornfield 现有 self-evolution 中建立可审计的经验到技能进化闭环，不直接引入 Python runtime 依赖。
doneWhen: |
  - 待补充
lastActivity: 2026-09-01 00:00
sessionRefs: []
nextAction: 盘点 Cornfield 现有 diagnosis、pattern、regression、skill version 数据结构，设计最小复用方案
artifacts: []
 decisions:
  - 2026-09-01 — 复用 WikiSkill 的算法、角色拆分和 gating 语义，不直接接入其 Python harness
openQuestions:
  - Pattern Catalog 是否继续以 evolution.db 为事实源并生成 markdown 投影
  - 首个 SKILL.state 试点是否放在编辑器修改—预览—验证流程
---

## 设计方案

- 先建立 `Diagnosis → Pattern → Proposal → Validation → Outcome` 关联。
- 复用现有 `SessionTrace`、`ToolChainDiagnosis`、regression fixture、`SkillVersionStore` 和 `EvolvedSkill`。
- Wiki/Pattern 作为持久知识层；active skill 可回滚，诊断证据和 rejected proposal 永久保留。
- SKILL.state 只在长流程中局部试点，不替换全局 interactive agent loop。

## 参考文档

- [WikiSkill 论文](https://arxiv.org/abs/2608.27454)
- [WikiSkill 开源实现](https://github.com/ashutoshsinghpr7/wikiskill)
- [SKILL.state 论文](https://arxiv.org/abs/2608.26263)

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-09-01 00:00 — topic 创建

## 批注

- 当前判断：WikiSkill 可复用算法与数据模型；不作为 Cornfield 的运行时依赖。
