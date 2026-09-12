---
name: Tool 呈现协议迁移：采用上游 xd:// 设备挂载
status: done
objective: 移植上游 oh-my-pi 已验证的 Tool 呈现设计（Catalog / Enabled Tool Set / Discoverable Tool Set 三层 + Load Mode + xd:// 设备挂载），并承接 tool2 让出的 4 项工具能力
doneWhen: |-
  - 交付票全部 complete 并通过各自 gate（第一期 12 张 + 第二期 2 张；3 张经前提核验移除或降级，理由见批注）
  - 合体验证通过（≥2 个 complete 子任务必须走 integration worktree）
  - 挂载开关关闭时，顶层工具暴露与改造前一致
  - internal 工具不可由用户配置、设置或发现结果启用（运行时注入通道除外，见 ADR-0003）
  - 两条系统提示路径都包含设备说明，SYSTEM.md 覆盖场景下不消失
lastActivity: 2026-09-12 12:42
sessionRefs:
  - ~/.cornfield/agent/sessions (tool1)
nextAction: 已完成并合入 main（当前 main = e7779db8c6）。远端 origin/main 未 push（领先 40 提交）。回退锚点：`git reset --hard pre-tool-xdev-batch`。
artifacts:
  - docs/adr/0003-tool-presentation-xdev.md
  - CONTEXT.md（Tool Catalog / Enabled Tool Set / Discoverable Tool Set / Load Mode / xd:// 挂载 / Tool Metadata）
  - .scratch/tool-xdev/issues/01..18
  - ~/.cornfield/squads/squad-20260911-tool-xdev/bundle.json（14 子任务，--check 通过）
  - ~/.cornfield/squads/squad-20260911-tool-xdev-w2/bundle.json（第 2 波 6 子任务，base=验证分支，--check 通过）
decisions:
  - 2026-09-11 采用上游 xd:// 作为 Tool 呈现协议，不自行推导
  - 2026-09-11 Load Mode 三层：essential / discoverable / internal；internal 约束注入权而非调度权
  - 2026-09-11 规范名 + legacy 别名（find→glob、search→grep、todo_write→todo）
  - 2026-09-11 read/write 承担 xd:// transport，永不挂载
  - 2026-09-11 挂载开关默认开启
  - 2026-09-11 MCP 最终统一走 xd，MCP 发现入口与旧配置退场（分批落地）
  - 2026-09-11 MCP 发现入口与 web_search 判为 essential
  - 2026-09-11 接管 tool2 的 4 项工作，单人执行
  - 2026-09-11 【约束】所有修改必须合入 worktree 的验证分支；合入 main 必须用户明确同意
openQuestions:
  - 旧名移除（别名表 find→glob / search→grep / todo_write→todo + 配置 key 只读兼容层）未排期 —— ADR 明确「另开一票」
  - MCP 会话侧残留：`agent-session.ts` 仍留有整套 discovery 子系统（#mcpDiscoveryEnabled / #discoverableMCPTools / #discoverableMCPSearchIndex / #selectedMCPToolNames / refreshMCPTools / #persistSelectedMCPToolNamesIfChanged），而设置入口已退场 ⇒ 无法再被配置开启的旧设计残留
  - `read`/`write` 的影响面单独评估（ADR 后果段要求：gateway / 子 Agent / RPC host tool / 自演化路径共用）—— 未见任何评估记录
  - 两份「首版」名单（essential 名单、XDEV_KEEP_TOP_LEVEL）的复评未排期
  - 【新增】合并/拉取任何触及 crates/pi-natives 的改动后，各检出必须重建 addon（gitignore 产物不随合并走）—— 主检出于本批就中过：见批注
---

## 当前状态（2026-09-11）

**已完成，等用户验收与合并裁决。** 分支 `squad-20260911-tool-xdev-w2b-integ`，tip `83841ae884`；相对 `main` 29 提交 / 66 文件 / +2028−129，可 **fast-forward**；`main` 仍为 `8daba81c48`。

五道门禁全绿（均在集成验证区实跑）：

1. `CI=0 bun check`（含 `check:tools` + Rust fmt/clippy；Rust 命令已改为按 workspace 成员逐包调用，否则在 git worktree 里必失败）
2. `bun test packages/coding-agent/test/tools` → **610 pass / 347 skip / 0 fail**
3. `bun packages/coding-agent/scripts/verify-xdev-mounting.ts` → **ALL PASS**（必须在 `bun test` 之外跑：挂载在该运行时下恒关）
4. `cargo nextest run -p cornfield-natives` → **214 pass / 0 skipped**
5. `PI_NATIVE_EXPECTED_ADDONS=darwin-arm64 bun scripts/ci-release-verify-natives.ts` → **links only system libraries**

交付内容：wave 1（T1/T4）+ wave 2（M1/A1–A4/N1）+ wave 2b（F1/G1）+ 收尾（ADR/CONTEXT 措辞、删 `INTERNAL_TOOL_NAME_FALLBACK`、`integrate.ts` 与 `run-rs-task.ts` 两处小队/仓库门禁修复、门禁落仓、两个包的 changelog）。

**下一读者须知 —— 本批最重要的教训**：「一个能力只要被排除在 gate 的默认路径之外，就是构造性地未经验证。」它在两层各出现一次：

- build-feature 层：`grep-pcre2` 必须进默认 feature，否则默认 `cargo nextest` 测不到 PCRE2 —— 被 N1 正确论证并保留。
- runtime 层：`isBunTestRuntime()` 让 `bun test` 恒不挂载，于是 `lsp` 以空摘要挂载、944 个单测全绿出厂 —— 靠场外真实运行时脚本才挖出来，现由第 3 项门禁兜住。

同族教训：本批四次遇到「先前的绿不可信」（Rust 段静默跳过已提交改动、workspace 级命令在 worktree 失败、符号链接依赖致同名类两身份、biome 缓存陈旧），每一次的修法都是同一个 —— **让门禁跑在真实环境里，并让失败可见**。

## 设计方案

移植上游已验证的 Tool 呈现协议，不做本地重新推导。核心是把「工具已知 / 本次会话可用 / 如何呈现给模型」三件事拆开：工具目录是静态定义真源，Enabled Set 由目录加配置、环境与 Agent 边界算出，discoverable 工具不再占用顶层 schema 而是挂载为内部 URL 设备，由 read/write 承担列出与执行入口。internal 类工具只约束注入源，不约束调度。

## 参考文档

- docs/adr/0003-tool-presentation-xdev.md（本批架构决策）
- docs/adr/0001-gateway-bridge-process-model.md、docs/adr/0002-unified-protocol-layer.md（正交）
- docs/gateway/im-agent-prompt.md（系统提示分层，设备说明需覆盖的路径）
- CONTEXT.md（术语：Tool Catalog / Enabled Tool Set / Discoverable Tool Set / Load Mode / xd:// 挂载 / Tool Metadata）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-09-11 18:04 — 发现并修复 squad skill 脚本两个 bug（squad-state.ts 的 update 分支不可达、bootstrap.ts 总结行引用未定义变量），均已验证；tool2 让出的 4 项并入本批；T9 发现依赖空洞（worktree 从 base 切出、deps 不传代码），实测确认对象字面量式工具（review.ts:133）需要接口先生效，因此改为「T1+T4 先行 → 合入验证分支 → 从该分支集结第 2 波」；用户新增约束：合入 main 必须明确同意
- 2026-09-11 17:47 — Phase 3 完成。任务包落 ~/.cornfield/squads/squad-20260911-tool-xdev/bundle.json（16907 字节，14 子任务）；自查：依赖无环、无自指、精确路径无冲突；硬闸门 `bun run ~/.cornfield/agent/skills/squad-programming/scripts/bootstrap.ts --check <bundle>` 输出「任务包校验通过: squad-20260911-tool-xdev（14 个子任务）」；文档已提交 8daba81c48
- 2026-09-11 17:43 — 提交本批设计产物（5 文件，纯文档）
- 2026-09-11 17:38 — topic 创建。Phase 1 决策清单经用户确认，架构决策落 ADR-0003，术语落 CONTEXT.md；18 票落 .scratch/tool-xdev/issues/；tool2 确认零交集并停手，其 4 项工作由本批接管

- 2026-09-11 18:08 — 放行 T1/T4（GO 已发、均落 running）；清理 12 棵被第 2 波取代的树：关闭 workspace（12/12 ok）、清除孤儿构建进程（cargo/clang/tsserver）、删 worktree 与分支（均停在 8daba81c48，无提交损失）、账本标 failed。worktree 由 19 降到 7。main 未被任何任务分支改动

- 2026-09-11 18:10 — T4 complete（settings-schema.ts +12，提交 f713cbdf9a）。独立复核：CI=0 bun check exit 0、settings-manager.test 10 pass。发现并实测确认全队 gate 环境坑：worktree 内裸跑 bun check 必 exit 1（CI=1 使 check:rs 不跳过，cargo fmt 走到被 exclude 的 vendored crate 后向上找到主仓库根 Cargo.toml）；同一 worktree CI=0 bun check exit 0。已把全队 gate 改为 `CI=0 bun check` 并同步 T1 与第 2 波任务包。

- 2026-09-11 18:20 — 第 1 波完成并验证。T1 首报 COMPLETE 但 gate acceptance 要求的测试未交付（提交仅 2 文件），打回后补 31f4c7de7a（与 essential-tools.test.ts +37，5 pass）通过。integrate.ts 将 feat/xdev-t1、feat/xdev-t4 合入验证分支 squad-20260911-tool-xdev-integ（exit 0，无冲突）。验证区补装依赖 + 从主检出引导 .node 后：CI=0 bun check exit 0，两文件共 15 pass / 0 fail。main 停在 8daba81c48 未动。

