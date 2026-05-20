# P0 Critical Gaps Design: Memory Fallbacks & Convention LLM Batch

## Summary

This document specifies the implementation of three P0 critical gaps identified in the OMP Evolution V2.1 plan:

1. **Gap 1.1** — Memory Phase 1 fallback rules (per-thread extraction)
2. **Gap 1.2** — Memory Phase 2 fallback rules (global consolidation)
3. **Gap 2.1** — Convention Layer 2 LLM Batch Extraction

## Architecture

```
Memory Pipeline:
  Phase 1 (Per-thread) ──▶ Phase 2 (Global) ──▶ Artifacts
       │                      │
  ┌────▼────┐            ┌────▼────┐
  │ Fallback│            │ Fallback│
  │ Rules   │            │ Template│
  └─────────┘            └─────────┘

Convention Pipeline:
  Layer 1 (Rules) ──▶ Layer 2 (LLM Batch) ──▶ Convention Store
       │                    │
       └──────────────────────┘
         Skip if rules sufficient
```

## Gap 1.1: Memory Phase 1 Fallback

### Current Behavior

`runStage1Job()` calls LLM to extract `raw_memory`, `rollout_summary`, `rollout_slug`. On failure → returns `{ kind: "failed" }` or `{ kind: "no_output" }`.

### New Behavior

Add `runStage1JobWithFallback()` wrapper that tries LLM first, then falls back to rule-based extraction.

### Fallback Rules

| Signal | Detection | Output |
|--------|-----------|--------|
| Tool sequence | Extract unique tool names in order | `raw_memory`: "Used tools: read → search → edit → verify" |
| Error patterns | Count errors, check for recovery | `raw_memory`: "Encountered 2 errors, recovered successfully" |
| File modifications | List modified files | `raw_memory`: "Modified: src/foo.ts, src/bar.ts" |
| User corrections | Detect "不对", "错了", "should be" | `raw_memory`: "User corrected: use async/await" |
| Session duration | Duration / tool count ratio | `rollout_summary`: "Quick fix (3 tools, 30s)" |

### Implementation

```typescript
async function runStage1JobWithFallback(options: Stage1Options): Promise<Stage1Result> {
  const result = await runStage1Job(options);
  if (result.kind === "output") return result;
  return runStage1Fallback(options);
}

function runStage1Fallback(options: Stage1Options): Stage1Result {
  const trace = loadTrace(options.claim.rolloutPath);
  const signals = extractSignals(trace);
  
  const rawMemory = buildRawMemory(signals);
  const rolloutSummary = buildRolloutSummary(signals);
  const rolloutSlug = buildRolloutSlug(signals);
  
  return {
    kind: "output",
    output: { rawMemory, rolloutSummary, rolloutSlug },
  };
}
```

## Gap 1.2: Memory Phase 2 Fallback

### Current Behavior

`runConsolidationModel()` calls LLM to consolidate all raw memories into `MEMORY.md`, `memory_summary.md`, and skills. On failure → no consolidated memory.

### New Behavior

Add three-tier fallback:

1. **Primary:** LLM consolidation (existing)
2. **Fallback 1:** Template-based assembly with deduplication
3. **Fallback 2:** Return last known good memory with stale marker

### Fallback Implementation

```typescript
async function runConsolidationWithFallback(options: ConsolidationOptions): Promise<ConsolidationResult> {
  // Tier 1: LLM
  try {
    return await runConsolidationModel(options);
  } catch (error) {
    logger.warn("Consolidation failed, trying fallback", { error: String(error) });
  }
  
  // Tier 2: Template-based assembly
  try {
    return await assembleConsolidationFallback(options);
  } catch (error) {
    logger.warn("Fallback assembly failed, using last known good", { error: String(error) });
  }
  
  // Tier 3: Last known good
  return loadLastKnownGood(options.memoryRoot);
}
```

### Template-based Assembly Rules

- **Deduplication:** Group raw memories by similar tool sequences (Levenshtein distance < 30%)
- **Ordering:** Sort by recency, most recent first
- **Summarization:** Concatenate rollout summaries, truncate to token limit
- **Skills:** Skip skill generation in fallback mode

## Gap 2.1: Convention Layer 2 LLM Batch Extraction

### Current Behavior

`ConventionExtractor` uses regex patterns to extract conventions from trace entries. Rules run per-session, producing conventions with confidence 50-85.

### New Behavior

Add LLM batch extraction layer between rules (Layer 1) and storage. Rules run first as fast path. If rule coverage is insufficient, send trace to LLM for deep extraction.

