# @oh-my-pi/cognitive-coordination

> Cognitive Coordination Layer — Project Synapse

Bridges the Memory and Self-Evolution systems into a unified context injection pipeline. Provides shared logic for skill aggregation, convention mining, activity monitoring, and virtual sandbox validation.

## Modules

### UnifiedSkillRegistry
Loads and merges skills from both Memory (file-based `skills/*/SKILL.md`) and Self-Evolution (SQLite → `skills/*.md`). Handles conflict resolution by confidence score and source priority.

### ContextAssembler
Assembles skills and conventions into a single markdown context block with:
- **Priority ordering**: Conventions first (safety rules), then Skills (sorted by confidence)
- **Token budget control**: Truncates low-priority content when exceeding limits
- **Convention preservation**: Conventions are never truncated

### ConventionMiner
Scans session logs for implicit conventions by detecting negative user instructions:
- 20+ keyword patterns with confidence weights (0.4–1.0)
- False positive filtering for common phrases
- Sentence-level extraction around matched keywords

### ActivityMonitor
Analyzes activity logs (`activity.jsonl`) for:
- **Fit score trends** — moving average over configurable windows
- **Skill decay** — detects skills unused for > threshold days
- **Error rates** — per-tool error frequency

### Virtual Sandbox
Heuristically validates skills against session log content:
- Token overlap scoring between skill content and log
- Error correlation: skills with fix/avoid/ensure keywords get boosted when logs contain errors
- Returns `SandboxReport` with scoreDelta, reason, and pass/fail

## API

```typescript
import {
  UnifiedSkillRegistry,
  assembleContext,
  mineImplicitConventions,
  analyzeActivityTrends,
  validateSkill,
} from "@oh-my-pi/cognitive-coordination";

// Load unified skills
const registry = new UnifiedSkillRegistry();
const skills = await registry.load(memoryRoot, evolutionRoot);

// Assemble context with token budget
const context = assembleContext(skills, conventions, { maxTokens: 2000 });

// Mine conventions from session log
const conventions = await mineImplicitConventions(sessionLogPath);

// Analyze activity trends
const report = await analyzeActivityTrends(activityLogPath);

// Validate a skill against session content
const result = validateSkill(skill, logContent);
```

## Testing

```bash
bun test packages/cognitive-coordination/src/
```

**29 tests** covering registry merging, context trimming, trend analysis, sandbox validation, and convention mining.

## Related

- [`@oh-my-pi/self-evolution`](../self-evolution/) — Extension factory, storage, lifecycle hooks
- [`l4-evolution-architecture.md`](../../l4-evolution-architecture.md) — Architecture design
