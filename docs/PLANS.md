# PLANS

> Central index of every plan document in the repository. Source of truth for
> "what's been proposed, what's done, what's pending". Last audited 2026-08-16
> (cleanup: 17 个已实施 MOA plan 合并入 `moa-development-history.md`，原文删除；plan 变更不再全量保留，见 Maintenance)。

**Summary**

| 状态 | 保留文件 |
|---|---|
| Active（未完成/待拍板） | 3 |
| 已归并（MOA 实施史） | 17 个 → `docs/moa-development-history.md` |
| 已删除（被取代/超期/诊断记录） | 见下方 Cleanup 记录 |

## Active plans

| Path | Title | 提出日 | 状态 |
|---|---|---|---|
| `docs/plans/2026-07-23-compaction-improvement.md` | Compaction Improvement: 对标 Hermes Agent | 2026-07-23 | Partially implemented — thresholdPercent=50 完成；idle auto-compaction + modelThresholds 待 |
| `docs/plans/2026-07-23-ttft-prompt-cache-skills-lazy.md` | TTFT Optimization: Prompt Build Cache + Skills Lazy Load | 2026-07-23 | Not started。ROI 高（TTFT 直接影响用户体验），候选下一 sprint |
| `docs/plans/2026-08-11-cornfield-improvement-proma-comparison.md` | cornfield 改进计划（源自 Proma 对比） | 2026-08-11 | 草案。7 项改进：2 P0（权限模型、自动化自迭代）+ 2 P1 + 3 P2 |

## 归档：MOA 实施史

2026-07 的 17 个 MOA plan（TCO 流水线 / quality-v2 / stage-test / stage-timing / once-right / research-stage / length-stall / soft-stop / grill-me-ask / worker-stream-ux / p1-p3-followups / research-claim-quality / inline 等）已合并为 **`docs/moa-development-history.md`**（时间线 + 架构决策沿革 + open items），原文删除，git 历史可查。设计级文档另行保留：

- `docs/moa-input-fulfillment.md` — TCO 单轮流水线设计（已实施）
- `docs/moa-multi-round-design.md` — 多轮增强设计（PR1/PR2 已实施）

## 2026-08-16 清理记录（git 历史可恢复）

| 类别 | 文件 |
|---|---|
| 被新版本取代 | `docs/omp-evolution-architecture-v2.md`、`v2.1.md`（v3 为当前默认实现）、`docs/omp-evolution-mock-demo.md` |
| V2 时代设计/计划 | `docs/superpowers/plans/*`（2）、`docs/superpowers/specs/*`（3）、`docs/plans/2026-05-*.md`（3） |
| 被实现替代 | `docs/plans/2026-08-14-omp2omp-peers-messaging.md`（intercom 已实现）、`docs/gateway-binary-split-plan.md`（已合入 main） |
| 合并入新文档 | `docs/voice-jarvis-p0-design.md` + `p1-design.md` + `docs/plans/2026-08-voice-jarvis-p0-implementation.md` → `docs/voice-jarvis-design.md`；`docs/session-tree-design.md` → `docs/session.md` |
| 单次诊断/排障 | `docs/cron-session-storage-diagnosis-2026-06-30.md`、`docs/trouble-shooting/zed-cornfield-acp-fail-to-launch-sigkill-2026-08-10.md`、`bugs/2026-07-10-*.md`（2） |
| 孤儿/垃圾 | `tmp/`（226 文件，MOA 探测残留）、`omp_screen_small.png`、`settings-guide.md`、`config/config.yml`+`models.yml`（运行时配置误入仓库） |

## Related doc indices

这些**不是 plan**，但放在这里便于交叉引用：

| 类型 | 位置 | 说明 |
|---|---|---|
| **ADR**（架构决策） | `docs/adr/0001-gateway-bridge-process-model.md` | 1 篇。Process 调整原因记录。 |
| **Design**（设计文档） | `docs/omp-evolution-architecture-v3.md`、`docs/voice-jarvis-design.md`、`docs/voice-jarvis-state-machine.md`、`docs/skill-telemetry-design.md`、`docs/moa-multi-round-design.md`、`docs/non-compaction-retry-policy.md`、`docs/todo/multi-agent-orchestration-design.md` | 当前架构/状态描述文档，不是 plan。 |
| **Trouble-shooting** | `docs/trouble-shooting/` | 排障记录。 |
| **Reference** | `docs/rpc-host-tool.md` | RPC 协议深度展开，生命周期五阶段。 |

## Maintenance

新写一份 plan 时：

1. 文件名加日期前缀（`YYYY-MM-DD-{topic-slug}.md`）
2. 文件头部加 Status / Date 元数据
3. 在本索引 Active 表加一行
4. 完成后更新状态；**已实施的 plan 在下一轮清理时合入 `moa-development-history.md`（或按主题归档），原文删除不保留**——证据在 git 历史，索引指向归档文档即可

下一轮审计建议每季度一次。

## See also

- `docs/voice-jarvis-design.md` — 实时语音设计（P0+P1 合并稿，已实现）
- `docs/moa-development-history.md` — MOA 实施史（2026-07）
- `packages/cornfield-gateway/docs/hermes-gateway-cron-architecture.md` — gateway 架构说明