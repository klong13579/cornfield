---
name: omp 前后端分层优化(契约统一)
status: active
objective: 以 wire 为唯一对外契约收敛 omp 多前端(TUI/web/desktop/gateway),统一多端行为,预留多 agent 与企业化扩展点
doneWhen: |-
  - P0-P3 落地:事件白名单确定、AgentSession 拆分、TUI 走 wire、映射+快照测试红绿、两套接口面收口
  - 验收标准 1-3 通过:同能力 TUI/web 一致、新增前端零引擎改动、协议变更测试兜底
  - R1/R2/R4 就位:trace 贯穿、重连对账语义、控制面事件优先
lastActivity: 2026-08-21
sessionRefs: []
nextAction: P0 契约设计:确定事件白名单 + 整理 wire 类型 + 定版本升号约定(评审本 topic 后启动)
artifacts:
  - topics/omp-frontend-backend-layering.md
decisions:
  - 2026-08-21 决策倾向 codex 式严格分层,统一性优先;进程解耦不作为当前目标
openQuestions: []
---

# omp 前后端分层优化建议(契约统一路线)

> 状态:待评审 · 来源:codex 对比分析(两模型独立分析 + 合并)
> 日期:2026-08-22
> 决策倾向:采用 codex 式严格分层,以契约统一保证多端行为一致

## 背景

对 omp 与 OpenAI Codex CLI 的前后端分层做过两轮独立分析(Claude 系 + glm-5.3),合并结论:

- **统一性来自"单一契约 + 前端无特例",不是"进程分离"**。进程解耦是 codex 为实现多前端(IDE/桌面)的手段,omp 不应照抄。
- omp 现状缺口:TUI 与 web 走双契约(EventStream vs pi-wire)、AgentSession 7000+ 行 God Class、wire 类型已共享但实现靠 review 同步。
- omp 已具备:pi-wire 命令面 + 帧 + 版本握手、类型全链路共享(编译期校验)、slash 命令表已协议化、审批事件已走 wire(ApprovalCard/ClarifyCard)。

## 目标态架构

```
AgentSession/agent-loop (引擎)
      │  唯一对外面:wire 契约(命令 + 事件 + 类型)
      ▼
  wire 总线 (serve 进程内)
      ├─ TUI      ← 进程内走 wire(不直读 AgentSession)
      ├─ web-app  ← WS wire 客户端
      ├─ desktop  ← 壳,拉起 serve
      └─ gateway  ← 独立进程,跨进程 bridge(合法例外)
```

## 一、契约结构(7 条)

### S1. wire 升格为唯一对外契约 【最高优先】
TUI 从直读 AgentSession 改为消费 wire 总线,消灭双契约。EventStream 降级为引擎内部事件,不进对外面。

### S2. 事件范围白名单(先于一切动手的护栏)
- 会话级事件进协议:turn 状态、文本 delta、tool 调用、审批、子 agent 事件
- 渲染级细节绝不可进:光标、滚动、局部动画
- 没有白名单,TUI 切 wire 会把 EventStream 全细节协议化 = 再造流式协议,成本失控

### S3. AgentSession 拆解(TUI 切 wire 的前置)
按职责拆:会话状态 / 事件发射 / 上下文组装 / 工具注册。7284 行不拆,wir-server 就是第二个 God Class。

### S4. 类型↔handler 强制对应(替代引入 schema 生成)
- 事实:TS 全栈直接 import 共享类型,编译期校验已存在
- 缺:wire-server 60 个 case 手写分发,实现与类型靠 review 同步
- 补:命令/事件 → handler 映射测试,新增命令未实现或未登记 → 测试失败

### S5. gateway 桥接不动,两套合法接口面收口
跨进程 bridge 是架构事实不是债。收口 = 明确"进程内 wire"与"跨进程 bridge"是仅有的两套合法接口面,irc 散文消息、EventStream 直读旁路全部废除。

### S6. 协议预留 agent 通信原语(多 agent 教训)
参考 codex InterAgentCommunication(Spawn/Message/Followup/Result + 加密身份)。wire 契约现在就把子 agent 事件、agent 身份、通信消息的类型定进去,只定类型不实现。分层是底盘,现在不留位,后面做多 agent 必返工。

