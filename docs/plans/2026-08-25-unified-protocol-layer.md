# 统一协议层方案（Unified Protocol Layer）

> 状态：**待审**。决策依据见 `docs/adr/0002-unified-protocol-layer.md`；术语见 `CONTEXT.md`（Wire 协议 / Wire 端点 / Sidecar / 服务端→客户端请求）。
> 参考语料：codex（~/Desktop/Narwal/codex，protocol-first）、OpenClaw（cron 宿主于 gateway）。

## 目标

TUI、web、桌面客户端、gateway IM 四个前端，共用一套底层 omp；中间是唯一协议层（Wire），传输无关。今天「四个宿主各包一层 AgentSession」收敛为「一个核心实现 + 协议层上的多个薄前端」。

## 目标架构

```
前端（薄 adapter）
┌─ TUI（终端）          ── 进程内内存传输（帧对象直传，不序列化）
├─ web-app（浏览器）     ── WS ─┐
├─ desktop（Electron）  ── WS ─┤
└─ gateway IM（DingTalk）── stdio（wire-over-stdio，每账号一子进程）
        │                        │
        ▼                        ▼
   serve Wire 端点          gateway Wire 端点
   （项目级 sidecar）        （常驻 service）
   宿主：项目会话/文件/实时    宿主：CronTask/账号/IM 投递
        │                        │
        └────────┬───────────────┘
                 ▼
        omp core（唯一实现）
        AgentSession 窄面：快照契约 + 命令动词
```

ACP（Zed）是外部标准，留在边缘做 ACP↔Wire 翻译，不改协议。

## 已定决策（D1–D7）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 「一套底层」的含义 | 一实现 + 传输无关协议；宿主形态按前端定（非单一 daemon） |
| D2 | 协议边界 | 只装 agent 关切；UI 本地状态留前端；对话交互 = 服务端→客户端请求 |
| D3 | pi-wire 所有权 | 完整契约：union + 结果形状 + 快照类型 + 守卫；直接 import，无代码生成 |
| D4 | 核心接口 | AgentSession 收窄到快照契约 + 命令动词；收窄优先，不拆类 |
| D5 | gateway 管道 | wire-over-stdio；ADR-0001 进程模型不动 |
| D6 | 迁移顺序 | P0→P1→P2→P3，每阶段独立可发布 |
| D7 | cron/账号/服务生命周期 | 留 gateway 适配器；gateway 暴露 Wire 端点宿主 cron CRUD |

## 分阶段计划

### P0 · 协议地基（纯加法，零行为变化）

范围：
1. `WireCommand` union 收口：MCP 4 命令 + skill-hub 2 命令正式登记，删 wire-server 的 string cast 与注释契约。
2. 结果形状进 pi-wire：stats/cron/memory/skills/fs/session-messages 等命令的返回类型，按领域分文件（参照 codex `protocol/v2/` 组织）。
3. `SessionSnapshot` 类型移入 pi-wire（coding-agent 保留构建快照的运行时；方向是协议定义、核心实现，禁止反向依赖）。
4. web-app 直接 import pi-wire：删 `wire-dto.ts`（425 行镜像），`pi-client-adapter.ts` 只做帧→状态映射。删 `wire-types.ts` shim（37 行）。
5. 协议形状锁定测试（参照 codex schema_fixtures）：快照测试锁住每个命令的参数/返回形状。

验收：`bun check` + 现有 wire-server 集成测试全绿；web-app 功能不变；`grep -r "as unknown as" packages/coding-agent/src/server/wire-server.ts` 无命令 cast。

### P1 · 核心收窄

范围：
1. AgentSession 公开面审计：~138 成员分类——命令动词（保留）/ 快照可读（保留为只读）/ 内部状态（改 # 私有）。
2. 重试/回退、tool-choice 队列、todos 计时、bash/python abort 控制器退到内部 seam（沿用已拆出的 tool-choice-queue.ts、retry-fallback-cooldown.ts 模式）。
3. wire-server 成为窄面的模范消费者；TUI 暂不动（P3 处理）。

验收：AgentSession 公开成员数降到两位数；现有 TUI/工具调用不破坏（TUI 此阶段允许走兼容面，记入 P3 清理清单）。

### P2 · gateway 切换

范围：
1. 新增 `omp --mode wire-stdio`（或 rpc 模式演进）：管道跑 Wire 帧，替代自定义 JSON-line RPC。
2. AgentBridge 重写消息层为 Wire 客户端；agent-transport 自定义协议层删除。崩溃恢复/熔断/指数退避保留（进程模型不动）。
3. gateway 暴露 Wire 端点：cron CRUD 命令（create/update/remove/test-run/logs）+ gateway_status 由 gateway 实现；serve 侧删除直读 jobs.json/status.json 的代理（readCronTaskList/readCronLogList/readGatewayStatus），web-app cron 页改连 gateway 端点。
4. 补齐 union 缺口：工具禁用等 bridge 专有命令。

验收：DingTalk 收发消息、模型热切换、会话切换行为不变；cron 触发/投递/失败通知不变；`omp-gateway` 测试套件全绿；repro-inject 端到端通过。

### P3 · TUI 切换

范围：
1. 服务端→客户端请求泛化落地：权限批准迁移为第一个实例，select/confirm/input 跟进。
2. TUI 改为进程内 Wire 客户端（内存传输）；interactive-mode 经协议层消费核心。
3. print 模式顺路切换；ACP 模式确认为边缘翻译器。
4. 清理 P1 遗留的 TUI 兼容面。

验收：交互式全流程（对话/权限/分支/压缩/模型切换）行为不变；协议层成为核心的唯一外部消费者。

## 范围外（明确不做）

- 不合并 serve 与 gateway 进程（D1 已决）。
- 不把 TUI UI 钩子协议化（D2 已决）。
- cron 引擎不进核心（D7 已决）；何时出现第二个调度宿主（如 web 端管理需求真实化）再议。
- 不动 ADR-0001 的进程模型与账号隔离。

## 风险

| 风险 | 缓解 |
|---|---|
| P3 协议宽度被 TUI 需求撑大 | D2 边界原则先行；每个新增命令族过「是否 agent 关切」审 |
| P2 期间 IM 行为回归 | 协议切换与进程模型解耦；repro-inject 端到端门禁 |
| pi-wire 类型迁移引入循环依赖 | 方向硬约束：协议定义、核心实现；CI 依赖检查 |
| 两线并行（瘦身审计等）触碰同批文件 | P0 开工前对表其他在途改动 |
