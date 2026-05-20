---
name: "boundary-condition-testing"
version: "1"
source: "memory"
status: "experimental"
confidence_score: 0.6
last_used_at: "2026-05-19T13:22:36.277Z"
description: "Apply # Boundary Condition Testing Skill"
---

# Boundary Condition Testing Skill

## Task Pattern
When asked to write test cases, design test scenarios, or verify code correctness.

## Approach
1. Identify all input domains: length, numeric range, collection size, state transitions, timing, resource limits.
2. Apply boundary value analysis: min, min+1, nominal, max-1, max, off-by-one.
3. Apply equivalence partitioning with edge representative selection.
4. Cover domain-specific boundaries:
   - Strings: empty, single char, max length, Unicode.
   - Collections: empty, large, duplicate, sparse.
   - State machines: init→ready→active→error→terminated.
   - API: auth, rate-limit, payload size, timeout.
   - Error paths: malformed, partial, duplicate, concurrent.
5. Verify each boundary is covered — not just the happy path.

## Pitfalls
- Happy path only
- Missing null/empty
- Missing max/large values
- Missing duplicate handling
- Missing concurrent access
- Missing timing/race conditions
- Missing state transitions
- Missing truncation/overflow
- Missing idempotency
- Missing default values
- Missing auth/permissions
- Missing resource limits

## Anti-patterns

- Do not apply outside the triggers described above.

