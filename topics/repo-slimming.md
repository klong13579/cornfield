---
name: 仓库瘦身：A+B 类全部清理（含需要确认的 6 项）
status: active
objective: 清理 oh-my-pi 仓库瘦身审计确认的 A/B 类删除候选（审计只读完成，本 topic 承接执行）
doneWhen: |-
  - A 类 10 项候选删除完成，git 状态干净
  - B 类 6 项逐项人工确认后删除或迁移完毕
  - 删除后 bun run check:ts 与受影响包测试通过
lastActivity: 2026-08-25 17:40
sessionRefs:
  - - （本次审计会话，路径未记录）
nextAction: 执行 A 类删除候选（10 项零引用文件），删除后跑 git status + check:ts 验证
artifacts:
  - - （删除完成后产生 commit）
decisions:
  - 2026-08-25 — 审计结论：A 类 10 项零引用可安全删；B 类 6 项需确认（python 评估组/batch-format-skills/typescript-edit-benchmark/voice-diag/validate-agent/dws.md）
openQuestions:
  - B 类中 scripts/ python 评估组是否已废弃（edit-tool 评估流程是否还在用）
  - packages/typescript-edit-benchmark 是否还要跑 bench（连带 root bench:* scripts 去留）
  - .omp/skills/voice-diag 迁移到 packages/coding-agent/scripts/ 还是补 SKILL.md
  - prompts/tools/dws.md 是否规划中的 dws tool 预留
---

## 设计方案

按审计报告风险分级分两批执行：
1. A 批（零引用，安全删）：scripts/trace-loader.ts、verify-llm-registry.ts、verify-unified-skills.ts、smoke-self-evolution-hooks.ts、self-evolution-report.ts、sync-versions.ts、test/fixtures/before-compaction.jsonl、chunk-edit-indent.rs、docs/porting-from-pi-mono.md、docs/task-board.yaml
2. B 批（需确认后连带清理）：scripts/ python 评估组 6 文件、batch-format-skills.ts、typescript-edit-benchmark/（连带 root bench:* scripts）、.omp/skills/voice-diag/（迁移）、validate-agent/、prompts/tools/dws.md

排除项（审计确认活跃或受保护，不删）：moa-extension、cognitive-coordination、pi-client、stats、desktop、topics/ 全部、PLANS.md、docs/skills/authoring-*、voice 系列脚本、omp-gateway/cron 调度链（含 SchedulerDbStorage 线索——核实零实例化属实但因排除项未入清单）。

## 参考文档

- 审计报告全文在会话记录（2026-08-25）
- SchedulerDbStorage 核实：packages/omp-gateway/src/scheduler/storage.ts:225 定义，scheduler/index.ts:59 + src/index.ts:64 export，生产与 test 零实例化；json-file-storage.ts:8 注释明示取代关系

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-25 17:40 — topic 创建；只读瘦身审计完成并交付报告（A 类 10 项 / B 类 6 项 / C 类 7 项，全部零文件改动）

## 批注

- B 类每项删除前需用户确认（审计报告已列证据）；voice-diag 建议迁移而非删除。
