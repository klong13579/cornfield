# MoA P1–P3 Follow-ups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / TDD per task.

**Goal:** Finish post-P0 quality/perf fixes: research source relevance (P1), plan-worker tool lockdown + round caps (P2), Ask dedupe vs known_inputs (P3).

**Architecture:** Pure filters in `tco` / `decision-missing` / `stages`; tighten `restrictPlanWorkerTools` + optional all-tool budget; Ask path filters duplicates before grill/form.

**Tech Stack:** Bun, bun:test, moa-extension.

---

### Task 1: P1 — filterResearchPackForTask + research.md cues

**Files:** `src/tco.ts`, `src/prompts/research.md`, `test/tco.test.ts`, wire in `stages.ts` after salvage/polish

**Behavior:** Extract compare entities from task; prefer sources whose url/claim mention an entity; drop clearly off-topic when ≥2 entities; keep host diversity within retained set.

### Task 2: P2 — intersect plan tools + count-all tool budget

**Files:** `src/stages.ts` (`restrictPlanWorkerTools`), `src/tool-budget.ts`, `src/worker-engine.ts` / `subprocess.ts` if needed, `src/research-mode.ts` guidance, tests

**Behavior:** Research modes → tools ⊆ `{read,search,find,ast_grep}` (no write/edit/bash). Plan workers get `maxToolRounds` counting **all** tools (compare: 8, other research: 12, local-impl none-research: 12).

### Task 3: P3 — filterMissingAlreadyKnown

**Files:** `src/decision-missing.ts`, grill-ask + ask-user, tests

**Behavior:** Drop missing_inputs whose key (or synonym) already exists in known_inputs.

### Task 4: CHANGELOG

---
