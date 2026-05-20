---
name: "skill-quality-guidelines"
version: "1"
source: "memory"
status: "active"
confidence_score: 0.6
last_used_at: "2026-05-19T13:22:36.277Z"
description: "Apply # Skill Quality Guidelines"
---

# Skill Quality Guidelines

## Description Rules
- Starts with an action verb.
- ≤120 characters, standalone readable, includes trigger keywords.
- Must not contain "Extracted from session" or raw user message excerpts.

## Body Rules
- Only include executable decision logic — content the agent would use to change behavior.
- Organize as decision tree: identify condition → options → steps → counterexamples.
- No standalone tool sequences, file paths, scoring tables, or population lifecycle blocks.
- Body ≤200 lines, each section 3-8 bullets.
- Prohibit "Extracted from session" and any session-specific audit trail.

## Quality Criteria
- High quality: approachSubstance ≥8, pitfallCoverage ≥10, toolDiversity ≥10, autonomy ≥10.
- Low quality (discard): empty body, body only tool sequences, description verbatim user message, duplicate content >60% with existing skills or AGENTS.md.

## Validation JSON Checklist (for self-evolution auto-filter)
- **must_pass**: description action verb, body conditional structure, no standalone tool sequences, no file paths, at least one counterexample/limitation, body ≤200 lines.
- **should_pass**: bullet hierarchy, trigger keywords in description, decision table, body ≥15 lines.
- **must_fail**: empty body/only tool sequence, verbatim user description, >60% duplicate.

## Durability
- Skill files must be decision-oriented, not historical logs. A good skill changes agent behavior when read.
- The template is authoritative for all new skill generation in the self-evolution system.
- Apply the validation checklist to filter low-quality candidates.

## Anti-patterns

- Do not apply outside the triggers described above.

