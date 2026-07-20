# MoA worker streaming widget UX

**日期**: 2026-07-19  
**状态**: 已实现  
**包**: `packages/moa-extension`（`src/stream-ui.ts`）

## 目标

Plan workers 并行流式时，在编辑器上方显示更大、带主题色的预览，对齐工具执行 / 异步 job 的视觉语言。

## 合同

| 项 | 值 |
|----|-----|
| Widget key | `moa-workers` |
| 内容形态 | `setWidget` **theme factory**（绕过 string[] 的 `MAX_WIDGET_LINES=10`） |
| 每 worker 预览 | 默认尾部 **6 行 / 480 字符** |
| streaming | `warning` + spinner + `toolPendingBg` |
| OK | `success` + ✓ + `toolSuccessBg` |
| BLOCKED | `warning` + ⊘ + `toolPendingBg` |
| FAILED | `error` + ✗ + `toolErrorBg` |

## 非目标

- 不改 status bar 的 Round/asking 文案
- 不引入独立 overlay；仍是 above-editor widget
