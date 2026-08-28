---
name: 统一协议层：TUI/web/桌面/IM 四前端收敛到一套 Wire（P0→P3 分阶段）
status: P0-P2 完成；P3 代码完成待合并
objective: 四个前端收敛到唯一 Wire 协议层，omp 核心为唯一实现；协议传输无关，宿主形态按前端定（TUI 进程内 / web·桌面 项目级 serve / IM 账号级常驻 gateway）
doneWhen: |-
  - P0：bun check 全绿 + wire-server 集成测试全绿 + wire-server.ts 无命令 cast + wire-dto.ts/wire-types.ts 删除
  - P1：AgentSession 公开成员降至两位数（按交付口径：协议面 39 / 总数 132，两位数总数推迟至 P3）
  - P2：DingTalk 收发/模型热切换/会话切换/cron 触发投递行为不变，repro-inject 端到端通过
  - P3：交互式全流程行为不变，协议层成为核心唯一外部消费者（代码完成在 feat/agent-work，未合 main）
lastActivity: 2026-08-28
sessionRefs:
  - ~/.omp/agent/sessions/-Desktop-Narwal-oh-my-pi/by-date/2026-08-25/140028__149b5524.jsonl
nextAction: 用户决定是否合入 feat/agent-work（含 P3 全量 + P2-4 web-app 直连）；P2 web-app 直连 gateway 端点可选跟进
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
  - 2026-08-28 D8 P2 形状保持：网关端点返回与旧 serve 直读代理同形 DTO（web-app 不改）；P3 合入后再议 web-app 直连
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
| 2026-08-28 | `bun test ./test/` (omp-gateway 全量) | 1040 pass / 7 skip / 0 fail |
| 2026-08-28 | `bun test ./test/wire-server-*.ts` (coding-agent，13 文件) | 54 pass / 1 skip / 0 fail |
| 2026-08-28 | 新 binary 安装 + 优雅重启 | `POST /wire` @ 7891 live：gateway_status（6 账号/scheduler running）、get_cron_tasks（9 任务） |
| 2026-08-28 | cron CRUD 实机往返 | create→update(paused+cron)→remove 全过；test_run 未知任务拒绝 |
| 2026-08-28 | repro-inject 真实钉钉 | hr 账号注入 200 OK → AgentBridge → wire-stdio 子进程回复「收到，链路通。」落钉钉 |

## 进度记录

- 2026-08-25 15:31 — topic 创建；方案落档完成（D1–D7 grill 定稿，ADR-0002 + CONTEXT.md 术语更新），状态 waiting 待用户审方案
- 2026-08-25 23:02 — P1 合入（merge e9f8d1c02d，协议面锁 39/总数 132）；TODO.md 记 P0✓ P1✓
- 2026-08-27 06:10 — P2 传输层合入 main（merge ffb5ce8a80：wire-stdio + bridge WireTransport + gateway 测试套件迁移）；旧 agent-transport.ts 保留
- 2026-08-28 — P2 收尾（a5f0a9cd0e）：gateway 生产端点 wire-endpoint.ts（cron CRUD 7 命令 + gateway_status）+ serve 转发 POST /wire + 删文件嗅探（readCronTaskList/readCronLogList/readGatewayStatus）+ 删 agent-transport.ts（类型迁入 agent-transport-wire）；形状保持旧 DTO（web-app 不改），仅新增 status 可选字段；P2-5 实机验证完成（上表）

## 批注

- P0 是纯加法、零行为变化，随时可开工；实施等用户对方案拍板。
- 与「仓库瘦身」topic 无文件交集：P0 动的 pi-wire / wire-server / web-app 不在瘦身删除清单内，两线可并行。
- P2 开工前需与在途的 gateway 改动对表（避免同批文件冲突）。
- P2-4 web-app 直连 gateway 端点（24924bcf64）随 feat/agent-work 合入时跟进；serve 转发已覆盖功能。
- P3 TUI 全量在 feat/agent-work 分支（22 commits，落后 main 83），合入需解 wire-server.ts/commands.ts 冲突；用户已拍板 P3 暂缓。
