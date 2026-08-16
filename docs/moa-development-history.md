# MOA 开发史（2026-07 实施记录）

> 本文档是 17 个已实施/部分实施的 MOA plan 文件的合并摘要（2026-08-16 清理时归并，原文已删除，git 历史可查）。
> 设计级文档另行保留：`docs/moa-input-fulfillment.md`（TCO 单轮流水线，已实施）、`docs/moa-multi-round-design.md`(多轮增强，PR1/PR2 已实施）。
> 代码位置：`packages/moa-extension/`（src + test，34+ 测试文件）。

## 时间线

| 日期 | 主题 | 状态 | 对应源码/测试 |
|---|---|---|---|
| 07-15 | MOA 内联化 + 移除 extension bundle cache | 完成 | `src/extension.ts` |
| 07-15 | Quality Check v2（heuristic weights） | **部分完成** | `src/quality/`；LLM judge 未集成（见 Open items） |
| 07-15 | Stage-Test Harness（真 LLM 阶段测试） | 完成 | `src/stage-test-cli.ts`、`src/stage-artifacts.ts` |
| 07-15 | Stage 级 wall-clock timing | 完成 | `src/timing.ts` |
| 07-17 | Once Right：A+B 一轮 Ask 收拢 + P0-P5 | 完成 | `src/ask-user.ts`、`src/merge-missing.ts`、`src/skip-input-collect.ts` |
| 07-17 | Research Stage + 韧性 | **部分完成** | `src/research-mode.ts`；claim polish 见 07-24 |
| 07-18 | Length Stall 熔断 + Spinner Dispose | 完成 | `src/activity-timeout.ts`、`src/status-bar.ts` |
| 07-18 | Research Budget Soft Stop + Salvage | 完成 | `src/research-mode.ts`（soft-stop 分支） |
| 07-19 | Ask = grill-me + Research 门禁 | **部分完成** | `src/grill-ask.ts`；P0 Research+Discovery gate 部分完成；P1 tool lockdown 待验 |
| 07-19 | Worker streaming widget UX | 完成 | `src/stream-ui.ts`、`src/status-bar.ts` |
| 07-24 | P1–P3 Follow-ups（research source refs 等） | 完成 | `src/worker-engine.ts`、`src/tool-budget.ts`、`src/decision-missing.ts` |
| 07-24 | Research Claim Quality (B+C) | **部分完成** | Task 1+2（sanitize + snippet）完成；Task 3（LLM polish）未启动 |

## 关键架构决策（沿革）

1. **TCO（Task Context Object）**：执行前 Discovery LLM 产出 task_understanding / known_inputs / missing_inputs，TUI 一次问完，非 TUI 全 assumed —— 解决 Data Gap（AgentAsk 审计 29.1% 失败根因）。
2. **多轮循环（maxRounds）**：质量 heuristic + 动态 output_schema + 收敛检测；`hasUI=false` 全程短路，Gateway/cron 行为不变。
3. **Once Right 收拢**：业务交互从前到后收成「A+B 一轮 Ask → 执行 → 收敛」，优先交互正确性。
4. **Quality heuristic 起步，LLM judge 缓行**：结构分 + 内容分 + 守契约分，<40 丢弃，全丢 fail loud；judge 留作后续。
5. **grill-me 复用**：ASK 澄清语义接 grill-me 模式，而不是新造澄清协议。

## Open items（部分完成项扬出的缺口）

- [ ] Quality: LLM judge 评分未集成产线（`src/quality/` 目前 heuristic）
- [ ] Research: claim quality Task 3（LLM polish）未启动
- [ ] Ask/Research: P1 tool lockdown 待验证
- [ ] Gateway/cron multi-round（`OMP_MOA_GATEWAY_ASK_URL` 让 cron 也能 ask 钉钉用户）—— 设计见 `moa-multi-round-design.md` §15

## 相关非-MOA plan（同期，另行保留）

- `docs/plans/2026-07-23-compaction-improvement.md` — compaction 对标 Hermes（thresholdPercent=50 已上线；idle auto-compaction + modelThresholds 待）
- `docs/plans/2026-07-23-ttft-prompt-cache-skills-lazy.md` — TTFT 优化候选（下个 sprint）
- `docs/plans/2026-08-11-omp-improvement-proma-comparison.md` — omp 改进草案（权限模型/自迭代等 7 项）