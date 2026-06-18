# Changelog

## [Unreleased]

### Changed

- **`pi-gateway install` now seeds agentDir through `omp agent init`**: The interactive DingTalk install wizard (`pi-gateway install`) now delegates agent directory creation to the public `runAgentInit` handler exported from `@oh-my-pi/pi-coding-agent/cli/agent-cli`, so install and the `omp agent` CLI share one source of truth for the skeleton layout. The wizard also adds an optional "Mission 文件" prompt so users can seed a custom `mission.md` at install time without leaving the flow.

### Fixed

- `pi-gateway install` output: the "下一步" hint now lists `omp agent show <accountId>` and `omp agent validate --dir <agentDir>` so users can verify the agentDir created during install. Also fixes a missing path separator in the "编辑 `<agentDir>/.omp/config.yml`" hint that previously rendered as `agentDir.omp/config.yml`.

## [14.5.12] - 2026-04-30

### Added

- Initial release of the unified gateway package.
