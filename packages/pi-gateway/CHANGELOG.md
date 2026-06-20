# Changelog

## [Unreleased]

### Added

- **`cron list` shows an `ACCOUNT` column**: Each task row now renders the channel account that owns the agent context for the task (e.g. `hr`, `opencode`, `ops/hr`, or `—` when unset). Bound at task creation time via `cron create --account <accountId>` and resolved at runtime to the account's `agentDir` from `gateway.json` (`channels.dingtalk.accounts[<id>].agentDir`). The agentDir is then used as the `Bun.spawn` cwd so `omp` finds the correct `.omp/config.yml` for the task's owning account. If the account is later removed from `gateway.json`, the task falls back to the gateway cwd with a warning (no break). Storage: new `account_id` column on `tasks` with an idempotent `ALTER TABLE` migration; existing tasks display `—` and continue to run as before.
- **`cron update <name>`**: New subcommand to mutate task fields in place, so existing tasks can be rebound to a different channel account (or have their delivery target / timeout changed) without delete+recreate. Supported flags: `--account <id>` / `--clear-account`, `--deliver <channel>` / `--clear-deliver`, `--deliver-user <id>` / `--clear-deliver-user`, `--timeout-ms <ms>`. A `--<field>` paired with its `--clear-<field>` on the same invocation is rejected with exit 1. The dispatch and help text are wired through `cli.ts`; the function is re-exported from the scheduler package.
- **`cron list` shows a `CHANNEL` column**: Each task row now renders the `deliver` target (e.g. `dingtalk:hr`, `dingtalk:user:601590212`, or `—` when unset) so users can see at a glance which channel a scheduled task's results will land in. The `deliverUser` field is intentionally not inlined into this cell (it's an orthogonal proactive-send destination); use `cron list --json` to see the full record. Over-long task names are truncated to 18 chars with an ellipsis (`omp-atomix:wiki-c…`) so they can't overflow into the `TYPE` column.

### Changed

- **Hierarchical execution-log layout**: Scheduler execution logs are now written to `<gateway-data>/scheduler/logs/by-task/<slug>/<YYYY-MM-DD>.jsonl` instead of `<gateway-data>/scheduler/logs/<sanitized-name>.jsonl`. The directory slug is `slugify(taskName)` — kebab-case, pinyin for CJK, capped at 32 chars. All runs of a task on the same day go in one file. One file per day keeps the append-only semantics intact and makes day-by-day cleanup trivial. Backward compatibility: readers (`readExecutionLog`, `pruneExecutionLog`, `pruneAllLogs`) also walk the legacy flat files at the logs root. New `setLogRoot()` / `getLogRoot()` helpers make the log root injectable for tests.
- **Slug cache on first write**: Each task computes its directory slug once (sync, via `pinyin-pro`) and caches it for subsequent writes. The first write for a CJK-named task already lands in the pinyin directory (no async/sync split).
- **Fixed CJK task name handling**: The previous `replace(/[^a-zA-Z0-9_.-]/g, "_")` sanitizer turned `omp-atomix:wiki-changelog:01-算法模块` into `omp-atomix_wiki-changelog-agent_01-____.jsonl` (Chinese characters erased to underscores). The new path resolves the same task to `logs/by-task/omp-atomix-wiki-changelog-01-suan-fa-mo-kuai/`.
- **`pi-gateway install` now seeds agentDir through `omp agent init`**: The interactive DingTalk install wizard (`pi-gateway install`) now delegates agent directory creation to the public `runAgentInit` handler exported from `@oh-my-pi/pi-coding-agent/cli/agent-cli`, so install and the `omp agent` CLI share one source of truth for the skeleton layout. The wizard also adds an optional "Mission 文件" prompt so users can seed a custom `mission.md` at install time without leaving the flow.

### Fixed

- `pi-gateway install` output: the "下一步" hint now lists `omp agent show <accountId>` and `omp agent validate --dir <agentDir>` so users can verify the agentDir created during install. Also fixes a missing path separator in the "编辑 `<agentDir>/.omp/config.yml`" hint that previously rendered as `agentDir.omp/config.yml`.

## [14.5.12] - 2026-04-30

### Added

- Initial release of the unified gateway package.
