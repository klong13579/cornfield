# RPC Host Tool 机制详解

> 配套文档：[RPC Protocol Reference](./rpc.md#host-tool-sub-protocol)
>
> 本文是对 `docs/rpc.md` 中 "Host Tool Sub-Protocol" 一节的深度展开，聚焦完整生命周期、id 关联、状态机与实战注意事项。

---

## 目录

- [一、整体定位](#一整体定位)
- [二、生命周期五阶段](#二生命周期五阶段)
  - [阶段 1：注册](#阶段-1注册)
  - [阶段 2：模型决策](#阶段-2模型决策)
  - [阶段 3：调用发起](#阶段-3调用发起)
  - [阶段 4：流式进度](#阶段-4流式进度可选)
  - [阶段 5：完成](#阶段-5完成)
- [三、完整时序图](#三完整时序图)
- [四、状态机](#四状态机)
- [五、字段对照表](#五字段对照表)
- [六、id 关联关系](#六id-关联关系最易混的部分)
- [七、关键设计点与常见坑](#七关键设计点--常见坑)
- [八、最简实现示例](#八最简实现示例)

---

## 一、整体定位

host_tool 是 RPC 模式里**宿主进程向 agent 注入执行能力**的机制。它让 agent 从"只能用 omp 内置工具"变成"可以调用宿主提供的任何能力"——查数据库、调内部 API、操作 IDE、控制浏览器，全部走这个口子。

```
┌─────────────────────────────────────────────────────────────┐
│                       Agent (omp 进程)                       │
│                                                              │
│   ┌─────────────────┐        ┌──────────────────────────┐    │
│   │  内置工具        │        │  host_tool（宿主注入）    │    │
│   │  read, bash,    │  +     │  create_jira,            │    │
│   │  edit, grep...  │        │  query_db, deploy...     │    │
│   └─────────────────┘        └──────────────────────────┘    │
│            │                            │                     │
│            │ 本进程执行                  │ 跨进程回调           │
└────────────┼────────────────────────────┼─────────────────────┘
             │                            │
             ↓                            ↓
       文件系统/Shell              stdio (host_tool_call)
                                          │
                                          ↓
                              ┌──────────────────────────┐
                              │  宿主进程                 │
                              │  实际执行工具逻辑          │
                              │  (调 API/DB/IDE...)      │
                              └──────────────────────────┘
```

**核心抽象：** 模型只看到「工具名 + 描述 + JSON Schema」，跟调用内置工具感觉完全一样。区别在于执行路径——内置工具是 omp 内部直接跑，host_tool 是把请求扔回宿主等结果。

---

## 二、生命周期五阶段

### 阶段 1：注册

**方向：** 宿主 → agent（stdin）
**命令：** `set_host_tools`

```
宿主进程                              omp 进程
  │                                     │
  │ {type:"set_host_tools", tools:[...]}│
  ├────────────────────────────────────→│
  │                                     │ 写入 session 工具注册表
  │                                     │ 下次模型调用时把工具 schema
  │                                     │ 注入到 LLM 的 tools 列表
  │ {type:"response", success:true,     │
  │  data:{toolNames:["..."]}}          │
  │←────────────────────────────────────┤
```

**关键特性：**

- **全量替换**，不是增量。再次发送会清空之前的工具集
- 作用域是**当前 session**，切会话后必须重新注册
- `description` 字段是**模型判断是否调用的唯一依据**，要写清楚「做什么、何时用、返回什么」
- `parameters` 是 JSON Schema 7，模型严格按它生成参数

### 阶段 2：模型决策

omp 把宿主注入的工具 schema 跟内置工具 schema 合并，统一塞给 LLM。LLM 在推理时决定是否调用：

```
LLM 看到：
  - read (内置)：读本地文件
  - bash (内置)：执行 shell 命令
  - create_jira (host)：在 Jira 创建工单
  - deploy_to_staging (host)：部署到 staging 环境

LLM 思考：用户要修 bug，应该先建工单跟踪
LLM 输出 tool_call: { name: "create_jira", arguments: {...} }
```

omp 的 agent loop 检查这个 tool_call 的名字，发现是 host_tool，**不直接执行**，走阶段 3。

### 阶段 3：调用发起

**方向：** agent → 宿主（stdout）

```
宿主进程                              omp 进程                    LLM
  │                                     │                          │
  │                                     │ tool_call 来了            │
  │                                     │ 检查是 host_tool          │
  │                                     │ 生成 host frame id        │
  │ {type:"host_tool_call",             │                          │
  │  id:"host_1",                       │                          │
  │  toolCallId:"toolu_xyz",            │                          │
  │  toolName:"create_jira",            │                          │
  │  arguments:{...}}                   │                          │
  │←────────────────────────────────────┤                          │
  │                                     │                          │
  │ 收到请求，路由到对应处理函数          │                          │
  │ 执行工具（可能耗时）                 │                          │
  │                                     │                          │
```

**字段含义：**

- `id`：**RPC 帧 id**，宿主必须在 result 里原样回传
- `toolCallId`：**LLM 层的 tool call id**，写到消息历史的 tool_calls 数组里用
- `toolName`：调哪个工具
- `arguments`：模型生成的参数

### 阶段 4：流式进度（可选）

**方向：** 宿主 → agent（stdin）
**命令：** `host_tool_update`

适合**耗时操作**（部署、跑测试、长查询），让模型能拿到中间状态：

```
宿主进程                                omp 进程
  │                                       │
  │ 工具执行中...                          │
  │                                       │
  │ {type:"host_tool_update",             │
  │  id:"host_1",                         │
  │  partialResult:{                      │
  │    content:[{type:"text",             │
  │             text:"部署进度 30%..."}]}}│
  ├──────────────────────────────────────→│
  │                                       │ 追加到当前 tool_call
  │                                       │ 的 partialResult
  │                                       │ （不进消息历史）
  │                                       │
  │ {type:"host_tool_update",             │
  │  id:"host_1",                         │
  │  partialResult:{content:[...]}}       │
  ├──────────────────────────────────────→│
  │                                       │
  │ 继续执行...                            │
```

**注意：** `partialResult` 不会写入消息历史，只在当前 tool 执行期间可见。最终结果还是看 `host_tool_result`。

### 阶段 5：完成

**方向：** 宿主 → agent（stdin）
**命令：** `host_tool_result`

```
宿主进程                                omp 进程
  │                                       │
  │ {type:"host_tool_result",             │
  │  id:"host_1",                         │
  │  result:{content:[{type:"text",       │
  │                   text:"OMP-1234 创建成功"}]}}│
  ├──────────────────────────────────────→│
  │                                       │ 把 result 追加到消息历史
  │                                       │ 作为 tool 调用的返回
  │                                       │ 继续 agent loop，调 LLM
  │                                       │ 让模型基于结果继续推理
  │                                       ├──────────────────────────→│
```

**错误情况：** 顶层加 `isError: true`：

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "isError": true,
  "result": {
    "content": [{"type": "text", "text": "权限不足"}]
  }
}
```

模型会把这个 text 当作 tool error 看到，可能换策略重试或放弃。

---

## 三、完整时序图

### 正常完成

```
宿主             omp 进程              LLM
 │                  │                   │
 │ set_host_tools   │                   │
 ├─────────────────→│                   │
 │                  │ 注册工具           │
 │                  │                   │
 │ prompt           │                   │
 ├─────────────────→│                   │
 │                  │ agent_start       │
 │                  │ message_start     │
 │                  │ tool_call 决策    │
 │                  ├──────────────────→│
 │                  │                   │ 输出 tool_call
 │                  │←──────────────────┤
 │                  │                   │
 │ host_tool_call   │                   │
 │←─────────────────┤                   │
 │                  │                   │
 │ 执行工具          │                   │
 │ host_tool_update │                   │
 ├─────────────────→│ (可选，多个)        │
 │ host_tool_update │                   │
 ├─────────────────→│                   │
 │                  │                   │
 │ host_tool_result │                   │
 ├─────────────────→│                   │
 │                  │ tool result 进历史 │
 │                  │ 继续 LLM 推理      │
 │                  ├──────────────────→│
 │                  │←──────────────────┤
 │ message_update   │                   │
 │←─────────────────┤                   │
 │ ...              │                   │
 │ agent_end        │                   │
 │←─────────────────┤                   │
```

### 中途取消

```
宿主             omp 进程              LLM              用户
 │                  │                   │                │
 │                  │ host_tool_call 之后                  │
 │                  │ 正在等待 result   │                │
 │                  │                   │                │
 │                  │                   │                │ Ctrl+C
 │                  │                   │                │
 │                  │ 收到 abort         │                │
 │                  │ 取消正在执行的     │                │
 │                  │ tool call          │                │
 │                  │                   │                │
 │ host_tool_cancel │                   │                │
 │←─────────────────┤                   │                │
 │                  │                   │                │
 │ (宿主应停止执行   │                   │                │
 │  并清理资源)      │                   │                │
 │                  │                   │                │
```

**注意：** `host_tool_cancel` 是 omp 单方面通知宿主停止，**宿主没有义务 ack**。如果宿主已经在执行一个不可中断的操作（比如发出去的 HTTP 请求），它可以选择忽略 cancel，等执行完照样发 `host_tool_result`——omp 会忽略迟到的 result。

---

## 四、状态机

```
        ┌─────────┐
        │  idle   │ ←── set_host_tools 之后进入 ready 状态
        └────┬────┘
             │ LLM 决定调用
             ↓
    ┌────────────────┐
    │ tool_called    │ ←── omp 已发 host_tool_call，等待宿主响应
    └─┬──────┬───────┘
      │      │
      │      │ 用户 abort / turn 中断
      │      ↓
      │   ┌─────────────┐
      │   │ cancelled   │ ←── omp 发 host_tool_cancel，强制结束
      │   └─────────────┘
      │
      │ 宿主发 host_tool_update（可选，0 到 N 次）
      ↓
    ┌──────────────┐
    │  executing   │ ←── 宿主正在执行，可以流式报告进度
    └─┬────────┬───┘
      │        │
      │        │ 宿主发 host_tool_result
      │        ↓
      │   ┌─────────┐
      │   │  done   │ ←── 结果进入消息历史，agent loop 继续
      │   └─────────┘
      │
      │ (cancelled 也可强行结束 executing)
      └─→ cancelled
```

---

## 五、字段对照表

| 字段 | 在哪端 | 含义 | 备注 |
|---|---|---|---|
| `id` | `host_tool_call` 上 | RPC 帧 id | 宿主在 result/update 上原样回传 |
| `toolCallId` | `host_tool_call` 上 | LLM 层 tool call id | 写到消息历史，宿主不需要用 |
| `id` | `host_tool_update` 上 | 关联到 host_tool_call | 必须是 `host_tool_call.id` |
| `id` | `host_tool_result` 上 | 关联到 host_tool_call | 必须是 `host_tool_call.id` |
| `id` | `host_tool_cancel` 上 | RPC 帧 id（新生成） | 跟被取消的 call id 无关 |
| `targetId` | `host_tool_cancel` 上 | 指向要取消的 call | 必须是 `host_tool_call.id` |
| `isError` | `host_tool_result` 上 | 标记工具失败 | 顶层字段，非 result 内 |
| `partialResult` | `host_tool_update` 上 | 中间结果 | 不进消息历史 |
| `result` | `host_tool_result` 上 | 最终结果 | 进消息历史，作为 tool 返回 |

---

## 六、id 关联关系（最易混的部分）

```
LLM 输出:
  message.tool_calls = [
    { id: "toolu_xyz", function: {name:"create_jira", arguments:"..."} }
  ]
                          │
                          │ omp 包装
                          ↓
agent → 宿主:
  {
    id: "host_1",           ← RPC 帧 id（omp 生成）
    toolCallId: "toolu_xyz", ← LLM 层 id（透传）
    toolName: "create_jira",
    arguments: {...}
  }
                          │
                          │ 宿主回包
                          ↓
宿主 → agent:
  {
    id: "host_1",           ← 必须等于 host_tool_call.id
    result: {...}
  }
                          │
                          │ omp 处理
                          ↓
消息历史中:
  tool_use {
    id: "toolu_xyz",       ← 用 toolCallId
    name: "create_jira",
    input: {...}
  }
  tool_result {
    tool_use_id: "toolu_xyz", ← 关联到上面的 tool_use
    content: [...]
  }
```

**记忆口诀：**

- `id` 是 **RPC 协议层**的关联，宿主用
- `toolCallId` 是 **LLM 消息层**的关联，omp 用来写历史

---

## 七、关键设计点 & 常见坑

### 设计点

1. **工具描述即 prompt 工程**

   `description` 写得烂，模型就不知道什么时候该调。应该写清楚：动词、适用场景、返回内容、注意事项。

2. **注册是状态，不是握手**

   `set_host_tools` 不是一次性的 RPC，是**修改 session 状态**。后续每次模型调用都基于当前注册的工具集。

3. **错误也是信息**

   工具失败时用 `isError: true` + 清晰的 text，模型会基于错误信息自己决定重试、换工具或放弃。**不要吞掉错误**。

4. **流式更新不进历史**

   `host_tool_update` 的内容是「实时进度条」性质，不污染消息历史。最终结果必须通过 `host_tool_result` 给到。

5. **取消是 best-effort**

   `host_tool_cancel` 是建议性通知，宿主有能力拒绝。设计工具时把操作设计成可中断的（长循环检查取消标志）。

### 常见坑

| 坑 | 表现 | 解决 |
|---|---|---|
| `description` 写得太短 | 模型从不调用 | 写「用于 X 场景，做 Y，返回 Z」 |
| 重复 `set_host_tools` | 之前的工具消失 | 宿主维护完整列表，每次全量发 |
| 切会话后工具消失 | 模型报错工具不存在 | 切完会话重新注册 |
| 多个并发 host_tool_call 用错 id | 结果串了 | 每次 call 都用唯一 id，宿主维护 id→handler 映射 |
| 工具返回巨大对象 | 上下文爆炸 | 工具内部做摘要/截断 |
| `partialResult` 当成 final 用 | 模型拿到中间值以为完成了 | 只用 `host_tool_result` 终结 |
| 忽略 `host_tool_cancel` | 用户取消了还继续执行 | 工具实现要响应取消事件 |
| 参数 schema 不严格 | 模型传错类型 | 严格 JSON Schema，宿主端再做一次校验 |

---

## 八、最简实现示例

```typescript
// === 宿主进程 ===
class HostToolServer {
  handlers = new Map<string, (args: any) => Promise<any>>();

  register(definition: ToolDef, handler: Function) {
    this.handlers.set(definition.name, handler);
  }

  start(ompStdin, ompStdout) {
    // 注册工具到 omp
    ompStdin.write({
      type: "set_host_tools",
      tools: Array.from(this.handlers.entries()).map(([name, h]) => h.definition)
    });

    // 处理 omp 来的请求
    readJsonl(ompStdout).onFrame(async (frame) => {
      if (frame.type === "host_tool_call") {
        const handler = this.handlers.get(frame.toolName);
        try {
          const result = await handler(frame.arguments);
          ompStdin.write({
            type: "host_tool_result",
            id: frame.id,        // 原样回传
            result: { content: [{ type: "text", text: JSON.stringify(result) }] }
          });
        } catch (err) {
          ompStdin.write({
            type: "host_tool_result",
            id: frame.id,
            isError: true,
            result: { content: [{ type: "text", text: err.message }] }
          });
        }
      }
    });
  }
}

// 使用
const server = new HostToolServer();
server.register(
  { name: "get_weather", description: "查询某城市天气", parameters: {...} },
  async (args) => fetch(`https://api.weather.com/${args.city}`).then(r => r.json())
);
server.start(process.stdout, process.stdin);  // 反向，因为 omp 才是从外部 spawn 的
```
