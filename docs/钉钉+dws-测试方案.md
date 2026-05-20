# 钉钉 + dws 集成测试方案

| 项 | 说明 |
|---|------|
| 文档版本 | V1.0 |
| 适用方案 | docs/钉钉+dws-集成方案-V2.0.md, docs/钉钉+OMP-agent-team-设计方案-V1.1.md |
| 状态 | 草案 — 待评审 |

---

## 1. 概述

### 测试目标

对三阶段集成方案产出完整的测试覆盖，每个 Phase 可独立验证、独立交付。

### 测试范围

| Phase | 测试范围 | 不测 |
|-------|---------|------|
| Phase 1 — dws Skill | agent 在 prompt 引导下正确调用 dws CLI；安全规则执行；错误提示 | dws CLI 本身的正确性（钉钉官方负责）；非 dws 命令路径 |
| Phase 2 — RPC Mode | 补充已有测试遗漏的场景：错误路径、并发、生命周期、流式事件 | 已有测试覆盖的基础功能不重复 |
| Phase 3 — 全链路 | Agent Bridge 重构、DingTalk Stream Token 获取、dws 出站调用、RPC 进程管理 | 钉钉 Stream 协议正确性；dws CLI 自身稳定性 |

### 测试策略总览

| 层级 | 方式 | 适用 |
|------|------|------|
| Prompt 行为验证 | 构造 agent 输入 → 断言工具调用 | Phase 1 |
| Unit / Integration | bun:test, spyOn, fixture | Phase 2, Phase 3 |
| Mock 外部依赖 | shell stub 模拟 dws CLI, WebSocket mock 模拟 Stream | Phase 1, Phase 3 |
| E2E（可选） | 真实 dws + 真实 omp --mode rpc | Phase 2, Phase 3 验收 |

---

## 2. Phase 1 — dws Skill 测试

### 2.1 交付物

`packages/coding-agent/src/prompts/tools/dws.md` — 一份 prompt 文件，指导 agent 如何通过 bash 工具调用 dws CLI。**没有可执行代码**，因此无法通过传统单元测试验证。

### 2.2 验证方式

#### 方式 A：Agent 行为录制（人工验证）

在真实 omp 会话中执行典型场景，录制 agent 的工具调用序列，人工审查。

| 测试ID | 场景 | 用户输入 | 预期的 dws 命令 | 约束 |
|--------|------|---------|----------------|------|
| P1-01 | 搜索联系人 | "查张三的钉钉联系方式" | `dws contact user search --query 张三 --format json` | 无 |
| P1-02 | 查看今日日程 | "我今天有什么日程" | `dws calendar event list --format json` | 无 |
| P1-03 | 创建待办 | "帮我创建一个待办叫'Review PR'" | `dws todo task create --dry-run --title Review PR --format json` → 确认后执行 | dry-run 先行 |
| P1-04 | 发群消息 | "给测试群发消息说项目已发布" | `dws chat message send-by-bot --dry-run ... --format json` → 确认后发送 | 需用户确认 |
| P1-05 | 创建日程 | "明天10点创建开会日程" | `dws calendar event create --dry-run ... --format json` → 确认后执行 | dry-run 先行 |
| P1-06 | 搜索文档 | "搜索关于架构的钉钉文档" | `dws doc search --query 架构 --format json` | 无 |
| P1-07 | 查询审批 | "我的待审批有哪些" | `dws oa approval list-pending --format json` | 只读 |
| P1-08 | dws 未安装 | "查张三的联系方式"（dws 不存在时） | 引导安装：提供 `curl ... install.sh \| sh` | 不报错 |
| P1-09 | dws 未登录 | "查张三的联系方式"（dws 未 login） | 引导登录：`dws auth login --device` | 不报错 |
| P1-10 | 敏感操作 | "给张三发 DING 通知" | `dws ding message send --dry-run ...` + 要求用户确认 | 用户确认后执行 |

#### 方式 B：Prompt 结构审查（可自动化）

检查 `dws.md` 是否符合项目规范：

