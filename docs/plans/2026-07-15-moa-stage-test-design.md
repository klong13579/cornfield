# MoA 阶段测试 Harness — 设计

**日期**: 2026-07-15  
**状态**: 已定稿  
**包**: `packages/moa-extension`

## 1. 目标

提供真实 LLM + 可交互 Ask 的阶段诊断入口：整条五阶段 smoke，以及各阶段可单独跑。产物落盘到 `tmp/moa-stage/`，解决 `/moa run` 改写中途不写 session jsonl、难以排查卡住的问题。

**非目标**：默认进 CI；改 `/moa` 命令面；纯 mock 阶段套件作为主交付（仅用 mock 保证 stage 导出重构不回归）。

## 2. 阶段边界

与设计文档一致（非 TUI status 细粒度）：

```
Discovery → Ask → Rewrite → Workers → Synthesis
```

- **Ask**：首轮补齐 `missing_inputs`（真交互 TUI 合同：answer / skip / stop）
- **Workers**：可含多轮 open_questions asking；多轮 asking 不单独算「大阶段」

## 3. 架构

```
stage-test.ts
  ├─ --stage all|discovery|ask|rewrite|workers|synthesis
  ├─ --task "..."
  ├─ 读 ~/.omp/agent/moa.yml → resolveSettings
  ├─ 建 WorkerEngine（默认与生产一致，如 in-process）
  └─ 调用导出的 stage runners
        discovery → ask(TUI) → rewrite → workers → synthesis
        单阶段：缺上游则报错，或 --from <dir> 读上一阶段 JSON
```

产物目录：`tmp/moa-stage/<timestamp>/`  
文件：`meta.json`、`discovery.json`、`tco.json`、`ask.json`、`rewrite.json`、`workers.json`、`synthesis.md` 等。

## 4. CLI 合同

```bash
bun packages/moa-extension/scripts/stage-test.ts \
  --stage all|discovery|ask|rewrite|workers|synthesis \
  --task "..." \
  [--from tmp/moa-stage/<id>] \
  [--out tmp/moa-stage] \
  [--rounds N] \
  [--continue-on-fail]
```

| `--stage` | 需要的上游 | 来源 |
|---|---|---|
| `discovery` | 仅 task | — |
| `ask` | TCO | 刚跑 discovery，或 `--from` 的 `tco.json` |
| `rewrite` | TCO + output_schema | `--from` 或先跑 discovery |
| `workers` | workers 提示 + TCO + schema | `--from` 的 `rewrite.json` / `plan.json` |
| `synthesis` | surviving workers + TCO | `--from` 的 `workers.json` |
| `all` | 从头串完 | 不需要 `--from` |

缺上游且无 `--from` → exit 2 + 明确报错。

Ask / `all`：脚本内建最小 `ExtensionUIContext`（stdin），`hasUI=true`。

## 5. 导出 API

从 executor 抽出并导出（`stages.ts` 或等价）：

- `runDiscoveryStage` → `{ discovery?, tco, outputSchema, durationMs }`
- `runAskStage` → `{ askSummary, tco, durationMs }`
- `runRewriteStage` → `{ rewrite?, workers, durationMs }`
- `runWorkersStage` → `{ workers, rounds?, dispatchLog, surviving, signal, durationMs }`
- `runSynthesisStage` → `{ synthesis, durationMs }`

`executePlan` 改为调用上述 stage，对外行为不变。

## 6. 错误处理

| 情况 | 行为 |
|---|---|
| 缺 `--task` / 非法 `--stage` | exit 2 |
| 单阶段缺上游 / `--from` 损坏 | exit 2 |
| 某阶段 LLM/引擎失败 | 写产物 + `meta.ok=false`；`all` 默认 stop-on-fail |
| rewrite 失败/空解析 | 与生产一致 fallback |
| 全员 quality-drop | 不跑 synthesis，`signal=quality_failed`，exit 1 |
| Ctrl+C | abort 下传；已写产物保留，可 `--from` 续跑 |

## 7. 文件清单

| 路径 | 作用 |
|---|---|
| `packages/moa-extension/src/stages.ts` | 导出五阶段 runner |
| `packages/moa-extension/src/executor.ts` | 抽 stage，保持 `executePlan` |
| `packages/moa-extension/scripts/stage-test.ts` | CLI |
| `packages/moa-extension/src/stage-cli-ui.ts` | 最小交互 UI |
| `packages/moa-extension/test/stages.test.ts` | mock 合同测试 |
| README / CHANGELOG | 文档 |
| `.gitignore` | 忽略 `tmp/moa-stage/`（如需） |

## 8. 验收标准

1. `--stage discovery` 写出非空 `tco.json`
2. `--stage all` 走完五阶段，Ask 可交互，产物齐全
3. `--stage rewrite --from <prev>` 不重跑 discovery
4. 现有 `bun test packages/moa-extension/test/` 全绿
5. `/moa run` 行为与抽 stage 前一致（现有 executor 测试）

## 9. 决策记录

- 测试类型：真实模型阶段 harness（B 向）；mock 仅服务重构回归
- 覆盖：整条 smoke + 各阶段入口（C）
- Ask：真交互（B）
- 入口：独立脚本（A），不进 `/moa`
