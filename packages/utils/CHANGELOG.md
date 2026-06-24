# Changelog

## [Unreleased]

### Added

- **Kebab-case alias in CLI flag parser**: `Cmd.flags` declared in camelCase (e.g. `deleteFiles`) now also accepts `--delete-files` on the command line. The camelCase key is the canonical name; the kebab-case form is registered to the same option object so `node:util` `parseArgs` populates either key the user typed, and the reader falls back across both spellings. Help text renders the kebab-case form when it differs from the key. Backward compatible — single-word lowercase flags (`--dir`, `--force`, `--json`, etc.) are unchanged.

- `slugify` / `slugifySync` helpers in `packages/utils/src/slug.ts` for converting human-readable names (including CJK) into filesystem-safe kebab-case slugs. The async path uses `pinyin-pro` (added as a workspace dependency) to convert Chinese characters to pinyin; the sync path uses an ASCII-only fallback. Both support `maxLen` and `hashOnTruncate` options, plus an NFKD pass to collapse diacritics (e.g. `Café → cafe`).
