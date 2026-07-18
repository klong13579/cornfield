# Changelog

## [Unreleased]

### Added

- **Evolution V3 (default)**: `learnings` table + `SessionLearner` (one LLM call per session, ≤3 items), `user_explicit` regex path, injection via `/evolution learnings pin|list|search|archive`, projection `learnings.md`.
- **Unified memory CLI**: `/evolution memory` hub (`search`, `stats`, `report`, `view`, `enqueue`, `refresh-summary`, `clear`); `/memory` remains a compat alias via `evolution-memory.ts`.
- **Architecture doc**: [docs/omp-evolution-architecture-v3.md](../../docs/omp-evolution-architecture-v3.md) (V3 flows, 1-B migration, Hermes/OpenClaw mapping).

- **DB connection recovery on disk I/O error**: `db.ts` exports `recreateEvolutionDb(cwd, globalStore)` which closes a poisoned SQLite handle, evicts it from the `dbCache`, and opens a fresh connection. `index.ts` detects `disk I/O error` in all handler catch blocks and calls `_recoverDbConnection` — which recreates the DB, stops the skills watcher, and resets the `_ensureInit` guard (`recorder = undefined`) so the next handler invocation re-initializes all stores with the fresh handle. A 10-second cooldown prevents tight recovery loops. Previously, once a cached connection hit a persistent I/O error (e.g. stale WAL shared-memory mapping), the `dbCache` held the dead handle forever and every subsequent write failed for the process's remaining lifetime.

### Changed

- **Removed V2 dead code**: JSONL `convention-store`, `projection.ts` conventions import/export, `SqliteConventionStore`, convention compliance checker, 4-layer injection formatter path, convention regression replay on `RegressionReplayBackend`; production injection always uses 7-layer formatter.
- **Default evolution scope is global user store**: memory and evolution DB use `~/.omp/self-evolution` and encoded agent memory paths by default; pass `--self-evolution-project-store` for per-repo `<cwd>/.omp/{memory,evolution,skills}`. Path helpers renamed from `resolveLegacy*` to `resolveGlobal*` (deprecated aliases kept).
- **V2 convention pipeline removed**: no `ConventionExtractor`, no `--no-self-evolution-v2-writer`, no `/evolution conventions`; admission refresh is skill-only; `backfill-episodes-from-sessions` writes episodes/traces/fixtures + `projectLearnings` only.
- **`/evolution learnings seed [file]`**: Import pinned learnings from `<project>/.omp/evolution/learnings-seed.json` (see `learnings-seed.example.json`) after `/evolution clear` so the next session has injectable rules without waiting for SessionLearner.
- **`ensureMemorySummaryFromMemory`**: After memory consolidation, backfill `memory_summary.md` from `MEMORY.md` when the LLM summary is shorter than 200 chars (fixes empty short-term injection).
- **Audit (V3)**: `system-diagnosis` / `/evolution audit` emphasize learnings counts and memory/learnings health.

### Removed

- **`Convention` types and injection parameter**: dropped `Convention` / lifecycle / feedback types from `types.ts`; `formatInjection` no longer accepts a conventions array (learnings are the last argument); trace no longer tracks `injectedConventionIds`.
- **Automatic legacy path migration** (`migrate-paths.ts`): no longer copies `~/.omp/self-evolution` or encoded memory into project `.omp/` on session start; use `scripts/migrate-evolution-data.sh` manually when needed.
- **V2 writer**: convention L2/L3 extractor, `src/legacy/`, `/evolution conventions`, convention regression on session end, `OMP_BACKFILL_LLM` convention extraction.
- **SQLite `conventions` / `convention_feedback`**: dropped on `initSchema`; escalation and daily report use `learnings` only; audit tolerates missing legacy table.
- Dev/ops scripts superseded by `/evolution` subcommands and project-local DB: `evolution-db-inspect.sh`, `run-evolution-command-test.ts`, `repair-and-backfill-traces.ts`, `migrate-to-global.ts`, `watch-omp-evolution-test.sh`.

### Changed

