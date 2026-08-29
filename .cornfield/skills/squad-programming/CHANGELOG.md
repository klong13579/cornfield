# Changelog

## [Unreleased]

### Added

- **GO 发放与 reconcile 调度**（`scripts/squad-state.ts`, `SKILL.md`）：新增 `running` 状态与 `reconcile` 动词——按「`started` + deps 全 complete + 并发槽位空闲（running/reviewing/blocked 计数 < maxConcurrency）」计算 `needGo`/`needAsk`/`waitingDeps`/`waitingConcurrency`/`unrunnable` 计划。GO 幂等可补发：worker brief 写明重复 GO 无副作用；父每轮盯盘跑 reconcile，父中断恢复用同一条命令，根治「父漏发 GO → worker 死等」。
- **取消协议**（`scripts/bootstrap.ts` worker brief, `SKILL.md`）：父 send `[<id>] CANCEL: 原因` → worker 停止实现与提交并回 `CANCELLED` → 父 `update <id> failed "cancelled: 原因"`，分支/worktree 按 FAILED 规则保留等用户表态。
- **deps 结构校验**（`scripts/bootstrap.ts`）：deps 引用不存在的 id / 自指 / 循环依赖在集结前拒绝（环 = reconcile 永远等不到 GO）。state.json 回填每子任务 deps 与 maxConcurrency。
- **测试**（`test/`）：新增 reconcile（槽位/依赖/恢复/CLI）与 worker brief 协议（GO 闸门/幂等/CANCEL/ask-with-to）测试；状态机测试覆盖 `running` 新转移。

### Changed

- **assembled/started 状态语义修正为三段**（`scripts/squad-state.ts`, `SKILL.md`）：`assembled`=已启动待确认，`started`=就绪确认停在 GO 闸门，`running`=GO 已发。转移矩阵同步：允许 `assembled -> blocked/failed`（准备失败上报不再被拒）、`started -> running`（GO 台账）；`started -> complete` 被拒（GO 台账不能丢，恢复用 `--force`）。
- **squadVersion 1 → 2**（`scripts/bootstrap.ts`, `SKILL.md`）：`reportProtocol.ask` 强制 `ask-with-to`（原文档默认 `ask-without-to` 与「ask 必须带 to」规则矛盾）；旧版任务包被拒绝重产。
- **波次调度改槽位制**（`SKILL.md`）：bootstrap 一次启动全部 worker（闸门空等不耗配额），开工由 GO 按 deps+槽位发放——与 `maxConcurrency` 文档语义对齐。
- **probe 闸门误报修复**（`scripts/probe.ts`）：idle/静默停滞/日志缺失告警只对业务态 `running` 生效（assembled/started 停在 GO 闸门、reviewing 等验收，静默属预期）；`done` 告警排除 blocked/failed。
- **Phase 1.5 父层增加 pending 清积压**（`SKILL.md`）：父每轮先 `intercom pending` 补收错过的 ask，再 list/ask 确认。
- **交接物改为集成分支 + diff 预览，用户确认后自动合并到 base 并清理** (`SKILL.md`): Phase 3 步骤 4 交接物从 N 个原始分支名改为已验证通过的集成分支（`<squadId>-integ`）完整 diff 预览 + 整体验证结果；步骤 5 改为「合并与清理」，用户说「合吧」后父自动合并到 base、关 agent、删 worktree、归档一次完成。清理权限同步更新。

### Added

- **新增 high 模型档位** (`SKILL.md`, `scripts/bootstrap.ts`): `narwal-plan/glm-5.3` 作为 `high` 档（重任务/复杂重构使用），子任务 `modelTier` 可选 cheap | mid | high。
- **任务包版本管理** (`SKILL.md`, `scripts/bootstrap.ts`, `scripts/squad-state.ts`): `.squad.json` 新增 `squadVersion` 字段（当前 `1`），bootstrap 启动时校验版本匹配，不匹配则拒绝；state.json 同步记录 `squadVersion` 供恢复时核对。