### Trigger Condition

```typescript
function shouldTriggerLlmExtraction(ruleConventions: Convention[]): boolean {
  const totalConfidence = ruleConventions.reduce((sum, c) => sum + c.confidence, 0);
  const avgConfidence = ruleConventions.length > 0 ? totalConfidence / ruleConventions.length : 0;
  
  // Trigger if: few conventions OR low average confidence
  return ruleConventions.length < 2 || avgConfidence < 70;
}
```

### LLM Batch Prompt

```
You are a convention extraction assistant. Analyze the following session trace and extract
project-specific conventions, preferences, and rules that the user has established.

Focus on:
- Implicit preferences (e.g., "use X instead of Y")
- Project-specific facts (e.g., "this project uses Bun")
- Workflow patterns (e.g., "always run tests before committing")
- Negative rules (e.g., "never modify generated files")

Return ONLY a JSON array of conventions:
[
  {
    "type": "negative_rule" | "positive_rule" | "preference" | "project_fact" | "procedural_rule",
    "content": "string",
    "confidence": number (0-100)
  }
]
```

### Integration

```typescript
export class ConventionExtractor {
  extract(trace: SessionTrace): Convention[] {
    // Layer 1: Rules (fast path)
    const ruleConventions = this.extractWithRules(trace);
    
    // Layer 2: LLM Batch (deep path)
    if (shouldTriggerLlmExtraction(ruleConventions)) {
      const llmConventions = await this.extractWithLlm(trace);
      return [...ruleConventions, ...llmConventions];
    }
    
    return ruleConventions;
  }
}
```

## Data Flow

### Memory Pipeline

```
Session End
    │
    ▼
┌─────────────────┐
│  Trace Recorder │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│  Phase 1 Extraction │
│  ┌───────────────┐  │
│  │ LLM (primary) │  │
│  │ Fallback      │  │
│  │ (rules)       │  │
│  └───────────────┘  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Phase 2 Consolidation│
│  ┌───────────────┐  │
│  │ LLM (primary) │  │
│  │ Template      │  │
│  │ (fallback)    │  │
│  └───────────────┘  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Artifacts          │
│  MEMORY.md          │
│  memory_summary.md  │
│  skills/            │
└─────────────────────┘
```

### Convention Pipeline

```
Session End
    │
    ▼
┌─────────────────────┐
│  Rule Extraction    │
│  (Layer 1)          │
└────────┬────────────┘
         │
         ▼
    ┌─────────┐
    │ Coverage│
    │ Sufficient?
    └────┬────┘
    Yes  │  No
    │    │
    │    ▼
    │ ┌─────────────────┐
    │ │ LLM Extraction  │
    │ │ (Layer 2)       │
    │ └─────────────────┘
    │    │
    ▼    ▼
┌─────────────────────┐
│  Convention Store   │
│  (SQLite)           │
└─────────────────────┘
```

## Error Handling

| Failure Mode | Handling |
|-------------|----------|
| LLM unavailable | Use fallback rules/templates |
| JSON parse error | Retry once, then fallback |
| Token limit exceeded | Truncate input, retry |
| Empty LLM output | Use fallback |
| Timeout | Abort and use fallback |

## Testing Strategy

1. **Unit tests:** Test each fallback rule independently
2. **Integration tests:** Test full pipeline with LLM mocked to fail
3. **E2E tests:** Verify artifacts are produced even when LLM is unavailable
4. **Regression tests:** Ensure fallback output quality meets minimum threshold

- [x] Phase 1 fallback produces valid output when LLM fails
- [x] Phase 2 fallback produces valid MEMORY.md when LLM fails
- [x] Convention LLM batch extraction triggers correctly
- [x] All fallbacks have unit tests
- [x] E2E tests verify pipeline works with LLM disabled
- [x] No regression in existing LLM-based extraction quality

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Fallback quality too low | Define minimum quality threshold, measure against LLM output |
| Performance impact | Benchmark fallback execution time, ensure <100ms |
| Maintenance burden | Keep rules simple, document each rule's purpose |
| False positives in convention extraction | Confidence threshold tuning, manual review of extracted conventions |

## Future Work

- **Layer 3 Fallback Rules (Task 2.2):** Implement additional rule-based conventions for cases where both rules and LLM fail.
- **Provenance Grading (Task 2.3):** Add provenance tracking to distinguish between rule-extracted and LLM-extracted conventions.
- **Convention Miner Integration (Task 2.4):** Integrate convention miner into the three-layer extraction pipeline.