- **V3 write path (default)**: `agent_end` no longer inserts diagnosis/error-pattern conventions; admission skips convention regression replay; `before_agent_start` injects `memory_summary.md` + active/pinned learnings.
- **Docs**: `README.md` and `doc/README.md` describe project-local `.omp/{memory,evolution,skills}` layout (default DB path, migration scripts, memory tables in `evolution.db`).
- **`/evolution clear`**: Deletes project-local (or global user store) `.omp/memory`, `.omp/evolution`, and `.omp/skills` after confirmation instead of asking users to remove `~/.omp/self-evolution` manually.
- **`backfill-episodes-from-sessions.ts`**: Re-archive `~/.omp/agent/sessions/*.jsonl` into project `evolution.db` (episodes, traces, fixtures) and refresh learnings/diagnosis projections.
- **P3: Memory SQLite tables share project `evolution.db`**: `threads`, `stage1_outputs`, `jobs` (memory kinds), and `vector_embeddings` are created in the same file as evolution/episodic tables (`<cwd>/.omp/evolution/evolution.db`). Memory runtime uses `getMemoryDb` / `releaseMemoryDb` (ref-counted with evolution). Run `packages/self-evolution/scripts/migrate-evolution-data.sh <repo>` to copy legacy FS artifacts and merge rows from `~/.omp/agent/agent.db`.
- **Memory module moved into self-evolution**: `packages/coding-agent/src/memories/` implementation now lives at `packages/self-evolution/src/memory/` (prompts under `src/memory/prompts/`). `@oh-my-pi/pi-coding-agent/memories` re-exports remain for compatibility.
- **Project-local evolution layout** (opt-in `--self-evolution-project-store`): memory → `<cwd>/.omp/memory/`, evolution DB + projections → `<cwd>/.omp/evolution/`, skills → `<cwd>/.omp/skills/`. User-level `~/.omp/self-evolution` is the default.

### Fixed

- **Memory consolidation (sk-sp keys)**: Phase1/Phase2 LLM calls route `sk-sp-*` keys to `alibaba-coding-plan` on `https://coding.dashscope.aliyuncs.com/v1` with `qwen3-coder-plus` (not `bailian-coding-plan` / compatible-mode `deepseek-v4-*`).
- **Ops**: `scripts/sync-alibaba-api-key-to-db.ts` persists `ALIBABA_API_KEY` to `alibaba-coding-plan` in `agent.db` (same `AuthStorage` path as omp).
- **Memory consolidation (V3)**: Phase-2 LLM output is sanitized to strip V2 convention/`conventions.md` references; prompts require V3 learnings/SessionLearner wording; `memory_summary` is derived from sanitized `MEMORY.md` when legacy text remains; `applyConsolidation` always sanitizes; on LLM failure prefer last-known-good `MEMORY.md` over raw stage1 template dump.
- Regression fixtures missing `dominant_error_*` (all grouped as `reg:unknown` escalations): infer labels from trace when diagnosis absent; repair backfill from `episode_diagnoses`; upgrade sparse traces from session JSONL on backfill; auto-resolve stale open escalations when pattern count drops
- `fit_scores` table created in `initSchema` so manual `sqlite3` queries do not fail on fresh DBs; added `scripts/evolution-db-inspect.sh` and corrected `doc/README.md` SQL examples (`lifecycle_state`, `episode_diagnoses`, `pattern_key`, no `entries_json`)
- Session trace hydration: `agent_end` and backfill upgrade traces from omp session JSONL when JSONL has a richer tool chain than the in-memory recorder

### Added