### S7. 进程解耦列为企业化前置项,现在不做
TUI 留在 serve 进程内走 wire 总线,统一性一分不少。企业化(多用户/审计/权限隔离)时再进程化。现在的成本花在契约上,不花在进程上。

## 二、运行健壮性(6 条)

### R1. 跨进程链路追踪——wire 帧带 trace id 【P0】
- 现状:pi-wire 帧只有 requestId(审批回指),无跨进程 trace;codex 用 W3C trace context 贯穿协议
- 建议:wire 帧加可选 trace 字段,serve/引擎/gateway 同一 trace 串联
- 收益:多端排障顺 trace 拉全链路日志;成本:一个字段 + 日志护栏

### R2. 重连对账语义 【P0】
- 现状:autoReconnect + session_snapshot 快照缓存("快照是权威源"),但断线期间事件如何补齐未定义
- 建议定死语义:重连 → 全量快照对账 → 断线期控制面事件(审批/错误)不丢、数据面事件(文本 delta)可合并丢弃
- 收益:手机/网页断网重连是常态,直接决定"重连后状态对不对、会不会漏审批"

### R3. 契约快照测试(wire golden 测试) 【P1】
- 所有 wire 命令/事件的 JSON 形态做 golden 快照,前端升级必跑
- 映射测试管"都实现了",快照测试管"形状没漂移",两者闭环

### R4. 控制面/数据面事件分级 【P0】
- 控制面事件(approval、clarify、error、permission)严格优先于数据面(文本流、token 计数)
- serve 慢消费者场景控制面不背压——审批卡片不迟到

### R5. 协议版本升号约定 【P2】
- 加字段 = 兼容(不升号);删字段/改语义 = 破坏性(必升号 + 双端同步窗口 + 兼容矩阵测试)
- 老 web-app 连新 serve 时版本不符即拒绝,而非静默错

### R6. 进程内免序列化双模式 【P3】
- 契约(类型)同源,传输分层:同进程直传对象引用(免 JSON),跨进程走序列化
- 统一性一分不少,TUI 交互零序列化开销

## 三、分阶段落地

| 阶段 | 内容 | 产出/验收 |
|---|---|---|
| P0 契约设计 | 事件白名单 + wire 类型整理 + agent 通信原语预留(只定类型)+ R5 版本约定 | 契约文档 + wire 类型变更,无行为改动 |
| P1 引擎侧收编 | 拆 AgentSession;会话级事件进 wire,渲染级留前端 | wire-server 覆盖全部会话能力;60 case 有归属 |
| P2 TUI 切 wire | TUI 走进程内 wire 总线,删 EventStream 直读旁路 | TUI 与 web 行为一致;同一能力无分叉 |
| P3 纪律固化 | 映射测试(S4)+ 快照测试(R3)+ 两套接口面收口 | 新增命令未登记 → 测试红;协议变更成本量化 |
| P4 可选(企业化) | TUI 进程化 + 权限/审计边界 + R1 trace 落地 | 安全模型就位 |

## 四、验收标准

1. 同一能力在 TUI 与 web 完全一致(改引擎一次,两个前端同行为)
2. 新增一个前端 = 纯客户端工作,引擎零改动
3. 协议变更成本量化:从"四处联动 + review 同步"变成"一处类型 + handler 登记,测试兜底"

## 参考对照(codex 侧对应物)

- 单一契约:codex-app-server-protocol(v2, ts-rs 生成 TS 类型)
- agent 通信原语:codex InterAgentCommunication(Spawn/Message/Followup/Result)
- 跨进程 trace:codex W3C trace context 贯穿 app-server 协议与 exec-server relay 帧
- 恢复语义:codex thread/resume + 分页恢复(omp R2 的对应物)
- 反面教材:codex spawn 槽位/residency 泄漏 issue 群(#34653/#18335/#34518 等)——omp 多 agent 实现时"子代理完成即回收、无幽灵占位"作为硬性验收标准
