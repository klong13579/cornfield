# MOA Worker Execution 模式切换方案

## 目标

在 `packages/moa-extension` 中新增可配置的 worker 执行模式：

- `subprocess`：保留当前实现，继续通过 `omp --mode json -p` 起子进程
- `in-process`：在当前 Bun 进程内复用 `pi-coding-agent` 会话执行 worker

目标是两点：

1. 给 MOA 一个可切换的执行 seam，而不是把子进程路径删掉
2. 在 `in-process` 模式下显著降低内存占用

## 非目标

这次不做下面几件事：

- 不修改 MOA 的 planner/domain model
- 不扩大 worker 能力边界
- 不改变默认模式（默认仍是 `subprocess`，保证向后兼容）
- 不把 MOA 的自定义输出 schema 接到 `createAgentSession({ outputSchema })`

---

## 结论先说

原计划方向对，但有 4 个必须先修正的点，否则实现会和当前 subprocess 行为不一致：

1. `systemPrompt` 不能直接 replace，必须 append 到 OMP 默认系统提示词后面
2. model 解析不能自造 `parseModelString + find`，必须复用 coding-agent 现有解析链
3. `thinkingLevel` 不能降成布尔语义，必须保留原始字符串透传
4. `@oh-my-pi/pi-coding-agent` 不应默认从 peerDependency 改成 dependency

基于这些修正，下面是可执行版方案。

---

## 设计原则

### 1. 一个 seam，两种 adapter

新增一个小接口，把 executor 和执行细节隔开：

```ts
interface MoaWorkerEngine {
	execute(input: MoaWorkerEngineInput): Promise<WorkerOutput>;
}
```

两个 adapter：

- `SubprocessWorkerEngine`
- `InProcessWorkerEngine`

这样 executor 只关心 `WorkerOutput`，不关心到底是 `Bun.spawn()` 还是 `AgentSession`。

### 2. 行为等价优先，能力收缩要显式声明

这次改动的核心是 **execution mode 切换**，不是顺手重做 worker 能力模型。

因此：

- 默认模式保持 `subprocess`
- 已有工具能力边界优先保持不变
- 如果 `in-process` 第一版故意更保守，必须在计划和 README 里明确写出来，不能暗改

### 3. 风险最小化

`in-process` 第一版只做当前 MOA 真正在用的能力：

- tools=`none`：discovery / rewrite / synthesis
- tools=`["read", "search", "find", "web_search", "ast_grep"]`：3 个主 worker

不在这一版里引入新工具，不放大边界。

---

## 配置设计

### `MoaSettings` 新增字段

```ts
workerExecutionMode: "subprocess" | "in-process";
```

### 默认值

```ts
workerExecutionMode: "subprocess";
```

理由：

- 完全向后兼容
- 现网/现有用户无行为变化
- `in-process` 作为 opt-in 实验路径上线更稳

### 配置来源

延续现有优先级：

1. `PI_MOA_SETTINGS_JSON`
2. `moa.yml` / `moa.yaml` / `moa.json`
3. `DEFAULT_SETTINGS`

### 非法值处理

`resolveSettings()` 里必须归一化：

- `"subprocess"` -> `"subprocess"`
- `"in-process"` -> `"in-process"`
- 其它值 -> fallback 到默认值，并记录 warning

不能直接把 loader parse 出来的字符串当真。

---

## 模块拆分

### 保留

- `src/subprocess.ts`：现有子进程路径，保持原状

### 新增

- `src/worker-engine.ts`

建议这里放两件事：

1. `createWorkerEngine(mode, shared)`：按配置返回 adapter
2. `InProcessWorkerEngine`：封装 in-process 执行逻辑

### executor 侧

`executor.ts` 不再直接调用 `spawnMoaWorker()`，而是：

```ts
const engine = createWorkerEngine(settings.workerExecutionMode, {
	authStorage: options.authStorage,
	modelRegistry: options.modelRegistry,
	settings: options.settings,
	cwd: options.cwd,
});

const result = await engine.execute(...);
```

这样后续如果要加第三种模式，也不需要再改 executor 主流程。

---