- `/evolution refresh-admission` and `/evolution regression [limit]` — manual full admission refresh and trial listing with `[replay:*]` / `[toolchain:*]` tags
- `regression_trials.reason` tagged with `[replay:heuristic|llm|subagent]` and optional `[toolchain:overturn|confirm|only|repeat|skip]` for audit queries
- Sub-agent regression replay: `omp --mode json` captures `tool_execution_*` events; `compareFixtureToReplayChain` gates KEEP/DISCARD against real tool-chain divergence
- `/evolution audit` and `system-diagnosis.md`: regression replay section (backend, traces/fixtures, trials by target, recent keep/discard rows)
- Regression JSON contract: `addresses_dominant_error` / `would_change_tool_chain` fields; sub-agent prompt prefers structured JSON over plain VERDICT
- Regression replay tool-chain contract: fixture entries summarized for LLM/sub-agent prompts; sub-agent output normalized via `interpretSubagentReplayOutcome` (VERDICT / JSON / timeout / spawn_error)
- Flag `--self-evolution-admission-reclassify-interval` (default 5) for llm/subagent convention reclassify cadence
- Regression replay backends: `heuristic` (keyword overlap), `llm` (background LLM JSON verdict), `subagent` (`omp -p` with `--no-self-evolution`, max 2 fixtures, falls back to llm/heuristic); runtime model/auth wired on `agent_end`
- Per-session benefit admission: deprecate low-help skills every session; convention reclassify every session (heuristic) or every 5 sessions (llm/subagent)
- Per-target fixture selection by error tool for convention/skill regression gates
- Skill population regression gate before `experimental`/`graduated` promotion (`regression_trials` with `target_type=skill`)
- `/evolution backfill-traces` and `scripts/backfill-session-traces.ts` to rebuild `session_traces` from omp session JSONL
- Evolution regression (P2): persist full `session_traces`, build `regression_fixtures` from failed sessions, run keep/discard replay gate before promoting conventions to `active` (`regression_trials` audit log)
- Evolution escalations (P3): `evolution_escalations` table, `/evolution stuck`, TUI warning on recurring failures, suppress auto convention insert for stuck patterns; audit report section
- Nudge outcome backfill (P4): score all context-injected nudges at session end even if tracker missed registration; audit shows regression discard/keep, deprecated skills, convention lifecycle counts
- `system-diagnosis.md` projection: audit + recent `episode_diagnoses` + open escalations written under `.omp/self-evolution/` after each session and on `/evolution audit`
- Session nudges are injected into the next LLM `context` (append user message) so the agent can act on inefficiency hints, not only TUI notify
- AB-02 harness (`nudge-context-ab.ts`, `scripts/nudge-context-ab.ts`) compares control vs treatment injection delivery and mock agent tool choice; flag `--no-self-evolution-enable-nudge-context-injection` for live control arm
- Cross-session nudges queue into the same LLM context injection path as in-session nudges
- Per-type nudge cooldown (15s warn / 30s info), one delivery per type per user turn, dismiss/ack suppression from `nudge_history`
- Nudge effectiveness tracking (`outcome_score`, `pattern_repeated`, `post_tool_calls`) scored at session end; surfaced in `/evolution audit` and `nudges`
- `/evolution nudges ack|dismiss <id>`; early single-shot `edit-verify-path-mismatch` nudge; `scripts/nudge-live-ab.ts` for synthetic + live A/B steps
- Canonical skill template at `src/prompts/skill-template.md` with export validation in `skill-validation.ts` and agent-body formatting in `skill-format.ts`
- Batch skill normalizer `src/skill-batch-format.ts` and `scripts/batch-format-skills.ts` for full-library template migration
- Convention Miner Integration (2.4): Integrated negative-keyword-based implicit rule mining as Layer 1.5 in the convention extraction pipeline
- Skill Population Evolution Engine (2.7): Added 5-state lifecycle (candidate → experimental → graduated → deprecated → archived) with composite scoring, selection bias, mutation triggers, elimination, and graduation logic
- Conventions Projection (2.9): Added `src/projection.ts` to generate `conventions.md` and import user edits back into the database
- Evolution Log Projection (2.10): Added `src/logging/evolution-log.ts` to generate `evolution_log.md` audit timeline from activity logs
- User Profile Projection (2.11): Added rolling window aggregation (7/30/90 days) and `user_profile.md` generation to `src/user-profiler.ts`

### Changed

- Storage dedup migration: drop `regression_fixtures.entries_json` and `skill_population.content`; replay hydrates entries from `session_traces`; legacy fixture rows backfill traces before column drop
- Markdown projections (`system-diagnosis.md`, `conventions.md`, etc.) write to global `~/.omp/self-evolution/` when `globalStore` is enabled
- Dialogue-extracted conventions are suppressed when the session error pattern is in an open evolution escalation
- Benefit admission (P1): default prompt injection only includes conventions in `active` lifecycle with proven compliance, and skills with injection help rate ≥ 50% after ≥5 injections; new conventions start as `candidate`
- Profile `errorRate` is displayed as avg tool errors per session (not a percentage); cross-session high-error nudges use the same semantics
- `syncSkillsToFiles` exports agent-facing markdown only (scores in YAML); skills failing template validation are skipped
- Memory consolidation skills get normalized frontmatter `description` and `experimental` status when validation fails
- `SkillManager.integrate()` now registers new skills in the population as candidates
- `_retrieveRelevantSkills()` now uses population engine selection bias (prefers graduated > high-score experimental)

