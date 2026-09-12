# 上游 `eval` js 半边移植方案（预研）

- 日期：2026-09-12
- 分支：`feat/xdev7-evaljs`
- 上游：`can1357/oh-my-pi`（`main`）
- 我们：本仓 `feat-xdev5-k1` 工作树
- 性质：**只出方案，不写实现代码**

回答任务五问。每条结论落到「上游文件:行」或「我们文件:行」；不确定标「未确认」，不写「不需要」。

---

## 一、上游机制拆解（问题 1 + 问题 4）

### 1.1 「持久 JS VM」到底是什么

**结论：不是 Bun 内建 eval、不是 `node:vm` 同进程直跑、不是自研 JS 解释器。它是一个跑在 `node:worker_threads` Worker 或子进程里的持久 VM 上下文，`mode: "isolated"`，超时靠 force-kill 进程/Worker。**

关键证据链：

- `src/eval/js/index.ts`：`jsBackend` 实现 `ExecutorBackend`，`execute()` 调 `executeJs`（`js/index.ts:36-52`）。
- `src/eval/js/executor.ts`：`executeJs` 调 `executeInVmContext(...)`（`executor.ts:95-121`），最后 force-kill 语义见 `formatJsTimeoutAnnotation`（`executor.ts:66-71`）——「Timeout cancellation force-kills the worker … discards the persistent VM state」。
- `src/eval/js/context-manager.ts`：`executeInVmContext` 管理每个 session 的持久 VM context（`context-manager.ts:117-179`），`WorkerHandle.mode` 是 `"process" | "worker" | "inline"`（`context-manager.ts:43`）。其中注释明说：为避免 `vm.runInContext` 的 Bun terminate-race（SIGILL/SIGSEGV），改用 `shared/indirect-eval.ts`（`context-manager.ts:84-88`）。
- 两个 transport 入口：
  - `worker-entry.ts` → `node:worker_threads`（`import { parentPort } from "node:worker_threads"`），`new WorkerCore(transport, { mode: "isolated" })`（`worker-entry.ts:1,26`）。
  - `process-entry.ts` → **子进程**，`startJsEvalProcess`，`new WorkerCore(…, { mode: "isolated", chdir: … })`，注释「The parent owns process lifetime and kills the subprocess」（`process-entry.ts:8-24`）。

**未确认点（如真要移植需另查）**：vm 上下文的精度 —— `node:vm.createContext` + `vm.Script` run，还是 Bun 的 `vm` 模块；以及 `shared/indirect-eval.ts` 的确切实现。但「执行面 = Worker/子进程内的持久 VM，非代理进程内 eval」已确认。

### 1.2 上游 `eval` 独有机制逐个定

| 机制 | 上游位置 | 本次处理 |
|---|---|---|
| 长时 cell 自动后台化 | `eval.ts` `execute()` 里 `asyncJobManager.register(...)` + `eval.autoBackground.enabled`（`eval.ts:460-529`） | **可延后（P1）**。依赖我们的 `asyncJobManager`（已有 `job`/`async`），但与 js 后端隔离生命周期耦合，P0 先做同步执行 |
| codex code-mode | `eval.ts` `#codeModeDescription` + `generateCodeModeDeclarations`（`eval.ts:306-329`） | **不建议**。我们无 plan-mode transport 的 code-mode 概念，进来了是空转 |
| preludes | `eval/preludes.ts` + `getEnabledEvalPreludes`（`eval.ts:324`） | **可延后（P1）**。我们 `python` 已有 prelude helper（`src/ipy/prelude.ts`）；js 侧可复用同一形态后续加 |
| 执行内委派 `agent()`/`workpool()` | `eval/agent-bridge.ts`、`eval/js/tool-bridge.ts`、`sessionDelegationBias` | **不建议（P0 排除）**。牵一整套子代理桥接，与隔离边界深度耦合，是独立大工程 |

---

## 二、隔离方案（问题 2，专门回答）