- [ ] 使用 Handlebars 条件语法（`{{#if}}`），对齐已有 prompt 风格
- [ ] 包含使用条件、前提检查、命令映射表
- [ ] 写操作（create/update/delete/send）明确要求 `--dry-run`
- [ ] 敏感操作（DING、审批）约束 agent 征得用户同意
- [ ] 包含 Schema 自省指引（`dws schema <command>`）
- [ ] 格式通过 Biome lint（已在 CI 中）

#### 方式 C：Self-Evolution 质量门禁

在 `packages/self-evolution/src/skill-batch-format.ts` 中添加标准：

```typescript
dws: {
  description: "Use when the user asks to access DingTalk product capabilities via the dws CLI.",
  acceptanceCriteria: "Correct DingTalk operation results using only verified IDs and fields from dws JSON output.",
  approachSubstance: 8,
  pitfallCoverage: 10,
  toolDiversity: 10,
  autonomy: 10,
}
```

### 2.3 验收条件

- [ ] P1-01 到 P1-07 经人工录制验证通过
- [ ] P1-08 和 P1-09 错误路径验证通过
- [ ] P1-10 敏感操作约束验证通过
- [ ] Prompt 格式审查通过
- [ ] Self-Evolution skill 质量评分通过（≥8 分）

---

## 3. Phase 2 — RPC Mode 测试

### 3.1 已有测试文件审查

| 文件 | 路径 | 覆盖内容 |
|------|------|---------|
| `rpc.test.ts` | `packages/coding-agent/test/rpc.test.ts` | getState、prompt + 等待、bash、compact、setModel、newSession、exportHtml、getLastAssistantText |
| `rpc-host-tools.test.ts` | `packages/coding-agent/test/rpc-host-tools.test.ts` | Host Tool 注册、execute、onUpdate |
| `rpc-client.start.test.ts` | `packages/coding-agent/test/rpc-client.start.test.ts` | 客户端启动成功/失败路径 |
| `rpc-mode-extension-ui.test.ts` | `packages/coding-agent/test/rpc-mode-extension-ui.test.ts` | Extension UI select/confirm/input/editor |

### 3.2 测试缺口

| 缺口类别 | 具体缺口 | 严重程度 |
|---------|---------|---------|
| **错误路径** | 非法 JSON、未知命令类型、参数缺失、命令执行异常 | 高 |
| **并发** | 多 session 同时 prompt、session 隔离性 | 高 |
| **生命周期** | SIGTERM 优雅退出、stdin EOF 自动退出、进程崩溃恢复 | 高 |
| **流式事件** | 事件时序（agent_start→message_start→tool_execution→message_end→agent_end）| 中 |
| **超时/取消** | AbortSignal 中断推理、Extension UI 超时 | 中 |
| **Host Tool 失败** | 工具返回 error、工具执行超时 | 中 |
| **Extension UI 取消** | 用户取消 select/confirm/input、多请求重叠 | 中 |

### 3.3 推荐新增测试

#### 新增文件 1: `test/rpc-error-paths.test.ts`

| 测试ID | 测试描述 | 前置条件 | 预期结果 | 优先级 |
|--------|---------|---------|---------|-------|
| RPC-E1 | 发送非法 JSON | RPC 进程运行中 | 服务端不崩溃，输出 parse error 响应 | 高 |
| RPC-E2 | 发送未知 command type | RPC 进程运行中 | 返回 `success: false` 响应 | 高 |
| RPC-E3 | prompt 后立即 abort | RPC 进程运行中 | 推理中断，agent_end 事件发出 | 高 |
| RPC-E4 | 关闭 stdin（EOF）| PID 文件存在 | 进程优雅退出，exit code 0 | 高 |

#### 新增文件 2: `test/rpc-concurrency.test.ts`

| 测试ID | 测试描述 | 前置条件 | 预期结果 | 优先级 |
|--------|---------|---------|---------|-------|
| RPC-C1 | 两个 session 同时 prompt | sessionId A 和 B 隔离 | 两路推理互不干扰 | 高 |
| RPC-C2 | prompt 中发起第二个 prompt | 第一个 prompt 进行中 | 第二个被排队或 reject | 中 |

