---
name: lint
description: >-
  When the user asks to check knowledge base health, scan for stale content,
  or verify external link validity. Customize the checks below to match this agent's
  domain and data sources.
---

# Lint — 知识库健康检查（模板）

> ⚠️ **Skeleton template — customize before using.**
> Fill in the `<请填…>` placeholders with your agent's specific paths, thresholds, and
> external workspace IDs. The structure follows the kb-lint pattern used in production agents.

## Outcome

一份按严重程度分级的健康报告：列出过期文件、失效外部链接、进度空窗、索引不同步问题，
附带修复建议。报告输出为回复正文并追加到 `log.md`。

## Procedure

### Step 1 — 检查过期内容

扫描 `knowledge/` 和 `wiki/` 下所有 `.md` 文件：

| 检查项 | 方法 |
|--------|------|
| 各文件最后修改日期 | `stat -f %m <file>` |
| 超过 `<请填阈值天数>` 天未更新 | 记录为 **🟡 待归档** |

**完成标准：** 所有文件 mtime 已列出，过期项已标记。

### Step 2 — 检查外部链接有效性

读取 `knowledge/external-workspaces.md` 的 `<请填表格名>` 表格，对每一行：

1. 用 `<请填验证命令>` 检查是否可访问
2. 返回空或报错 → 记录为 **🔴 链接失效**
3. 判断内容与描述是否匹配 → 不匹配记录为 **🔴 映射错误**

**完成标准：** `external-workspaces.md` 中每个外部引用都已验证可访问且内容匹配。

### Step 3 — 检查进度/业务空窗

读取 `<请填进度文件路径>`：

- 最新条目的日期到当前日期超过 `<请填空窗天数>` 天 → **🟡 进度空窗**
- 条目包含"待更新" → **🔴 需要更新**

**完成标准：** 所有进度文件已检查，空窗项已标记。

### Step 4 — 输出检查报告

```markdown
# 📋 知识库健康报告 — YYYY-MM-DD

## 🔴 需要关注
- [问题描述 + 修复建议]

## 🟡 建议处理
- [问题描述 + 修复建议]

## ✅ 正常项
- [确认正常的项]

## 建议操作
- [对每个 🔴 问题的具体修复步骤]
```

报告输出为**回复正文**，同时追加到 `log.md`。

**完成标准：** 报告已格式化，正文已输出，`log.md` 已追加。

## Verification

- [ ] 每项检查有结果输出（正常或异常），无遗漏
- [ ] 🔴 问题项附带具体修复建议
- [ ] `log.md` 已追加本次报告，格式与历史一致
- [ ] 未修改任何知识库文件（只读检查）

## Pitfalls

- **直接报错终止**：某个外部引用不可访问时应记录"不可访问"而非中断检查
- **遗漏修复建议**：仅列问题而不给出操作步骤，接收者不知从何入手
- **过度报警**：根据业务文档生命周期调整过期阈值（HR 文档可放宽到 90 天，技术文档建议 30 天）

## Cron 配置参考（待启用）

```json5
// cron/tasks/kb-lint.json5 — 自定义
{
  name: "kb-lint",
  schedule: "<请填 cron 表达式>",
  taskType: "agent",
  agentDir: "<请填 agentDir 路径>",
  prompt: "跑一次知识库健康检查",
  timeoutMs: 180000,
  enabled: false
}
```
