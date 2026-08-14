# Implementation Plan: P0 Critical Gaps

## Overview

Implement three P0 critical gaps from the OMP Evolution V2.1 plan:
1. **Gap 1.1** — Memory Phase 1 fallback rules (per-thread extraction)
2. **Gap 1.2** — Memory Phase 2 fallback rules (global consolidation)
3. **Gap 2.1** — Convention Layer 2 LLM Batch Extraction

## Phase 1: Memory Phase 1 Fallback (Gap 1.1)

### Files to Modify
- `packages/coding-agent/src/memories/index.ts` — Add fallback wrapper

### Tasks
1. Create `runStage1JobWithFallback()` wrapper
2. Implement `runStage1Fallback()` with rule-based extraction
3. Add signal detection for:
   - Tool sequences
   - Error patterns
   - File modifications
   - User corrections
   - Session duration

### Acceptance Criteria
- [ ] Fallback produces valid output when LLM fails
- [ ] All signals are correctly detected and formatted
- [ ] Unit tests cover each signal type

## Phase 2: Memory Phase 2 Fallback (Gap 1.2)

### Files to Modify
- `packages/coding-agent/src/memories/index.ts` — Add consolidation fallback

### Tasks
1. Create `runConsolidationWithFallback()` with three-tier fallback
2. Implement template-based assembly with deduplication
3. Add last-known-good memory loading
4. Implement Levenshtein distance-based deduplication

### Acceptance Criteria
- [ ] Fallback produces valid MEMORY.md when LLM fails
- [ ] Deduplication works correctly
- [ ] Last-known-good memory is loaded when all else fails

## Phase 3: Convention Layer 2 LLM Batch (Gap 2.1)

### Files to Modify
- `packages/self-evolution/src/convention-extractor.ts` — Add LLM batch layer

### Tasks
1. Add `shouldTriggerLlmExtraction()` trigger condition
2. Implement `extractWithLlm()` method
3. Create LLM prompt template for convention extraction
4. Integrate Layer 2 into existing extraction pipeline

### Acceptance Criteria
- [ ] LLM extraction triggers when rule coverage is insufficient
- [ ] Extracted conventions are correctly formatted
- [ ] Integration tests verify trigger conditions

## Testing Strategy

1. **Unit tests:** Test each fallback rule independently
2. **Integration tests:** Test full pipeline with LLM mocked to fail
3. **E2E tests:** Verify artifacts are produced even when LLM is unavailable
4. **Regression tests:** Ensure fallback output quality meets minimum threshold

## Timeline

| Phase | Task | Estimated Time |
|-------|------|---------------|
| 1 | Memory Phase 1 Fallback | 2 days |
| 2 | Memory Phase 2 Fallback | 2 days |
| 3 | Convention Layer 2 LLM Batch | 3 days |
| - | Testing & Validation | 2 days |
| **Total** | | **7 days** |

## Dependencies

- `packages/coding-agent/src/memories/index.ts`
- `packages/self-evolution/src/convention-extractor.ts`
- `packages/self-evolution/src/types.ts`

## Risks

| Risk | Mitigation |
|------|-----------|
| Fallback quality too low | Define minimum quality threshold |
| Performance impact | Benchmark fallback execution time |
| Maintenance burden | Keep rules simple and documented |

## Success Criteria

- [ ] Phase 1 fallback produces valid output when LLM fails
- [ ] Phase 2 fallback produces valid MEMORY.md when LLM fails
- [ ] Convention LLM batch extraction triggers correctly
- [ ] All fallbacks have unit tests
- [ ] E2E tests verify pipeline works with LLM disabled
- [ ] No regression in existing LLM-based extraction quality