#### 新增文件 3: `test/rpc-lifecycle.test.ts`

| 测试ID | 测试描述 | 前置条件 | 预期结果 | 优先级 |
|--------|---------|---------|---------|-------|
| RPC-L1 | SIGTERM 发出后 | RPC 进程运行中 | 进程退出，exit code 0 | 高 |
| RPC-L2 | 发送多个 prompt 并发后关闭 stdin | 多个 prompt 执行中 | 所有 prompt 完成后优雅退出 | 中 |
| RPC-L3 | RPC 启动后立即 stop | 进程启动中 | 进程退出，资源清理 | 中 |

#### 更新文件 1: `test/rpc.test.ts`

增加测试：

| 测试ID | 测试描述 | 预期结果 | 优先级 |
|--------|---------|---------|-------|
| RPC-S1 | `get_messages` 命令验证 | 返回完整消息列表 | 中 |
| RPC-S2 | `set_steering_mode` + `set_follow_up_mode` | 模式切换生效 | 中 |
| RPC-S3 | `set_auto_compaction` + `set_auto_retry` | 设置生效 | 低 |

### 3.4 验收条件

- [ ] 新增的 3 个测试文件通过
- [ ] 现有 4 个测试文件不退化
- [ ] 全部 RPC 测试可通过 `bun test rpc` 运行
- [ ] 测试不依赖真实 LLM API（ut 用 mock，e2e 用 `describe.skipIf`）

---

## 4. Phase 3 — 全链路测试

### 4.1 模块划分

| 模块 | 变更 | 测试重点 |
|------|------|---------|
| `agent-bridge.ts` | spawn `omp -p` → `RpcClient` | RPC 进程管理、消息收发 |
| `channels/dingtalk.ts` | 修复 Token 获取、Stream 协议 | 认证、消息解析、出站 |
| `gateway.ts` | RPC 进程生命周期 | spawn、心跳、重启 |
| 出站 | REST API → `dws send-by-bot` | dws 调用、错误处理 |

### 4.2 测试用例

#### Agent Bridge 测试 (`test/agent-bridge-rpc.test.ts`)

| 测试ID | 测试描述 | 前置条件 | 步骤 | 预期结果 | 优先级 |
|--------|---------|---------|------|---------|-------|
| AB-01 | RpcClient spawn omp --mode rpc | dws 可用 | spawn → 等待 ready | 进程启动，`ready` 信号发出 | 高 |
| AB-02 | 通过 RPC 发送消息并获取回复 | RPC 进程运行中 | prompt("你好") → waitForIdle | 收到 agent_end 事件 | 高 |
| AB-03 | 多轮会话保持上下文 | RPC 进程运行中 | prompt("我的名字是张三") → prompt("我叫什么") | 第二次回复包含"张三" | 高 |
| AB-04 | RPC 进程崩溃后自动重启 | RPC 进程运行中 | kill RPC 进程 → 等待重启 | 新进程就绪，新消息正常处理 | 高 |
| AB-05 | 并发消息排队 | RPC 进程运行中 | 连续发 5 条 prompt | 按 FIFO 顺序处理 | 中 |
| AB-06 | RPC 连接超时 | dws 不存在 | client.start() | 抛出连接错误 | 高 |
| AB-07 | 空消息过滤 | RPC 进程运行中 | 发送空字符串 | 不调用 agent，返回 null | 中 |
| AB-08 | 消息截断（超过 2000 字）| RPC 进程运行中 | 发送 >2000 字回复 | 截断 + 附加截断提示 | 中 |

#### DingTalk Channel 测试 (`test/dingtalk-channel.test.ts`)

