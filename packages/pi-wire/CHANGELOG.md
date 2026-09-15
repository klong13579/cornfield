# Changelog

## [Unreleased]

### Added

- **调度定义写面与 schedule 绑定形状**（`src/commands.ts`, `src/results/cron.ts`）：新增 `cron_create` / `cron_update` / `cron_remove` / `cron_test_run` 四条 wire 命令（`cron_update` / `cron_remove` 用 `taskId` —— 不复用命令的关联 `id`）；`TaskRowDto` 补 agent 绑定（`agentId` / `agentDir` / `agentDisplayName` / `agentResolution` / `agentEnabled` / `agentError` / `projectIds`）与可靠性事实（`taskType` / `timeoutMs` / `retry` / `repeatCount` / `repeatCompleted` / `delivery` / `lastDeliveryError` / 时间戳），`CronLogEntryDto` 补 `agentSessionPath`；新增 `ScheduleAgentResolution` 三态（registered / unregistered / unbound）与写面入参/回写形状。

- **听记条目形状 canon化**（`src/results/listen.ts`）：`ListenRecordingDto` + `ListenProvenanceDto`（写入时标下的 agentId / agentDir / projectId / sessionFile）进 pi-wire，serve 与 web-app 共用一份（客户端级听记库里的归属只能来自这个字段，缺省 = 未标注）。

- **`CronUpdateInput.unbind`**（`src/results/cron.ts`）：改绑语义写进契约 —— 两个字段都不给 = 不动绑定；只给 `agentId`/`agentDir` = **整个绑定换成它**（不隐式保留旧身份）；两个都给必须指向同一个 Agent，否则网关 `ok:false`；`unbind: true` 显式清空（与上面两个字段互斥）。

## [1.1.1] - 2026-09-06

### Added

- **听记分帧上传命令类型**（`src/commands.ts`）: 新增 record_transcribe_begin / record_transcribe_chunk / record_transcribe_end 三条命令类型——长录音 base64 超 Bun WS 单帧 16MB 上限时前端分帧上传。

## [1.1.0] - 2026-09-05

### Added

- **模型控制中心协议契约**（`src/commands.ts`, `src/results/models.ts`, `src/results/providers.ts`, `src/results/config-scope.ts`）: v2 全量目录 DTO（`ModelCatalogDto`/`ModelCatalogEntryDto`，六态互斥 status + 目录元数据）；Provider 接入九命令与 `ProviderStatusDto`/`ProviderDependencyDto`/`ProviderDisconnectResultDto`（依赖检查走结果不走错误通道）；配置作用域 DTO（`ConfigScope`/`ConfigScopeDto`/`ConfigScopeKeyDto`/`ModelSelectionDto`）；`test_model`/`refresh_catalog`；`set_config` 支持 `scope`。所有响应不回显明文凭据，仅掩码。v1 `get_available_models`/`AvailableModelsDto` 保留不动（旧端兼容）。
