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
  → Map this as a **design tree**: every decision branches into the decisions that hang off it. Work the tree in **rounds**: the **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Within a round, ask the frontier one question at a time, in dependency order, waiting for the answer to each before the next. Each settled answer reshapes the tree: recompute the frontier and begin the next round. A question whose answer depends on another still-open question belongs to a _later_ round, not this one. The session is done when the frontier is empty — every branch of the design tree visited, nothing left silently assumed.

For all intent types:
- Provide your recommended answer for each question.
- Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.
- Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), look it up or dispatch a sub-agent — don't ask the user for anything you could find yourself. Don't block the rest of the round on it: only the questions downstream of the running exploration wait; ask the rest now.
- The _decisions_ are the user's: put each one to them and wait.
- Do not act on the plan until the user confirms you have reached a shared understanding.