# Changelog

## [Unreleased]

### Added

- **`STATS_CLIENT_NO_WAIT=1` 跳过 `dist/client` 竞态等待**（`scripts/generate-client-bundle.ts`）：该脚本原本要轮询最多 120s，等并行的 stats build 产出 `dist/client`（`bun run --workspaces build` 下两者并发写同一目录）。在 CI 的 release / install 步骤里没有第二个进程会碰 `dist/client`，等待只是把超时跑满 —— 实测 `release_binary` 的 `generate-client-bundle` 步骤耗时 122s，其中 120s 是这段空等。设 `STATS_CLIENT_NO_WAIT=1` 的调用方跳过轮询，直接兑底构建。

## [1.0.0] - 2026-08-29

### Changed

- **去 omp 化品牌迁移**: 包引用/环境变量/路径对齐 cornfield —— 包 scope `@oh-my-pi/* → @cornfield/*`，配置根路径 `~/.omp → ~/.cornfield`，环境变量 `OMP_*`/`PI_* → CORNFIELD_*`（含 gateway 目录改名 `omp-gateway → gateway` 后的 import 路径更新）。纯改名，无行为变化。

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI Codex costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03
### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/oh-my-pi/issues/250))
