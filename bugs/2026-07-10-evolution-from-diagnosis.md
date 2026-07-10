# 会话诊断结果 → 进化：方案设计

## 背景

2026-07-08 ~ 07-09 共 34 个会话的意图理解诊断完成，发现 3 个 P1、5 个 P2、5 个 P3 问题。
核心模式：instruction degradation、thinking 死循环/沉浸式工具调用、abort 后静默吞消息。

本文档讨论如何将这些诊断结果反馈到 OMP 自进化系统（`packages/self-evolution/` V4）。

---

## 方案一：Write-memory → Learnings（轻量，手动触发）

**路径**：诊断数据 → 人工精选 → seed JSON → `/evolution learnings seed` → 自动注入

**修改面**：
- `learnings` 表写一行（`source=manual_pin`, `lifecycle=active`, `kind=procedure|fact`）
- 下轮 session prompt 注入区多一行（`【规则】`区块），~2000 字预算
- `agent_end` 自动跟踪 `times_injected`/`times_helped`/`times_ignored`
- 不达标自动 archive，不生效不污染

**已有能力**：
- `/evolution learnings seed <file>` 命令已存在
- `learnings-seed.ts` 解析 JSON → 写入 DB → pin active

**示例 seed**：
```json
[
  {"kind": "procedure", "content": "用户说\"全都\"修饰词时，必须列出所有受影响端点逐一确认覆盖后再执行", "pin": true},
  {"kind": "procedure", "content": "用户提供带引号的完整句子要求搜索时，做 literal match 而非关键词提取", "pin": true},
  {"kind": "fact", "content": "\"发消息\"表述可能表示立即执行（已发送）或计划执行（即将发送），应先确认状态", "pin": true}
]
```

**优点**：改动极小，人工控制，可逆
**缺点**：依赖人工筛选，无法覆盖 thinking 死循环这类需实时打断的场景

---

## 方案二：诊断 → Regression Fixture（自动化回归门禁）

**路径**：`patterns.jsonl` 中 P1/P2 模式 → `regression_fixtures` 表 → skill 变更时 `regression gate` 校验

**已有基础设施**：

| 组件 | 位置 | 状态 |
|---|---|---|
| `buildRegressionFixtureFromTrace` | `regression/fixture-from-trace.ts` | 从 session_trace 构建 fixture |
| `runSkillRegressionGate` | `regression/replay.ts` | 跑 skill 对 fixtures 的通过率，<60% discard |
| 三种 replay backend | `regression/replay-backend.ts` | heuristic / LLM / subagent |
| `selectFixturesForSkill` | `regression/select-fixtures.ts` | 按 tool hint 选 fixture |

**需要补的桥**：
- 从诊断数据的 `patterns.jsonl` 批量回写 `regression_fixtures` 表
- 按诊断等级（P1/P2/P3）分配 fixture 权重
- fixture 选择策略增加"按诊断 pattern 类型"维度

**优点**：自动化，skill 变更必须通过历史失败模式的门禁
**缺点**：实现工作量大，当前 regression 框架以 tool 为中心而非以意图模式为中心

---

## 方案三：Nudge 规则（实时打断）

**路径**：诊断出的 thinking 死循环、沉浸式工具调用 → 注册新的 `NudgeDetector` 规则

**已有能力**：
- `NudgeDetector`：监听 trace，按模式触发 nudge
- `NudgeDeliverer`：TUI 提示，按类型冷却
- nudge_history 持久化

**适用的诊断模式**：
- thinking 内容 >5K chars 且 unique 词数 <50 → 自动 interrupt + fallback
- 单轮 tool call >20 次无中间输出 → 强制 checkpoint
- 用户输入含"怎么一直"、"卡主了" → 暂停执行，输出状态摘要

**优点**：实时生效，不影响 prompt
**缺点**：nudge 目前只做 TUI 提示，没有 interrupt/fallback 机制

---

## 推荐路线

### 阶段一（立即做）
**方案一：seed learning**

选 3-5 个 P1/P2 模式写成 seed JSON，`/evolution learnings seed` 注入。
- 改面最小，可验证 learnings 在 this session 中的实际效果
- 一个 `/evolution learnings seed` 命令即可落地

### 阶段二（本周）
**方案三：nudge 规则** 中的 thinking 循环检测

这是当前最痛的 P1：thinking 死循环让 agent 完全失能。
- 在 streaming consumer 层加 thinking-only 循环检测
- 检测到后强制 interrupt + fallback to no-thinking mode

### 阶段三（下个迭代）
**方案二：诊断→fixture 桥**

需要先统一 diagnosis data 的 schema，再建批量回写路径。
- P1/P2 模式必须有明确的 fixture schema 映射
- 需要协调 `patterns.jsonl` 的格式
