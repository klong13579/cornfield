---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
---

First, identify the user's intent type from context:

- **user** — acquiring user profile, preferences, or constraints (e.g. first-time setup, persona building)
  → Read `skill://grilling/grilling-template.md` and follow its dimension checklist in order.

- **task** — clarifying a specific task's requirements, scope, or approach before or during execution
  → Analyze the current task. Identify ambiguous points, unresolved decisions, and unstated assumptions. Do NOT load a fixed template — generate questions dynamically from the task context.

- **design** — stress-testing a plan or design before implementation
  → Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

For all intent types:
- Provide your recommended answer for each question.
- Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.
- If a question can be answered by exploring the codebase, explore the codebase instead.
