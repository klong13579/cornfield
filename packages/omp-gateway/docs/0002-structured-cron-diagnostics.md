# Structured Cron Run Diagnostics

Gateway 的定时任务执行诊断从 raw text 升级为结构化数据。

## 背景

CronService 在每次 cron 执行后将 exitCode、stdout/stderr 写入 JSONL 文件。这种方式有两个核心问题：

1. **状态矛盾**：JSONL 记录 `exitCode=0`、`status=success`，但执行实际因超时而失败。调用方只能从 JSONL 的 raw text 推断真相，无法可靠区分"真的成功"和"成功记录了一个失败"。
2. **不可查询**：JSONL 是追加写入的平面文件，CLI 命令需逐文件 grep 才能获取最近执行的概览/详情。没有分页、过滤、按严重度排序能力。

OpenClaw 的同类系统使用结构化 `CronRunDiagnostics`（来源/严重度/消息/工具名/exitCode）解决了同样的问题。

## 决策

引入 `CronRunDiagnostics` 类型，替换 CronService 中的 raw text 输出/错误存储逻辑。

### 诊断结构

```typescript
type CronRunDiagnosticSource =
  | "cron-preflight"    // 任务定义/配置校验
  | "cron-setup"        // 启动/预热/Operator 取消
  | "model-preflight"   // 模型/Provider 预检
  | "agent-run"         // Agent 执行异常/超时
  | "tool"              // 工具调用失败
  | "exec"              // Subprocess 执行失败
  | "delivery";         // 结果投递失败
type CronRunDiagnosticSeverity = "info" | "warn" | "error";

interface CronRunDiagnosticEntry {
  ts: number;
  source: CronRunDiagnosticSource;
  severity: CronRunDiagnosticSeverity;
  message: string;           // 自动脱敏，上限 1000 字符
  toolName?: string;         // 仅 source=tool 时
  exitCode?: number | null;  // 仅 source=exec 时
  truncated?: boolean;       // message 被截断时
}

interface CronRunDiagnostics {
  summary?: string;          // 对外展示的最严重诊断摘要，上限 2000 字符
  entries: CronRunDiagnosticEntry[];  // 上限 10 条
}
```

### 诊断收集点

每个采集点产生一个或多个 `CronRunDiagnosticEntry`：

| 采集点 | source | severity | 时机 |
|---|---|---|---|
| 任务定义/配置校验失败 | cron-preflight | error | onTrigger 入口 |
| 启动/Operator 取消 | cron-setup | error | warm bridge 起始/取消 |
| Provider 预检失败 | model-preflight | warn/error | executeAgent 前 |
| Agent 超时/报错 | agent-run | error | warm bridge 返回 error |
| Agent 工具调用失败 | tool | error | tool 执行异常 |
| Subprocess 执行失败 | exec | error/warn | `executeScheduledCommand` 返回非零 |
| Wall-clock 达超时 | exec | error | timedOut=true |
| 投递失败 | delivery | error | `deliver()` 返回 !ok |
| 重新调度被跳过 | cron-preflight | info | grace window / 并发限制 |

### JSONL 写入策略

本次变更**保持 JSONL 追加写入**，但写入的内容从 raw text 改为 `{ diagnostic: CronRunDiagnostics }` 包裹的结构化 entry。每条 JSONL entry 同时保留 `exitCode`/`status` 等遗留字段以兼容消费者，但诊断决策以 `diagnostics` 字段为准。

```json
{
  "id": "exec_xxx",
  "ts": 1783023402539,
  "exitCode": 0,
  "status": "success",
  "durationMs": 1715732,
  "diagnostics": {
    "summary": "Agent RPC inactive for 971734ms, subprocess also timed out",
    "entries": [
      { "ts": 1783023400000, "source": "agent-run", "severity": "error",
        "message": "Agent RPC inactive for 971734ms (no session event for 60000ms, hard cap 300000ms)" },
      { "ts": 1783023402000, "source": "exec", "severity": "error",
        "message": "Subprocess timed out after 300000ms", "exitCode": 124 }
    ]
  }
}
```

### 上游变更

1. **CronService.onTrigger()**：在每个失败/异常点调用 `appendDiagnostic()` 方法，而非直接设 `stderr`/`exitCode`
2. **execution-log.ts**：新增 `appendCronDiagnostic(taskName, entry)` 方法，写入 JSONL 文件
3. **executor.ts**：`executeScheduledCommand` 返回的 `ExecutionResult` 增加 `diagnostics` 字段，携带 exec 层面的结构信息
4. **gateway-cron-lifecycle.ts**：`#executeCronAgent` 在 catch 分支中构造 `agent-run` 类型的诊断 entry

### 优先原则

本次变更只改诊断系统，不涉及：
- CLI 命令新增（`cron status` 等留待后续）
- HTTP 端点（`/health/cron` 等留待后续）
- 钉钉查询接口
- SQLite 替代 JSONL

## 考虑过的方案

| 方案 | 问题 |
|---|---|
| 保持 raw text，仅修复 bug | 下次遇到同类问题仍需 grep 推断 |
| 直接迁移到 SQLite | 改动面过大，DB 与 JSONL 双写一致性问题 |
| 在 Gateway 上层做诊断分析 | 诊断信息在下层（CronService）就已丢失，无法重建 |

## 后果

- **正向**：JSONL 文件的可读性和可查询性得到质的提升；CLI 命令和钉钉查询可以基于 `diagnostics` 字段做过滤，不再依赖 grep
- **负向**：每次 cron 执行需额外序列化 `CronRunDiagnostics` 对象；但数据量小（上限 10 条 × 1KB），可忽略
- **兼容性**：旧 JSONL 文件没有 `diagnostics` 字段，查询代码需做空值检查
- **迁移路径**：本 ADR 是第一步；后续 ADR 将覆盖 SQLite 存储、CLI 命令、HTTP 端点
