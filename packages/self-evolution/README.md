# @oh-my-pi/self-evolution

> L4 Metacognitive Evolution Engine — Project Synapse

The self-evolution package transforms the agent from a passive executor into an adaptive, self-improving system. It extracts skills from sessions, mines conventions from user feedback, tracks effectiveness, and continuously refines its behavior through a closed-loop evolution cycle.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Session                         │
└────────┬──────────────────────────────┬──────────────────┘
         │                              │
    ┌────▼─────┐                  ┌─────▼─────┐
    │ Trace    │                  │ Activity  │
    │ Recorder │                  │ Logger    │
    └────┬─────┘                  └─────┬─────┘
         │                              │
    ┌────▼──────────────────────────────▼─────┐
    │          Processing Engine               │
    │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
    │  │ Skill    │ │Intent    │ │ Workflow │ │
    │  │Extractor │ │Classifier│ │ Miner    │ │
    │  └──────────┘ └──────────┘ └──────────┘ │
    │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
    │  │Convention│ │ User     │ │ Trace    │ │
    │  │Extractor │ │ Profiler │ │ Analyzer │ │
    │  └──────────┘ └──────────┘ └──────────┘ │
    └──────────────────┬──────────────────────┘
                       │
    ┌──────────────────▼──────────────────────┐
    │          Storage Layer (SQLite)          │
    │  skills · episodes · conventions · fit   │
    │  intents · profiles · workflows · nudges │
    └──────────────────┬──────────────────────┘
                       │
    ┌──────────────────▼──────────────────────┐
    │          Feedback & Pruning              │
    │  Sandbox Validation → Score Update      │
    │  → Deprecation → Auto-Rollback           │
    └─────────────────────────────────────────┘
```

## Features

### Skill Extraction & Evolution
- **Automatic extraction** when session complexity exceeds threshold
- **LLM refinement** of rule-extracted skills
- **Version tracking** with rollback capability
- **Quality scoring** based on success rate, tool diversity, pitfall coverage
- **User rating** (1-5 stars) that influences quality score

### Convention Mining
- **Implicit convention extraction** from session logs — detects negative user instructions ("don't use X", "never do Y")
- **False positive filtering** — ignores common phrases like "don't worry", "never mind"
- **Confidence-weighted** rules based on keyword strength
- **Cross-session persistence** via `conventions.jsonl`

### Context-Aware Retrieval
- **Intent-filtered** episode retrieval
- **Skill relevance scoring** against current task
- **Convention compliance** checking
- **Token-bounded** injection via Context Assembler

### Fit Evaluation (懂我程度)
- **5-dimension scoring**: Memory, Thinking, Style, Prediction, History
- **Heuristic + LLM judge** modes
- **Trend tracking** with historical comparison
- **Scheduled auto-evaluation** every 3 days

### Activity Monitoring
- **JSONL activity log** for all system events
- **Skill decay detection** — identifies unused skills
- **Error rate tracking** per tool
- **Fit score trend analysis** with moving averages

### Self-Modification
- **File watcher** monitors `skills/*.md` for agent edits
- **Auto-sync** file changes back to SQLite (version +1)
- **Preserves statistics** (usage count, success rate) during edits
- **Debounce protection** against rapid writes

### Pruning & Rollback
- **Sandbox validation** tests skills against session logs
- **Score-based deprecation** — skills below threshold are marked
- **Usage-count protection** — frequently-used skills resist pruning
- **Autonomy notes** track why changes were made

## Storage

### SQLite Database (`~/.omp/self-evolution/evolution.db`)

| Table | Purpose |
|---|---|
| `skills` | Evolved skills with quality scores, usage stats |
| `skill_versions` | Version snapshots for rollback |
| `episodes` | Archived session summaries |
| `conventions` | Mined rules from user feedback |
| `fit_scores` | 懂我程度 evaluation history |
| `intents` | Episode intent classifications |
| `profiles` | User behavioral profiles |
| `workflow_patterns` | Mined tool call sequences |
| `effectiveness` | Episode/skill injection tracking |
| `nudge_history` | Cross-session nudge records |
| `stats` | System counters |

### File System (`~/.omp/self-evolution/`)

```
self-evolution/
├── evolution.db          # SQLite database
├── skills/               # Markdown skill files (agent-editable)
│   ├── git-workflow.md
│   └── python-debugging.md
├── conventions.jsonl     # Mined implicit conventions
└── activity.jsonl        # System activity log
```

## CLI Commands

```
/evolution status              Show statistics (episodes, skills, versions)
/evolution skills [--detail]   List evolved skills with score breakdown
/evolution rate <name> <1-5>   Rate a skill
/evolution clear               Clear all self-evolution data
/evolution archive             Archive low-quality skills
/evolution history <name>      View version history for a skill
/evolution rollback <n> <v>    Rollback a skill to a version
/evolution profile             Display user behavioral profile
/evolution workflows [intent]  List mined workflow patterns
/evolution audit               Generate health report
/evolution report              Generate daily report
/evolution fit                 Run '懂我程度' evaluation
```

## Configuration

Flags passed via CLI or config:

| Flag | Default | Description |
|---|---|---|
| `--self-evolution` | `true` | Enable/disable the plugin |
| `--self-evolution-skill-threshold` | `5` | Min tool calls to trigger extraction |
| `--self-evolution-max-episodes` | `500` | Max episodes to retain |
| `--self-evolution-enable-prompt-injection` | `true` | Inject past experiences |
| `--self-evolution-llm-refinement` | `true` | Use LLM to refine skills |
| `--self-evolution-llm-rerank` | `true` | Use LLM to rerank episodes |
| `--self-evolution-enable-versioning` | `true` | Enable skill version snapshots |
| `--self-evolution-enable-activity-log` | `true` | Enable JSONL activity logging |
| `--self-evolution-global-store` | `true` | Shared store across projects |

## API

```typescript
import { createSelfEvolutionExtension } from "@oh-my-pi/self-evolution";

// Register as an extension
session.registerExtension(createSelfEvolutionExtension({ settings, agentDir }));
```

## Testing

```bash
# Run all self-evolution tests
bun test packages/self-evolution/src/

# Run cognitive-coordination tests
bun test packages/cognitive-coordination/src/

# Run both
bun test packages/cognitive-coordination/src/ packages/self-evolution/src/
```

**Test coverage**: 66 tests across 10 files covering:
- Unit tests (assembler, registry, sandbox, activity monitor, convention miner)
- Integration tests (watcher debounce, sync lifecycle, pruning)
- E2E tests (full evolution loop, self-modification)
- AB tests (convention injection effectiveness)
- Safety tests (auto-rollback, score clamping)

## Related

- [`@oh-my-pi/cognitive-coordination`](../cognitive-coordination/) — Unified skill registry, context assembler, convention miner
- [`l4-evolution-architecture.md`](../../l4-evolution-architecture.md) — Full architecture design document