### Changed

- **bootstrap 改调用 `resolveModel()`** (`scripts/bootstrap.ts`): 从内联表达式提取为独立函数，支持 `high` 档位和 `modelTiers` 可选字段的安全访问。
- **状态机增加转移护栏** (`scripts/squad-state.ts`): 新增 `VALID_TRANSITIONS` 转移矩阵，`updateState()` 校验非法转移（如 `assembled -> complete`）；终态（`complete`/`failed`）不可逆，重复设置同一状态幂等；`--force` 参数供恢复场景跳过校验。CLI 同步支持 `--force` 标志。
- **父模型 >= 子模型硬约束** (`scripts/bootstrap.ts`, `SKILL.md`): 新增 `--parent-model` 参数，`validateParentModel()` 校验父模型档位不低于任何子任务；`cheap < mid < high` 三级比较，不在标准档位表的模型假设为最高级。

- **整体验证升级为强制门禁** (`scripts/integrate.ts`, `SKILL.md`): Phase 3 整体验证从「条件触发」（改动同域或涉及整体行为时）改为**硬门禁**——任何 squad 有 ≥2 个 complete 子任务，父必须建 integration worktree 合体验证，无论子任务是否同域/文件是否相交；判定依据是「合体后的产物才是交付物」。实测教训（2026-08-21 打包 squad）：T1 改 `main.ts` 生产加载、T2 改打包链路，单 worktree 验收各自通过，但打包只用 T2 worktree（缺 T1 的 `isPackaged` 分支）→ 装机白屏。豁免仅限单子任务或全只读 research（交接清单须显式说明理由）。integrate.ts 对单分支场景输出豁免提示。

### Changed

- **worktree 自动安装依赖** (`scripts/bootstrap.ts`, `SKILL.md`): 新任务 worktree 无 node_modules → tsgo `types: ["bun","assets"]` 解析失败（「从未安装依赖」报错）。`ensureTaskWorktree` 在 `herdr worktree create` 成功后自动 `bun install`（`worktreePath/node_modules` 存在即跳过，幂等；复用已有节点分支不重复装；`timeoutMs 300s`、失败 fatal）。SKILL.md 集结段补充说明：不要对未装依赖的 worktree 直接开 worker。
- **probe 改直连 intercom broker** (`scripts/probe.ts`, `SKILL.md`): 不再绕 herdr——broker.sock 注册+list 协议直接拿 `SessionInfo.status`/`lastActivity`（omp 状态机源头，herdr 只是镜像）。实证：register 需全字段（isSessionInfo 校验 cwd/model/pid/startedAt/lastActivity 必填，缺字段被断开）；一次 list 返回全部 13 会话状态+新鲜度。
- **静默挂起探活维度** (`scripts/probe.ts`, `SKILL.md`): s2 实测 187s 静默案例——pid 活着 + pane 残影 ≠ 在推进（模型 API 响应挂起）。probe 增加 session JSONL 最近写入时间判据（每回合必写；>240s 未写 = 静默挂起，`PROBE_STALL_AFTER_S` 可调）；处置阶梯增加「ask 唤醒」——实测 ask 到达即恢复。
- **父健康扫描探活机制** (`scripts/probe.ts`, `SKILL.md`): 父不干等消息——`probe.ts <state.json>` 对未终态子任务三路探活（ps 进程存活 / herdr agent 注册 / pane 输出错误签名扫描），输出 OK/WARN；WARN 处置阶梯不直接判死：先看 API 断连自愈 → ask 自报 → 无响应才 stalled 转用户。解决「worker 静默挂掉父不知道」。
- **清理协议硬化：先关 agent 再删 worktree** (`SKILL.md`): 实测——`git worktree remove` 不杀 herdr 树节点里跑的 omp 进程（7 个 idle worker 残留，进程/节点/intercom 会话三处漏清）。Phase 3 步骤 5 改为：① `herdr workspace close` 关 agent 节点（ps 无 omp 残留 + 树无节点 + intercom 无子会话三判据）→ ② worktree remove + branch -D → ③ state 归档 → ④ 父 workspace 名还原。
- **wait-gate 改 pull 模式** (`bootstrap.ts`, `SKILL.md`): 第二批次复现子进程首轮主动 send 报 Session not found（启动窗口期 broker 目标解析不可用，ask 双向始终可靠）——STARTED 确认改为父 ask 驱动（wait-gate 主动拉），worker 的 send 降级为可选补报且失败不刷屏。
- **整体验证 integration worktree** (`scripts/integrate.ts`, `SKILL.md`, `USAGE.md`): 新增 Phase 3 整体验证步骤——`integrate.ts <state.json>` 把全部 complete 分支按序合并到 `.worktrees/<squadId>-integ`（纯 git worktree，不占 agent；`--link-node-modules` 软链主仓库依赖；`--force` 重建）。冲突即停并打回子任务，不在验证区打补丁；验证跑全部 gate 并集 + 整体功能冒烟（web → dev server + 浏览器）。用户 merge 后与正式分支一并清理。
- **父中断恢复：squad state 落盘** (`scripts/squad-state.ts`, `scripts/bootstrap.ts`): 集结完成后写 `~/.cornfield/squads/<squadId>/state.json`（每子任务落点/分支/paneId/状态）；父每收一条状态消息用 `squad-state.ts update <taskId> <status>` 同步；父进程中断后 `squad-state.ts list` 读恢复清单，按 pane 复核后接续。SKILL.md 新增「父中断恢复」章节定义完整流程。

