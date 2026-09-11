---
name: Tool 呈现协议迁移：采用上游 xd:// 设备挂载
status: active
objective: 移植上游 oh-my-pi 已验证的 Tool 呈现设计（Catalog / Enabled Tool Set / Discoverable Tool Set 三层 + Load Mode + xd:// 设备挂载），并承接 tool2 让出的 4 项工具能力
doneWhen: |-
  - 18 票全部 complete 并通过各自 gate
  - 合体验证通过（≥2 个 complete 子任务必须走 integration worktree）
  - 挂载开关关闭时，顶层工具暴露与改造前一致
  - internal 工具无法经配置、设置或显式清单进入可选择集合
  - 两条系统提示路径都包含设备说明，SYSTEM.md 覆盖场景下不消失
lastActivity: 2026-09-11 17:38
sessionRefs:
nextAction: Phase 3 转译——现场查代码补 scope.files，生成 squad 任务包并过 bootstrap.ts --check
artifacts:
  - docs/adr/0003-tool-presentation-xdev.md
  - CONTEXT.md（Tool Catalog / Enabled Tool Set / Discoverable Tool Set / Load Mode / xd:// 挂载 / Tool Metadata）
  - .scratch/tool-xdev/issues/01..18
decisions:
  - 2026-09-11 采用上游 xd:// 作为 Tool 呈现协议，不自行推导
  - 2026-09-11 Load Mode 三层：essential / discoverable / internal；internal 约束注入权而非调度权
  - 2026-09-11 规范名 + legacy 别名（find→glob、search→grep、todo_write→todo）
  - 2026-09-11 read/write 承担 xd:// transport，永不挂载
  - 2026-09-11 挂载开关默认开启
  - 2026-09-11 MCP 最终统一走 xd，MCP 发现入口与旧配置退场（分批落地）
  - 2026-09-11 MCP 发现入口与 web_search 判为 essential
  - 2026-09-11 接管 tool2 的 4 项工作，单人执行
openQuestions:
  - 挂载文档注入开关的 setting 默认值未独立验证（上游函数级默认是 inline）
  - 名称规范化的 contract 阶段（配置 key 与提示词改名、旧名移除）未排期
---

## 设计方案

移植上游已验证的 Tool 呈现协议，不做本地重新推导。核心是把「工具已知 / 本次会话可用 / 如何呈现给模型」三件事拆开：工具目录是静态定义真源，Enabled Set 由目录加配置、环境与 Agent 边界算出，discoverable 工具不再占用顶层 schema 而是挂载为内部 URL 设备，由 read/write 承担列出与执行入口。internal 类工具只约束注入源，不约束调度。

## 参考文档

- docs/adr/0003-tool-presentation-xdev.md（本批架构决策）
- docs/adr/0001-gateway-bridge-process-model.md、docs/adr/0002-unified-protocol-layer.md（正交）
- docs/gateway/im-agent-prompt.md（系统提示分层，设备说明需覆盖的路径）
- CONTEXT.md（术语：Tool Catalog / Enabled Tool Set / Discoverable Tool Set / Load Mode / xd:// 挂载 / Tool Metadata）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-09-11 17:38 — topic 创建。Phase 1 决策清单经用户确认，架构决策落 ADR-0003，术语落 CONTEXT.md；18 票落 .scratch/tool-xdev/issues/；tool2 确认零交集并停手，其 4 项工作由本批接管

## 批注

Phase 3 起需现场查代码补每票的 scope.files：squad 硬规则要求各票文件范围互不相交，read/write/find/search/edit 的呈现标注已并入对应能力票以避免同文件被两票修改。原生 PCRE2 票的验证链与其余票不同（cargo 与原生构建），转译时不要套用默认推导。
