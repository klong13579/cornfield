# Changelog

## [Unreleased]

### Added

- `slugify` / `slugifySync` helpers in `packages/utils/src/slug.ts` for converting human-readable names (including CJK) into filesystem-safe kebab-case slugs. The async path uses `pinyin-pro` (added as a workspace dependency) to convert Chinese characters to pinyin; the sync path uses an ASCII-only fallback. Both support `maxLen` and `hashOnTruncate` options, plus an NFKD pass to collapse diacritics (e.g. `Café → cafe`).