### Changed

- **STARTED 送达协议防竞态** (`bootstrap.ts`, `SKILL.md`): 子进程 intercom 注册晚于 TUI 上线/首个 LLM 回合 —— 发 STARTED 前先 status 自检，失败按 5s/10s/15s 退避重试 ≤3 次，仍失败继续任务、终态必达；父 wait-gate 超时先轮询 `intercom list` 等子注册齐全，再 ask 拉 ack，仍失败才 BLOCKED（不直接判死）。
- **merge 移出 skill 职责** (`SKILL.md`, `USAGE.md`): 父 agent 不再合并任何代码进 base —— Phase 3 改为「验收交接」，验证通过后把 branch + diff 摘要摆给用户，由用户自己 `git merge <branch>`；清理仅在用户表态后执行。`mergePolicy` 语义降级为验收提示（unknown 强制 human-review 护栏保留）。
- **最终形态：父 workspace 改名 + 树节点 worktree** (`scripts/bootstrap.ts`, `SKILL.md`): 父 omp 所在 workspace label 改为任务包名（squadId）；每个子任务用 `herdr worktree create` 按任务名建树节点（`--label "T<n> · <title 前 18 字>"`，语义化显示；分支/目录 = id 小写；幂等复用 open_workspace_id），worker 直接起在树节点 pane —— Spaces 面板在任务包 workspace 下以树挂出 T1/T2/T3。取代 git worktree add（不产生树节点）与 0.2.0 的 squad 专属 workspace。
- **worker 启动改 `exec omp` 直启** (`scripts/bootstrap.ts`): `bash -c 'export PI_SUBAGENT_*; exec omp …'` —— pane 前台进程必须是 omp，herdr agent 识别才登记（agents 列表可见）；弃 script -q 包装（前台是 script/bash，permanent 缺位）。env 注入走 shell export（tab create --env 破坏 pane prompt）。
- **模型使用纪律** (`SKILL.md`): 档位模型必须确认 provider 有 key（list_models 目录≠key，实测 kimi-code 无 key 直接 No API key）；多并发同 provider 命中分钟级 TPM（429）；模型按子任务类别分档（重实现 mid / 轻任务 cheap）。

### Fixed

