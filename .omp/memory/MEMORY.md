# OMP Long-Term Memory

## Project Overview
OMP is a coding agent with self-evolution capabilities. Key packages: coding-agent, ai, utils. The agent uses a file-based multi-step evolution pipeline (V3).

## Key Durable Rules
1. **Boundary Condition Testing**: When designing test cases, OMP MUST automatically include boundary condition analysis (equivalence partitioning, edge cases, extreme values) for every input field/condition. This is permanent and requires no user reminder.
2. **Step Timing**: OMP currently lacks step-level timing. Implementation plan exists (add startTime/endTime to tool events, persist to session JSONL, render in TUI) but not executed.
3. **User Persona Awareness**: Implementation planned for mid-conversation persona extraction via `identity auto_extract` tool and system prompt rebuild. Current system prompt is built once at session start.
4. **Read Tool Cache**: File read caching is not recommended due to external modification risks, cross-session cache waste, and formatting complexities. The real bottleneck is LLM TTFT (~4.8s median). Better to reduce repeated reads via prompt constraints.

## Skill Quality Guidelines
A comprehensive reference template was created at `~/.omp/[REDACTED].md` establishing:
- Description must start with action verb, ≤120 chars, no session excerpts.
- Body must contain executable decision logic (decision trees, conditions, counterexamples), no raw tool sequences, file paths, or scoring tables.
- Quality criteria: approachSubstance ≥8, pitfallCoverage ≥10, toolDiversity ≥10, autonomy ≥10.
- Validation checklist: must pass conditional structure, no standalone tool sequences, at least one counterexample, body ≤200 lines.

## Boundary Condition Testing Skill
Created skill `boundary-condition-testing` (quality 90, graduated) that enforces automatic boundary condition analysis. Task pattern: "When asked to write test cases, design test scenarios, or verify code correctness." Approach includes boundary value analysis, equivalence partitioning, domain-specific boundaries, and 12 documented pitfalls.

## Self-Evolution System (V3)
- Package: `packages/self-evolution/`; SQLite: `<repo>/.omp/evolution/evolution.db`.
- **Learnings** + **SessionLearner** (≤3 items per session); `user_explicit` regex path for pinned rules.
- Inject on `before_agent_start`: `memory_summary.md` + active/pinned learnings (not legacy conventions).
- Projections: `learnings.md`, `user_profile.md`, `system-diagnosis.md`; skills under `.omp/skills/`.
- CLI: `/evolution learnings` (list/pin/seed), `/evolution memory refresh-summary`.
- **Removed in V3**: `ConventionExtractor`, `conventions` SQLite table, `conventions.md`, convention regression on session end.