| 测试ID | 测试描述 | 前置条件 | 步骤 | 预期结果 | 优先级 |
|--------|---------|---------|------|---------|-------|
| DC-01 | Stream 注册成功 | mock Stream 服务 | 发送 register 请求 | 收到 endpoint + ticket | 高 |
| DC-02 | Stream WebSocket 连接 | mock 服务返回有效 endpoint | 连接 WebSocket | onopen 触发 | 高 |
| DC-03 | 收到 Stream 消息并 ACK | WebSocket 已连接 | 收到消息 payload | 发送 ACK（code 200）| 高 |
| DC-04 | 解析 dingtalk 消息 | mock 消息 payload | parseRawMessage | 正确提取 userId、conversationId、text | 高 |
| DC-05 | 群消息 / 单聊消息识别 | mock 两种 conversationType | parseRawMessage | 正确设置 isGroup | 中 |
| DC-06 | Token 获取失败（OAuth 错误）| 无效 appKey/appSecret | registerAndConnect | 错误日志 + 10s 后重试 | 高 |
| DC-07 | WebSocket 断开后自动重连 | WebSocket 已连接 | 断开连接 | 5s 后重新注册 | 高 |
| DC-08 | 出站 dws send-by-bot 调用 | 正确配置 | sendMessage() | spawn dws 命令 + 参数正确 | 高 |
| DC-09 | dws send 失败处理 | dws 命令失败 | sendMessage() 遇到错误 | 记录结构化错误日志，不无限重试 | 高 |

#### Gateway 生命周期测试 (`test/gateway-lifecycle.test.ts`)

| 测试ID | 测试描述 | 前置条件 | 步骤 | 预期结果 | 优先级 |
|--------|---------|---------|------|---------|-------|
| GW-01 | Gateway 启动 | 有效 config | gateway.start() | 所有 enabled channel 连接 | 高 |
| GW-02 | Gateway 停止 | gateway 运行中 | gateway.stop() | 所有 channel 断开，store 关闭 | 高 |
| GW-03 | 收到消息 → 创建 session | 无活跃 session | 收到 dingtalk 消息 | 新 session 创建，后续消息复用 | 高 |
| GW-04 | Session 超时关闭 | session 空闲超时 | 等待 idleTimeout | session 状态变为 closed | 中 |
| GW-05 | 多 route channel 隔离 | dingtalk + 其他 channel | 两 channel 同时消息 | session 按 channelId 隔离 | 高 |

### 4.3 Mock 策略

| 外部依赖 | Mock 方式 | 说明 |
|---------|---------|------|
| dws CLI | shell stub 脚本 | `test/fixtures/mock-dws.sh` — 输出预定义 JSON，接收参数校验 |
| DingTalk Stream | WebSocket mock | `ws://localhost` 上跑一个 mock server，回复预设的 Stream payload |
| OMP RPC | 直接实例化 `RpcClient` | 连接真实的 `omp --mode rpc` 进程（同进程内） |
| API Key | `e2eApiKey("ANTHROPIC_API_KEY")` | 有则跑 e2e，无则 skip（已有模式） |

**mock-dws.sh 示例**：

```bash
#!/bin/bash
# Mock dws CLI for testing
case "$1 $2" in
  "contact user")
    echo '{"code":0,"result":[{"name":"张三","userId":"user_001"}]}'
    ;;
  "calendar event")
    echo '{"code":0,"result":[{"summary":"测试会议","start":"2025-06-01T10:00"}]}'
    ;;
  "todo task")
    echo '{"code":0,"result":{"id":"todo_001"}}'
    ;;
  *)
    echo '{"code":-1,"message":"mock: unknown command"}'
    ;;
esac
```

### 4.4 验收条件

- [ ] AB-01 到 AB-08 测试通过
- [ ] DC-01 到 DC-09 测试通过（Stream mock 可用）
- [ ] GW-01 到 GW-05 测试通过
- [ ] mock-dws.sh 可独立验证
- [ ] 全部测试可通过 `bun test packages/pi-gateway` 运行

---

## 5. 边界条件和错误路径清单

### 5.1 输入边界

| 边界 | 测试场景 | 所属 Phase |
|------|---------|-----------|
| 空消息 | agent-bridge 收到空字符串 / 纯空白 | Phase 3 |
| 超长消息 | 超过 dws 或 LLM 限制 | Phase 3 |
| 特殊字符 | markdown 注入、路径遍历、Unicode | Phase 1 |
| 重复消息 | 钉钉 Stream 重放同一消息（幂等）| Phase 3 |

### 5.2 网络边界

