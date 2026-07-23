# MoA Research Claim Quality (B+C) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When Research falls back to `tool_trace` salvage, produce readable factual `claim`/`relevance` (not hostname+path), via snippet extraction (B) plus one cheap no-tools LLM polish (C).

**Architecture:** Pure parse/enrich in `tco.ts` (sanitize + web_search hit extract → finalize). After salvage in `runResearchStage`, optionally call a tools-none polish pass that may only rewrite claim/relevance keyed by URL; failures keep B output.

**Tech Stack:** Bun, `bun:test`, moa-extension `tco.ts` / `stages.ts` / WorkerEngine, static prompt `.md`.

---

### Task 1: Stronger URL sanitize

**Files:**
- Modify: `packages/moa-extension/src/tco.ts` (`sanitizeResearchUrl`)
- Test: `packages/moa-extension/test/tco.test.ts`

**Step 1:** Failing tests — strip trailing `` ` `` / `%60`, collapse path `//`, keep valid https.

**Step 2:** Implement minimal sanitize fixes.

**Step 3:** Tests pass.

---

### Task 2: B — extract web_search hits → claims

**Files:**
- Modify: `packages/moa-extension/src/tco.ts` (`extractWebSearchHits`, `finalizeResearchPackFromToolTrace`, `claimFromUrl` fallback)
- Test: `packages/moa-extension/test/tco.test.ts`

**Step 1:** Failing test — raw LLM search format:

```
[1] OpenClaw Intro
    https://docs.openclaw.ai/intro
    OpenClaw is an open-source agent runtime…
```

→ source.claim includes title (or snippet sentence), relevance from snippet, not bare path.

**Step 2:** Implement parser + wire into finalize.

**Step 3:** Tests pass; existing tool_trace caps still hold.

---

### Task 3: C — polish merge (pure) + spawn/engine helper

**Files:**
- Create: `packages/moa-extension/src/prompts/research-claim-polish.md`
- Modify: `packages/moa-extension/src/tco.ts` (`applyPolishedClaims`, `parseClaimPolishResponse`)
- Modify: `packages/moa-extension/src/stages.ts` (after salvage)
- Test: `packages/moa-extension/test/tco.test.ts`, `packages/moa-extension/test/stages.test.ts`

**Step 1:** Failing tests — applyPolishedClaims matches by URL; ignore empty; polish failure leaves B pack; stage calls polish when tool_trace.

**Step 2:** Implement + wire with short timeout (~60s), tools none, researchModel.

**Step 3:** Tests pass.

---

### Task 4: CHANGELOG

**Files:** `packages/moa-extension/CHANGELOG.md` under Unreleased / Changed or Fixed.
