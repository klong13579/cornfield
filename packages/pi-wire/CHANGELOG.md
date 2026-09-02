# Changelog

## [Unreleased]

### Added

- **模型控制中心协议契约**（`src/commands.ts`, `src/results/models.ts`, `src/results/providers.ts`, `src/results/config-scope.ts`）: v2 全量目录 DTO（`ModelCatalogDto`/`ModelCatalogEntryDto`，六态互斥 status + 目录元数据）；Provider 接入九命令与 `ProviderStatusDto`/`ProviderDependencyDto`/`ProviderDisconnectResultDto`（依赖检查走结果不走错误通道）；配置作用域 DTO（`ConfigScope`/`ConfigScopeDto`/`ConfigScopeKeyDto`/`ModelSelectionDto`）；`test_model`/`refresh_catalog`；`set_config` 支持 `scope`。所有响应不回显明文凭据，仅掩码。v1 `get_available_models`/`AvailableModelsDto` 保留不动（旧端兼容）。
