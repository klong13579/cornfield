# MoA P1–P3 Follow-ups Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / TDD per task.

**Goal:** Finish post-P0 quality/perf fixes: research source relevance (P1), plan-worker tool lockdown + round caps (P2), Ask dedupe vs known_inputs (P3).

**Architecture:** Pure filters in `tco` / `decision-missing` / `stages`; tighten `restrictPlanWorkerTools` + optional all-tool budget; Ask path filters duplicates before grill/form.

**Tech Stack:** Bun, bun:test, moa-extension.

**Verification:** `bun packages/moa-extension/scripts/short-probe.ts` (Discovery→Research→Ask→Workers; asserts; no Rewrite/Synthesis).

---

### Task 1: P1 — filterResearchPackForTask + research.md cues

**Files:** `src/tco.ts`, `src/prompts/research.md`, `test/tco.test.ts`, wire in `stages.ts` after salvage/polish

**Behavior:** Extract compare entities from task; prefer sources whose **URL** mentions an entity; claim/relevance alone cannot keep a source when the text is an off-topic disclaimer; drop clearly off-topic URLs when ≥2 entities; keep host diversity within retained set.

### Task 2: P2 — intersect plan tools + count-all tool budget

**Files:** `src/stages.ts` (`restrictPlanWorkerTools`), `src/tool-budget.ts`, `src/worker-engine.ts` / `subprocess.ts` if needed, `src/research-mode.ts` guidance, tests

**Behavior:** Plan workers **always** get tools ⊆ `{read,search,find,ast_grep}` (no write/edit/bash/**web_search**), including `researchMode=none`. Plan workers get `maxToolRounds` counting **all** tools (compare **16** / other research 12 / local-impl 12). Budget abort messages distinguish plan-worker vs research.

### Task 3: P3 — filterMissingAlreadyKnown

**Files:** `src/decision-missing.ts`, grill-ask + ask-user, tests

**Behavior:** Drop missing_inputs whose key (or synonym, incl. `comparison_depth`/`comparison_focus`) already exists in known_inputs. After Ask, **prune** answered keys from `missing_inputs`.

### Task 4: CHANGELOG + short-probe

---
