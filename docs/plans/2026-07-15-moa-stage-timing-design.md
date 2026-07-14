# MOA Stage Timing — Design

**日期**: 2026-07-15  
**状态**: 已确认  
**范围**: `packages/moa-extension`

## 目标

为 MOA 每个阶段统计墙钟耗时，并在执行过程中可见（选项 C）：

1. **进行中**：`setWorking` + status bar 带当前阶段已用时（有 UI 时约 500ms 刷新）
2. **阶段结束**：`notify` 附带该阶段耗时
3. **全部结束**：再 `notify` 一条各阶段 + total 汇总

## 计时阶段

| key | 说明 |
|---|---|
| `discovery` | Discovery LLM |
| `ask` | 首轮 ask-user（含用户等待） |
| `rewrite` | Rewrite；禁用则记 0 并标 skipped |
| `workers` | 所有 worker 轮次墙钟合计；多轮另记 `workers_rN` |
| `synthesis` | Synthesis |
| `total` | `/moa run` 全程 |

## 输出格式

进行中：

```text
setWorking:  MOA: 发现阶段 — 分析任务意图… 3.2s
status bar:  Round 1/3 · discovery · 3.2s
```

阶段结束 notify：在现有文案后追加 ` · 12.3s`。

汇总 notify：

```text
MOA 耗时
  discovery  12.3s
  ask         4.0s
  rewrite     8.1s
  workers    41.2s   (r1 22.0s + r2 19.2s)
  synthesis  15.6s
  total      81.2s
```

## 组件

- `src/timing.ts`：`formatDuration`、`StageClock`、`formatTimingSummary`
- `status-bar.ts`：可选 `elapsedMs`
- `executor.ts`：接线 + 500ms ticker（仅 `hasUI`）
- `types.ts`：`MoaExecutionResult.timings?: Record<string, number>`

## 非目标

- Gateway 产品侧启用 MOA
- 把 timings 写入 archive（可后续加；结果对象先带字段）
- 过程中 worker 互见 / synthesis select 模式