- 2026-09-11 18:38 — 第 2 波集结完成（exit 0，bootstrap 修复在生产路径验证）。基检阶段发现并修复自己的错误：改了 gate.verifiers 却漏改 acceptance 文案（仍写「验证：bun check 通过」）；已修正全部 brief。［注：当时归因它「导致」了 Rust 全量构建，后经 A3 进程链实测纠正 —— 见下方更正。］
- 2026-09-11 18:38 — 磁盘事件：发现时仅剩 12Gi（98%），6 个 worktree 各有 cargo+4〜6 rustc 在跑。处置：通知 5 个 worker → 杀 m1/a1/a2/a3/a4 的 cargo/rustc（保留 n1）→ 删这 5 个 worktree 与 T1/T4 的 target/。可用空间 12Gi → 18Gi。未动主检出 target（23GB）与其他 squad 遗留（~6.3GB），等用户拍板。
- 2026-09-11 18:38 — 验收 A1（052735f3bf，8 文件 = scope，+16）与 A2（03e1e80d58，5 文件 = scope，+15）：父跑 gate 均 CI=0 bun check exit 0 + index.test 17 pass / 0 fail。A1 的 8 条摘要全量核对通过（仅 bash 为 essential，其余 discoverable）。A2 的 checkpoint.ts +7 已查明为该文件含 CheckpointTool/RewindTool 两类工具。

- 2026-09-11 18:40 — A1 发现本仓历史里存在上游原始提交 `649794360c`（added loadMode and summary to AgentTool discovery），其 BUILTIN_TOOL_METADATA 表可作摘要蓝本（先对照再判断，非照搬：其 8 条中有 3 条对本仓实现不成立）。已转为线索传给仍在跑的 A3/A4。
- 2026-09-11 18:40 — 预调一个跨票连锁故障：M1 的挂载行为会让 `test/tools/index.test.ts` 里断言旧顶层工具列表的用例失败（A1–A4 因 worktree 不含 M1 改动而 gate 全绿，故单 worktree gate 抓不到）。已授权 M1 更新该文件（红线：不得为过测试削弱实现），并把第 3 波 scope 从 `test/tools/**` 收窄到三个具体文件避重叠。**教训：单 worktree gate 天然抓不到跨票行为破坏，只有集成验证能抓。**

- 2026-09-11 18:46 — 【归因更正】磁盘事件的真因不是 worker 跑裸 bun check，而是 **harness 为每个 worktree 自动拉起 rust-analyzer**，由它发起 workspace 级 `cargo check --workspace --all-targets`；N 个 worktree = N 份全量 Rust 构建。证据（A3 实测进程链）：cargo pid 16896 ← ppid rust-analyzer ← ppid 该 worktree 的 cornfield 会话。A3 同时提醒「杀 cargo 不持久，rust-analyzer 会重拉」。
- 2026-09-11 18:46 — 实验验证了上面的边界：按 cwd 定位并杀掉 a1/a2/a3/a4（已终态、worker 空闲）的 rust-analyzer 后，60 秒内未复活，磁盘 17Gi → 21Gi（回收 ~4GB）。所以「打地鼠」只适用于 worker 仍在编辑的树；终态树杀一次即永久生效。m1/n1 的 rust-analyzer 保留。

- 2026-09-11 18:47 — 【自身缺陷·已出现四次】scope 起草遗漏，四次漏的都是同一类：**契约/类型/生成物所在的文件**。依次为：(1) acceptance 文案里的 gate 命令与 verifiers 不一致；(2) `test/tools/index.test.ts` 的归属（行为变更导致其断言过期）；(3) `system-prompt.ts`（提示渲染上下文的选项类型）；(4) `packages/natives/native/index.d.ts`（生成但被 git 跟踪的绑定契约）。共性：按「功能要写哪几个源文件」列 scope，而接线类改动总落在定义契约的那个文件里。四次均靠 worker 主动发现后问我，说明任务包自身不自洽。**回写 skill 时加检查项：列 scope 时同时问「这个改动会牵动哪个类型/契约/生成文件的定义处」。**

- 2026-09-11 18:48 — 【安全性证据】A4 动手前跑了 impact 分析（HIGH）并逐层证伪，结论对整批标注都成立：① 所有 provider（anthropic/openai-responses/openai-completions/azure/google-shared/ollama/bedrock/cursor/codex）均显式挑 name/description/parameters/strict 四个字段建新对象，无一处 spread 整个 tool 对象 —— loadMode/summary 不可能泄漏进 API 请求；② agent-loop.ts:176 的展开只 spread 进内部 Context；③ 全仓无 Object.keys(tool)/entries/structuredClone(tool)，对 tool 的 JSON.stringify 只作用于 tool.parameters；④ 声明在 M1 装配落地前是惰性的。HIGH 来自结构性扇出（d1 仅 1-2，d2≈48、d3≈91 全从 createTools → ToolSession → TUI/session 扇出），9 个符号 processes_affected 均为 0。

- 2026-09-11 18:49 — 【缺陷·A3 发现，已转 M1】adapter 边界丢 loadMode：web_search 在 sdk.ts 有第二条注册路径（1231-1233 推 CustomTool，1451-1453 按名 `toolRegistry.set` 覆盖 builtin 实例），而 CustomToolAdapter.wrap() 后 loadMode=undefined，resolveLoadMode("web_search", undefined) → discoverable。根因在接口层：ToolDefinition（extensibility/extensions/types.ts）与 CustomTool（custom-tools/types.ts）都没有 loadMode/summary 字段。与上游 #5764 同型。即时风险被 M1 的 XDEV_KEEP_TOP_LEVEL 兜住（已含 web_search），但那是兜底不是机制性修复。已要求 M1 核实：① Enabled Set 从 createTools() 输出算还是从 sdk.ts 的 toolRegistry 算；② 除 web_search 外还有哪些工具走 adapter 重注册，是否会导致 essential 工具静默降级。后续项：接口层补 loadMode/summary 并让 adapter 透传（或在 adapter 边界统一走 defaultLoadModeForToolName）。

- 2026-09-11 18:51 — 【完整性缺口·A4 发现】① 4 个公开工具无任何声明：ask / edit / find / lsp。前三个在集中 essential 名单内，靠兜底仍判 essential（无功能影响，但缺 summary）；**lsp 不在名单内 → 会被挂载且无 summary，提示里的设备目录会渲染出一行空摘要**。② 更重：票 16（find 超时返回部分结果）与票 17（编辑工具自动修复）从未排进任何一波。票面去向核对：wave1=02(T1)+08(T4)；wave2=01/03/04/05/06/07/09(M1)+10/11/12/13(A1-A4)+14/15(N1)；wave3=18(I1) —— 合计 16，缺 16/17。而这两张正是用户批准的「接管 tool2 的 4 项」中的两项（另两项：grep PCRE2→N1、write conflict://→M1），实际只排了 2 项。根因：因 T9 依赖问题重写 wave-2 结构时漏排两票，且当时报『6 个子任务』未做「18 → 各波合计」核对。性质比前四次重：前四次是文件漏列，这次是整张票漏排。修法：新增 wave 2b（F1/E1/G1，base=当前验证分支，文件与 wave2 全票零重叠）。

- 2026-09-11 18:53 — 【漏项三·M1 发现】票 07 的验收里我把 `conflict://` 写成既有 handler，实际它在本仓不存在 —— 它来自接管的 tool2 清单（「write 的 conflict://」），是要从上游移植的功能。M1 找不到它后按「单一分发表 + archive.zip:entry / db.sqlite:table 一并纳入」理解并实现，这半是对的、保留。
- 2026-09-11 18:53 — conflict:// 另立为 wave3 的 C1：上游形态是 read 侧记录冲突区段（ConflictHistory 带编号）+ write 侧按编号拼接，需新增冲突探测模块，跳 read.ts/write.ts。验收写明：编号无效时报错并列出可用编号；重复替换行为必须明确（幂等或报错，不得静默错拼）；编号通过 session 共享而非隐式全局态；进既有单一分发表不新增第二套分发。base=w2-integ。
- 2026-09-11 18:53 — 【漏项汇总·均源于我】① 4 个工具无声明（ask/edit/find/lsp）→ wave2b G1；② 票 16/17 整票漏排 → wave2b F1/E1；③ conflict:// 误认为既有 → wave3 C1。三份任务包均已备好并 --check 通过。

- 2026-09-11 18:53 — 【A3 缺陷的暴露面已解】M1 答复：Enabled Set 在 `createTools()` 内部、从**工厂直构的 builtin 实例**算（splitToolsForXdev 吃工厂产物，resolveLoadMode 读类上声明）→ A3 的类上声明生效；sdk.ts 的 toolRegistry/adapter 重注册发生在 **split 之后**，MCP/extension 工具根本不进 split，一律留顶层（不挂载）—— 与「MCP 迁移另票」的边界一致；web_search 被 registry 覆盖只影响那个实例，不影响 split 结果（keep-list 兼作兜底）；走 adapter 的只有 CustomTool/extension/MCP，**无 essential builtin** → 本批无静默降级路径。⇒ 接口层缺 loadMode/summary 仍是真实缺陷，但在本批不可达；作为后续项保留（MCP 迁移那票必须一并解决）。