## In-Process 路径设计

## 1. 共享资源

`in-process` worker 复用父调用方传入的：

- `authStorage`
- `modelRegistry`
- `settings`
- `cwd`

注意：`cwd` 必须显式传给 `createAgentSession()`，不能依赖默认 `getProjectDir()`。

```ts
createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	settings,
	...
})
```

否则 context file / prompt template / 相对路径工具行为都可能漂移。

## 2. model 解析

这里不能自己发明：

```ts
parseModelString(requested)
modelRegistry.find(provider, id)
```

原因：当前 subprocess 路径是把原始 model string 直接交给 CLI，支持：

- `provider/id`
- alias
- role/default selector
- coding-agent 现有解析链能处理的其它形式

如果 in-process 自己只认 `provider/id`，就会和 subprocess 路径不一致。

### 正确做法

优先复用 `createAgentSession` 的已有入口：

```ts
createAgentSession({
	modelPattern: requestedModelString,
	...
})
```

而不是自己先解析成 `Model`。

只有在调用方本来就已经拿到了 `Model` 对象时，才传 `model`。

## 3. thinkingLevel

必须保留现有字符串语义，原样透传：

```ts
thinkingLevel?: string; // off|minimal|low|medium|high|xhigh
```

不能降维成布尔值。

## 4. systemPrompt

这是原计划里最大的坑。

当前 subprocess 路径不是替换系统提示词，而是：

- 先走 OMP 默认系统 prompt
- 再通过 `--append-system-prompt` 追加 worker prompt

所以 in-process 路径必须保持这个语义：

```ts
systemPrompt: defaultPrompt => `${defaultPrompt}\n\n${workerSystemPrompt}`
```

绝不能：

```ts
systemPrompt: workerSystemPrompt
```

否则会把默认工具协议、行为约束、基础系统规则整个抹掉。

## 5. 会话最小化配置

`in-process` worker 会话使用：

```ts
createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	settings,
	modelPattern,
	thinkingLevel,
	systemPrompt: defaultPrompt => `${defaultPrompt}\n\n${workerSystemPrompt}`,
	sessionManager: SessionManager.inMemory(),
	disableExtensionDiscovery: true,
	skills: [],
	enableMCP: false,
	enableLsp: false,
	skipPythonPreflight: true,
	hasUI: false,
	toolNames,
})
```

### 关于 `disableExtensionDiscovery`

这不是纯性能优化，而是**显式的行为收缩**：

- `in-process` 第一版故意不加载 project extensions / custom commands / MCP
- 目的是降低内存、降低递归风险、降低工具边界复杂度

这意味着 `in-process` 模式 **不是 100% 能力等价**，而是更保守。

这个差异必须：

1. 写进 README
2. 写进 `/moa status`
3. 写进 CHANGELOG

## 6. 工具边界

第一版只允许当前已有的 worker 工具集合：

- `none`
- `["read", "search", "find", "web_search", "ast_grep"]`

不要在这版里偷偷加：

- `ast_grep`
- `lsp`
- 其它只读工具

原因：这是 execution-mode 切换，不是能力扩张。

### `toolNames` 使用方式

`createAgentSession({ toolNames })` 已支持限制可用工具。

因此：

- 主 worker：`toolNames = ["read", "search", "find", "web_search", "ast_grep"]`
- discovery/rewrite/synthesis：不需要工具，直接走 `runEphemeralTurn()`，不跑完整 tool loop

## 7. 执行方式

### A. tools = `none`

discovery / rewrite / synthesis 走轻量路径：

```ts
const { session } = await createAgentSession(...);
const { replyText, assistantMessage } = await session.runEphemeralTurn({
	promptText: task,
	signal,
});
```

优点：

- 无工具 loop 开销
- 更接近当前 subprocess 的 `--no-tools`
- 更轻

### B. tools = readonly list

3 个主 worker 走完整 agent loop：

```ts
const { session } = await createAgentSession(...);
await session.prompt(task);
const lastMessage = session.state.messages.at(-1);
```

从最后一个 assistant message 提取：

- text
- stopReason
- errorMessage
- usage

