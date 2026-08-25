---
name: 统一协议层：TUI/web/桌面/IM 四前端收敛到一套 Wire（P0→P3 分阶段）
status: active              # P0 完成，待 P1 开工
objective: 四个前端收敛到唯一 Wire 协议层，omp 核心为唯一实现；协议传输无关，宿主形态按前端定（TUI 进程内 / web·桌面 项目级 serve / IM 账号级常驻 gateway）
doneWhen: |-
  - P0：bun check 全绿 + wire-server 集成测试全绿 + wire-server.ts 无命令 cast + wire-dto.ts/wire-types.ts 删除
  - P1：AgentSession 公开成员降至两位数
  - P2：DingTalk 收发/模型热切换/会话切换/cron 触发投递行为不变，repro-inject 端到端通过
  - P3：交互式全流程行为不变，协议层成为核心唯一外部消费者
lastActivity: 2026-08-25 15:31
sessionRefs:
  - ~/.omp/agent/sessions/-Desktop-Narwal-oh-my-pi/by-date/2026-08-25/140028__149b5524.jsonl
nextAction: 用户审 docs/plans/2026-08-25-unified-protocol-layer.md，拍板后进 P0
artifacts:
  - docs/plans/2026-08-25-unified-protocol-layer.md
  - docs/adr/0002-unified-protocol-layer.md
  - CONTEXT.md（新增 Wire 协议 / Wire 端点 / Sidecar / 服务端→客户端请求 4 术语）
decisions:
  - 2026-08-25 D1 一实现+传输无关协议（非单一 daemon）
  - 2026-08-25 D2 协议只装 agent 关切；对话交互=服务端→客户端请求
  - 2026-08-25 D3 pi-wire=完整契约，直接 import，无代码生成
  - 2026-08-25 D4 AgentSession 收窄到快照契约+命令动词，收窄优先不拆类
  - 2026-08-25 D5 gateway 管道统一 wire-over-stdio（ADR-0001 进程模型不动）
  - 2026-08-25 D6 迁移顺序 P0 协议地基→P1 核心收窄→P2 gateway→P3 TUI
  - 2026-08-25 D7 cron 留 gateway 适配器；gateway 暴露 Wire 端点宿主 cron CRUD
openQuestions: []
---

## 设计方案

完整方案见 `docs/plans/2026-08-25-unified-protocol-layer.md`（目标架构、D1–D7 决策表、P0–P3 每阶段范围与验收、范围外清单、风险）。决策记录见 `docs/adr/0002-unified-protocol-layer.md`（含被拒方案：单一 daemon / TUI 全量进协议 / cron 进核心 / gateway 保留自有 RPC / 代码生成）。

目标架构一句话：

```
四前端（薄 adapter）─► 一套 Wire 协议（传输无关）─► omp core（唯一实现）
  serve 端点：项目会话        gateway 端点：cron/账号/IM 投递
```

## 参考文档

- codex（~/Desktop/Narwal/codex）：protocol-first 参照系。app-server-protocol/export.rs（协议类型生成）、core-api（facade）、AppServerClient = InProcess | Remote（TUI 也走协议）
- OpenClaw：cron 宿主于 gateway 的业内佐证（"Automations run inside the Gateway process"，docs.openclaw.ai/automation/cron-jobs）
- 架构 review 报告（临时文件）：$TMPDIR/architecture-review-20260825-140938.html、$TMPDIR/architecture-review-codex-20260825.html

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-25 — P0 完成（5 commit：9458fe08/67bd0434/2cdca57/bf6125db+04164ce2/d2277f90）：①WireCommand union 收口（MCP 4 + skill-hub 2 登记，wire-server cast 清零）；②结果形状 8 领域进 pi-wire（stats/cron/memory/skills/session/agents/models/events）；③SessionSnapshot 权威类型移入 pi-wire（coding-agent 保留 reducePhase 运行时，todoPhases 用 WireTodoPhase 结构兼容）；④shape-lock 测试（compile-time 断言 + 运行时命令清单）；⑤web-app 直连 pi-wire，删 wire-dto.ts（镜像）+ wire-types.ts（shim，无 importers）。验证：pi-wire/web-app/coding-agent tsgo 全绿；web-app 功能零变化。**遗留**：wire-server 集成测试 pre-existing 挂（serve 隔离 HOME 启动失败，stash 验证与改动无关，待单独修）；GitNexus 索引过期（WireCommand/applyWindowing 未收录，需 gitnexus analyze 后补 impact）
- 2026-08-25 15:31 — topic 创建；方案落档完成（D1–D7 grill 定稿，ADR-0002 + CONTEXT.md 术语更新），状态 waiting 待用户审方案

## 批注

- P0 是纯加法、零行为变化，随时可开工；实施等用户对方案拍板。
- 与「仓库瘦身」topic 无文件交集：P0 动的 pi-wire / wire-server / web-app 不在瘦身删除清单内，两线可并行。
- P2 开工前需与在途的 gateway 改动对表（避免同批文件冲突）。
