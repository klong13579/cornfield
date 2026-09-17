# Changelog

## [Unreleased]

### Added

- **`set_thinking_level` 增加可选 `persist`**（`src/commands.ts`）：缺省只改本次会话（与随时切档同语义）；`persist: true` 时内核把生效档位一并写进目标 agent 的配置，重启后仍是它。内核只在档位真的发生变化时才写盘。

- **`get_agent_prompt_sources`**（`src/commands.ts`, `src/results/agents.ts`）：读目标 agentDir 的 prompt 源清单，逐项 `{ path, title, description, exists }`。清单的权威在服务端（`skeleton/agent-dir-files.ts`），形状与 `exists` 一起构成契约：缺的那项也在清单里，不裁成「存在的那些」。

- **`create_agent`**（`src/commands.ts`, `src/results/agents.ts`）：建一个 agentDir（`name` 必填，`dir` / `mission` / `template` 可选），回传 `{ name, agentDir, created, filesWritten }` —— serve 侧复用 `cornfield agent init` 的实现，失败把服务端原文交给客户端。

- **「最深祖先 root 获胜」规则单源化**（`src/scope.ts`）：新增纯选择函数 `pickDeepestRootIndex(roots, targetPath)` —— 返回命中 `targetPath` 的最深祖先 root 的下标（未命中 = -1）。不碰文件系统、不做归一化：输入是调用方按自己运行时的真实能力归一后的字符串（serve 用 realpath，浏览器用词法），判定只有这一份。边界：`/a/b` 不是 `/a/bc` 的祖先；`/a/b/` 与 `/a/b` 等价；空串 root 跳过；多个命中取最深者。

- **调度定义写面与 schedule 绑定形状**（`src/commands.ts`, `src/results/cron.ts`）：新增 `cron_create` / `cron_update` / `cron_remove` / `cron_test_run` 四条 wire 命令（`cron_update` / `cron_remove` 用 `taskId` —— 不复用命令的关联 `id`）；`TaskRowDto` 补 agent 绑定（`agentId` / `agentDir` / `agentDisplayName` / `agentResolution` / `agentEnabled` / `agentError` / `projectIds`）与可靠性事实（`taskType` / `timeoutMs` / `retry` / `repeatCount` / `repeatCompleted` / `delivery` / `lastDeliveryError` / 时间戳），`CronLogEntryDto` 补 `agentSessionPath`；新增 `ScheduleAgentResolution` 三态（registered / unregistered / unbound）与写面入参/回写形状。

- **听记条目形状 canon化**（`src/results/listen.ts`）：`ListenRecordingDto` + `ListenProvenanceDto`（写入时标下的 agentId / agentDir / projectId / sessionFile）进 pi-wire，serve 与 web-app 共用一份（客户端级听记库里的归属只能来自这个字段，缺省 = 未标注）。

- **`CronUpdateInput.unbind`**（`src/results/cron.ts`）：改绑语义写进契约 —— 两个字段都不给 = 不动绑定；只给 `agentId`/`agentDir` = **整个绑定换成它**（不隐式保留旧身份）；两个都给必须指向同一个 Agent，否则网关 `ok:false`；`unbind: true` 显式清空（与上面两个字段互斥）。

### Changed

- **`set_config` 的缺省落点不再硬编码 `global`**（`src/commands.ts`）：不传 `scope` 时由服务端按「合并视图解析这个键的那一层」判定（有 project 层就写 project，否则写本实例的 `config.yml`），响应里回报的 `scope` 就是真落到的那一层。`get_config` / `set_config` 改为读/写**目标 agent 自己的配置实例**，因此需要该 agent 已挂载（未挂载时 `ok:false`，错误文本 `agent not attached: …`）；只查 agentDir 文件的 `get_agent_prompt_sources` 不受影响。

## [1.1.1] - 2026-09-06

### Added

- **听记分帧上传命令类型**（`src/commands.ts`）: 新增 record_transcribe_begin / record_transcribe_chunk / record_transcribe_end 三条命令类型——长录音 base64 超 Bun WS 单帧 16MB 上限时前端分帧上传。

## [1.1.0] - 2026-09-05

### Added

- **模型控制中心协议契约**（`src/commands.ts`, `src/results/models.ts`, `src/results/providers.ts`, `src/results/config-scope.ts`）: v2 全量目录 DTO（`ModelCatalogDto`/`ModelCatalogEntryDto`，六态互斥 status + 目录元数据）；Provider 接入九命令与 `ProviderStatusDto`/`ProviderDependencyDto`/`ProviderDisconnectResultDto`（依赖检查走结果不走错误通道）；配置作用域 DTO（`ConfigScope`/`ConfigScopeDto`/`ConfigScopeKeyDto`/`ModelSelectionDto`）；`test_model`/`refresh_catalog`；`set_config` 支持 `scope`。所有响应不回显明文凭据，仅掩码。v1 `get_available_models`/`AvailableModelsDto` 保留不动（旧端兼容）。