**上游隔离**：JS 执行跑在 Worker 线程或子进程，**绝不在 agent 进程内直接 eval**。`mode: "isolated"`；超时/interrupt 无法打断同步用户代码，只能 force-kill 进程/Worker（`executor.ts:66-71`）。

**我们的现状（对照物）**：`python` 走的隔离级更高——独立 IPython 内核，经 Jupyter kernel gateway 走 WebSocket（`src/ipy/kernel.ts:450` `PythonKernel.start` → `acquireSharedGateway` → `#startWithSharedGateway`，`kernel.ts:2` Bun `$`、`gatewayUrl`）。即我们允许模型跑 Python 的条件是「完全出进程的内核 + 网络边界」。

**冲突点**：如果 js 半边为了图快做成「agent 进程内 `node:vm`/同进程 eval」，隔离级别就比 `python` 低一档——模型在同一进程里拿到任意 JS 执行。这在我们的安全模型里是**不可接受的默认**（任务纪律 (b) 同判）。

**我的推荐隔离方案**：

1. **生产：子进程**（`process-entry.ts` 形态），复用我们的 `subprocess` 层（如 `src/ipy/runtime.ts` `resolvePythonRuntime` 的同类 spawn 路径），`mode: "isolated"`，超时 force-kill 子进程。理由：与 `python` 的「完全出进程」隔离对齐（甚至更强，无 WebSocket 网关这层），子进程崩溃不拖垮 agent 主进程。
2. **测试：`node:worker_threads` 可选**（`worker-entry.ts` 形态），仅为省 spawn 成本，绝不进生产默认路径——同进程 Worker 崩溃仍可能带崩进程（SIGILL/SIGSEGV），与上游 `useWorkerThreadForTests` 的取舍一致（`context-manager.ts:98-102`）。
3. **明确不做**：agent 进程内 `new Function` / `vm.runInContext` 直接 eval。上游自己都注释了 Bun 下直接 `vm.runInContext` 有 terminate-race（`context-manager.ts:84-88`）。

> 一句话：**「同进程 eval 是不可接受的默认」成立**。我们应把 js 后端做成「子进程 + force-kill」，与 python 的进程隔离对齐，而不是照抄上游的 worker 线程路径当默认。

---

## 三、我们侧改动清单（问题 3，文件级）

**设计决策：加独立 `js` 工具，镜像 `python.ts` 形态，不搞上游的统一 `eval`（py|js 语言参数）。** 理由：我们已有成熟的 `python` 工具（schema/流式/渲染/测试全链路），把 js 塞进一个 `eval(language)` 会打断 python、白付重构成本。「js 半边」= 一个与 python 并列、形状一致的 `js` 工具。

| 文件 | 改动 | 依据 |
|---|---|---|
| `src/tools/js.ts`（新） | `JsTool`，镜像 `python.ts`：cells 数组 / timeout / reset schema；OutputSink + TailBuffer 流式；json/image/markdown/status 输出；clampTimeout | 对齐 `tools/python.ts:52-67`（schema）、`:206-463`（流式/输出/超时）、`:490-500`（display 输出汇总） |
| `src/ipy/js/`（新）或 `src/eval/js/`（新） | 子进程执行层：`process-entry` + vm context + worker-core 的最小集（不带 agent-bridge/tool-bridge 委派） | 上游 `eval/js/{process-entry,worker-entry,context-manager,executor,worker-core}.ts` 的最小裁剪 |
| `src/tools/index.ts` | `BUILTIN_TOOLS` 注册 `js: s => new JsTool(s)` + `isToolAllowed` 加 `name === "js"` 门控 | 现状 `python: s => new PythonTool(s)`（`index.ts:230`）、`isToolAllowed`（`index.ts:411-438`） |
| `src/prompts/tools/js.md`（新） | 工具说明书，镜像 `python.md` | `python.ts:13` import `python.md`；js 侧需同构 |
| `src/config/settings-schema.ts` | 加 `js.toolMode`/`js.enabled`（默认关）一个门控项 | `python.toolMode` 先例 |
| `tools/xdev.ts` | js 工具 `loadMode: "discoverable"` + 一行 `summary`（非空，满足 verify:xdev 的 summary 门） | `buildXdevDeviceCatalog` 取 `tool.summary`（`xdev.ts:133`）；python `loadMode: "discoverable"`（`python.ts:152`） |

