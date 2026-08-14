# PLANS

> Central index of every plan document in the repository. Source of truth for
> "what's been proposed, what's done, what's pending". Generated 2026-08-13
> from the audit at `docs/PLANS.md` (this file) — re-audit quarterly.

**Reading guide**

- `Status` is the implementation status of each plan, derived from CHANGELOG
  entries, git log, and code references at audit time. `unknown` means the
  audit could not verify either way — open the plan file to make the call.
- "Last touched" is the git log last-write date of the plan file itself, not
  the date the implementation shipped. Plans older than 3mo are usually
  already shipped or abandoned.
- Plans live next to implementation in their topic area. Do not delete a
  plan after completion — keep it as evidence and link this index.

**Summary** (2026-08-14 audit, post-`docs/plans/` consolidation)

| Status | Count |
|---|---|
| Completed | 16 |
| Partially implemented | 7 |
| Not started | 3 |
| Unknown | 0 |
| **Total** | **26** |

All plan files now live under `docs/plans/`. If you write a new one, drop it here and add a row to this index.

---

## Not started (2)

| Path | Title | 提出日 | 备注 |
|---|---|---|---|
| `docs/plans/2026-08-14-omp2omp-peers-messaging.md` | omp2omp 通信机制（TUI 实例间消息/状态/等待/回复） | 2026-08-14 | 方案已审批，用户决定暂缓实施。TODO「omp2omp 通信机制」跟踪。 |
| `docs/plans/2026-07-23-ttft-prompt-cache-skills-lazy.md` | TTFT Optimization: Prompt Build Cache + Skills Lazy Load | 2026-07-23 | 审计时无对应 CHANGELOG。ROI 高（TTFT 直接影响用户体验），候选下一 sprint。 |
| `docs/plans/2026-08-11-omp-improvement-proma-comparison.md` | omp 改进计划（源自 Proma 对比） | 2026-08-11 | 状态 = 草案。7 项改进：2 P0（权限模型、自动化自迭代）+ 2 P1 + 3 P2。Phase 1 建议先做 #2 自迭代 → #1 权限模型。 |

## Partially implemented (7)

| Path | Title | 提出日 | 缺口 |
|---|---|---|---|
| `docs/plans/2026-07-15-moa-quality-v2-design.md` | MOA Quality Check v2 Design | 2026-07-15 | 启发式 weights 完成，LLM judge 未集成到产线 |
| `docs/plans/2026-07-15-moa-quality-v2-implementation.md` | MOA Quality Check v2 Implementation Plan | 2026-07-15 | 同上：Task 1+2 完成，Task 4 (LLM judge) 待 |
| `docs/plans/2026-07-17-moa-research-stage-design.md` | MOA Research Stage + 韧性 | 2026-07-15 | Research stage 已存在；claim quality polish（B+C plan Task 3）待 |
| `docs/plans/2026-07-19-moa-grill-me-ask-and-research-fix.md` | MoA Ask=grill-me + Research 门禁 | 2026-07-19 | ASK=grill-me 完成；P0 Research+Discovery gate 部分完成；P1 tool lockdown 待验 |
| `docs/plans/2026-07-23-compaction-improvement.md` | Compaction Improvement: 对标 Hermes Agent | 2026-07-23 | thresholdPercent=50 完成；idle auto-compaction + modelThresholds 待 |
| `docs/plans/2026-07-24-moa-research-claim-quality.md` | MoA Research Claim Quality (B+C) | 2026-07-24 | Task 1+2（sanitize + snippet）完成；Task 3（LLM polish）未启动 |
| `docs/plans/2026-05-omp-evolution-v2.1-development-plan.md` | omp evolution v2.1 开发计划 | 2026-05 前后 | Phase 0-7 共 50+ 项任务。审计判定大部分已完成；Phase 表内个别项个别标"部分完成"或未标。整体以 plan 文件阶段追踪表为准。 |

## Completed (16)