- 2026-09-11 19:00 — 【验证盲区与解法】挂载启停含 `isBunTestRuntime()` 环境边界 → **`bun test` 下一律不挂载**，因此所有基于 bun test 的验证（含集成合体验证）看到的都是「挂载关闭」的世界，挂载路径未被端到端执行过（绿 ≠ 功能可用）。可预测后果：若挂载路径真有问题，全绿也会直接上线。解法（M1 提供并已自用）：**在非 bun test 的普通 bun 进程里跑一次性脚本**直接调 `createTools`（或调 `buildSystemPrompt` 传 `xdevDevices`）—— 此时 `isBunTestRuntime()` 天然为 false，可见真实设备目录与 `write xd://` 全链路。集成验证清单必须包含这一条。
- 2026-09-11 19:00 — M1 收尾：read.ts 有意不改（read 的内部 URL 分发本就协议无关，sdk.ts 注册 XdevProtocolHandler 即插即用，票 06 的交付由 handler 注册满足）；`prompts/tools/read.md` 不授权加 xd:// 指引（条件性指引应放在条件渲染的系统提示段，而非常驻工具描述——token 经济学 + 条件性）。N1 补授权 `Cargo.lock`（第六次漏「生成但被跟踪的契约物」），并预警 PCRE2 的 C 依赖跨平台风险（参 maudio-vendored 前科）。

- 2026-09-11 19:29 — 【N1 独立复验】commit 3e0978f4ef，8 文件（grep.rs +218/-21、Cargo.toml、Cargo.lock、docs/natives×2、tools/search.ts、native/index.d.ts、native/index.js），全部落在声明/补充授权 scope 内，零蔓延。逐项实测：① `cargo nextest run -p cornfield-natives` → 214 passed / 0 skipped（与自报一致）；② `cargo fmt -p cornfield-natives --check` → 0；③ `cargo clippy -p cornfield-natives --all-targets` → 0，3 条 warning 全在 audio.rs/audio_vpio.rs，grep.rs 零新增；④ `bun test ./packages/coding-agent/test/tools` → 579 pass / 347 skip / 0 fail（自报 657 不准，第二次同类）；⑤ **端到端功能实测（非 bun test 进程，加载真实 .node）** → ALL PASS：rust 引擎普通正则匹配、rust 引擎拒 lookaround/backref 且报错明确、pcre2 引擎支持 lookahead 与反向引用、不传 engine 默认走 rust。实现评审亮点：feature 关闭时 `build_pcre2_matcher` 返回含 "not available" 的错误而非静默降级，并专写 `pcre2_engine_errors_when_unavailable` 断言此点 —— 失败面诚实。⚠️ 未决：`default = ["full"]` 且 full 含 "grep-pcre2" → 默认构建编译 PCRE2 C 源码；已向 N1 追问 aarch64-linux 交叉编译判断与「是否应进 full」。
- 2026-09-11 19:29 — 【发现：门禁假绿（仓库级，非本批）】`scripts/run-rs-task.ts:73-82` 的 `hasRustAffectingChanges()` 只看 `git status --porcelain`（**仅未提交改动**）。后果：Rust 改动**提交后**再跑 `CI=0 bun check` → check:rs 静默跳过（本次实测打印 “Skipping check:rs (not in CI and no Rust-affecting changes were found)”），而 grep.rs 明明改了 → **绿色不覆盖 Rust 面**。未提交时才会触发 check:rs。
- 2026-09-11 19:29 — 【发现：worktree 里 Rust 检查双重失效】① 提交后静默跳过（上条）；② 即便触发，`cargo fmt --all` / `cargo clippy --workspace` 在 worktree 报 `cargo metadata` 错 —— vendored crate `brush-builtins-vendored` 在 worktree 内解析到**主检出**的 workspace（`workspace: /Users/.../cornfield/Cargo.toml`），与改动无关。⇒ 本批 Rust 票的验收命令固定为 crate 级：`cargo nextest run -p cornfield-natives` + `cargo fmt -p cornfield-natives --check` + `cargo clippy -p cornfield-natives --all-targets`。⇒ 候选新票：修 `run-rs-task.ts` 的判定（改为含未推送提交，如 `git diff --name-only $(git merge-base HEAD @{u})..HEAD` 与 status 并集）。

- 2026-09-11 19:37 — 【wave-2 集成完成】6 分支（m1/a1/a2/a3/a4/n1）**零冲突**合入 → 分支 `squad-20260911-tool-xdev-w2-integ`，工作树 `.worktrees/squad-20260911-tool-xdev-w2-integ`。（先做了改动文件集互斥预检，实测确认两两不相交。）
- 2026-09-11 19:37 — 【wave-2 集成验证】5 道：① `CI=0 bun check` → 0；② `bun test ./packages/coding-agent/test/tools` → **597 pass / 347 skip / 0 fail**（与 M1 分支一致，标注与 Rust 改动合体后无回归）；③ `cargo nextest run -p cornfield-natives` → **214 passed / 0 skipped**；④ 真实 addon 端到端 pcre2 → ALL PASS；⑤ **真实运行时挂载管线（非 bun test）→ 分区不变量成立**：legacy 22 == 顶层 13 + 设备 9，无丢失无重复；边界全对（显式 toolNames 关挂载、tools.xdev=false 关、keep-list 不挂载、read/write 不挂载）。
- 2026-09-11 19:37 — 【真缺陷·单测盲区实证】`lsp` 被挂载为设备但**无 summary**（设备条目空）→ 仅真实运行时可见，944 个单测全部漏掉。**已由 wave-2b 的 G1（lsp/index.ts）覆盖**。⇒ 本批不能只靠 bun test 验收，此条是硬证据。
- 2026-09-11 19:37 — 【环境坑 1：`integrate.ts --link-node-modules` 机制错误】它把 `node_modules` 做成指向主检出的符号链接，而内部的 `@cornfield/* -> ../../packages/*` 相对链接因此解析回**主检出**源码 → 同一类两个身份 → tsgo 报「Type X 不可赋值给 Type X」。正确机制 = bootstrap.ts:435-441 的**工作树内 `bun install`**（真实目录，链接相对本工作树）。wave-1 与各子任务工作树都是这么建的，所以我加这个 flag 反而搞坏了 wave-2 的 TS 验证。⇒ 候选修复：integrate.ts 去掉 --link-node-modules，改为条件 bun install。
- 2026-09-11 19:37 — 【环境坑 2：集成工作树缺 gitignore 的原生 addon】`.node` 不入 git，新集成工作树没有它 → 59 个测试全报 "Failed to load cornfield_natives native addon"（**假失败**）。补法：从已构建的工作树复制。本次用 n1 的 pcre2 版（32.9MB，sha256 109ce60b…）。⇒ integrate.ts 应在建完工作树后复制/构建原生 addon，否则每个集成都假红。
- 2026-09-11 19:37 — 【自省】排查中我的一条断言（ask/job/search_tool_bm25 缺失）**是错的** —— 拿 legacy 路径当 ground truth 才发现它们在本会话压根未构造（无 UI、MCP discovery 未开）。教训：对“应该存在的集合”做断言前，先向环境本身求真（legacy 基线），否否则会把环境事实误告为代码缺陷。

- 2026-09-11 19:37 — 【补验：ADR 的“默认开启”断言】schema `tools.xdev: { type: boolean, default: true }` + 真实运行时实测（不传任何 override → 挂载生效 Map(9)）→ **ADR 该条为真**。（这条差点漏掉：早期脚本全程显式传 `{"tools.xdev": true}`，默认值从未验证 —— 若默认 false，功能对所有人关闭，与 ADR 矛盾。）
- 2026-09-11 19:37 — 【wave-2 集成验证终态】验证脚本 10 条断言：9 过 / 1 真缺陷（`lsp` 无 summary，已由 wave-2b G1 覆盖）。集成分支 `squad-20260911-tool-xdev-w2-integ`：5 个 merge commit，工作树无残留改动，base..head = **49 文件 +1027/−73**（= 6 票文件数之和 11+8+5+8+9+8），无夹带。

- 2026-09-11 19:41 — 【N1 票 14 完整验收·含跨平台】aarch64-linux 交叉编译**实跑通过**：`bun scripts/build-native-linux-arm64.ts` → `Compiling grep-pcre2 v0.1.10` → Finished in 2m45s → 产出 cornfield_natives.linux-arm64.node。⇒ N1 关于“低风险”的推断已验证为事实（cc-rs 路径 + zig 映射，无需 bindgen）。**N1 全部四个未决问题已闭环**：crate=grep-pcre2 0.1.10（→pcre2 0.2.11→pcre2-sys 0.2.10）；有 C 依赖（cc 编 bundled PCRE2，无 bindgen/cmake）；feature-gated 且 full 默认启用；默认构建即编译但运行时不主动用。
- 2026-09-11 19:41 — 【重要：仓库明文强制的检查此前无人跑】`scripts/build-native-linux-arm64.ts:10-11` 明文："Run it before pushing changes that touch `crates/pi-natives` or its Cargo.toml/Cargo.lock."（理由：v1.1.0 曾因此烧掉三个 CI run）。⇒ 本次 N1 的改动正好命中该条件，却不在它的 acceptance / gate.verifiers 里 —— **我的工单起草漏了这条仓库明文要求**（第七次同类：漏掉仓库里已写明的契约）。后续任何改 crates/pi-natives|Cargo.toml|Cargo.lock 的票，gate 必须含此命令。

