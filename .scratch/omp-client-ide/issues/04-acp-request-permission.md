# 04: OMP AcpAgent 补发 requestPermission（审批链发射侧）

**What to build:** 让 omp agent 在 ACP 会话（IDE 内对话）里能向人发起权限请求——agent 需要审批时（写危险路径/跑命令/对外操作）向 OpenSumi 客户端发 ACP `requestPermission`（agent→client 单向方法，OpenSumi 侧处理器与权限规则已存在，spike 已证）。当前 AcpAgent 不发射、不声明权限能力，审批链在 ACP 模式是断的。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**File scope:** packages/coding-agent（modes/acp/acp-agent.ts + 相关事件映射），扩展 acp-session-test 模式覆盖 requestPermission 帧。

- [ ] 扩展 ACP 会话测试：agent 触发需审批操作时发出 requestPermission 帧，客户端响应决策后 agent 收到结果
- [ ] 既有 acp-smoke / acp-session-test 全绿（不回归）
- [ ] 决策（allow once / reject once）能正确流回 agent 侧并影响工具执行

---
*来源：spec Implementation Decision #5 + User Story 22；spike-opensumi-verdict 集成点 #7*