### 统一 cleanup

两种路径都在 `finally` 里：

```ts
await session.dispose();
```

---

## 递归与扩展影响

原计划里的全局 `_moaActive` 方案不采用，原因有两个：

1. `disableExtensionDiscovery: true` 下，worker session 默认不会发现 MOA 扩展
2. 全局布尔会污染整个进程，误伤其它 session / 并发调用

### 结论

第一版不新增全局 recursion guard。

保留现在的 subprocess guard：

```ts
if (process.env.PI_MOA_SUBAGENT === "1") return;
```

仅作用于 subprocess 路径。

如果后续发现 in-process worker 仍能加载到 MOA command，再补最小化 guard；但不提前做全局状态污染设计。

这意味着：

- `extension.ts` 大概率不需要因 in-process 而改递归 guard
- `extension.ts` 只需要补 `status` 输出展示 mode

---

## 超时与失败语义

## 1. 超时

subprocess 超时可以杀进程；in-process 不行。

因此 in-process 路径采用：

- `AbortController`
- 外部 `signal` 合并
- `Promise.race` 控制上限
- 超时后返回 `timedOut: true`

### 注意

超时后不能假装“彻底回收成功”。

只能承诺：

- 调用了 abort
- 当前 worker 结果不再等待
- 会话随后尝试 `dispose()`

不要把“已终止”说成事实，除非确实观测到了。

## 2. `WorkerOutput.exitCode`

当前字段名带 subprocess 假设。

为了不改太大，第一版可以保持：

- subprocess 成功：真实 exitCode
- subprocess 失败：真实 exitCode/null
- in-process 成功：`0`
- in-process 异常/超时：`null`

但必须在计划里明确：

> `exitCode` 在 in-process 模式下只是兼容字段，不再表示真实进程退出码。

同时把 trace / archive 注释里的 “subprocess” 文案改成 execution-neutral。

---

## `package.json` 依赖策略

原计划里把 `@oh-my-pi/pi-coding-agent` 从 peerDependency 改成 dependency，这里不作为默认动作。

### 原因

`moa-extension` 是宿主扩展，不是独立应用。把宿主包改成 dependency 可能带来：

- 两份 `pi-coding-agent` 实例
- singleton / registry / symbol / runtime identity 失配
- 宿主-插件边界被破坏

### 结论

第一版保持：

- `peerDependencies` 不动

只有在实际打包/运行验证确认必须改时，再单独决策。

---

## 需要改的文件

### 必改

1. `src/types.ts`
	- `MoaSettings` 增加 `workerExecutionMode`
	- 相关注释去 subprocess 假设

2. `src/settings.ts`
	- 默认值
	- 非法值归一化

3. `src/worker-engine.ts`（新建）
	- `MoaWorkerEngine` seam
	- `createWorkerEngine()`
	- `InProcessWorkerEngine`

4. `src/executor.ts`
	- 不再直接绑死 `spawnMoaWorker()`
	- 接 worker engine
	- discovery/rewrite/worker/synthesis 全部走同一 seam

5. `src/extension.ts`
	- `/moa status` 增加当前 execution mode 展示
	- 递归 guard 维持现状，不新增全局布尔 guard

### 可能改

6. `src/subprocess.ts`
	- 保持原有实现
	- 如果需要，抽公共 `WorkerOutput` 映射工具函数

### 文档/说明必须一起改

7. `packages/moa-extension/README.md`
	- 配置项说明
	- `in-process` 与 `subprocess` 的差异说明

8. `packages/moa-extension/CHANGELOG.md`
	- 新增配置能力
	- 说明 `in-process` 为 opt-in

---

## 测试策略

这次最重要的不是“能跑”，而是“两条路径 contract 一致”。

### 1. 保留现有 subprocess 测试

当前已有的 subprocess contract 测试不能删，它们是基线。

### 2. 新增 in-process 测试

至少覆盖：

#### 路径分发
- `workerExecutionMode = in-process` 时走 `InProcessWorkerEngine`
- `workerExecutionMode = subprocess` 时走现有路径