- **intercom ask 路由坑**: ask 不带 to 时按 cwd 优先路由，实测误投同目录活跃的其他会话（aion-ui）—— 协议更新为 ask 必须带 to=父 target（`SKILL.md`、`bootstrap.ts` worker brief）。
- **herdr agent.start 不稳定实验**（记档）: 本环境 5 轮集结反复 agent_pane_busy / timeout / 名字不登记 —— 弃用，恢复 pane run + exec omp。
- **集结 stdout 污染**: tab/worktree create 非 quiet 输出混入最终 JSON（"Extra data"）—— 命令 quiet 化。

## [0.2.0] - 2026-08-20

### Added

- **squad 专属 workspace** (`scripts/bootstrap.ts`): 集结时创建独立 workspace（label `squad-<squadId>`），所有子 omp 的 tab 固定落在同一个 workspace 下 —— 硬保证同 workspace，且与父 workspace 解耦；回收时按 `squadWorkspaceId` 整体关闭。
- **三层启动检查** (`scripts/bootstrap.ts`, `SKILL.md`): 脚本层 pane 活体探测（pane 输出 + `script -q` 落盘日志，默认 60s，`--verify-timeout` 可调）→ worker 层 STARTED ack（读任务包 + `list_models` 核对模型）→ 父层 wait-gate（全部 STARTED 才进 Phase 2）。替代原 herdr agent list 探测 —— script 包装启动的 pane 终端标题非 π，agent list 永久缺位（实测）。
- **herdr 版本门 + 命令超时 + 错误信封诊断** (`scripts/bootstrap.ts`): 集结前校验 `herdr --version` >= 0.8.0（`tab create --workspace` 依赖），低于直接 fail；所有 herdr/git 命令默认 30s 超时（Bun spawnSync/spawn 的 `timeoutMs` 在 1.3.14 不生效，自实现 Promise.race + kill）；命令失败优先提炼 `{"error":{code,message}}` 信封。

### Changed

- **worktree 落点自动推导** (`scripts/bootstrap.ts`, `SKILL.md`, `USAGE.md`): 默认 `<父cwd>/.worktrees/<branch 去/为->`（`feat/t1` → `.worktrees/feat-t1`）。`parent.cwd` 字段变为可选，缺省取 bootstrap 运行目录（= 父 omp 会话 cwd）；任务包写入时回填解析后的真实路径。
- **git 原生 worktree 替代 herdr worktree create** (`scripts/bootstrap.ts`): `git worktree add -C <parentCwd>` —— 仓库上下文由 `-C` 明确，且不再产生 herdr 给每个 worktree 自动开的冗余展示 workspace（`open_workspace_id`）。
- **子任务窗口从 pane split 改为独立 tab**: 每个子任务一个 tab（固定落在 squad workspace），不分割当前 pane。
- **worker CLI 固定用 omp**: 不再读 `PI_INTERCOM_PI_BIN`（旧 pi CLI 兼容变量，认证栈与本仓库不互通）；`OMP_BIN` 保留作自定义覆盖。
- **回收协议硬化** (`SKILL.md`): herdr 交互命令逐个执行、确认 JSON 后再下一步（禁止 `&&` 串行）；按 tab 逐个关闭优先，workspace close 仅兜底且异常返回立即停止；自动合并的子任务由父直接清理，human-review / FAILED 的 worktree/分支一律保留等用户验收。

### Fixed

- **启动检查误报**: verify 曾轮询 `herdr agent list`（60s 超时误报 "2/2 未通过"，子进程实际全活）—— 判定依据改为 pane 真实输出 + outLog 文件大小。
- **worktree 建错仓库**: herdr worktree create 的仓库上下文取自 workspace 关联而不是 bundle 的 parent.cwd（曾把 worktree 建到父 workspace 的仓库）—— 改用 git `-C parentCwd` 后仓库归属幂等。
- **paneCmd 接线遗漏**: `script -q` 包装 + 输出落盘的命令此前计算出但未传入 launchPane。