# Raw Memories

## 019e3cb8-d010-7000-8531-e026b56366e6
updated_at: 1779135216
No significant signals extracted.

## 019e3cad-3e2e-7000-947e-3a0012167f07
updated_at: 1779134834
No significant signals extracted.

## 019e3c94-56b6-7000-b2b8-4184f0f90157
updated_at: 1779132977
No significant signals extracted.

## 019e3c81-98b9-7000-a16b-2d0f04b80021
updated_at: 1779132218
No significant signals extracted.

## 019e3c7a-1f76-7000-9d02-d4f338eded87
updated_at: 1779131554
No significant signals extracted.

## 019e3baa-05d3-7000-a0ac-31bd532dd63d
updated_at: 1779117546
No significant signals extracted.

## 019e3b4e-e12b-7000-a9c6-8a050f8562d6
updated_at: 1779111508
No significant signals extracted.

## 019e3b4c-f142-7000-8f77-5765dc568abf
updated_at: 1779111369
No significant signals extracted.

## 019e3aed-f927-7000-a6ad-aa65c415e1de
updated_at: 1779110917
No significant signals extracted.

## 019e3b11-3a33-7000-a077-b706c24d41f8
updated_at: 1779107630
## Diagnostic Session on Skill File Quality

### What Happened
User asked to examine skill markdown files in ~/.omp/ and diagnose if they are well-described. Assistant read self-evolution skills, agent skills, and memory-inferred skills (e.g., boundary-condition-testing.md, omp.md, omp-root-cause.md, reading.md, session-read.md, log.md, omp-evolution.md, omp-userpersona.md, task-mp8vukjv.md, dws.md, skill-dws.md, and agent/memories skills). Identified recurring quality defects:
- Body content contained raw tool sequences (e.g., "Tool sequence: search → read → edit") instead of decision logic
- Description strings were extracted from session excerpts (e.g., "Extracted from session ...: 修复")
- File paths and session-specific references were mixed into skill body
- Scoring tables and population lifecycle metadata were duplicated in content (managed by DB)
- Lack of conditional structures, counterexamples, and actionable rules

### Action Taken
Created a comprehensive reference template at ~/.omp/[REDACTED].md. The template establishes:

**Description Rules**
- Starts with an action verb
- ≤120 characters, standalone readable, includes trigger keywords
- Must not contain "Extracted from session" or raw user message excerpts

**Body Rules**
- Only include executable decision logic — content the agent would use to change behavior
- Organize as decision tree: identify condition → options → steps → counterexamples
- No standalone tool sequences, file paths, scoring tables, population lifecycle blocks
- Body ≤200 lines, each section 3-8 bullets
- Prohibit "Extracted from session" and any session-specific audit trail

**Quality Criteria**
- High quality: approachSubstance ≥8, pitfallCoverage ≥10, toolDiversity ≥10, autonomy ≥10
- Low quality (discard): empty body, body only tool sequences, description verbatim user message, duplicate content >60% with existing skills or AGENTS.md

**Validation JSON Checklist** (for self-evolution system to auto-filter)
- must_pass: description action verb, body conditional structure, no standalone tool sequences, no file paths, at least one counterexample/limitation, body ≤200 lines
- should_pass: bullet hierarchy, trigger keywords in description, decision table, body ≥15 lines
- must_fail: empty body/only tool sequence, verbatim user description, >60% duplicate

### Durable Learnings
1. Skill files must be decision-oriented, not historical logs. A good skill changes agent behavior when read.
2. The template is now the authoritative reference for all new skill generation in the self-evolution system.
3. When evaluating existing skills, apply the validation checklist to filter low-quality candidates.
4. The template lives at ~/.omp/[REDACTED].md and should be referenced by generation and validation modules.

## 019e3b0e-76f6-7000-af39-aa45f062ecee
updated_at: 1779107279
No significant signals extracted.

## 019e34c1-4700-7000-9acd-d589aa3f15d9
updated_at: 1779001676
No significant signals extracted.

## 019e32b8-383f-7000-bc3c-a3322676f6c2
updated_at: 1778968388
No significant signals extracted.

