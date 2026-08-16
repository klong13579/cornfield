---
name: 独立验证者：执行与验证分离，数字员工结果由独立进程验收
status: active
objective: 给 OMP 无人值守任务配 QA——执行与验证分离，gateway cron/长任务结果由独立验证进程验收，验收必须附证据
doneWhen: |-
  - 待补充（建议候选，待用户拍板）：
  - 验收报告必须附原始命令输出/文件证据，无证据的批准判不通过
  - 验证进程看不到执行会话的上下文（执行与验证视角分离）
  - 不通过的结果不以"完成"归档，回到执行侧续改
lastActivity: 2026-08-16 15:40
sessionRefs:
  - agent/sessions/-Desktop-Narwal-oh-my-pi/by-date/2026-08-16/145514__07671c53.jsonl
nextAction: 定义验证契约的格式与最小验证者形态（顺着 topic 的验收情况表 + 网关 cron 接入点）
artifacts: []
decisions:
  - 2026-08-16 不集成 glla 插件本体（跑不了 OMP），只移植"独立验证者+证据强制"思想
  - 2026-08-16 本 topic 即 topic 功能首个实战案例（Create/Update/Resume 流程验证）
openQuestions:
  - 验证者用什么身份跑：独立模型 / 无上下文的独立 OMP RPC 进程 / 复用现有 agent 账号
  - 每次验收的模型成本由谁承担，几百项批量任务时怎么控
  - 与 gateway cron 的接入点：cron 结果投递前先过验证，还是按任务类型选配
---

## 设计方案

（待补充——nextAction 先行：验证契约格式 + 最小验证者形态）

## 参考文档

- pi-goal-list-loop-audit 的独立审计设计：https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/audit/AUDITOR-AS-SUBAGENT-DESIGN.md
- 同类实现（证据强制）：https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/extensions/goal-loop-shield.ts

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-16 15:40 — topic 创建，由话题讨论提炼：执行/验证分离 + 证据强制，作为数字员工 QA 层

## 批注

（agent 叙述，不进状态）