#### tools=none
- discovery/rewrite/synthesis 通过 `runEphemeralTurn()` 返回结果
- 输出映射到 `MoaWorkerResult` 正确

#### readonly tools
- 主 worker 通过 `session.prompt()` 执行
- 只暴露 `read/search/find/web_search/ast_grep`

#### 失败语义
- abort
- timeout
- agent loop throw
- 无输出

### 3. 新增行为等价测试

这是原计划漏掉的关键项。

至少验证：

1. 相同输入下，两条路径都能产出合法 `WorkerOutput`
2. `mapWorkerOutput()` 后字段契约一致：
	- `ok`
	- `output`
	- `stderr`
	- `exitCode`
	- `model`
3. synthesis 在部分 worker 失败时仍能继续

不要求模型文本完全一样，但要求 executor 合同一致。

### 4. 只跑改到的测试

按仓库约束，只跑 MOA 自己改动的测试文件，不跑全仓。

---

## 风险和取舍

## 1. 内存

预期收益成立，但这里写成假设更准确：

- subprocess：每个 worker 一份 Bun runtime
- in-process：共享 runtime，减少 RSS

### 风险

- `AgentSession` / tool registry / extension runner 如果有残留引用，可能泄漏
- 需要通过 `session.dispose()` 和 targeted test 观察

## 2. 并行语义

`Promise.all` 仍保留。

但这个结论只在**当前只读工具集**下成立。以后如果开放更重的工具，需要重新评估。

## 3. 能力边界

`in-process` 第一版通过关闭 extension discovery 收缩能力边界。

这不是 bug，是显式 tradeoff：

- 换内存
- 换更简单的递归/安全模型
- 代价是 worker 不再自动继承项目扩展能力

这个必须对外说清楚。

---

## 实施顺序

1. `types.ts` / `settings.ts`：配置项与归一化
2. `worker-engine.ts`：定义 seam 和 in-process adapter
3. `executor.ts`：接入 worker engine
4. `extension.ts`：status 展示 mode
5. `README.md` / `CHANGELOG.md`：补配置说明与差异说明
6. `test/executor.test.ts`：补 in-process 与行为等价测试
7. 跑 MOA 定向测试

---

## 最终判断

这个方案值得做，但实施姿势要收一下：

- **保留 subprocess 为默认和兜底**
- **in-process 作为 opt-in**
- **第一版只做当前能力边界，不扩张**
- **复用现有 prompt/model/thinking 语义，不发明新解释器**

这样落地风险最低。

---

## 实施 checklist（开工用）

### A. 配置与类型

- [ ] `src/types.ts` 给 `MoaSettings` 新增 `workerExecutionMode: "subprocess" | "in-process"`
- [ ] 清掉 `types.ts` / trace 注释里把 worker execution 写死成 subprocess 的文案
- [ ] `src/settings.ts` 给 `DEFAULT_SETTINGS` 增加 `workerExecutionMode: "subprocess"`
- [ ] `src/settings.ts` 对非法 `workerExecutionMode` 做归一化 + warning
- [ ] `loadMoaConfigOverrides()` 的配置结果能透传到 `resolveSettings()`

### B. 执行 seam

- [ ] 新建 `src/worker-engine.ts`
- [ ] 定义 `MoaWorkerEngine` 接口：`execute(input): Promise<WorkerOutput>`
- [ ] 提供 `createWorkerEngine(mode, shared)` 工厂
- [ ] `SubprocessWorkerEngine` 只做现有 `spawnMoaWorker()` 适配，不改行为
- [ ] `InProcessWorkerEngine` 封装 `createAgentSession()` / `runEphemeralTurn()` / `prompt()`

### C. In-process session 构造

- [ ] 显式透传 `cwd`
- [ ] 复用 `authStorage` / `modelRegistry` / `settings`
- [ ] 使用 `SessionManager.inMemory()`
- [ ] `systemPrompt` 走 append 语义，不是 replace
- [ ] model 解析复用 `createAgentSession({ modelPattern })` 或现有 resolver
- [ ] `thinkingLevel` 原样透传，不降维
- [ ] `disableExtensionDiscovery: true`
- [ ] `skills: []`
- [ ] `enableMCP: false`
- [ ] `enableLsp: false`
- [ ] `skipPythonPreflight: true`
- [ ] `hasUI: false`

