# ADR-0003 补充评估：read/write 承担 xd:// transport 的影响面

> 本文件是 [ADR-0003（采用上游 xd:// 作为 Tool 呈现协议）](./0003-tool-presentation-xdev.md) 结论段第 1 条「影响面需单独评估」的补做交付。ADR-0003 写下该结论，但从未执行；本票补上逐项取证。
>
> 结论纪律：每条结论都落到 `文件:行` / 命令输出 / 测试名；无法确认的明确标「未确认」并说明卡点，不写成「不受影响」。

## 1. 语义变更的精确定义

read/write 的语义变化是「**多了一族内部 URL `xd://`**」，不是改动普通文件读写：

- `read xd://` → 列出本会话挂载的全部设备目录（`packages/coding-agent/src/internal-urls/xd-protocol.ts:87-89`）。
- `read xd://<name>` → 返回该设备的 manual（能力摘要 + 完整 description + wire schema）（`xd-protocol.ts:91-102`）。
- `write xd://<name>`（content = JSON 参数）→ 执行该设备（`packages/coding-agent/src/tools/write.ts:514-556`）。

两个入口的接线点：

- read 走内部 URL 路由：`internalRouter.canHandle(readPath)` → `#handleInternalUrl`（`packages/coding-agent/src/tools/read.ts:1017-1022`）；`XdevProtocolHandler`（scheme `"xd"`）在 `packages/coding-agent/src/sdk.ts:1169` 注册。
- write 走虚拟路径派发表的第一项 `#writeXdDevice`，仅当 `path` 匹配 `/^xd:\/\/(.+)$/i` 时生效，否则依次回落到 archive/sqlite/普通文件（`write.ts:429-465`、`write.ts:521-522`）。

挂载是否生效由 `xdevMountingActive()` 决定（`packages/coding-agent/src/tools/xdev.ts:53-57`）：显式 toolNames 关闭、`bun test` 运行时关闭、否则 `tools.xdev === true`（默认 `true`，`packages/coding-agent/src/config/settings-schema.ts:1935-1937`）。

read/write 本身是 `essential`（`packages/coding-agent/src/tools/essential-tools.ts:13-14`），永远顶层、不被挂载——它们是 transport，不是被挂载的设备。

## 2. 逐项影响面

### ① gateway 子 Agent（`~/.cornfield/agents/*` 的会话）→ 不受影响（行为语义）

**网关进程本身不按 URL/路径形状判断 read/write 的行为。**

- 网关通过 `AgentBridge` 拉起子进程 `omp --mode wire-stdio`（`packages/gateway/src/agent-transport-wire.ts:303`；`packages/gateway/src/agent-bridge.ts:1-11` 头部注释同）。子进程内跑的是完整的 `createAgentSession` → `createTools`，没有显式 toolNames、也不是 bun-test，故 `xd://` 挂载在网关子会话中**生效**（`xdev.ts:53-57` + `settings-schema.ts:1937` 默认 `true`）。即：网关里的模型确实能看到、也能用 `read xd://` / `write xd://<name>`。
- 但网关侧对 read/write 的唯一接触点是**展示**，不是行为判断：`formatLongTaskArgs`（`packages/gateway/src/channels/dingtalk.ts:3310-3317`）对 `toolName === "read"` 取 `args.path` 拼进长任务卡片摘要，纯显示；`dingtalk-card.ts:440-442` 仅做 tool name → icon 的映射。
- 未发现网关代码对 read/write 的 `path` 做 URL 形状分支（`search` 全 gateway 无 `parseInternalUrl` / `xd://` / 行为分支；唯一的 `toolName === "read"` 命中即上述显示用途，`dingtalk.ts:3316`）。

**结论**：语义不受影响。需要留意的只有一点——挂载在网关子会话**默认开启**，所以网关里的模型获得的是 transport 语义（`read xd://` 可列出设备目录），这是 ADR-0003「默认开启」的直接后果，不是缺陷。

### ② RPC host tool 路径（wire/serve 暴露的工具面）→ 不受影响

**read/write 不是 host tool；host-tool 桥不检查 read/write 的 URL 形状。**

- RPC host tool 桥包的是「网关定义、在网关进程执行的」工具（DingTalk、`bridge_status`、cron 等），通过 `set_host_tools` 注入并由 `RpcHostToolBridge` 按 `definition.name` 代理（`packages/coding-agent/src/modes/rpc/host-tools.ts:87-90`、`118-176`）。`RpcHostToolAdapter` 用 `applyToolProxy` 按属性转发，不解析参数路径（`host-tools.ts:52-56` + `packages/coding-agent/src/extensibility/tool-proxy.ts:4-25`）。
- read/write 是内置工具，在子进程会话里由 `createTools` 构建，与 host-tool 命名空间不相交。wire/serve 侧（`packages/coding-agent/src/commands/serve.ts:87-120`、`packages/coding-agent/src/server/wire-server.ts`）复用同一 `createAgentSession`，对 read/write 无语义特判。

**结论**：不受影响。read/write 的 `xd://` transport 语义随 `createAgentSession` 统一生效，RPC host tool 路径不参与对它的判断。

### ③ 自演化调用路径 → 受影响（启发式降级，非崩溃）

自演化在**读会话记录时按工具名 + 参数形状**匹配，且把 `write`/`read` 的 `path` 当成**文件系统路径**。transport 化之后，`write xd://<name>` 的 `path` 是 `xd://<name>`，工具名仍是 `write`，于是设备执行被误当成文件修改/文件读。证据：

- `packages/self-evolution/src/trace.ts:242-247`（`summarizeTrace`）：`entry.toolName === "write"|"edit"|"ast_edit"` 时读 `entry.args.path` 加入 `filesModified`。`write xd://<name>` 会把 `xd://<name>` 当「被修改的文件」写进 episode 元数据。
- `packages/self-evolution/src/trace-analyzer.ts:366`（`#analyzeReadFailures`）匹配 `call.toolName === "read"`，再用 `#extractPath`（`trace-analyzer.ts:634-637`，`args.path ?? args.file_path`）取路径归因。`read xd://<name>` 失败时 `attemptedPath` 会是 `xd://<name>`，错误文本「Unknown xd device…」不命中硬编码签名（`trace-analyzer.ts:66-86` 的 `path_not_found` 等），落入 `other`。
- `packages/self-evolution/src/trace-analyzer.ts:484-502`（`#detectSlowLoop` / `#computeToolEfficiency`）：把 `write` 计为「修改」。`write xd://<name>` 计为一次成功修改，尽管没有落盘文件。
- `packages/self-evolution/src/feedback-tracker.ts:166-167`、`245-250`（`#extractEditPath`，`args.path ?? args.file_path`）：把 `write xd://<name>` 的 path 当编辑路径参与「用户手动回退」检测，可能产生误配对。
- `packages/self-evolution/src/memory/index.ts:1263-1267`：与 `summarizeTrace` 相同的 `filesModified` 启发式，是同一模式的第二份拷贝。
- `packages/self-evolution/src/workflow-miner.ts:19-32`（`extractCommandName`）：非 bash 工具返回工具名本身，所以 `write xd://<name>` 在 workflow 序列里只记成 `write`，实际被执行的设备名丢失（信息丢失，非错误）。

**结论**：受影响。性质是**启发式降级 + 元数据污染**（`filesModified` 里混入 `xd://` 串、`write` 被误计为文件修改、设备名不可见），不导致崩溃或数据损坏。这需要最小修复或立票（见 §3），不在本票范围内改代码。

### ④ 其它共享调用方（扩展 / hook / MCP）→ 部分受影响

**`moa-extension`（远程 read 阻断）→ 不受影响。**

- `packages/moa-extension/src/block-remote-read.ts:16-19` 匹配 `toolName === "read"` 后以 `isRemoteReadPath`（`block-remote-read.ts:4-7`，仅 `/^https?:\/\//i`）判断是否阻断。`xd://` 不是 http(s)，不会误拦。意图（阻断远程网页、保留本地读）在新语义下仍成立。

**autorerearch（作用域编辑 guard）→ 受影响（模式行为与 xd:// 的交互）。**

- `packages/coding-agent/src/autoresearch/index.ts:96-108` 匹配 `toolName === "write"|"edit"|"ast_edit"`，`getGuardedToolPaths` 对 write 返回 `[input.path]`（`index.ts:407-409`）。
- `resolveAutoresearchRelativePath` 有 `looksLikeInternalUrl` 守卫（`index.ts:434-439`，模式 `index.ts:500-502`），对内部 URL 返回 `ok:false`、理由「cannot validate internal URL paths …」→ **在 autoresearch 模式下 `write xd://<name>` 会被 block**。
- 这不算「破坏」，但它是 transport 语义与 scoped-editing guard 的一次真实交互：设备执行在 autoresearch 里恒被拦截。是否合理取决于「scoped editing 期间不允许经设备执行绕过 scope」是否是有意为之——当前代码没有注释说明该意图，属**需人工确认**的条款。

**`protected-paths` 示例 hook → 不受影响（按 device exec 的语义正确放行）。**

- `packages/coding-agent/examples/hooks/protected-paths.ts:12-28` 匹配 `write`/`edit` 后检查 `event.input.path` 是否包含受保护子串。`xd://<name>` 不含 `.env`/`.git/`/`node_modules/`，设备执行不会被这个「路径守卫」拦——设备执行本就不是文件写，语义正确。属示例代码。

**MCP → 不受影响。**

- MCP 工具是挂载对象而非 transport：`createTools` 之后才把 MCP 工具拆进 device 集合（`packages/coding-agent/src/sdk.ts:1443-1453`、`packages/coding-agent/src/tools/xdev.ts:101-112`）。MCP 路径不读 read/write 的 URL 形状。

## 3. 发现与建议

### 3.1 需要立票（本票不改代码）

**自演化把 transport 化的 `write` 当文件修改。** 根因：trace 只记 `toolName`（transport 名）+ `args.path`，自演化层没有区分「普通文件路径」与「内部 URL 路径」。影响是 `filesModified` 污染、`write`/`read` 计数失真、设备名在 workflow 序列中丢失。

建议的最小修复方向（择一，需另行评估）：
- 在 `packages/self-evolution/src/trace.ts` 的 `summarizeTrace`、`trace-analyzer.ts` 的 `#extractPath`、`feedback-tracker.ts` 的 `#extractEditPath`、`memory/index.ts` 的 filesModified 启发式中，对匹配内部 URL（`^[a-z][a-z0-9+.-]*://`）的 `path` 跳过文件归类；或
- 在 trace 事件层补记 `write xd://<name>` 的实际设备名，让下游按设备名而不是「write+path」统计。

### 3.2 需人工确认的行为

autoresearch 模式下 `write xd://<name>` 恒被 `looksLikeInternalUrl` 守卫拦截（`autoresearch/index.ts:434-439`）。若「scoped editing 期间不允许设备执行」不是本意，需单独处理；若是本意，建议在该守卫加一行注释把它标为 intentional。

## 4. 覆盖范围说明

- 已取证：gateway 子 Agent、RPC host tool 路径、自演化、扩展（moa-extension / autoresearch / protected-paths 示例）/ hook / MCP。
- 未覆盖：提示词资产（`packages/coding-agent/src/prompts/system/_environment.md:59-65`、`custom-system-prompt.md:183-189`）只负责向模型描述 `read xd://`/`write xd://<name>` 用法，不构成「判断 URL 形状」的调用方，故不在影响面内，仅在本文档记录其存在。