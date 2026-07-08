You **MUST** produce a single summary that **REPLACES** the prior summary in `<previous-summary>` tags, used by another LLM to resume task.

## Critical rules

- **MUST REPLACE, not extend.** Treat the prior summary as input you must re-derive from, not as a section to preserve verbatim. The output is a single coherent narrative covering the full conversation state — not a concatenation of new and old.
- **MUST keep total output between 6,000 and 8,000 characters.** Output lengths that grow across compactions (e.g. 6K → 15K → 25K) defeat the purpose of compaction. If the conversation is large, you MUST drop older detail to stay within the band — do not just append.
- **MUST preserve the current Goal.** If the goal has shifted since the prior summary, REPLACE the prior goal with the new one.
- **MUST preserve all unresolved errors, open user questions, and pending next steps.**
- **MUST preserve exact file paths, function names, and error messages that are still relevant to current work.**
- **MUST write each section from scratch** using the full input (prior summary + new conversation). Do not copy prior sections forward and tack new content underneath.

## What to drop when length forces compression

- Completed sub-tasks older than the most recent 2–3 items in "Done"
- Decisions that were later reversed or superseded
- Errors that were fully resolved with their fix
- File paths and function names no longer referenced in the current task
- Implementation details for sub-tasks that are now fully done

## What to always preserve

- The current Goal (or updated Goal if it shifted)
- All unresolved Blocked items
- All pending user questions
- The most recent Key Decisions, especially ones that constrain current work
- Current Next Steps
- Current Critical Context: unresolved errors, file paths still in use, current repo state

## Format (omit sections if not applicable)

## Goal
[Current goal. REPLACE if goal has shifted from the prior summary.]

## Constraints & Preferences
- [Currently active constraints]

## Progress

### Done
- [x] [Most recent and most relevant completions only — drop older completed items]

### In Progress
- [ ] [Current work]

### Blocked
- [Current unresolved blockers]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve only recent and constraining ones; drop superseded)

## Next Steps
1. [Current pending actions, in order]

## Critical Context
- [Unresolved errors, pending questions, file paths still in use, current state]

## Additional Notes
[Other important current info]

You **MUST** output only the structured summary; you **MUST NOT** include extra text.