## 019e32b1-e19b-7000-9d3c-ab642d9d1959
updated_at: 1778968278
- When user asks about identity ("你是谁", "who are you", "what can you do"), the assistant must invoke `identity` with `action: "whoRu"`.
- The system prompt is built at session initialization from markdown templates in `packages/coding-agent/src/prompts/` (system-prompt.md, identity.md, user-persona-awareness.md, etc.). The `rebuildSystemPrompt` function in `sdk.ts` reads settings, MCP server instructions, memory instructions, and passes them to `buildSystemPromptInternal` in `system-prompt.ts`, which compiles the template.
- User persona awareness implementation plan: (1) Create `user-persona-awareness.md` prompt file that instructs the agent to maintain user persona, extract info during conversation, and use `identity update_persona` tool. (2) Modify `system-prompt.md` to include a `{{userPersonaBlock}}` placeholder. (3) Modify `system-prompt.ts` to accept `userPersona` in options and pass it to the template. (4) Modify `sdk.ts` to read persona from storage (via `buildMemoryToolDeveloperInstructions` or similar) and pass it during system prompt rebuild. (5) Update `identity.md` tool prompt to add `auto_extract` action for automatic persona extraction.
- Key constraint: System prompt is built once at session start. If persona is updated mid-conversation (e.g., via `update_persona` or `auto_extract`), the system prompt won't reflect the change until the next rebuild (which occurs when tool names change). The implementation should handle this by perhaps updating the prompt immediately or accepting the delay.
- The `identity` tool supports actions: `whoRu`, `update_persona`. The new `auto_extract` action (to be added) would automatically extract persona information from user messages.
- The codebase structure: `packages/coding-agent/src/sdk.ts` contains `rebuildSystemPrompt` which calls `buildSystemPromptInternal` from `system-prompt.ts`. The latter uses a prompt template system (likely handlebars or similar) to render the system prompt with variables.
- Settings model: `settings.get('tools.intentTracing')` or `$flag('PI_INTENT_TRACING')` controls intent field. `settings.get('task.eager')` controls eager tasks. The persona system should follow similar patterns.
- Memory instructions are built via `buildMemoryToolDeveloperInstructions(agentDir, settings)` from a separate module.
- The system prompt includes MCP server instructions with a limit of 4000 characters per server.

## 019e32a9-b37b-7000-99b7-094959a1d154
updated_at: 1778967092
## Boundary Condition Testing Made Automatic

### Change Made
- **File**: packages/coding-agent/src/prompts/system/system-prompt.md
- **Section**: `<design-checklist>` (lines 151-164)
- **Action**: Added boundary conditions item to the design checklist

### Exact Text Added
"Boundary conditions: when writing tests, enumerate input domains (numeric ranges, string lengths, null/empty, collections, enum values, special characters) and verify each boundary is covered — not just the happy path"

### Why This Approach
- The `test.md` agent prompt (packages/coding-agent/src/prompts/agents/test.md) already referenced `{{DESIGN_CHECKLIST}}` from system-prompt.md
- Adding the boundary condition guidance to the central checklist ensures all agents (test, designer, etc.) automatically consider it
- The dedicated skill file `boundary-condition-testing/SKILL.md` was expected at `~/.cursor/skills/superpowers/skills/boundary-condition-testing/SKILL.md` but did not exist — so the system prompt checklist was the most reliable integration point

### Relevant Files
- packages/coding-agent/src/prompts/system/system-prompt.md (design-checklist section, lines 151-164)
- packages/coding-agent/src/prompts/agents/test.md (references {{DESIGN_CHECKLIST}})
- packages/coding-agent/src/prompts/agents/task.md (also references design-checklist pattern)

### Future Considerations
- If the skill file is created later, it should stay consistent with this checklist item to avoid contradictions
- The design-checklist is evaluated before writing or refactoring, ensuring boundary thinking is applied to test generation, not just code review
- No ConventionExtractor or SessionLearner changes needed — this is a direct prompt embedding

## 019e3263-6266-7000-86f3-8873db7c9636
updated_at: 1778966627
No significant signals extracted.

## 019e32a7-1eae-7000-adca-d9983f34fb8b
updated_at: 1778966328
Durable rule: When designing test cases, omp MUST automatically consider and include boundary conditions (equivalence partitioning, edge cases, extreme values) for every input field or condition. This requirement is permanent and should be enforced without requiring the user to remind. If boundary conditions are omitted, it is a defect in the output. (Source: user message timestamp 1778966279411, thread 019e32a7-1eae-7000-adca-d9983f34fb8b)

## 019e328b-1785-7000-af4c-fc3600e60460
updated_at: 1778965676
## Boundary condition testing by default

### Request
User wants the coding-agent's test agent to automatically include boundary/edge conditions in test case design, without needing to be reminded each time.

### Context
- Thread ID: 019e328b-1785-7000-af4c-fc3600e60460
- Target: The test agent prompt at `packages/coding-agent/src/prompts/agents/test.md`
- The assistant searched this prompt and related review prompts to understand current behavior

### Implication
- The `test.md` prompt for the test agent should include explicit instructions to consider boundary conditions (e.g., empty inputs, max limits, invalid types, off-by-one, null/undefined, overflow/underflow) when generating test cases
- This should be baked into the prompt template, not left as a manual instruction per session

## 019e3299-6f71-7000-9e9a-a75a1a5e6d32
updated_at: 1778965467
## 用户明确偏好：测试用例设计默认包含边界条件

**时间**: 对话 019e3299-6f71-7000-9e9a-a75a1a5e6d32

