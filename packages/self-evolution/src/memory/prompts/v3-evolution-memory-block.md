## Self-Evolution System (V3)
- Package: `packages/self-evolution/`; SQLite: `<repo>/.omp/evolution/evolution.db`.
- **Learnings** + **SessionLearner** (≤3 items per session); `user_explicit` regex path for pinned rules.
- Inject on `before_agent_start`: `memory_summary.md` + active/pinned learnings (not V2 conventions).
- Projections: `learnings.md`, `user_profile.md`, `system-diagnosis.md`; skills under `.omp/skills/`.
- CLI: `/evolution learnings` (list/pin/seed), `/evolution memory refresh-summary`.
- **Removed in V3**: `ConventionExtractor`, `conventions` SQLite table, `conventions.md`, convention regression on session end.
