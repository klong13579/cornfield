# 统一协议层：一个实现、一套 Wire、多个宿主

TUI、web、桌面、gateway IM 四个前端今天各自包装 AgentSession（~138 个公开成员），协议表示三处分裂（pi-wire 半成品 + web-app 手抄镜像 + 命令族 string cast）。决定：所有前端收敛到唯一的 Wire 协议层，omp 核心是唯一实现；协议传输无关，宿主形态按前端定——TUI 进程内、web/桌面走项目级 serve、IM 走账号级常驻 gateway。参照系：codex 的 protocol-first 架构（其 TUI 亦经 app-server 协议消费核心，`AppServerClient = InProcess | Remote`）。

## 决策要点

- **协议只装 agent 关切**：回合/事件/权限/todos/模型/会话/文件等引擎事实进协议；前端 UI 本地状态（编辑器文本、主题、布局）不进协议。对话类交互（选择/确认/输入）泛化为通用「服务端→客户端请求」，权限批准是其第一个实例。
- **pi-wire = 完整契约**：命令 union（含 MCP/skill-hub）+ 全部结果形状 + 快照类型 + 运行时守卫，按领域组织。全 TypeScript，前端直接 import——不需要 codex 式代码生成（那是跨语言的代价，我们没有）。
- **核心接口收窄**：AgentSession 公开面收敛到快照契约 + 命令动词；重试、工具队列、abort 控制退到内部 seam。收窄优先于拆类。
- **gateway 管道统一走 wire-over-stdio**：AgentBridge 演进为 Wire 客户端 + IM 适配器。ADR-0001 的进程模型（每账号一个子进程、崩溃隔离、熔断）原样保留——换协议不换进程模型。
- **cron 留 gateway 适配器**：调度器依附常驻进程，不进核心、不独立成进程。gateway 暴露 Wire 端点，宿主 cron CRUD 与账号关切。参照：OpenClaw 的 automations 明确「run inside the Gateway process」；codex 本地无调度（任务在云端）。
- **迁移顺序**：P0 协议地基（纯加法）→ P1 核心收窄 → P2 gateway 切换 → P3 TUI 切换。web/桌面已在协议上，P0 完成即受益。每阶段独立可发布。

## 考虑过的方案

| 方案 | 拒绝理由 |
|---|---|
| 单一 daemon 托管一切 | 多租户隔离重做（账号级崩溃隔离丢失）；项目 scoped 与账号 scoped 语义冲突；TUI 启动依赖 daemon |
| TUI 全量进协议（远程 UI 协议） | 协议宽度随 UI 细节爆炸；web/桌面被迫实现 TUI 语义 |
| cron 引擎进核心 | 今天只有一个真实宿主（gateway），搬进核心是假想缝；codex 无本地调度、OpenClaw 放 gateway，业内佐证 |
| gateway 保留自有 RPC 协议 | 两套协议永久并存，统一对 IM 线等于白做 |
| 客户端类型代码生成 | 全 TS 直接 import 即可；生成器是跨语言问题的解法，我们没有该问题 |

## 后果

- 系统有**两个 Wire 端点**：serve（项目会话）与 gateway（cron/账号/IM）。客户端按需连接；serve 直读 gateway 数据文件（jobs.json/status.json）的跨 seam 泄漏由 gateway Wire 端点取代。
- TUI 迁移成本最大，放最后；协议先被 web、桌面、IM 三个消费者打磨。协议宽度由 agent 关切决定，不由 TUI UI 细节决定。
- 删除目标：web-app wire-dto.ts（425 行镜像）、wire-types.ts shim、bridge 自定义 RPC 协议（agent-bridge/agent-transport 消息层）。
- 本 ADR 与 ADR-0001 兼容：0001 决定进程模型，本条决定其上运行的协议；两者正交。