**用户原话**: "我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒"

**含义**: 用户要求 coding-agent 在生成测试用例时，**自动**将边界条件（boundary conditions）作为测试设计的一部分，不需要用户每次主动提出。

**存储位置**: 
- 应作为 ``preference`` 类型或 ``positive_rule`` 类型存储在 conventions 中
- 来源为 ``user_stated``，confidence 应设为 90+（用户明确要求）
- 应在 coding-agent 的测试相关 prompt（packages/coding-agent/src/prompts/agents/test.md）中体现为默认行为

**内容模板**: "在设计测试用例时，必须自动考虑并包含边界条件（boundary conditions），不需要用户提醒。"

**触发场景**: 当 agent 被分配到测试用例设计任务时，本偏好应作为前提条件自动生效。

## 019e3270-b14b-7000-88ce-049b20aca568
updated_at: 1778965327
## OMP Skill System & Boundary Condition Testing Skill Creation

### Context
User requested that OMP automatically consider boundary conditions when designing test cases, without needing manual reminders.

### Skills System Architecture
- Skills are stored in `~/.omp/self-evolution/evolution.db` with two key tables:
  - `skills`: stores skill definitions (name, description, task_pattern, approach, tools, pitfalls, quality_score, version, deprecated flag, etc.)
  - `[REDACTED]`: manages lifecycle with fields (name, state, evolution_score, quality_metrics_json, etc.)
  - `[REDACTED]`: tracks version history with change_type (extracted, optimized, etc.)
- Skills go through lifecycle: candidate → graduated (when quality_score >= 90) → deprecated
- Graduated skills are injected into system prompts when task_pattern matches user request
- Task pattern matching determines when each skill auto-injects

### Skills Created/Updated

**1. boundary-condition-testing** (quality: 90, v2, graduated)
- taskPattern: "When asked to write test cases, design test scenarios, or verify code correctness"
- Approach covers complete boundary condition analysis:
  1. Identify input domains (length, numeric range, collection size, state transitions, timing, resource limits)
  2. Apply boundary value analysis (min, min+1, nominal, max-1, max, off-by-one)
  3. Apply equivalence partitioning with edge representative selection
  4. Domain-specific boundaries: strings (empty, single char, max length, Unicode), collections (empty, large, duplicate, sparse), state machines (init→ready→active→error→terminated), API (auth, rate-limit, payload size, timeout), error paths (malformed, partial, duplicate, concurrent)
- 12 pitfalls documented (happy path only, missing null/max/duplicate/concurrent/timing/state/truncation/idempotency default/auth/resource)

**2. omp** (quality: 75, v2, candidate)
- Updated approach to include explicit rule: "When designing test cases, include boundary condition analysis for each relevant input domain"

### Database Operations
- Created skill by INSERT into skills table with all fields
- Registered in [REDACTED] with evolution_score=90, state='graduated'
- Skill jumped from v1 (SQL default) to v2 due to optimized prompt from optimize_skill_prompt
- Version snapshot recorded in [REDACTED] with change_type='extracted'

### Failure/Success Pattern
- Initial INSERT failed due to missing tools/pitfalls fields in DB schema being NOT NULL (had defaults from code today)
- Must always include tools and pitfalls as JSON strings when inserting manually
- optimizse_skill_prompt tool can refine skill quality (jumped from 75→90 after optimization)

## 019e3276-bcc7-7000-80ea-e95f00de09dd
updated_at: 1778965047
No significant signals extracted.

## 019e3275-42b5-7000-bd79-881353df8af9
updated_at: 1778964262
Durable fact: omp's codebase does not record or display the duration of individual execution steps (tool calls, bash runs, etc.).
- Session entries have 'timestamp' (ISO string) but no 'duration' or 'elapsed' field.
- AgentEvent types 'tool_execution_start' and 'tool_execution_end' (packages/agent/src/types.ts) currently have no startTime/endTime fields.
- TUI renderers (renderCall/renderResult) in packages/coding-agent/src/tools/ only show pending/complete states, not elapsed times.
- Separate CPU profiling exists (packages/coding-agent/src/debug/profiler.ts) for performance reports, but is not step-level timing.
- Step timing can only be inferred indirectly by parsing ISO timestamps between consecutive session entries, which is unreliable.
- Implementation approach known: (1) add startTime/endTime to tool event types and agent-loop.ts, (2) persist to session JSONL, (3) render elapsed in TUI. This plan was described in detail but not executed.

## 019e326e-8d1d-7000-b70c-52b2e6f36e17
updated_at: 1778962665
No significant signals extracted.

## 019e3011-bbd9-7000-bd5f-b4b01507019d
updated_at: 1778962361
No significant signals extracted.

## 019e3055-1f87-7000-b451-52c6611e8202
updated_at: 1778961043
## OMP Evolution V3 Architecture