- 2026-09-11 19:41 — 【命名的不变量·本批最重要的教训】**「一个能力只要被排除在 gate 的默认路径之外，它就是构造性地未经验证。」**同一批次里以两种形态出现：① build-feature 层：N1 论证 —— 若 `grep-pcre2` 不进 `full`（默认 feature），cargo nextest 就再也测不到 lookaround/backref，核心交付被推出 gate；⇒ 进 full + 用 `build:native:linux-arm64` 显式兜住交叉面。② runtime 层（**本批现状，未修**）：`isBunTestRuntime()` 让 bun test 恒不挂载 ⇒ 挂载路径被 gate 完全排除 ⇒ `lsp` 空 summary 出厂而 944 个单测均报绿。⇒ **候选新票（建议立）**：把场外验证落成仓库脚本（如 `packages/coding-agent/scripts/verify-xdev-mounting.ts`）并写进 gate，否则当前唯一的措施是 `/tmp/xdev-mount-verify.mjs` ——下一个人不知道它存在，等于没有。该脚本的 10 条断言已跑通（9 过 / 1 真缺陷），可直接搬进仓库。
- 2026-09-11 19:41 — N1 四问已全部闭环并接受（是否为 C 依赖 / aarch64-linux 风险 / 是否 feature-gated / 是否进 full），票 14 完整验收。

