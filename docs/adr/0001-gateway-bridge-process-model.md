# Gateway-Bridge Process Model and Multi-Account Isolation

Gateway 将 IM 消息 routing 到 Agent 时，采用"一账号一进程"模型：每个 DingTalk 账号拥有一个独立的 `omp --mode rpc` 子进程，由 AgentBridge 管理。进程间通过 JSON-line RPC 协议（stdin/stdout）通信。

## 背景

Gateway 需要将多个 DingTalk 账号的消息转发到 Agent 处理。每个账号对应一个钉钉机器人，有独立的 appKey/appSecret、独立人格（mission.md）、独立 session 存储。此设计决定描述了 Agent 进程的托管模型。

## 决策

- 每个账号一个 `omp --mode rpc` 子进程，由 AgentBridge 实例管理（1:1）
- AgentBridge 负责 spawn、ready 信号等待、stdin/stdout 读写、crash 检测与恢复、熔断器
- 子进程生命周期绑定 Gateway 进程（V1）；V2 中可独立部署
- RPC 协议使用 JSON line 格式，每行一个 JSON 消息，通过 stdin 下发命令、stdout 接收事件
- Session 按 `agentDir/sessions/` 隔离，跨账号不共享

## 考虑过的方案

| 方案 | 问题 |
|---|---|
| 单进程共享 Agent，通过 switch_session 切换 | session/credential/mission 无法隔离；一个 crash 影响所有账号 |
| 每次请求 spawn 一个 `omp --print` 子进程 | 无 session 持久化，冷启动慢，无法流式输出 |
| Agent 进程通过 HTTP 暴露 API | 需要网络栈、认证、端口管理，V1 复杂度不必要 |

## 后果

- 每个账号约 30-60MB 额外内存（RPC 进程）
- AgentBridge 需管理进程生命周期（crash 恢复、指数退避、熔断）
- 进程间通信延迟在微秒级（pipe），可忽略
- V2 迁移路径：AgentBridge 抽离 spawn 逻辑，替换为网络连接，对上层（forward / executePrompt）接口不变