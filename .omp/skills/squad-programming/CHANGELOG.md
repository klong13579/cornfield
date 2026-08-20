# Changelog

## [Unreleased]

### Added

- **父中断恢复：squad state 落盘** (`scripts/squad-state.ts`, `scripts/bootstrap.ts`): 集结完成后写 `~/.omp/squads/<squadId>/state.json`（每子任务落点/分支/paneId/状态）；父每收一条状态消息用 `squad-state.ts update <taskId> <status>` 同步；父进程中断后 `squad-state.ts list` 读恢复清单，按 pane 复核后接续。SKILL.md 新增「父中断恢复」章节定义完整流程。

### Changed

- **merge 移出 skill 职责** (`SKILL.md`, `USAGE.md`): 父 agent 不再合并任何代码进 base —— Phase 3 改为「验收交接」，验证通过后把 branch + diff 摘要摆给用户，由用户自己 `git merge <branch>`；清理仅在用户表态后执行。`mergePolicy` 语义降级为验收提示（unknown 强制 human-review 护栏保留）。
- **子任务 tab 建进父进程 workspace** (`scripts/bootstrap.ts`, `SKILL.md`, `USAGE.md`): 取消 squad 专属 workspace —— 所有子 omp 的 tab 直接建在父所在 workspace（`HERDR_WORKSPACE_ID`），父+子同一个 workspace、一个窗口全看到；回收改为 `herdr pane close <paneId>` 逐个关（不再 workspace close）。

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