### D. Worker 执行路径

- [ ] discovery/rewrite/synthesis（tools=`none`）走 `session.runEphemeralTurn()`
- [ ] 主 worker（readonly tools）走 `session.prompt()`
- [ ] 从最终 assistant message 提取 `output / stopReason / errorMessage / usage`
- [ ] `finally` 中统一 `await session.dispose()`
- [ ] timeout 通过 `AbortController` + `Promise.race` 兜住

### E. 工具边界

- [ ] 第一版只允许 `read/search/find/web_search/ast_grep`
- [x] ~不在第一版引入 `ast_grep`~ — 已添加
- [ ] `toolNames` 限制只在 in-process 模式生效
- [ ] 若 `plannerToolMode: "all"`，in-process 仍按只读工具集执行，并在文档里明确说明

### F. Executor 接线

- [ ] `executor.ts` 不再直接依赖 `spawnMoaWorker()`
- [ ] discovery / rewrite / worker / synthesis 全部改走 worker engine seam
- [ ] `MoaWorkerResult` 映射逻辑保持单点复用
- [ ] subprocess 与 in-process 共用同一套 `mapWorkerOutput()` 契约

### G. 扩展与状态展示

- [ ] `extension.ts` 的 subprocess guard 保持原状
- [ ] 不引入全局 `_moaActive` 布尔 guard
- [ ] `/moa status` 展示当前 `workerExecutionMode`
- [ ] 若 `in-process` 能力边界比 subprocess 更保守，在 status 文案里说清楚

### H. 文档与发布

- [ ] `README.md` 增加 `workerExecutionMode` 配置说明
- [ ] `README.md` 明确 `in-process` 与 `subprocess` 的能力差异
- [ ] `CHANGELOG.md` 记录新增 execution mode 配置
- [ ] 明确默认值仍为 `subprocess`

### I. 测试

- [ ] 保留现有 subprocess 测试作为基线
- [ ] 新增 in-process 路径分发测试
- [ ] 新增 discovery/rewrite/synthesis tools=`none` 测试
- [ ] 新增 readonly worker `session.prompt()` 测试
- [ ] 新增 timeout / abort / throw / empty-output 测试
- [ ] 新增 subprocess vs in-process 行为等价测试（contract-level）
- [ ] 只跑 MOA 改动测试文件，不跑全仓

---

## 验收口径（完成定义）

只有同时满足下面条件，才算这次改动完成：

1. **默认无行为变化**

- 未配置 `workerExecutionMode` 时，MOA 仍走当前 subprocess 路径
- 现有 subprocess 测试全部通过

2. **in-process 可用**

- `workerExecutionMode: "in-process"` 时，discovery / rewrite / 3 workers / synthesis 都能跑通
- 主 worker 只暴露 `read/search/find/web_search/ast_grep`
- discovery / rewrite / synthesis 不走工具 loop

3. **契约一致**

- 两条路径都返回合法 `WorkerOutput`
- executor 映射出的 `MoaWorkerResult` 字段契约一致
- 部分 worker 失败时 synthesis 仍能继续

4. **没有偷偷扩权**

- in-process 第一版没有新增工具能力
- 没有把 `systemPrompt` 改成 replace
- 没有把 model/thinking 语义改坏

5. **文档说真话**

- README / status / changelog 都明确了默认模式和差异
- trace / 注释不再把所有执行都写死成 subprocess

6. **资源能收尾**

- `session.dispose()` 在 in-process 路径总会执行
- timeout / abort 场景不会把异常冒泡成 executor 崩溃

---

## 不做项（防止范围漂移）

这次不顺手做：

- [ ] 扩大 worker 工具集
- [ ] 让 in-process 自动继承项目扩展/MCP
- [ ] 重构 MOA planner / TCO / worker-parser 设计
- [ ] 改默认模式为 `in-process`
- [ ] 改发布依赖拓扑（peerDependency -> dependency）除非验证后被证明必须