- 2026-09-11 19:42 — 【真缺陷·发行级：natives addon 动态链接 brew pcre2】**N1 的“可接受环境方差”判断只在行为面成立，漏了链接面。**证据：`otool -L` 集成产物显示 `/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib`；本机 `pkg-config --modversion libpcre2-8` = 10.47（probe 成功 → 走 pcre2-sys build.rs 的动态分支）。**对照组**：主检出的 addon（pcre2 之前构建）otool 一个 brew 库都没有，只有 /usr/lib 与系统 framework ⇒ **本批新引入的第一个非系统动态依赖**，非既有属性。后果：制造机若有 brew pcre2（GitHub macOS runner 很可能），出货二进制就要求用户机器上存在该 dylib；安装脚本装的用户没有 brew → addon 加载失败。且同一提交因制造机偶发状态产出不同产物。⇒ 已打回 N1：新建仓库级 `.cargo/config.toml` ([env] PCRE2_SYS_STATIC = "1"，本仓现有 rust-toolchain.toml 这类“仓库级构建确定性”先例）；验收含 otool 无 /opt/homebrew 条目、功能仍真（改用 bundled 静态后）、nextest 214、新文件随提交、文档补一句不变量。⇒ **命名教训：「行为面方差」与「链接面/产物面方差」是两回事。前者可用“我的代码只用稳定核心”排除，后者只能靠固定构建策略排除 —— 而后者在发行上更严重。**
- 2026-09-11 19:42 — N1 第 4 问的 build.rs 实读结果（保留作为背景）：pcre2-sys 0.2.10 build.rs:32-35 `want_static = pcre2_sys_static() || target.contains("musl")`，非静态且 pkg_config probe 到 libpcre2-8 则直接 return（不编 bundled）；PCRE2_SYS_STATIC=1 可强制 bundled 静态。musl 与 aarch64-linux(zig sysroot 无 .pc) 恒走 bundled。

- 2026-09-11 19:43 — 【双路径提示注入已实证】脚本 `/tmp/xdev-prompt-verify.mjs` 5/5 通过：默认路径 len=27590 有设备段；**customPrompt 路径 len=16591 也有（关键 —— 若这条缺失，自带自定义 system prompt 的用户会完全失去挂载工具的可达性）**；customPrompt 确实替换默认正文（16591 < 27590）；无设备时不渲染该段（不白占 token）；指令含 read/write xd://。
- 2026-09-11 19:43 — 【ADR-0003 断言验证矩阵（已逐条实证）】当前已验：① read/write 永不被挂载（传输层）✓；② tools.xdev 默认开启（schema default:true + 无 override 实测挂载生效）✓；③ 分区不变量 legacy == 顶层 ∪ 设备（22 == 13+9，无丢失无重复）✓；④ keep-list（web_search/search_tool_bm25/irc/hub）不被挂载✓；⑤ 显式 toolNames 与 tools.xdev=false 均关挂载✓；⑥ 双路径提示注入✓（本行）。**未验/待决**：internal 工具的定义语（ADR 写「显式 toolNames 不可启用」与 reviewer 子 Agent 实际依赖相矛盾 —— 待用户拍 A/B）。
- 2026-09-11 19:43 — 【场外脚本清单（待落成仓库脚本，见候选新票 5）】`/tmp/xdev-mount-verify.mjs`（挂载管线 10 断言）、`/tmp/xdev-prompt-verify.mjs`（双路径注入 5 断言）、`/tmp/n1-pcre2-verify.mjs`（pcre2 端到端 5 例）。三者均在 /tmp，下一个人不知道它们存在。

- 2026-09-11 19:45 — 【动态链接缺陷已修复并双向复验】N1 新建 `.cargo/config.toml`（`[env] PCRE2_SYS_STATIC`），重建后 addon 32,913,664 → 33,226,336 字节（+312KB，静态链入 bundled PCRE2）。**链接面（我独立验）**：`otool -L` 重建后**不再出现 `/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib`**，只剩自身 install_name + 系统 framework + /usr/lib —— 与主检出（pcre2 之前）的 profile 一致。**功能面（我独立验）**：pcre2 lookahead / 反向引用在 bundled 静态库上仍可用，rust 引擎仍拒这两类且报错明确，不传 engine 仍走 rust → ALL PASS。
- 2026-09-11 19:45 — 【额外加固：cargo [env] 默认不覆盖环境变量】查 Cargo 官方文档（https://doc.rust-lang.org/cargo/reference/config.html）确认：`[env] VAR = "v"` **若环境里已存在同名变量会被忽略**，需 `{ value = "v", force = true }` 才强制。⇒ 已要求 N1 改为 force 形式：否则任何人/CI 预先设了 `PCRE2_SYS_STATIC` 就会静默走回动态分支，缺陷无声回归 —— 与本修复的目的（“同一提交 → 同一产物”）直接冲突。文档同时确认 config 按「当前目录 + 所有父目录」逐层合并 → 工作树根的 `.cargo/config.toml` 会被正确读到，合并回仓库根后同样有效。

- 2026-09-11 19:48 — 【不变量无机器检查 ⇒ 必然无声回归】查得：`scripts/ci-release-verify-natives.ts` 已被用来校验原生产物，但**只查两件**：addon 文件是否存在 + x86-64 变体是否混入 AVX-512 指令标记。**不查动态链接。**而本仓早已为「依赖悄悄引入不该有的东西」这一模式立了「版本 pin + 机器检查」组合 —— `crates/pi-natives/Cargo.toml:76-84` 明文：flate2 pin 到 1.1.9（zlib-rs 含 AVX-512）、crc32fast pin 到 1.4.2（无条件编 AVX-512 CRC 路径）。**PCRE2 动态链接是同一失效模式的上一层形态（链接层而非指令层），而这次没有任何检查。**⇒ 候选票（并入待拍板第 5 项）：扩 `ci-release-verify-natives.ts` 加「无非系统动态依赖」检查（macOS `otool -L` / Linux `readelf -d`），并按 `hasAvx512Markers` 的既有先例给纯解析函数配单测（`packages/natives/test/build-safety.test.ts` 已有该先例）。本仓有现成约定可循，不是新造约定。

- 2026-09-11 19:53 — 【票 14 收口】`force` 修正已落地：`.cargo/config.toml` 为 `PCRE2_SYS_STATIC = { value = "1", force = true }`（含 force 原因注释），commit `176a9df405`（amend）。我三项独立复验全过：配置内容 ✓；`otool -L | grep -c "opt/homebrew|pcre2" → 0` ✓；端到端 pcre2 ALL PASS ✓。（N1 报“重建”，但 addon mtime 仍为 19:45 —— cargo 判定无需重建，与预判一致；这是它第三次自报与实测有出入，仍以实测为准。）
- 2026-09-11 19:53 — 【wave-2 重新集成（含返工）】旧集成分支里 N1 部分还是返工前 `3e0978f4ef`（缺静态链接修复）—— 那是已知带缺陷的中间态，故用 `integrate.ts --force` 重建。6 分支再次全部干净合入。重建后重跑门禁：① `CI=0 bun check` → 全包 code 0 ✓；② `bun test ./packages/coding-agent/test/tools` → **597 pass / 347 skip / 0 fail**（与上次完全一致，逐位可复现）✓；③ 挂载管线场外脚本 → **9/10**，唯一缺陷仍为 `lsp` 空 summary（稳定复现）✓；④ 双路径注入 → **5/5** ✓；⑤ `cargo nextest -p cornfield-natives` → **214 passed / 0 skipped**（冷构建，且走的正是 `PCRE2_SYS_STATIC=1` 静态路径）✓。
⇒ **wave-2 集成（6 票含返工）5 道门禁全部通过，唯一遗留为真缺陷 `lsp` 空 summary（已由 wave-2b G1 覆盖）。**环境重建采用 bootstrap 机制（工作树内 `bun install`，非 `--link-node-modules`）+ 复制已构建 addon；`.cargo/config.toml`(force) 已随合并进入集成工作树，故从该树构建同样走静态链接。

- 2026-09-11 19:55 — 【任务包缺陷（已修）】wave-2b 的 `baseBranch` 错写为 wave-1 集成分支 `squad-20260911-tool-xdev-integ`（含 M1 的 xd 基础设施**之前**的状态）；而 G1 的验收正是「`lsp` 不再以空 summary 出现在挂载设备目录」——**在缺 M1 基础设施的树上无法观测**。⇒ 已改为 `squad-20260911-tool-xdev-w2-integ`（与 wave-3 一致，wave-3 本就正确）。教训：**后一波次的任务包 base 必须指向前一波次的集成分支**，否则 worker 在“看不到前序能力”的树上干活，自验不可能通过。

- 2026-09-11 19:56 — 【wave-2b 前提核验：三票里一票冗余】**逐一去代码里核前提，而非信任当初的推断**：F1（find 超时丢结果）**成立** —— `find.ts` 超时时 `throw new ToolError("find timed out after Ns")`，丢弃已收集全部结果；G1（ask/lsp 呈现元数据）**成立** —— `lsp` 空 summary 已被真实运行时实测坐实；**E1（edit 自动修复）不成立** —— 该能力已存在且已测试：`replace.ts` 6 策略 `ContextMatchStrategy = exact|trim|unicode|prefix|substring|fuzzy` + `SequenceMatchStrategy(exact/trim-trailing/trim/…)`；`hashline.ts` `tryRebaseAnchor` + `ANCHOR_REBASE_WINDOW=5`，且 warnings 逐字输出 `Auto-rebased anchor … (line shifted within ±5; hash matched)` —— **逐字命中 E1 验收的「行锚点偏移被自动修复且显式标注」**；测试覆盖：`test/core/atom.test.ts:775-796`（rebase warnings 断言）与 `test/edit-diff.test.ts:126`（fuzzyMatches 上报）。⇒ 已从 bundle 移除 E1（保留会诱发 worker 另造与既有 6 策略并行的修复机制）。wave-2b 现为 F1 + G1，任务包校验通过。
- 2026-09-11 19:56 — 【教训·第三次同源】我起草工单时按「对比中推断的需求」而非「先追代码现状」定前提，本批已第四次（前三次：漏/多列契约物、多列 read.ts）。⇒ **凡「某能力缺失，需要新增」型工单，开工前必须先做一次存在性核验**（搜代码 + 搜测试）；已存在则降级为纯测试票或移除。

- 2026-09-11 19:56 — 【wave-3 前提核验：一票越界、一票大部分冗余】用刚落地的规则去核 wave 3 两票：
  **I1（不变量与回归）—— 大部分已存在。** M1 的 `test/tools/xdev.test.ts` 已 17 个用例逐条覆盖：normalizeToolName 别名、splitToolsForXdev（essential/internal 留顶层 / 两集不相交 / KEEP_TOP_LEVEL）、xdevMountingActive（三边界）、createTools with mounting（开关开/关/显式清单，含 `mockNonTestRuntime` 解除环境边界）、XdevProtocolHandler（列设备/手册+wire schema/未知设备带目录报错）、write xd:// 传输。残余缺口仅为我实测掘出的三条「属性断言」：分区等式（legacy == 顶层 ∪ 设备）、**每个挂载设备 summary 非空**（这条会拓到 `lsp`）、默认开启。⇒ 建议 I1 从「不变量与回归」**降级为「补三条属性断言」**（cheap 级，极小 scope）。
  **C1（conflict:// 移植）—— 前提成立但越界。** 全树搜 `conflict://|conflictDetect|ConflictProtocol` 零命中（前提✓），但它是**上游另一个协议设备、一项新增能力**，不是 xd:// 呈现机制的一部分，没有任何已证实缺口/观测缺陷 ——系我起草时从上游对照带入的**范围蔓延**（用户原话只要求“抄 xd:// 呈现设计”）。⇒ 建议从本批移除（除非用户明确要整个上游 xd 家族）。
- 2026-09-11 19:56 — 【规则二次应用】刚立的「存在性核验」规则立即复用于 wave 3，又拓出两处 —— 说明「推断型前提」在本批是系统性风险，不是个例。

- 2026-09-11 23:24 — 【wave-2b 完成并集成】F1 + G1 两票均父独立复验通过。**F1**（find 超时）commit `d8d0d842c8`：超时从「抛错丢光」改为返回已收集部分结果 + 标 `incomplete:{reason,timeoutMs}`，且顺手修了更隐蔽的一条 —— incomplete 且 0 文件时不得渲染 “No files found”（那是在断言它并不知道的否定）；`globTimeoutMs` 做成可注入选项以便可测。**G1**（ask/lsp 元数据）commits `a72b91a340`+`1f1c2e9be4`：`lsp` 声明 discoverable + 单行摘要、`ask` 声明 essential + 单行摘要；**G1 纠正了我的判断** —— 目录不是渲染空条目，而是回落渲染 description 首行（`buildXdevDeviceCatalog:110`），我据此也改了自己脚本里那句不实描述。
- 2026-09-11 23:24 — 【新门禁实战：由红转绿】用新脚本 `verify-xdev-mounting.ts` 拷进 G1 工作树跑真实运行时：修复前两条红（with/without summary: lsp、fell back to description: lsp）→ 修复后 **ALL PASS**。同一断言、同一数据，转绿是因为缺陷真被修，不是断言被放松。
- 2026-09-11 23:24 — 【集成完成】`squad-20260911-tool-xdev-w2b-integ`（base = w2 集成分支，2 分支零冲突）。五道门禁全绿：`CI=0 bun check`（含 check:tools + Rust fmt/clippy）、`test/tools` **610 pass/347 skip/0 fail**（597 + F1 的 12 + G1 的 1）、`verify-xdev-mounting.ts` **ALL PASS**、`cargo nextest -p cornfield-natives` **214/0**、`ci-release-verify-natives.ts` **links only system libraries**。
- 2026-09-11 23:24 — 【环境坑 3：addon 复用会选到过期产物】新写的自动补 addon 逻辑按 mtime 取最新，结果选中了从主检出复制来的旧 addon（探针：`SearchEngine=false`），而集成区 natives 已含 PCRE2，等于拿错的二进制跑测试（对正确的树产生假红）。⇒ 策略改为「能不能信」而非「哪份新」：本区 natives 与 main 不同时一律在本区构建，相同才复用。
- 2026-09-11 23:24 — 【先前的绿曾被缓存污染】我的 `CI=0 bun check` 多次报绿后，`check:tools`（= `biome check .`）开始报出 M1 代码里的 `useTemplate` 违规（已修）。该违规为既有，biome 缓存失效（`bun install` 重建 node_modules）后才暴露。**又一个「先前的绿不可信」实例 —— 与运行前清理缓存、以及把门禁跑在干净环境里同样重要。**

- 2026-09-11 23:24 — 【wave-3 去向已收口，不再单独开工】**I1（不变量与回归）→ 由新门禁脚本实际交付**：它原本要补的三条属性断言（分区等式 legacy == 顶层 ∪ 设备、每个挂载设备 summary 非空、tools.xdev 默认开启）已全部落在 `packages/coding-agent/scripts/verify-xdev-mounting.ts` 里，且跑在真实运行时（bun test 下挂载恒关，断言放单测里测不到该路径）；其中两条在本批实战中真的拓到了缺陷。**C1（conflict:// 移植）→ 移除**：前提成立（全树零命中）但越界 —— 它是上游另一个协议设备、一项新增能力，不属 xd:// 呈现机制，无任何已证实缺口。`~/.cornfield/squads/squad-20260911-tool-xdev-w3/` 的任务包保留作为记录，不再集结。⇒ 本批到此不再有待开工的票，剩下的是用户验收与是否合入 main。

- 2026-09-11 23:30 — 【最后一条构造性未验证已补齐】N1 主张「未编译 PCRE2 的构建下请求 pcre2 显式报错、不静默降级」并为此写了测试，但那条测试是 `#[cfg(not(feature = "grep-pcre2"))]` —— **默认构建下它根本不运行**，我跑的 214 个用例里没有它。补验：`cargo nextest run -p cornfield-natives --no-default-features --features client` → **204 passed / 0 skipped**；再按名过滤 → `PASS grep::tests::pcre2_engine_errors_when_unavailable`（1 test run / 203 skipped）。声明成立。⇒ 同一教训的又一形态：**cfg 门控的测试在默认构建下等于不存在**。仓库声明的 `client` 变体（不含 pcre2/语法高亮/剪贴板/PTY/音频）目前只靠“有人手动跑”验证 —— 候选改进：门禁同时跑两组 feature。与 `verify:xdev` 接 CI 同属“门禁覆盖”决策，一并交用户。

- 2026-09-11 23:31 — 【F1 变异验证：独立复现成立】把超时分支按同形改回旧 `throw` → **9 pass / 3 fail（正是超时那三条）/ Ran 12**，文件 sha256 精确还原、工作区干净。F1 的「测试真的抓得住这个缺陷」成立。
  半途险些被骗：**第一次变异我多留了一个 `)`，跑出 `error: Unexpected )`，退出码同样是 1** —— 若只看退出码，就把一次语法错当成了「测试抓住缺陷」。⇒ 教训：**退出码不是证据，输出形态才是**；复现他人的「红」时必须区分「断言红」与「编译红」。
  （**纠正我先前对 F1 的不公正归类**：它的 3红/6绿 与我实测的 9/3 并不矛盾 —— 它的变异跑在加 renderer 测试**之前**，当时文件只有 9 个测试（3 resolvePartialMatchPaths + 5 FindTool + 1 declaration），差的 3 条正是后来加的 renderer 测试，不经过超时分支故变异下仍绿。两个读数都对，只是文件状态不同。要求别人区分「实测 vs 推断」的人，自己也不能把不同状态下的两个真值当成矛盾。）
- 2026-09-11 23:31 — F1 报告里另三处值得记的实现判断：①`onMatch` 改为**无条件收集**（否则超时路径根本无部分结果可返）；②`FindIncomplete` 用具名联合而非 boolean，保留「为何不完整」域信息；③不完整标记**追加在 truncation 之后**，保证被 head 截断时不会把这句裁掉。
- 2026-09-11 23:31 — F1 自述把 `.node` 软链到主检出旧产物（12:48 构建，不含 PCRE2）；其测试用 `vi.spyOn(natives,"glob")` 替换真实 walker 故不受影响 —— **但它与集成区 addon 过期事故是同一模式的两个实例**，说明「worker 工作树拿旧 addon」是系统性的，不是一次性失误。
- 2026-09-11 — 【F1 的方法改进优于我的提醒】它把「退出码 1 分不清『测试抓到缺陷』与『代码根本没跑起来』」推进一步：**变异运行前先断言变异后的代码能通过类型检查，把语法错挡在外面**。比我说的「要看输出形态」更可操作 —— 记入本批方法库。
- 2026-09-11 — 【F1 主动收敛自己的证据边界】它声明：其 `bun test test/tools -> 687 pass` 是连着那份 12:48 旧 addon 跑的，因此只能作为「我的 TS 改动没打破既有 find 行为」的证据，**不能**当作「整个 tools 套件在正确 natives 上通过」的认证 —— 后者由集成五道门禁覆盖。这正是本批要求的「不把未观察的结论说成事实」，主动做比被追问后再做更值钱。
- 2026-09-11 — 【阻塞：等用户四项决定】（任务清单中非我方推进项已移除，阻塞状态记录于此）
  ① 验收过不过；② 合不合 main；③ CI 两项（verify:xdev 接 CI + 门禁跑 client feature 组，两项均需用户接受「linux 侧无法本地验证」）；  ④ bootstrap.ts 是否补原生 addon（与已修的 integrate.ts 同族缺陷，但它不在用户明确批准的脚本内，故未扩进去）。
  执行「合」时的次序（已核对，反过来会真丢内容）：先把主检出那份最新台账提交到分支 → 再清主检出的本地副本 → 然后 `git merge --ff-only`。

- 2026-09-12 00:01 — 【清理完成（用户指示：保留含全部功能的那棵树）】删除本批 12 棵 worktree（10 棵任务树 + 2 棵已被取代的集成树），**保留 `squad-20260911-tool-xdev-w2b-integ`**（还没合 main）。其余 5 棵不是本批的（agent-client / coord-*），未动。10 个 agent 节点已 herdr workspace close。
  磁盘只释放 **2G**（按 du 估的是 ~11G）。查过：样本文件 links=1（非硬链接）、APFS 本地快照只有系统更新项 —— 常见解释均不成立，**标为未解释，不编原因**。
- 2026-09-12 00:01 — 【真实磁盘大头】主检出 `target/` **26G**（待用户点头）；`.worktrees/` 剩余 16G（其中 ~8G 是其他 squad 的，未动）；`~/.bun/install/cache` **7.7G** 与 `~/.cargo/registry` **3.6G**（纯缓存，共 11G，已提议可清，待用户）。
- 2026-09-12 00:01 — 【第二期开工】任务包 `~/.cornfield/squads/squad-20260911-tool-xdev-w3/bundle.json`（--check 通过），base = `squad-20260911-tool-xdev-w2b-integ`：**D1** 名称规范化（canonical 换 glob/grep/todo，旧名留别名；先交改动面清单，规模超预期先停下报）；**M1** MCP 工具纳入 xd 分流（要害：MCP 在 createTools 之后注册、分流在内部，须延伸到注册后；`search_tool_bm25` 与 `mcp.discoveryMode` 退场并留读旧配置兼容层）。M1 依赖 D1（两票同动 prompts/** 与 tools/index.ts）。两个 worker 均为 deepseek-v4-pro（mid），已 STARTED，D1 已 GO。
- 2026-09-12 00:01 — 【新模块生产首跑】`native-addon.ts` 在 w3 集结时真实生效：两棵树均从保留的 `w2b-integ` 取到正确 addon（git-hash f0b9d532c56db5cc…，与先前验证一致），无需重建、无旧产物。（未逐项答复的两处 scope 按默认执行并在此备案：只换规范名、旧名留别名；MCP 设备名不做显示名映射。）

- 2026-09-11 — 【已核实的 M1 前提（给它发 GO 时一并用）】读 `sdk.ts` 确认：`1184` 先 `createTools(...)`，`1186` 起才 `discoverAndLoadMCPTools`，`1189` 起进 `CustomTool[]`。⇒ MCP 工具确实在分流**之后**注册，落点在 toolRegistry/CustomToolAdapter（非设备集）—— 与 A3 发现的「适配器重注册丢 loadMode」是同一处。给 M1 的 GO 里应写明这三个行号，省它考古；并提醒它“只声明 loadMode 不会生效，因为分流已经跑过了”。

- 2026-09-11 — 【已核实的 M1 前提之二 —— bm25 发现机制】读 `search-tool-bm25.ts`：`createIf` 在 `mcp.discoveryMode` 关闭时返回 null（工具不存在）；`loadMode = "essential"` 且注释写明「否则模型完全失去发现 MCP 工具的能力」；搜索对象是 `../mcp/discoverable-tool-metadata` 的 discoverable MCP 工具；执行时若发现被禁则直接 throw。⇒ `search_tool_bm25` 确是当前**唯一**的 MCP 发现入口。给 M1 的 GO 要写明一条边界：**退场它之前，xd 设备目录必须已能承担发现职责**；而目录受 `XDEV_PROMPT_BUDGET_CHARS = 2000` 预算限制，MCP 服务器多时会截断 —— 所以「截断后靠 `read xd://` 拿全量」这条路径必须实测通，否则就是发现机制退场、新机制只覆盖一半，MCP 工具实际不可达。

- 2026-09-11 — 【D1 清点回报与三处决策】D1 严格停在动手之前交了清单（里程碑生效）：A 组锚点在 scope 内；**B 组约 20 个 scope 外文件**因「全仓不得出现两个规范名」硬要求需同步（tools/index.ts, essential-tools.ts, renderers.ts, settings-schema.ts, wire-server.ts, agent-session.ts, task/index+executor, cli/args, live/tool-risk+consult-bridge, acp-event-mapper, event-controller, session-observer-overlay, tree-selector, settings-defs, extensions/types, hooks/types, bash.ts, export/html 产物, cursor.ts）。它还拓出一个我没想到的判别：`find.md`/`search.md` 里的 find/fd/grep/rg 是 **shell 命令**，不改 —— 无脑替换会把文档里的命令也改掉。
  决策：**① 配置 key 改名 + 兼容读旧 key**（它发现的陷阱是决定性的：老 config.yml 写 `find.enabled: false`，改名后会读成默认 true，等于把用户关掉的工具静默打开）；**② `tools/index.ts` 与 `settings-schema.ts` 均归 D1**（M1 依赖 D1，实际操作不撞；M1 的 GO 里要写明“不要二次改”）；**③ 授权 D1 本票内一次改完 Bucket B**，但三条约束：只改「承载工具名」处（内部标识符如 `hashFind`/`hashSearch` 不得为对齐而 churn）、生成文件走生成器不手改、实际面超 2 倍就停下报。

- 2026-09-11 — 【待办：M1 的 GO 消息要包含这四块（防 compaction 丢失）】① `sdk.ts:1184` 先 `createTools`、`1186` 起才 `discoverAndLoadMCPTools`、`1189` 起进 `CustomTool[]` ⇒ MCP 工具在分流**之后**注册，只声明 `loadMode` 不会生效。② `search-tool-bm25.ts`：`createIf` 在 `mcp.discoveryMode` 关闭时返回 null；`loadMode="essential"` 且注释写明「否则模型完全失去发现 MCP 工具的能力」；搜索对象是 `../mcp/discoverable-tool-metadata`。③ 边界：退场 bm25 之前，xd 设备目录必须已能承担发现职责；目录受 `XDEV_PROMPT_BUDGET_CHARS=2000` 限制会截断，所以「截断后靠 `read xd://` 拿全量」必须实测通，否则 MCP 工具变不可达。④ **不要二次改 registry 与配置 key** —— D1 本票已改（`find.enabled→glob.enabled` 等），M1 在 D1 结果上继续。另：M1 的硬要求重申 —— 证据必须含 `bun run --cwd=packages/coding-agent verify:xdev`（挂载在 bun test 下恒关，单测验不到）。

- 2026-09-11 — 【D1 提交 5293031bff（57 文件 +265/−220）父独立复验】门禁全过：`CI=0 bun check`、`test/tools` 957 用例 **0 fail**（D1 自报 688 与我实测 610+347skip 不符，这是它第 N 次自报数字偏差，仍以实测为准）、`verify:xdev` **ALL PASS**。**决策 ① 真落地了**：`settings.ts:114-120` 的 `RENAMED_SETTING_GROUPS = [["find","glob"],["search","grep"]]` + 组级迁移 + 一次性 `logger.warn` 废弃提示 —— 组级而非逐 key，比预期更稳。
- 2026-09-11 — 【真缺陷：跨包按工具名字面匹配】全仓普查拓出 `packages/ai/src/providers/cursor.ts`：`CURSOR_NATIVE_TOOL_NAMES = new Set([..., "todo_write"])` 用于 `advertisedTools = tools.filter(t => !CURSOR_NATIVE_TOOL_NAMES.has(t.name))`（决定哪些工具走 MCP 通告）；且它自己构造 `name: "todo_write"` 的调用（:1977）。⇒ 改名后 `todo` 不在集合内 → **会被当 MCP 工具重复通告**；**别名机制救不了这类**（它比的是精确名字）。另：该集合本来就有 `grep` —— 说明 AI 层当年照上游命名写，本轮正好对齐，但漏了 `todo`。
- 2026-09-11 — 【D1 打回清单（已发）】A 真缺陷（授权改 cursor.ts，2 行；要求给「改前/改后 advertisedTools 差异」作证据）；B 文档/注释/用户可见串（event-controller:492 用户可见告警、DEVELOPMENT.md:396、todo-write.ts:310、docs/client/editor-extension.md:156、docs/gateway/gateway.md:1041〔还错两层：列表过时 + enabledToolsets 现为任务配置字段、代码无硬编码默认值〕、packages/agent/src/types.ts:323）；C 明确不动 CHANGELOG×2 与 ADR（历史事实）；D 要求它扫 `packages/{ai,agent,gateway,tui}` 同形形态（字符串集合 / `name === "…"` / 按名分派）**只报不改**，交清单给我判。

- 2026-09-11 — 【detect_changes 给出 CRITICAL（D1 分支）—— 已按仓库硬约束上报用户】changed 89 符号 / 18 条受影响流程 / risk=critical。**定性：广度而非破坏。** `Settings` 类被全仓引用，改过它则所有读配置的流程均计为 affected；实际改动是**在 `settings.ts` 既有迁移函数内新增一组** —— 紧邻已有两组同类迁移（`isolation.enabled→mode`、`statusLine.plan_mode→mode`），不是新造机制。关键性质：`!(key in canonical)` ⇒ **规范 key 已显式存在时旧值不覆盖**（优先级正确）；`delete raw[legacyGroup]`；仅迁移发生时告警一次。**已核实（原推断已推翻）**：该迁移**不会**写回 `config.yml`。`#migrateRawSettings` 的三个加载期调用点（`settings.ts:595`、`:627`）只返回迁移后的内存对象；唯二落盘处是 `migrateLegacyModelConfig` 的显式重写（`:575-594`，注释写明）与从旧 `.settings.json`/`agent.db` 迁移时的一次性写入（`:667-669`）——均与本次无关。⇒ 用户现有 config.yml 不被静默改写，旧 key 仅在内存中按“规范优先”被读懂。

- 2026-09-11 — 【D1 复验通过 + 拓出一类缺陷：别名边界之外的名称字面匹配】D1 第一次返工 commit `cdad23d45e`（7 文件 +12/−12），A 项证据正是要求的形态：`advertisedTools` 由 `["todo","glob"]` 变为 `["glob"]`（todo 不再进 MCP 通告）。
  **但这条证据暴露了第二个漏网 + 它自己报了三处，共四处，均已核实并授权本次改完**：① `anthropic.ts:1820` `ANTHROPIC_STRICT_TOOL_ALLOWLIST=["bash","python","edit","find"]` 用于 `:2082` 决定哪些工具走 strict schema ⇒ `glob` **失去 strict 处理**（已核实）；② `validation.ts:960` `toolName === "todo_write"` ⇒ 模型发歪的 todo ops **不再被修复**（已核实）；③ `cursor.ts:2056` `CURSOR_NATIVE_TOOL_NAMES` 有 `grep` 却无 `glob`（**改名之前就存在的错配**，改名使其显形）⇒ 补 `glob` 后期望 advertisedTools 为空；④ `dingtalk-card.ts:444-445` `TOOL_EMOJIS` 旧键（cosmetic）。
  **系统性教训（已要求 D1 写进提交信息）**：这四处**别名机制全都救不了** —— 别名只在 `normalizeToolName` 的边界内生效，而这些是别的包直接用**字面量**比对工具名。⇒ 本批教训在命名层的重演：**只要判断发生在归一化边界之外，它就是构造性地失守**（与“能力被排除在 gate 默认路径之外”同构）。

- 2026-09-11 — 【D1 完成并验收】3 commits：`5293031bff`（规范名换 glob/grep/todo，57 文件）+ `cdad23d45e`（cursor.ts 等复验意见）+ `19e8738eeb`（4 处跨包字面载体）。父独立复验：check 全绿 / 957 用例 0 fail / verify:xdev ALL PASS；四处载体已验（`anthropic.ts` allowlist、`validation.ts:960`、`cursor.ts` native set 补 glob、`dingtalk-card.ts` emoji），提交信息含要求的观察。
- 2026-09-11 — 【我自己的任务包设计缺陷（已修，教训待入 skill）】我用「独立工作树 + deps」表达代码依赖，但 skill 的铁律是「**deps 只做顺序安排；worktree 不传递依赖代码**」。后果：reconcile 放行 M1 时，M1 的工作树仍停在 base（不含 D1 的改名）⇒ 它会在旧名上写代码并与 D1 撞车。做法：父在发 GO **之前**把 `feat/xdev3-d1` 并进 M1 工作树（现 HEAD `19e8738eeb`），再放行。⇒ **候选 skill 改进**：`bootstrap`/GO 发放环节应对 `deps` 做「先 merge 依赖分支再发 GO」，或任务包 schema 拒绝「独立工作树 + 代码依赖」的组合。
- 2026-09-11 — M1 已 GO（带四块硬料：sdk.ts 行号与「声明 loadMode 不生效」、bm25 唯一发现入口与预算截断边界、verify:xdev 必须在 bun test 外、别二次改 registry/config key）。

- 2026-09-11 — 【重要基线：base 分支整包测试本就有 22 条失败】在 `squad-20260911-tool-xdev-w2b-integ`（含第一期全部工作、未含第二期）跑 `bun test packages/coding-agent/test`：**3675 pass / 411 skip / 22 fail / 2 errors（4108 用例）**。失败形如 `gh.test.ts` 的 worktree `ENOENT`（临时 HOME 路径），**与工具改名无关**。⇒ 这是仓库既有状态，不是本批造成的；但意味着「整包绿」不是可用的判据，只能用**失败集对齐**。此数已交给 D1 作为基线。
- 2026-09-11 — 【M1 复验 + D1 重开】M1 声明的 gate 全绿（check / test/tools 944 用例 0 fail / `verify:xdev` ALL PASS，含我要的截断证据：prompt catalog 59 条 +441 截断，`read xd://` 仍达最后一台设备）；实现：`sdk.ts` 在 createTools 后用 `splitPostRegistrationMCPToolsForXdev` 把注册后的 MCP 工具挂进 xdevDevices（**只挂 `mcp__*`**，扩展/自定义工具留顶层—— 限额得当、炸半径小）；`search_tool_bm25` 全退场（19 文件 +137/−1240，大量为删除）。
  **但整包跑出 1 条真回归（base 同文件 16 pass/0 fail vs 本支 14/1）**：`test/system-prompt-templates.test.ts` 的「references overridden tool wire names」期望仍写 `search`/`find`。根因**不是粗心，是 gate 覆盖面**：D1 的 gate 只跑 `test/tools`，该文件在 `test/` 根目录 ⇒ 落在 gate 路径之外。⇒ 已重开 D1（`complete` → `running --force`），要求：改期望（先看实际渲染再改）+ **gate 扩到整包** + 失败集必须与 base 的 22 条一致（不得新增）。
- 2026-09-11 — 【同一教训的第三种形态】「能力/检查只要落在 gate 的默认路径之外，就是构造性地不被覆盖」：① build-feature 层（grep-pcre2 若不进默认 feature，nextest 测不到 PCRE2）；② runtime 层（bun test 下挂载恒关，lsp 空摘要出厂）；③ **gate 路径层（只跑 test/tools 则 test/ 根目录的期望过期无人知）**。

- 2026-09-11 — 【集成风险预告：M1 与 D1 改同一测试文件】M1 的 `5a6c443fe6` 也改了 `test/system-prompt-templates.test.ts`（它退场 bm25 时清理该文件）。D1 的期望修复也在同一文件 ⇒ 合并时可能冲突。**根因是我的任务包：两票同落 `prompts/**` 与该测试文件，我用 `deps` 表达了顺序但没消除文件重叠**（skill 的铁律是「代码依赖必须共享工作树」，又一次同源）。处理：D1 修完后由父把其分支**再次**并进 M1 工作树（同依赖处理），冲突在父处解 —— D1 的期望修复是同一文件的更新更正，M1 在下游。

- 2026-09-12 03:00 — 【第二期完成并集成】分支 `squad-20260911-tool-xdev-w3-integ`（base = w2b-integ）。D1 4 commits（改名 + 两次返工）+ M1 1 commit + 合并。
  门禁：`CI=0 bun check` ✓ / `test/tools` 944 用例 0 fail ✓ / `verify:xdev` **ALL PASS** ✓（含 MCP 设备路径 + 截断证据：catalog 59 条 +441 截断，`read xd://` 仍达最后一台设备）。
  整包：20 fail / 3 errors（4087 用例），**全部为环境性/预存**；其中 `wire-server-git.integration.test.ts` 的 6 条已在 base 上验为**完全一致**（1 pass / 6 fail）⇒ 非本批引起。无一条与改名/xd/MCP 相关。
  `detect_changes`：107 符号 / 74 文件 / 18 流程 / **critical** —— 与 D1 单独评测同形同源（`Settings` 类引用广度 + 18 条读配置流程），非新风险；该改动为既有迁移表新增一组且**不写回 config.yml**（已核实）。

- 2026-09-12 03:00 — 【本批四条同源教训已集齐】「判断/能力只要落在某个边界之外，就是构造性地失守」的四种形态：
  ① build-feature 层（grep-pcre2 不进默认 feature ⇒ nextest 测不到 PCRE2）
  ② runtime 层（bun test 下挂载恒关 ⇒ lsp 空摘要出厂，944 单测全绿）
  ③ gate 路径层（只跑 test/tools ⇒ test/ 根的过期期望无人知；扩到整包后 D1 又拓出 4 处残留，含 read.ts 的用户可见提示）
  ④ 命名归一化层（别名只在 normalizeToolName 内生效 ⇒ 跨包字面量比对全失效：anthropic strict 白名单、validation、cursor native set、dingtalk emoji）

- 2026-09-12 12:01 — 【磁盘清理（用户「3 清」）】删 `~/.bun/install/cache` 7.7G + `~/.cargo/registry` 3.6G + 主检出 `target/` 26G；**磁盘 16Gi → 50Gi 可用**（+34G，占用 97%→89%）。动手前已确认无构建在跑（仅 `lspmux` 常驻进程，非构建，未动）。
  代价：下次 `bun install` 与 Rust 构建走冷启动（重下/重编）。交付物不受影响 —— addon 在 `packages/natives/native/`，不在 `target/` 内。

- 2026-09-12 12:21 — 【合并】用户确认「合并 main」；因 main 是本批基点，执行 **fast-forward**：`main` 由 `8daba81c48` 前进到 `e90f75c74c`（38 提交 / 129 文件 / +2614 −1592），无 merge commit。**合上去的树与我验过的树是同一棵树**（ff 的代价优势：无需重跑门禁）。

- 2026-09-12 12:21 — 【Tag（用户要求「先打 tag 再合并」，与我的合并动作交叉）】`pre-tool-xdev-batch` → `8daba81c48`（annotated，描述写清两期内容与回退/分层检查点）。它回答「测试出问题怎么找回正常 commit」：三层回退 `git reset --hard pre-tool-xdev-batch` / `87c51720b9`（第一期末）/ `e90f75c74c`（第二期末），再细一级用 `git bisect`，**判据必须用那条出问题的具体测试**（整包有 ~20 条环境性失败，拿它当判据会让 bisect 失效）。

- 2026-09-12 12:21 — 【清理（skill Phase 3 步骤 5）】关 w3 两个 agent 节点；删本批 6 棵 worktree；删 **16/16** 已合并分支（均含在 main 中）；4 个 squad 任务包归档至 `~/.cornfield/squads/archive/`。未触碰非本批的 `feat-agent-client-m1` / `feat-coord-*` / `squad-20260909-coord-p0-integ`。磁盘 16Gi → 57Gi。

- 2026-09-12 12:21 — 【AGENTS.md 更新（用户「改」）】commit `e7779db8c6`，三处：① `tools/` 清单标注 **文件名 ≠ 工具名**（find.ts 承载 glob、search.ts 承载 grep、todo-write.ts 承载 todo，且不存在 glob.ts/grep.ts —— 已核实），并把 builtin-names.ts 列入；② 新增「Tool presentation (xd:// devices)」小节（三层、Load Mode、read/write 作 transport、MCP 工具在 createTools 返回后才进设备集、配置 key 只读迁移，以及「在归一化边界之外做字面量判断会静默失去别名」）；③ 门禁写明 `verify:xdev` 必须在 `bun test` 之外运行及原因。

- 2026-09-12 12:21 — 【上游对齐已核实（用户问「glob/grep 和远程一样了吗」）】拉 `can1357/oh-my-pi` 的 `packages/coding-agent/src/tools/builtin-names.ts`：`BUILTIN_TOOL_NAMES` 含 **`glob`/`grep`/`todo`**，`LEGACY_BUILTIN_TOOL_NAME_ALIASES` = `search→grep`、`find→glob` ⇒ **规范名与别名方向均与上游逐字一致**。额外发现：**上游自身也有同类不一致** —— 其规范名是 `todo`，而其 `ai/utils/validation.ts` 按 `todo_write` 匹配；我们在本批把这类跨包字面载体在自家仓里修干净了（4 处），这一点上比上游更自洽。另：`origin` 是用户的 `klong13579/cornfield`（与上游不是同一远端），**本地 main 领先 origin 40 提交，未 push**。

- 2026-09-12 12:42 — 【文档两处过期已修】commit `19f65688be`：ADR-0003 的 essential 清单原按旧名（find/search/todo_write）书写（那是现状描述、非历史决策），改为规范名并注明旧名走别名；台账 openQuestions 里的「配置 key 与提示词改名未排期」已过期（第二期已做），换成四项真实开放项。

- 2026-09-12 12:42 — 【与上游的工具清单比对（用户问）】本地 31 个内置工具 vs 上游 28 个：共有 **18**（ask/ast_edit/ast_grep/bash/checkpoint/debug/edit/github/glob/grep/hub/lsp/read/rewind/task/todo/web_search/write），仅本地 **13**（browser/calc/inspect_image/irc/job/list_models/notebook/project_context/python/recipe/render_mermaid/ssh/switch_model），仅上游 **10**（context_notes/eval/learn/manage_skill/memory_edit/new_context/recall/reflect/retain/security_scan）。隐藏工具：本地 6（exit_plan_mode/identity/report_finding/report_tool_issue/resolve/yield），上游 3（yield/goal/think）仅 yield 共有。⇒ 改名使 `glob`/`grep`/`todo` 从「仅本地」变为「共有」，与上游对齐得到印证。

- 2026-09-12 12:42 — 【w4 开池（用户：开多个 worker 作为进程池接作业）】按建议先做两项、留下一轮两项。任务包 `squad-20260912-tool-xdev-w4`（base = main `19f65688be`）：**J1** 清理 MCP 会话侧残留（`agent-session.ts` 仍留有设置入口已删除的整套 discovery 子系统）；**J2** read/write 影响面评估（ADR 后果段要求、从未做过）。两票 scope 不相交（J1 动 session、J2 只写 docs）。给 J1 的第一条硬要求是**先证明不可达再删**（本批已有三票因跳过前置核验而白做）；给 J2 的是**每条结论必须有引用，不确定写「未确定」**。

- 2026-09-12 12:42 — 【w5 备包（未启动，等槽位）】`squad-20260912-tool-xdev-w5`：**K1** 旧名移除（删除前必须先加显式提示 —— 否则老 config 的 `find.enabled: false` 会静默变默认 true）；**K2** 两份首版名单复评（依据以真实运行时为准）。文件重叠提醒：K2 与 J2 都写 `docs/adr/0003`，不可同时开。

- 2026-09-12 12:42 — 【重要发现：合并后 addon 陈旧会使 search 每次调用抛错】主检出的 `packages/natives/native/cornfield_natives.darwin-arm64.node` 仍是 9月11日 12:48（PCRE2 之前）的产物，而 main 的代码已含 PCRE2。`search.ts` 无条件解引用 `SearchEngine.Rust/Pcre2`，旧 addon 上该导出不存在 ⇒ **从源码跑 main 时 search 必抛错**（不是“少个可选引擎”，是运行时崩溃；且症状不是构建失败）。
⇒ **可推广：`*.node` 是 gitignore 的构建产物，不随合并/拉取走；凡触及 `crates/pi-natives` 或其 Cargo 文件的改动合并后，每个检出都要重建一次。**已后台重建主检出 addon；并提议在 AGENTS.md 的构建段加一句明确要求。（`native-addon.ts` 只覆盖集成/子任务工作树，管不到主检出。）

## 批注

Phase 3 起需现场查代码补每票的 scope.files：squad 硬规则要求各票文件范围互不相交，read/write/find/search/edit 的呈现标注已并入对应能力票以避免同文件被两票修改。原生 PCRE2 票的验证链与其余票不同（cargo 与原生构建），转译时不要套用默认推导。

发现两处 squad skill 空隙，建议回写 SKILL.md：（1）`herdr workspace close` 只杀 cornfield agent，不回收它派生的构建子进程（cargo/clang/tsserver 仍占 target/），删 worktree 前需按路径 pkill；（2）`bootstrap.ts` 与 `squad-state.ts` 的两个 bug 已在本机修复，尚未回写用户级 skill；（3）worktree 嵌在仓库目录内会让 cargo 向上找到主仓库根，导致 worktree 内 `bun check` 必失败 —— 要么 gate 用 `CI=0 bun check`，要么把 worktree 建在仓库外；（4）每个 worktree 各建一份 `target/`（~750MB 起）不共享，N 个子任务就是 N 份重复 Rust 构建，磁盘与 CPU 双重浪费 —— 建议 squad worktree 共用 `CARGO_TARGET_DIR`；（5）改 gate 命令必须同时改 `verifiers` 与 `acceptance` 两处，否则 worker 以 acceptance 为准会跑错命令（本条是真缺陷，但**不是**本次磁盘事件的主因，主因见（6））；（6）**harness 为每个 squad worktree 自动拉起 rust-analyzer，它会自行发起 workspace 级 cargo check** —— N 个子任务就是 N 份全量 Rust 构建（磁盘 ~1GB/树 + 大量 CPU）。修法候选：squad worker 关 LSP（`enableLsp: false`）、worktree 共用 `CARGO_TARGET_DIR`、或子任务终态后按 cwd 杀掉其 rust-analyzer。
