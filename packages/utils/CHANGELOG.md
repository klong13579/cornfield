# Changelog

## [Unreleased]

### Added

- `logger.info()` export: winston supports the `info` level but it was not re-exported from the logger module. Callers in `pi-gateway` and `self-evolution` that called `logger.info()` hit a runtime `TypeError` that was silently swallowed, causing DingTalk card tool-result blocks to not render.

### Fixed

- **`runCleanup` reentrancy crash ("Cleanup invoked recursively")**: Signal handlers (SIGINT/SIGTERM/uncaughtException) are async — `await runCleanup()` does not block `process.exit()`. When `process.on("exit")` fired during an in-flight cleanup (cleanupStage still `"running"`), the reentrant `runCleanup` call logged an error and returned `Promise.resolve()`, leaving cleanup callbacks unexecuted and crashing the gateway. Fixed: the `"running"` branch now returns the existing `cleanupPromise` instead of logging an error, so reentrant callers await the same in-flight cleanup. Added `cleanupPromise` field to track the active cleanup promise across reentrancy.

### Added

- **Kebab-case alias in CLI flag parser**: `Cmd.flags` declared in camelCase (e.g. `deleteFiles`) now also accepts `--delete-files` on the command line. The camelCase key is the canonical name; the kebab-case form is registered to the same option object so `node:util` `parseArgs` populates either key the user typed, and the reader falls back across both spellings. Help text renders the kebab-case form when it differs from the key. Backward compatible — single-word lowercase flags (`--dir`, `--force`, `--json`, etc.) are unchanged.

- `slugify` / `slugifySync` helpers in `packages/utils/src/slug.ts` for converting human-readable names (including CJK) into filesystem-safe kebab-case slugs. The async path uses `pinyin-pro` (added as a workspace dependency) to convert Chinese characters to pinyin; the sync path uses an ASCII-only fallback. Both support `maxLen` and `hashOnTruncate` options, plus an NFKD pass to collapse diacritics (e.g. `Café → cafe`).