| 边界 | 测试场景 | 所属 Phase |
|------|---------|-----------|
| Stream 断连 | WebSocket 意外断开 | Phase 3 |
| 出站超时 | dws 命令超时（`--timeout`）| Phase 3 |
| DNS 失败 | 钉钉 API 无法解析 | Phase 3 |
| 速率限制 | 钉钉 API 429 | Phase 3 |

### 5.3 进程边界

| 边界 | 测试场景 | 所属 Phase |
|------|---------|-----------|
| RPC 进程崩溃 | `omp --mode rpc` 异常退出 | Phase 3 |
| dws 未安装 | `$ which dws` 失败 | Phase 1 |
| dws 旧版本 | 命令参数不兼容 | Phase 1 |

### 5.4 权限边界

| 边界 | 测试场景 | 所属 Phase |
|------|---------|-----------|
| Token 过期 | dws OAuth token 过期 | Phase 1 |
| 机器人未入群 | send-by-bot 目标群无机器人 | Phase 1 |
| 应用无权限 | 调用了未授权的 API | Phase 3 |

### 5.5 推荐错误注入测试

| 场景 | 注入方式 | 预期行为 |
|------|---------|---------|
| dws 返回非 JSON | mock 返回 "error" | agent 报告解析失败 |
| Stream 发送格式错误的 payload | mock 发送截断 JSON | gateway 记录错误日志，不崩溃 |
| RPC 进程退出码非 0 | kill -9 | pi-gateway 指数退避重启 |
| 连续快速消息（burst）| 1 秒内发送 20 条 | 队列限流，不丢消息 |

---

## 6. 测试基础设施建议

### 6.1 Mock dws CLI

建议建一个 shell 脚本 stub，放在 `test/fixtures/mock-dws.sh`：

```bash
# 用法：PATH=test/fixtures:$PATH dws contact user search --query "张三"
# 输出预设 JSON，不调用真实 API
```

测试中通过设置 `PATH` 环境变量注入 mock。

### 6.2 Mock DingTalk Stream

由于 Stream 协议需要 WebSocket 连接，建议：

- **短期**：使用 fixture JSON 文件模拟入站消息，直接调用 `DingTalkChannel.#handleStreamMessage()`
- **长期**：跑一个简单的 WebSocket mock server（用 Bun 内置 `Bun.serve` + WebSocket）

### 6.3 RPC 测试 Setup/Teardown

```typescript
// 通用 setup
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-test-"));
  client = new RpcClient({
    cliPath: "dist/cli.js",
    cwd: projectRoot,
    env: { PI_CODING_AGENT_DIR: tempDir },
    provider: "anthropic",
    model: "claude-sonnet-4-5", // 或 mock provider
  });
});

afterEach(() => {
  client?.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
```

### 6.4 CI 集成

| Phase | CI 阶段 | 命令 | 条件 |
|-------|--------|------|------|
| Phase 1 | lint | `bun check:ts`（prompt 文件格式检查）| 总是运行 |
| Phase 2 | test | `bun test rpc` | 总是运行（ut 部分）；有 API Key 时跑 e2e |
| Phase 3 | test | `bun test packages/pi-gateway` | 总是运行 |
| Phase 1+3 | manual | tmux 录制验证 | 开发环境 |

---

## 7. 测试优先级和时间估算

| 优先级 | 测试内容 | 估算人天 | 说明 |
|--------|---------|---------|------|
| P0 | RPC 错误路径 + 生命周期测试 | 2d | 已有 RPC 代码的核心缺口 |
| P0 | Phase 1 agent 行为录制验证 | 1d | dws Skill 的唯一验证方式 |
| P1 | Agent Bridge RpcClient 集成测试 | 1d | Phase 3 核心变更 |
| P1 | DingTalk Channel mock 测试 | 1.5d | Stream 协议对齐的关键验证 |
| P2 | RPC 并发测试 | 0.5d | 常驻进程核心约束 |
| P2 | Gateway 生命周期测试 | 0.5d | 进程管理验证 |
| P3 | 全链路 E2E（可选）| 1d | 仅在有真实凭证时执行 |