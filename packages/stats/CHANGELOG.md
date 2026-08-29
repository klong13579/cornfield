# Changelog

## [Unreleased]

## [1.0.0] - 2026-08-29

### Changed

- **去 omp 化品牌迁移**: 包引用/环境变量/路径对齐 cornfield —— 包 scope `@oh-my-pi/* → @cornfield/*`，配置根路径 `~/.omp → ~/.cornfield`，环境变量 `OMP_*`/`PI_* → CORNFIELD_*`（含 gateway 目录改名 `omp-gateway → gateway` 后的 import 路径更新）。纯改名，无行为变化。

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI Codex costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03
### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/oh-my-pi/issues/250))