### Fixed

- Nudge context injection logging uses `logger.debug` (pi-utils has no `logger.info`), avoiding `Pipeline context injection failed` after successful inject
- Align `activity.log` / episodic `session_started` with the current turn’s prompt; include `trace.userPrompt` in convention Layer 1 and Layer 2 user-text so bootstrap traces without `user_input` entries still extract rules
- Wired `ErrorPatternExtractor` in the self-evolution extension (`agent_end` no longer throws `ReferenceError: errorPatternExtractor is not defined`)
- Convention Layer 2 LLM batch: pass `ctx.model` from `agent_end` into `ConventionExtractor.extract()` / `extractConventionsWithLlm()`; prompts moved to `extract-conventions.md` + `extract-conventions-input.md`
- `agent_end` uses `intentClassifier.classify(trace, backgroundModel)` when rule confidence is low; trace diagnosis and skill refinement share `resolveBackgroundModel(ctx)`
- Background LLM calls (`callBackgroundLlm`) resolve API keys via `ctx.modelRegistry.getApiKey` (same as main agent / title-generator), not only environment variables; log `stopReason: error` instead of silently returning empty text
- Fixed `db.ts` conventions table schema syntax
- Fixed `SqliteConventionStore` missing `#db` private field declaration
- Fixed `extractConventionsFromTraces` to properly await async `extract()` calls
- **24 pre-existing tsgo errors cleared across 7 files** (`src/commands.ts`, `src/index.ts`, `src/projection/learnings.ts`, `src/regression/omp-session-to-trace.ts`, `src/regression/replay-contract.ts`, `src/trace-analyzer.ts`, `src/unified-skills.test.ts`): type-contract drift between `SelfEvolutionFlags` / `Learning` / `InjectionFormatOptions` callers and their definitions (`enableEpisodeInjection` missing in `parseFlags`, `scope` missing in `rowToLearning`, `memorySummary` missing in `InjectionFormatOptions`); missing symbol declarations (`completedSuccessfully` undeclared in `parseOmpSessionJsonlToTrace`, now properly threaded through the return value so `session_end.completedSuccessfully` overrides the episode default); missing `UserProfile` / `ProfileStore` types and `CommandStores.profileStore()` method, plus three callsites (`_handleProfile`, `handleFit`, `registerProfileCommand`, `buildHeuristicResponses`); broken `BackgroundLlmAuth` construction (`{ auth: ctx.auth }` was never valid — the type is `{ getApiKey: (model) => Promise<string | undefined> }`); `ExternalTraceScanResult` not assignable to `Record<string, unknown>` for `logger.info` (now spread); `null` vs `undefined` mismatch in `ToolChainDiagnosis` (`analyzeWithLlm` empty-trace path); `Array.prototype.findLast` not in the package's effective lib (replaced with `reverse().find()` for portability). The dead `_handleProfile` function (35 lines, 5 type errors, never called) was removed; its functionality is provided by the live `registerProfileCommand`. The `commandStores` literal in `index.ts` now provides a `profileStore` stub returning `null` until a real implementation lands. `parseOmpSessionJsonlToTrace`'s return now uses the locally-tracked `completedSuccessfully` (capturing any `session_end` override) instead of `episode.completedSuccessfully`. All fixes preserve runtime semantics; only `buildHeuristicResponses` widened its parameter from `UserProfile | undefined` to `UserProfile | null | undefined` to match the `ProfileStore.get(...)` return type. `tsgo --noEmit` is now clean for the package.

## [0.1.1] - 2026-05-14

### Added

- Convention Layer 2 LLM Batch: Added LLM-based batch extraction between rules and storage
- Convention Layer 3 Fallback: Added deterministic fallback rules when both rules and LLM fail
- Provenance Grading: Added provenance tracking (user_stated, inferred, fallback) to conventions

### Changed

- Enhanced ConventionExtractor with three-layer architecture (rules → LLM batch → fallback rules)
- Improved convention extraction coverage with layered approach

### Fixed

- Convention extraction now has fallback mechanisms when LLM is unavailable