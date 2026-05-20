# System Diagnosis

Generated: 2026-05-20T08:25:11.949Z

Consolidated health snapshot from evolution DB (audit, per-session diagnoses, stuck patterns).
Regenerated after each archived session and via `/evolution audit`.

---

# Self-Evolution Audit Report
Generated: 2026-05-20T08:25:11.948Z

## Episodes
- Total: 24 / 500 max
- Success rate: 33%
- Avg tool calls: 9.5
- Avg errors: 1.0

## Skills
- Total: 18 (12 deprecated)
- Names: omp-thingking, system-reminder-you-stopped-without-ca, background-conte, omp-api-key, omp-zshrc-alibaba-codin, dws, hermes-agent-agent-agent, hermes-agent, daemon, bunfs-root-omp, scheduler, 5, ask-llm, job-openclaw, skill-quality-guidelines, boundary-condition-testing, skill-writing, skill-file-quality
- Quality scores: 78, 65, 65, 100, 100, 0, 100, 93, 100, 100, 93, 68, 100, 100, 60, 60, 60, 60

## Effectiveness
- Episodes tracked: 16
- Injections: 82
- Helped: 23
- Help rate: 28%
- Skills tracked: 17

## Nudges
- Total recorded: 29
- Injected into context: 29
- Outcomes scored: 28
- Help rate: 57%
- Pattern repeat rate: 39%

## Intents
- exploration: 9 (avg confidence: 87.2)
- bugfix: 9 (avg confidence: 70.0)
- feature-add: 3 (avg confidence: 76.7)
- testing: 1 (avg confidence: 45.0)
- configuration: 1 (avg confidence: 95.0)

## Workflow Patterns
- Total: 9
- Meaningful (≥2 occurrences): 1

## Conventions (legacy)
- Total: 0

## Learnings (V3)
- Total: 22
- Active: 20 | Pinned (manual): 20
- Injection stats: helped 16 / injected 248
  - active: 20
  - candidate: 2

## Profile
- Sessions: 6
- Avg tool errors/session: 0.2
- Top intent: exploration

## Escalations (stuck patterns)
- Open: 1 / 1 total
  - esc_1rvxn9v62gx4t [acknowledged] task (3x)

## Regression replay
- Backend: heuristic
- Session traces: 11
- Regression fixtures: 21
- Trials: keep 0, discard 0, pending 0
  - conventions: keep 0, discard 0
  - skills: keep 0, discard 0
  - by backend: heuristic 0, llm 0, subagent 0
  - tool-chain tags: overturn 0, confirm 0, only 0

## Benefit admission (reject / deprecate)
- Learnings: active 20, candidate 2, archived 0
- Skills deprecated: 12
- Nudges dismissed: 1, acknowledged: 0

## Issues Found
- Low session success rate: 33%.
- Episode injection help rate is 28% — more than half of injections are not helping.
- 1 evolution deadlock(s) need human review — automatic fixes did not stabilize recurring errors.

## Recommendations
- Review error patterns and consider extracting recovery skills.
- Consider disabling prompt injection (--no-self-evolution-enable-prompt-injection) or tuning retrieval.
- 21 regression fixture(s) exist but no trials recorded — run sessions or /evolution backfill-traces, then refresh admission.
- 12 skill(s) deprecated by benefit admission — run /evolution skills to confirm.
- Run /evolution stuck to acknowledge or resolve; add a manual convention after you fix the root cause.


---

## Recent session diagnoses

### 019e4479-55c0-7000-933f-ec76b3db6347-1779265329822
- Recorded: 2026-05-20T08:23:03.009Z
- Dominant error tool: task
- Dominant error pattern: 401 Invalid API-key provided. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error
- Tool efficiency: 1.00
- Redundant searches: yes
- Slow loop: yes
- Suggested action: Fix the invalid API key for the Bailian (aliyun) model provider before retrying any task agent calls.

### 019e447a-8115-7000-883e-3e062b023e9b-1779265342772
- Recorded: 2026-05-20T08:22:23.202Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e447a-8113-7000-a76c-b23cf698f8bb-1779265342688
- Recorded: 2026-05-20T08:22:22.998Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e447a-8115-7000-883e-3e062b023e9b-1779265341564
- Recorded: 2026-05-20T08:22:21.905Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e447a-8113-7000-a76c-b23cf698f8bb-1779265341424
- Recorded: 2026-05-20T08:22:21.767Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e447a-8115-7000-883e-3e062b023e9b-1779265340281
- Recorded: 2026-05-20T08:22:20.707Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e447a-8113-7000-a76c-b23cf698f8bb-1779265340243
- Recorded: 2026-05-20T08:22:20.536Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e417b-16a8-7000-a759-a9011e2690ca-1779215046312
- Recorded: 2026-05-19T18:26:33.169Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: yes
- Slow loop: yes
- Suggested action: No significant issues detected.

### 019e417b-16a8-7000-a759-a9011e2690ca-1779215047244
- Recorded: 2026-05-19T18:24:29.322Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: yes
- Slow loop: yes
- Suggested action: No significant issues detected.

### 019e40f9-3f78-7000-b90d-cbd5745ba2b4-1779206540358
- Recorded: 2026-05-19T16:02:20.781Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e40f9-3f78-7000-b90d-cbd5745ba2b4-1779206539187
- Recorded: 2026-05-19T16:02:19.618Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e40f9-3f78-7000-b90d-cbd5745ba2b4-1779206537879
- Recorded: 2026-05-19T16:02:18.473Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

### 019e4066-135d-7000-a6e0-e9457a3c58de-1779196891997
- Recorded: 2026-05-19T13:28:26.298Z
- Dominant error tool: read
- Dominant error pattern: [{"type":"text","text":"Path 'packages/self-evolution/src/ev
- Tool efficiency: 1.00
- Redundant searches: yes
- Slow loop: yes
- Suggested action: No significant issues detected.
- Read failures: 1
- Cascade patterns: 1

### 019e4066-135d-7000-a6e0-e9457a3c58de-1779196908792
- Recorded: 2026-05-19T13:22:42.513Z
- Dominant error tool: read
- Dominant error pattern: {"content":[{"type":"text","text":"Path 'packages/self-evolu
- Tool efficiency: 1.00
- Redundant searches: yes
- Slow loop: yes
- Suggested action: No significant issues detected.
- Read failures: 1
- Cascade patterns: 1

### 019e4061-6bdd-7000-a2d7-436749040700-1779196589625
- Recorded: 2026-05-19T13:16:30.084Z
- Dominant error tool: —
- Dominant error pattern: —
- Tool efficiency: 1.00
- Redundant searches: no
- Slow loop: no
- Suggested action: No significant issues detected.

---

## Open escalations (stuck patterns)

### esc_1rvxn9v62gx4t [acknowledged]
- Pattern: task
- Occurrences: 3
- Failed auto-improvements: 0
- Recurring error pattern (3 failed sessions): task
- Automatic evolution has not produced an active learning fix. Review with /evolution stuck, adjust environment, or pin a learning via /evolution learnings pin.