| Path | Title | 提出日 |
|---|---|---|
| `docs/plans/2026-05-implementation-plan-p0-critical-gaps.md` | P0 Critical Gaps (Memory Phase 1/2 Fallback + Convention Layer 2) | 2026-05 前后 |
| `docs/plans/2026-05-omp-evolution-test-plan.md` | omp evolution test plan | 2026-05 前后 |
| `docs/plans/2026-07-15-moa-inline-no-extension-bundle-cache.md` | MOA Inline + Remove Extension Bundle Cache | 2026-07-15 |
| `docs/plans/2026-07-15-moa-stage-test-design.md` | MoA Stage-Test Harness — Design | 2026-07-15 |
| `docs/plans/2026-07-15-moa-stage-test.md` | MoA Stage-Test Harness Implementation | 2026-07-15 |
| `docs/plans/2026-07-15-moa-stage-timing-design.md` | MOA Stage Timing — Design | 2026-07-15 |
| `docs/plans/2026-07-15-moa-stage-timing.md` | MOA Stage Timing Implementation | 2026-07-15 |
| `docs/plans/2026-07-17-moa-once-right-design.md` | MOA Once Right — Design (P0-P5 全部完成) | 2026-07-17 |
| `docs/plans/2026-07-17-moa-once-right.md` | MOA Once Right Implementation | 2026-07-17 |
| `docs/plans/2026-07-18-length-stall-and-spinner-dispose-design.md` | Length Stall Circuit Breaker + Spinner Dispose | 2026-07-18 |
| `docs/plans/2026-07-18-length-stall-and-spinner-dispose.md` | Length Stall + Spinner Dispose Implementation | 2026-07-18 |
| `docs/plans/2026-07-18-moa-research-soft-stop-design.md` | Research Budget Soft Stop + Salvage | 2026-07-18 |
| `docs/plans/2026-07-19-moa-worker-stream-ux-design.md` | MoA worker streaming widget UX | 2026-07-19 |
| `docs/plans/2026-07-24-moa-p1-p3-followups.md` | MoA P1–P3 Follow-ups Implementation | 2026-07-24 |
| `docs/plans/2026-08-voice-jarvis-p0-implementation.md` | omp Jarvis P0 实施计划 | 2026-08 |

---

## Related doc indices

这些**不是 plan**，但放在这里便于交叉引用：

| 类型 | 位置 | 说明 |
|---|---|---|
| **ADR**（架构决策） | `docs/adr/0001-gateway-bridge-process-model.md` | 1 篇。Process 调整原因记录。 |
| **Design**（设计文档） | `docs/omp-evolution-architecture-v{2,2.1,3}.md`、`docs/voice-jarvis-*.md`、`docs/skill-telemetry-design.md`、`docs/moa-multi-round-design.md`、`docs/session-tree-design.md`、`docs/non-compaction-retry-policy.md`、`docs/todo/multi-agent-orchestration-design.md` | 当前架构/状态描述文档，不是 plan。 |
| **Trouble-shooting** | `docs/trouble-shooting/` | 故障复盘。 |
| **Reference** | `docs/rpc-host-tool.md` | RPC 协议深度展开，生命周期五阶段。 |
| **Diagnosis report** | `docs/cron-session-storage-diagnosis-2026-06-30.md` | 单次现场诊断报告。 |

---

## Maintenance

新写一份 plan 时：

1. 文件名加日期前缀（`YYYY-MM-DD-{topic-slug}.md` 或 `topic-slug-plan.md`）
2. 文件头部加 Status / Date 元数据（看 `docs/plans/2026-07-*.md` 现状）
3. 在本索引对应状态下加一行
4. 完成时**不要删原 plan 文件**，把状态移到 Completed 区，注明日期

下一轮审计建议每季度一次；审计 subagent prompt 模板可参考首次生成的 audit 任务（JTD JSON 输出格式）。

---

## See also

- `docs/gateway-binary-split-plan.md` — 当前推进中的 plan（拆 omp binary）
- `docs/hermes-gateway-cron-architecture.md` — gateway 架构说明
- `docs/omp-evolution-architecture-v2.1.md` — evolution v2.1 设计终稿
