# @oh-my-pi/self-evolution

> L4 Metacognitive Evolution Engine — Project Synapse

The self-evolution package transforms the agent from a passive executor into an adaptive, self-improving system. It extracts skills and learnings from sessions, tracks effectiveness, and continuously refines its behavior through a closed-loop evolution cycle.

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
    │  │Learning  │ │ User     │ │ Trace    │ │
    │  │Extractor │ │ Profiler │ │ Analyzer │ │
    │  └──────────┘ └──────────┘ └──────────┘ │
    └──────────────────┬──────────────────────┘
                       │
    ┌──────────────────▼──────────────────────┐
    │          Storage Layer (SQLite)          │
    │  skills · learnings · episodes · fit   │
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

### Context-Aware Retrieval
- **Intent-filtered** episode retrieval
- **Skill relevance scoring** against current task
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

**Default (per project):** all evolution + memory state lives under `<project-root>/.omp/`. Session JSONL remains in `~/.omp/agent/sessions/`; credentials stay in `~/.omp/agent/agent.db` (not mixed with evolution data).

### Layout

```
<repo>/.omp/
├── memory/                    # Memory pipeline artifacts
│   ├── MEMORY.md
│   ├── memory_summary.md
│   ├── raw_memories.md
│   └── rollout_summaries/
├── evolution/
│   ├── evolution.db           # SQLite (evolution + memory tables)
│   ├── system-diagnosis.md
│   ├── user_profile.md
│   ├── activity.log
│   └── evolution_log.md
└── skills/                    # Exported skill markdown (*.md)
```

### SQLite (`<repo>/.omp/evolution/evolution.db`)

| Table | Purpose |
|---|---|
| `episodes` | Archived session summaries |
| `session_traces` | Full traces for regression replay |
| `learnings` | Session-derived rules and preferences (V3, replaces conventions) |
| `skills` | Evolved skills with quality scores, usage stats |
| `skill_versions` | Version snapshots for rollback |
| `threads` | Memory: session rollout index |
| `stage1_outputs` | Memory: per-thread Stage 1 output |
| `jobs` | Memory: stage1 / consolidate job queue |
| `vector_embeddings` | Memory: optional embedding store |
| `fit_scores` | 懂我程度 evaluation history |
| `episode_intents` | Intent classification per episode |
| `user_profiles` | User behavioral profiles |
| `workflow_patterns` | Mined tool call sequences |
| `episode_effectiveness` | Episode injection tracking |
| `skill_effectiveness` | Skill injection tracking |
| `nudge_history` | Cross-session nudge records |
| `stats` | System counters |

**Default (global user store)**: `~/.omp/self-evolution/` — memory under `~/.omp/self-evolution/memory/--encoded-cwd--/`. **Per-project layout** (opt-in `--self-evolution-project-store`): `<cwd>/.omp/evolution/{memory,skills,evolution.db}`. To copy global-store data into a repo tree, run `packages/self-evolution/scripts/migrate-evolution-data.sh <repo>`.

### Migrating from older installs

```bash
# FS copy + agent.db memory rows → project evolution.db
bash packages/self-evolution/scripts/migrate-evolution-data.sh /path/to/repo

# Re-archive sessions from ~/.omp/agent/sessions/*.jsonl
bun packages/self-evolution/scripts/backfill-episodes-from-sessions.ts --cwd /path/to/repo --per-project
```

## CLI Commands

```
/evolution status              Show statistics (episodes, skills, versions)
/evolution skills [--detail]   List evolved skills with score breakdown
/evolution rate <name> <1-5>   Rate a skill
/evolution clear               Delete project .omp/memory, evolution, skills (after confirm)
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
| `--self-evolution-global-store` | `true` | Global user store: `~/.omp/self-evolution` + encoded agent memories (default) |
| `--self-evolution-project-store` | `false` | Per-project `<cwd>/.omp/memory`, `evolution`, `skills` |

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
- Unit tests (assembler, registry, sandbox, activity monitor)
- Integration tests (watcher debounce, sync lifecycle, pruning)
- E2E tests (full evolution loop, self-modification)
- Safety tests (auto-rollback, score clamping)

## Related

- [`@oh-my-pi/cognitive-coordination`](../cognitive-coordination/) — Unified skill registry, context assembler
- [`l4-evolution-architecture.md`](../../l4-evolution-architecture.md) — Full architecture design document
