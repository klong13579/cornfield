# System Diagnosis

Generated: 2026-06-23T13:12:37.953Z

Consolidated health snapshot from evolution DB (audit, per-session diagnoses, stuck patterns).
Regenerated after each archived session and via `/evolution audit`.

---

# 进化审计报告
生成时间: 2026-06-23T13:12:37.952Z

## 1. 概览
- 归档会话: 374 / 500 最大
- 会话成功率: 45%
- 平均工具调用/会话: 13.3
- 平均错误/会话: 0.4
- 用户画像: 0 次会话, 主要意图: unknown

## 2. 已采纳的进化
### Skills (0 个, 0 个已废弃)

### 注入表现
- Evolution 回放后端: llm
- 被追踪的技能数: 0
- 技能注入: 0 次
- 帮助率: 0% (0 / 0)

### Learnings
- 总数: 549
- Active: 549 | 手动固定: 0
- 注入统计: 帮助 540 / 注入 5620
  - active: 549

## 3. 收益分析
### Nudge 行为修正
- 总检测: 381 | 注入上下文: 4
- 已评分: 3 | 帮助率: 100% | 重复率: 0%

### 用户意图分布
- exploration: 204 次 (平均置信度: 66.6)
- bugfix: 66 次 (平均置信度: 61.8)
- feature-add: 30 次 (平均置信度: 64.0)
- configuration: 23 次 (平均置信度: 60.8)
- testing: 19 次 (平均置信度: 65.1)
- refactoring: 9 次 (平均置信度: 75.1)
- documentation: 8 次 (平均置信度: 67.5)
- optimization: 4 次 (平均置信度: 73.3)
- integration: 4 次 (平均置信度: 78.8)

### 工作流模式
- 总模式: 535 | 有意义的 (>=2次): 41

### 阶段变化
- 最近 7 天意图分布:
  - exploration: 185 次
  - bugfix: 48 次
  - feature-add: 26 次
  - configuration: 23 次
  - testing: 15 次
  - refactoring: 8 次
  - documentation: 8 次
  - optimization: 4 次
  - integration: 1 次
- 无显著阶段变化

## 4. 待解决问题
- Low session success rate: 45%.
- No skills extracted yet.
- 1 evolution deadlock(s) need human review — automatic fixes did not stabilize recurring errors.

## 5. 改进建议
- Review error patterns and consider extracting recovery skills.
- Lower --self-evolution-skill-threshold to capture more sessions as skills.
- 257 regression fixture(s) exist but no trials recorded — run sessions or /evolution backfill-traces, then refresh admission.
- Run /evolution stuck to acknowledge or resolve; add a manual convention after you fix the root cause.

## 6. 技术明细
### Escalations
- Open: 1 / 1 总数
  - esc_181g1cerl0r0f [open] reg:3ub458avxlwf9 (14x)

### Regression
- Session traces: 104
- Regression fixtures: 257
- Trials: keep 0, discard 0, pending 0

### Nudge 明细
- 已忽略: 1, 已确认: 0


---

## Recent session diagnoses

_No episode diagnoses recorded yet._

---

## Open escalations (stuck patterns)

### esc_181g1cerl0r0f [open]
- Pattern: reg:3ub458avxlwf9
- Occurrences: 14
- Failed auto-improvements: 0
- Recurring error pattern (14 failed sessions): reg:3ub458avxlwf9
- Automatic evolution has not produced an active learning fix. Review with /evolution stuck, adjust environment, or pin a learning via /evolution learnings pin.