**呈现**：`loadMode` 给 `"discoverable"`（与 python 一致，挂成 xd:// 设备进目录）；`summary` 给一行如 `"Execute JavaScript in a persistent VM"`。

---

## 四、测试与验收形态 + 默认开关（问题 5）

**我们 `python` 测试**（找到的文件）：
- `packages/coding-agent/test/tools/python.test.ts`
- `packages/coding-agent/test/tools/python-execution.test.ts`
- `packages/coding-agent/test/tools/python-renderer.test.ts`

js 半边应对齐：schema 校验、执行往返（echo/状态/错误）、renderer（statusLine/单元格渲染）、超时/abort/force-kill、以及「无 summary 挂载」的 xdev 契约。（各文件内部断言细节未读，对齐面按文件名归类，标注为「未确认」级别。）

**默认开关建议：默认关闭（opt-in）**。理由：

1. 新增一个代码执行面是安全边界变化，不该默认敞开。
2. 它依赖新的子进程 spawn 层（一次冷启动成本），默认开意味着每个 session 都背上这层。
3. 与 `tools.xdev` 默认开的关系要用门控处理：js 若 `loadMode: "discoverable"`，xdev 开时会被挂进设备目录（`splitToolsForXdev`，`xdev.ts:68-90`）。所以「默认关」必须落在工具注册层（`isToolAllowed` 读 `js.enabled` 默认 false，`createIf` 返回 null），而不是靠 xdev——否则设备目录里会出现一个默认开着的 js 设备。

实现上：`js.enabled` 默认 `false`（或 `PI_JS` 环境开关），工具在 `createIf` 层不注册，确认打开后才进 BUILTIN_TOOLS 被 xdev 挂载/发现。

---

## 五、工作量分级

### P0 — 最小可用（同步、单语言、子进程隔离）

- `src/tools/js.ts`（镜像 python.ts 的 schema/流式/输出/超时/abort）
- `src/ipy/js/`（或 `src/eval/js/`）最小子进程执行层：`process-entry` 形态 + vm context + `executeJs`，**去掉** agent-bridge/tool-bridge 委派
- `src/tools/index.ts` 注册 + `isToolAllowed` 门控
- `src/prompts/tools/js.md`
- `settings-schema.ts` 加 `js.enabled`（默认 false）
- 测试：`test/tools/js.test.ts` + xdev 呈现断言

### P1 — 补齐

- preludes（复用 python 的 helper 形态）
- 长时 cell 自动后台化（依赖 asyncJobManager）
- 图片/JSON 的 resize 与 webp 排除（`webpExclusionForModel`）

### 明确不做（本阶段）

- codex code-mode
- 执行内委派 `agent()`/`workpool()`

---

## 六、风险与未确认项

| 风险/未确认 | 定性 |
|---|---|
| vm 上下文精度（`node:vm.createContext`+`vm.Script` vs Bun vm vs indirect-eval 包装） | 未确认；不影响「子进程 + force-kill」的隔离结论，但决定 P0 里 vm 层的实现选型 |
| 上游生产默认是 worker 线程还是子进程（`resolveWorkerSpawnCmd` 的确切分支） | 未确认；但两入口都存在，我们直接定「生产=子进程」即可，不必照抄其默认 |
| 子进程 cold-start 成本 | 与我们 `python` 网关启动同类；P0 单 session 复用一个持久子进程可摊薄 |
| js 内核并发/独占语义（`concurrency: "exclusive"`） | 镜像 python：`python.ts:158` `concurrency = "exclusive"`，js 同设即可，无新增风险 |
| 默认关闭与 xdev 发现性如何共存 | 已明确：门控落在 `isToolAllowed`/`createIf`，不靠 xdev |