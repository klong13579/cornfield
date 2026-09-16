/**
 * Orchestration Record kernel — public surface.
 *
 *   - `./types` — the vocabulary: a unit, a record, the plan, violations, and the *derived*
 *     Main Worker status.
 *   - `./state-machine` — the one transition table and its guards.
 *   - `./events` — append-only event contracts.
 *   - `./store` — the ledger and its durable store.
 *   - `./main-worker` — the orchestrator: plan, verbs, acceptance, and the two result facts.
 *
 * Nothing here schedules, spawns, or owns a runtime; see `./types` for the module boundary
 * and `docs/proma-comparison/orchestration-record-contract.md` for the contract. The boundary
 * is enforced, not just documented: `test/task-control/kernel-boundary.test.ts` fails if a
 * strategy word, a process-spawning import, or an unexpected export appears.
 */

export * from "./events";
export * from "./main-worker";
export * from "./state-machine";
export * from "./store";
export * from "./types";
