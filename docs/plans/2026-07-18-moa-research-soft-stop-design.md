# Research 预算软停 + Salvage — 设计补丁

**日期**: 2026-07-18  
**状态**: 实施中  
**前置**: [2026-07-17-moa-research-stage-design.md](./2026-07-17-moa-research-stage-design.md)

## 问题

Live 复验中 `researchMaxToolRounds=12` 把 `read`/`search`/`web_search` 一并计数，硬 `abort` 后
output 为空 → `research_pack=null` → plan workers 无共享证据。加额度不是根本解。

## 合同

1. **预算语义** = 最多 N 次 `web_search`（与 `researchMaxQueries` 对齐）；`read`/`search`/`find` 不计。
2. **软停**：第 N+1 次 `web_search` 触顶时先打标，给当前工具 + 随后一轮文本收口窗口；窗口内再发起
   `web_search` 才硬 abort。硬墙钟仍由 `researchTimeoutMs` / `workerIdleTimeoutMs` 负责。
3. **Salvage**：Research agent 已跑但 JSON/markdown 解析失败（含空 output）时，必须产出
   `parse_source: "salvage"` 的 pack（从原文抽 URL + `gaps` 写明中断原因），写入 TCO。

## 非目标

- 不改 agent-core 工具结果注入协议
- 不在本期做双角度 research