Evolution is **not** raw system prompt injection. It is a file-based multi-step pipeline:

1. **SessionLearner** extracts durable knowledge from conversation history (replaces old ConventionExtractor). Knowledge types: memory summary, conventions, user profile, episodic patterns.
2. **InjectionFormatter** merges all knowledge into a formatted injection block that is appended to the system prompt. It uses a **7-layer priority system** (architecture §7.5):
   - Layer weights: agents 0.02, memory 0.08, conventions 0.15, skills 0.30, profile 0.05, episodic 0.05, past_episodes 0.02, buffer 0.33
   - Dynamic token budgets per task type (bugfix, refactoring, feature-add, exploration, documentation)
3. **Skill system** delegates evolution to the coding agent via `delegate-to-skills` which triggers the full evolution lifecycle.

### File Storage
- Knowledge files stored in `.omp/self-evolution/`: `memory_summary.md`, `conventions.md`, `user_profile.md`, `evolution_log.md`
- Profiling cache stored in `.omp/cache/<session-id>/`
- `conventions.md` and `user_profile.md` are projected (regenerated) each session

### Lifecycle Hooks
- `before_agent_start`: loads profiling cache, loads memory, project conventions/user_profile/evolution_log, format injection block
- `agent_end`: run SessionLearner (episodic extraction), update memory/conventions/profile, trigger background LLM if configured, save profiling cache

### Key Contractor
- `InjectionFormatter` class: formats the injection block with layered content, supports `useSevenLayer` mode
- `SessionLearner`: extracts episodic memory, conventions, and user profile from conversation
- Evolution is stored in `SelfEvolutionArtifacts` and loaded by coding agent's identity system

### Known Bugs (not durable unless user confirms rule)
- `errorPatternExtractor is not defined` on agent_end
- `SQLiteError: fts5: syntax error near "."` on before_agent_start (FTS5 query parsing issue)
- Background LLM skipped when no model available (not an error, expected)

### Usage Pattern
- Evolution is **always active** but controlled by configuration (SelfEvolutionConfig)
- Cross-session nudges (e.g., high error rate) are suppressed by a feedback loop
- No conventions.md or memory_summary.md are created until evolution runs at least once

## 019e3035-a823-7000-a030-e64ef9279b1f
updated_at: 1778960962
No significant signals extracted.

## 019e3087-d25e-7000-8325-85f39dd9fc13
updated_at: 1778930714
No significant signals extracted.

## 019e3086-3583-7000-883c-a0b4fbdb5b61
updated_at: 1778930604
No significant signals extracted.

## 019e3084-780f-7000-bf9f-c09c79b2a546
updated_at: 1778930481
No significant signals extracted.

## 019e307f-7c74-7000-a645-4a96c2d745f4
updated_at: 1778930159
No significant signals extracted.

## 019e307e-22c7-7000-a28d-3b1eb46fbe34
updated_at: 1778930048
No significant signals extracted.

## 019e304b-996e-7000-9d1b-530c9b8c1e80
updated_at: 1778929996
## Memory: File read tool cache analysis

**Context:** Investigation into slow tool execution in OMP recent sessions, specifically whether cache issues are the cause.

**Conclusion:** The `read` tool is the main bottleneck (file reading), but adding a file read cache is not recommended due to numerous risks:

- **External modification blind spot:** Invalidation only works for OMP's own write/edit tools. External changes (vim, git checkout, npm install, etc.) would return stale content.
- **Line-range query still requires full I/O:** The `sel` parameter forces reading the whole file via `streamLinesFromFile` anyway. Caching partial ranges doesn't save disk I/O.
- **Display mode sensitivity:** `hashline` vs `line-number` display mode can change mid-session, causing cache key mismatch or returning wrong formatted content.
- **Silent errors on deleted files:** Cache lookup may skip `fs.stat` existence check, returning old content for deleted files.
- **Session-scoped cache waste:** Each session instantiates a new `ReadTool` instance with its own cache Map, so cross-session reuse is zero.
- **No caching for converted documents (markit):** `.pdf`, `.docx`, `.xlsx`, `.ipynb` files converted via Markit cannot be cached due to potentially dynamic data.
- **Symlink target change not detected:** Symlink resolution caches absolute path but file could change under same path.

**Real root cause:** LLM TTFT (time to first token) median ~4.8s dominates tool execution time. Disk I/O overhead is negligible (~500ms/day). The better optimization is to **prevent the agent from re-reading the same file in consecutive turns** via prompt constraints or tool result markers (e.g., note 'previously read'), not a cache layer.

## 019e3077-cfce-7000-82f1-bc76db829a18
updated_at: 1778929695
No significant signals extracted.

## 019e2fac-7055-7000-929c-95d2d196bc9b
updated_at: 1778916419
No significant signals extracted.
