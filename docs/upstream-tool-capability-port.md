# 上游工具能力差移植方案

- 日期：2026-09-16
- 上游：`can1357/oh-my-pi` @ `c5a8e0e`（快照 `/tmp/omp-upstream`）
- 本地基线：`main` @ `3d9ddde0`
- 状态：设计（分批实施中）
- 范围：**两棵树都有的 Tool，其能力差**（含行为、TUI 渲染、prompt）

与另两篇的分工（禁止分叉）：

- `upstream-tool-port-evaluation.md`（2026-09-12）：上游有、本地**零痕迹的整工具**（eval / learn / memory 四件套 / security_scan / goal / think / manage_skill / context_notes）。本文引用其结论，不重做。
- `upstream-eval-js-port-plan.md`：其中 eval 的 js 后端单独成篇。
- 本文：**同工具内的能力差**——两边都有这个 Tool，但上游多做了事。

## 方法与证据强度

7 组只读对比（bash/shell、read 系、写路径、edit 系、memory/skill、github、output/eval），每条带上游 `文件:行`。标注 `[复核]` 的条目由我读过源码确认；其余为调研代理给出的证据，未逐条复核。

## 13 条移植项

| # | 能力 | 上游证据 | 本地现状 | 尺寸 | 波次 |
|---|---|---|---|---|---|
| 1 | bash 拦截器逐段判定 + 保守 shell 分词器（含 cd 提取） | `tools/shell-tokenize.ts:14,217,369,501`、`bash-interceptor.ts:119` | 部分：`bash-interceptor.ts:42` 只 trim+正则（`^` 锚导致"单独跑被拦、脚本里放过"）；`bash.ts:557` 脆弱 cd 正则 `[复核]` | S | 1 |
| 2 | GitHub 补 5 个 op：`file_read`、`pr_create`、`search_code`、`search_commits`、`search_repos` | `gh.ts:261-361`、`gh-search.ts:458-523`、`gh-types.ts`、`gh-common.ts` | 本地 9 op（`gh.ts:132-143` `[复核]`） | S | 1 |
| 3 | edit auto-repair：hunk 隔离（singles→pairs→贪心剥）+ reference 文本 + realign + blackbox 语料 | `edit/auto-repair.ts:110-133,183-202,229-266`、`edit/blackbox.ts` | 部分：`edit/post-write.ts:283-292` 用线性 diff 范围 `[复核]` | M | 1 |
| 4 | todo：`blocked` 状态 + `blocker` + `block`/`unblock`/`view` | `tools/todo.ts:21-29,126-128` | 缺：`todo-write.ts:21` 四状态 `[复核]` | S | 1 |
| 5 | read：tail 选择器 `-N` + 多段选择器渲染 | `read-selector.ts`、`read-format.ts` | 缺：本地对 `-N` 与不相邻多段直接报错 | M | 2 |
| 6 | 未解决 git 合并冲突浮出 + `conflict://N` 读写解决 | `tools/conflict-detect.ts:1-500` | 缺 | M | 2 |
| 7 | PDF 读取（Chromium 渲染单页） | `read-pdf.ts` | 缺（本地 PDF 走文本抽取） | M | 2 |
| 8 | `run_watch` 健壮性（429 退避、fast/slow 轮询、no-runs-give-up、completed jobs 缓存）+ `pr_checkout` worktree 冲突后缀 + `view` 的 stateReason 回退 | `gh-run-watch.ts:44-46,192-200,1015-1026`、`gh-pr-checkout.ts:96-117`、`gh-view.ts:81-114` | 部分 | S（每项） | 2 |
| 9 | GitHub 视图 SQLite 缓存层（soft/hard TTL、后台刷新、auth-key 隔离） | `github-cache.ts` | 缺 | M | 3 |
| 10 | edit `sloppy` 模式 + inline-edit-recovery（模型把 edit 写成纯文本时捞回） | `session/inline-edit-recovery.ts`、`edit/schemas.ts` | 缺 | M | 2 |
| 11 | 输出 schema 校验统一（yield 与 executor 共用）+ 增量 yield 的 section 校验 | `tools/output-schema-validator.ts:1-307` | 部分：`yield.ts:82-100` 自 compile AJV `[复核]`，executor 另有一套；yield 当前无测试 | M | 2 |
| 12 | 终端屏幕读取（把虚拟终端行导出为可重放样式） | `tools/terminal-output.ts` | 缺；**本地已有 `@xterm/headless` + `bash-interactive.ts:215` 读屏** `[复核]`，零新依赖 | S | 3 |
| 13 | memory `reflect`（对长期记忆做 LLM 综合回答） | `tools/memory-reflect.ts:1-90` | 缺；本地有 `write_memory` + `query_episodic_memory`（`self-evolution/src/tools.ts:23-38` `[复核]`），只返回列表 | M | 3（受前作「记忆后端」决策阻塞） |

渲染面（上游有的 TUI 渲染）**不单独成票**：它属于哪条能力的可见性，就并进那条票的验收（read 徽章→5/6/7，gh 结果渲染→2/8，edit 结果渲染→3，todo 的 blocked 标记→4）。

**CHANGELOG 不在子任务范围内**：同一波的四条能力票都要写 `CHANGELOG.md`，那就是同一文件相交——squad 明令子任务 scope 互不相交，相交即打回。改为父在集成交接时统一补条目（一个入口，也避免并发会话互相覆盖 `## [Unreleased]`）。

**第一波的交付形状**（5 个子任务）：01 渲染验收基线（预重构，先把渲染断言的手段固定）→ 02/03/04/05 四条能力（各自依赖 01 的契约）。四条能力文件面互不重叠，故可并行；01 串行在前，因为它定义其余四票写渲染断言的接口。

## 口径（本次会话定的，已落 ADR-0004）

1. 完成面 = 能力 + 针对性测试 + 必要 prompt（`.md`）+ CHANGELOG + 上游 TUI 渲染
2. 允许改核心路径，但外部行为必须兼容；无护栏处先补测试
3. 依赖按上游引入，不为体积设限；范围限"只需本机已有件"，需外部账号/云服务的不做
4. 分波交付：先发文件面互不重叠、无前置的一批并验收，再拆剩余
5. 拦截语义（第 1 条）与修复语义（第 3 条）已分别定稿，术语入 `CONTEXT.md`

## 出局项与理由

| 项 | 理由 |
|---|---|
| `file-write-fallback` | 宿主缝，不是用户能力：无 handler 注册时完全惰性。本地无沙箱、无消费者 `[复核]` |
| `approval` | 依赖上游审批 UI 与 tier/策略体系 |
| `security_scan` | 需 `src/security/` 整套 + Codex Security 云（外部账号） |
| `acp-bridge` | 本地走 ACP 服务端（`modes/acp/`），架构互斥 |
| `computer/`、`tts`、`vibe` | 依赖驱动 / 供应商 / 上游独有产品形态 |
| `eval` 的 py 半边、`think`、`manage_skill`、`memory_edit` | 与本地形态重复，或前作已判"不值得"（`upstream-tool-port-evaluation.md:71,107,114`） |
| `bash-pty-selection`、`fs-cache-invalidation`、`auto-generated-guard` | 本地已等价或更强 `[复核]` |

## 待定（不在 13 条内）

- tree-sitter 结构化摘要（`read-summary.ts`）：依赖已放行，但收益未证，等 read 系票落地后再评估
- 路径后缀匹配 memoize（`read-path-resolution.ts`）：性能项，不是能力项

## 未覆盖

`lsp/`、`browser/`（1508 KB）、`image-gen.ts`、`hub`、`session/*`、`eval-format/`、`computer/` 内部细节。
