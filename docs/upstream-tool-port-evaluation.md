# 上游缺失工具移植评估

- 日期：2026-09-12
- 分支：`feat/xdev6-tooleval`（纯调研，不改 `packages/**` 实现）
- 上游：`can1357/oh-my-pi`（`main`）
- 我们：本仓 `feat-xdev5-k1` 工作树（即 `main` 基本一致）

评估对象：上游有、我们零痕迹的 10 个内置工具 + 2 个隐藏工具。每条结论落到「上游文件:行」或「我们文件:行」；拿不准的写「未确认」，不写「不需要」。

---

## 总览

| 上游工具 | 我们对应物 | 移植判断 |
|---|---|---|
| `context_notes` | 无（compaction 自动压缩） | 取决于 |
| `new_context` | 无（compaction 自动触发） | 取决于 |
| `eval` | `python`（py 半边）+ 无（js 半边） | 值得（补 js） |
| `learn` | `write_memory` + self-evolution（近似，关键差异） | 取决于 |
| `manage_skill` | 无（skill-creator 外部工具） | 不值得 |
| `memory_edit` | 无（依赖 mnemopi 后端） | 不值得 |
| `recall`（上游名，非 `memory_recall`） | 无直接等价 | 取决于 |
| `reflect`（上游名） | 无直接等价 | 取决于 |
| `retain`（上游名） | `write_memory`（近似） | 取决于 |
| `security_scan` | 无（`report_finding` 只记录） | 取决于 |
| `goal`（隐藏） | 无（plan-mode / todo 异） | 取决于 |
| `think`（隐藏） | 无（provider 原生 reasoning） | 不值得 |

**命名勘误（重要）**：任务清单把三个记忆工具写成 `memory_recall / memory_reflect / memory_retain`，但上游真实 wire name 是 `recall / reflect / retain`（见 `memory-recall.ts:16`、`memory-reflect.ts:16`、`memory-retain.ts:15`），只有 `memory_edit` 带前缀（`memory-edit.ts:23`）。若后续移植，注册名以源码 `name` 字段为准，勿按清单名。

**最大前置依赖**：四个记忆工具 + `learn` 全部挂在同一个 `memory.backend` 抽象上（`hindsight` = 远程服务 / `mnemopi` = SQLite 类向量后端 / `local` = 文件），我们在 `packages/**` 中搜 `memory.backend` / `mnemopi` / `hindsight` 零命中。移植这些工具 ≠ 加几个工具文件，而是要先移植整套记忆后端。这是「取决于」判断的核心。

---

## 逐工具评估

### `context_notes` + `new_context`

| 栏 | 内容 |
|---|---|
| 它做什么 | 读/写持久化「实验性上下文笔记本」；`new_context` 请求开新上下文窗口 |
| 我们对应物 | 无。compaction 是自动压缩（`session/compaction/compaction.ts:218` `shouldCompact`），无可供模型主动读写的笔记本 |
| 重叠与差异 | 上游两工具都门控在 `compaction.experimentalContextManagement === true`（`context-notes.ts:43`、`:51`），挂在 `session/context-notes` 分支上，与自动压缩是「补充」而非「替代」 |
| 移植建议 | 取决于。若决定引入「模型主动管理自己的上下文窗口」能力，两工具一起搬；否则放弃。目前我们的 compaction 走自动阈值，路线不同 |

### `eval`

| 栏 | 内容 |
|---|---|
| 它做什么 | 进程内执行 `py`（IPython 内核）/ `js`（持久 JS VM）代码（`eval.ts`，`eval-backends.ts:13-20` 按 `eval.py`/`eval.js` + `PI_PY`/`PI_JS` 控制） |
| 我们对应物 | `python`（`tools/python.ts:150`、`:153`「Execute Python code in a persistent IPython kernel」）——只覆盖 `py` 半边；`js` 半边无；`bash`（shell）是正交能力，上游另有独立 `bash.ts` |
| 重叠与差异 | **py 半边高度重叠**：都是 IPython 持久内核 + cells + timeout/reset + image/JSON/status/markdown 输出 + 流式。上游 `eval.js` 的「持久 JS VM」我们完全没有非原生对应物。上游 `eval` 还多：长时 cell 自动后台化、codex code-mode、preludes、执行内委派（`agent()`/`workpool()`） |
| 移植建议 | 值得（补 `js` 后端 + 若需统一入口）。py 半边别重造——与我们 `python` 功能等价；真正的增量是持久 JS VM 与委派机制。是否值得取决于有没有「进程内求值 JS」的真实需求 |

### `learn`

| 栏 | 内容 |
|---|---|
| 它做什么 | 存一条可复用教训到长期记忆，可选在同一次调用里造/改一个 managed skill（`learn.ts:35` summary） |
| 我们对应物 | `write_memory`（`self-evolution/src/write-memory-tool.ts:57`）：模型写「学习条目」到 learnings 表，target `user`/`memory`，无「顺带造 skill」能力。self-evolution 本体是**自动**提取（`self-evolution/src/index.ts:4-5`） |
| 重叠与差异 | 上游 `learn` 是模型**主动调用**，且耦合 managed-skill 铸造；我们是**自动** self-evolution + `write_memory`（只写条目、不造 skill）。两者对「模型主动学习」的定位不同 |
| 移植建议 | 取决于。若要「模型显式学习」，得先决定它与自动 self-evolution 的关系（可能冲突或重复发给用户），并依赖记忆后端。单独把 `learn` 搬进来没意义 |

### `manage_skill`

