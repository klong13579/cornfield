---
name: session 诊断优化：诊断结果 → learning/nudge/regression 三阶段落地
status: active
objective: 会话诊断结果按 learning/nudge/regression 三阶段落地，形成闭环
doneWhen: |-
  - 待补充（未给验证契约，需与用户确认）
lastActivity: 2026-09-01 23:30
sessionRefs:
  - <待填：最近的诊断会话路径>
nextAction: 与用户确认三个阶段的动作定义和验收契约
artifacts: []
decisions: []
openQuestions:
  - regression 阶段动作的触发阈值由谁定、怎么定
---

## 设计方案

（待补充——三阶段应用暂缓，先做诊断能力）

## 已实现

### 诊断按钮 + 详情页（2026-09-01）

**诊断命令**（serve 端，wire 协议）：
- `diagnose_session <sessionFile>` — 触发异步诊断（spawn cornfield --mode rpc 子进程，不占用当前会话）
- `list_diagnosis_reports [sessionFile]` — 诊断报告索引
- `get_diagnosis_report <reportId>` — 报告全文（markdown + 结构化摘要 JSON）

**诊断执行器**（`packages/coding-agent/src/server/diagnosis-runner.ts`）：
- spawn 独立 `cornfield --mode rpc` 子进程（复用 gateway AgentBridge 同款模式）
- 子 agent 加载 `session-diagnosis-orchestrator` skill 做 6 维分析 + 根因融合
- 产物：`~/.cornfield/agent/diagnosis-reports/<sessionId>_<ts>.md`（完整报告）+ `<同一前缀>.summary.json`（结构化摘要）
- 默认配置模型（用户拍板 A），超时 15min，返回 running 状态立即返回

**前端**（`packages/web-app/`）：
- 会话记录页每行增加「诊断」按钮（spinning 异步态）+ 诊断等级 badge（P0-P3）
- 诊断详情页路由 `/records/:sessionId/diagnosis`（保留左侧导航栏）
- 六维度可展开详情（判定依据 / 关键指标明细 / 证据片段 / 修复建议）
- 摘要卡 + 完整报告两级展示（用户拍板行内展开 + 详情页形态）

**原型验证**：`DiagnosisPrototypeView.tsx`（已删除，结论落回 RecordsView 直接实现）

### 范围外（暂缓）

- learning/nudge/regression 三阶段应用（用户确认：进化功能未想明白，暂不做）
- 每日自动化诊断（用户确认：先做手动触发，稳定后未来再做）

## 参考文档

- docs/self-evolution.md（self-evolution 架构，待核实）
- `packages/coding-agent/src/server/diagnosis-runner.ts`（诊断执行器）
- `packages/pi-wire/src/results/diagnosis.ts`（诊断 DTO）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| 2026-09-01 | 原型 mock 截图 (inline/drawer/badge/detail 四变体) | 确认形态 badge + 详情页 |
| 2026-09-01 | 原型 v2 截图（侧边栏保留 + 维度可展开） | 确认信息密度 OK |
| 2026-09-01 | 类型检查通过（web-app / coding-agent） | 无新增类型错误 |

## 进度记录

- 2026-08-16 15:24 — topic 创建
- 2026-09-01 23:30 — 诊断按钮 + 详情页落地实现（serve 端 + 前端），原型文件删除