| 栏 | 内容 |
|---|---|
| 它做什么 | 增/删/改「托管技能」（managed skills，与 authored 技能隔离、后者优先），门控 `autolearn.enabled`（`manage-skill.ts:28`、`:41`） |
| 我们对应物 | 无分层。我们只有仓库内 authored skills + `skill-creator`（外部 skill 生成流程），没有运行时「托管技能」目录概念 |
| 重叠与差异 | 上游把「模型运行时生成的技能」放进独立 `managed-skills/` 命名空间，避免覆盖 authored。我们无此生命周期 |
| 移植建议 | 不值得。我们 skills 是手写/仓库管理，无模型托管技能的分层需求；引进来是空架子 |

### `memory_edit` / `recall` / `reflect` / `retain`

| 栏 | 内容 |
|---|---|
| 它做什么 | 四个模型可调的长期记忆原语：`retain` 存事实、`recall` 自然语言检索、`reflect` 从记忆综合回答、`memory_edit` 更新/遗忘/失效（各工具 `name` 见 `memory-{retain,recall,reflect,edit}.ts`） |
| 我们对应物 | 无直接等价。self-evolution/memory 是**自动**检索注入（`self-evolution/src/index.ts:139` 起），`write_memory` 只写不检/不 reflect。`memories/index.ts:1` 已 `@deprecated` 指向 self-evolution/memory |
| 重叠与差异 | 上游是「模型显式调度记忆」范式；我们是「框架自动记忆+模型只在 write_memory 写入」。功能上有重叠（都存长期事实），但调度权归谁完全不同。且上游四件套齐依赖 `memory.backend ∈ {hindsight, mnemopi}`，我们两者皆无 |
| 移植建议 | 取决于。核心决策是「要不要模型可调的长期记忆后端」。要→四件一起迁并补后端；不要→四个都不值得（`memory_edit` 还只支持 mnemopi，单独迁必然空转）。这一项应作为独立架构决策提交，不是单个工具取舍 |

### `security_scan`

| 栏 | 内容 |
|---|---|
| 它做什么 | 编排 OMP 原生安全扫描 + Codex Security 云扫描：`preflight/start/status/cancel/validate` + `cloud_scans/cloud_start/cloud_status/cloud_pull`（`security-scan.ts`），门控 `security.enabled`，依赖 model/auth registry |
| 我们对应物 | 无。`report_finding`（`tools/review.ts:137`）是「审查输出的结构化记录器」，只记 finding（title/body/priority/置信度/file:line），**不做扫描** |
| 重叠与差异 | 关键差别：`security_scan` 是**扫描器**（coordinator/store/cloud 一整套）；`report_finding` 只是**记录**审查代理已经发现的问题。两者都产出「finding」，但一者产生、一者记录。我们无任何安全扫描子系统 |
| 移植建议 | 取决于。若需内置 SAST/云安全扫描能力，`security_scan` 值得并需连带 `src/security/`（coordinator/store/preflight/cloud）整套；否则不值得。与 `review` 无实质重叠，不能拿 `review` 当替代品 |

### `goal`（隐藏）

| 栏 | 内容 |
|---|---|
| 它做什么 | goal 模式：创建/查询/完成/恢复/丢弃带 token 预算的目标（`goal-tool.ts`，`name="goal"`） |
| 我们对应物 | 无。plan-mode（`exit_plan_mode`/计划态）与 `todo` 都不含「token 预算 + goal 生命周期」概念 |
| 重叠与差异 | 上游 goal 是「带预算的单一目标跟踪」；我们的 plan-mode 是「改代码前的计划审批」，todo 是「任务拆分」。三者语义不同 |
| 移植建议 | 取决于。若产品需要「goal 模式（带 token 预算的目标驱动执行）」则值得；否则不值得，且与现有 plan-mode 的定位容易混淆，需先厘清 |

### `think`（隐藏）

| 栏 | 内容 |
|---|---|
| 它做什么 | 私有草稿思考：在关闭原生推理时记录不进用户视角的思考（`think.ts`，`name="think"`，`intent="omit"`，`supportsExternalThinking` 判断哪些传输可压制原生 reasoning） |
| 我们对应物 | 无直接等价。我们走 provider 原生 reasoning + thinking 块渲染；`yield`（`tools/yield.ts:44`）是子代理结构化输出提交，不是草稿 |
| 重叠与差异 | 上游 `think` 是「原生 reasoning 被屏蔽时的软件层草稿替代」。我们未屏蔽原生 reasoning，已有 thinking 处理路径 |
| 移植建议 | 不值得。与 provider 原生 reasoning 重叠；只有在我们决定「屏蔽原生 thinking、改用软件层草稿」这种特殊模式时才有意义，当前无此需求 |

---

## 整体建议

1. **明确值得**：`eval`（增量 = `js` 持久 VM 后端 + 统一入口；py 半边与我们 `python` 等价，别重造）。
2. **纯不值得，避免空转**：`manage_skill`、`think`；`memory_edit` 单看也不值得（依赖 mnemopi）。
3. **需要用户拍板的「取决于」项**，按牵引力排序：
   - **记忆四件套 + `learn`**：本质是「要不要模型可调用的长期记忆后端」一个架构决策，不是 5 个工具各自取舍。我们当前是自动 self-evolution + `write_memory`，方向不同。
   - **`security_scan`**：要不要内置安全扫描子系统（连带 `src/security/` 整套）。
   - **`context_notes`/`new_context`**：要不要「模型主动管理上下文窗口」的实验路径（可怜 compaction 的 `experimentalContextManagement`）。
   - **`goal`**：要不要带 token 预算的 goal 模式（需先与 plan-mode 划清边界）。

未确认项：`eval` 的 js 后端（`@oh-my-pi` 的「持久 JS VM」）具体是 Bun/Node/自研 VM、与我们 natives 的兼容性未核实——若要移植需另起调研。