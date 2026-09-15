/**
 * Agent-first domain contract (WP1).
 *
 * Public surface:
 *   - `./types` — vocabulary, authorities, read models, Session Todo re-exports.
 *   - `./relations` — relation invariants and their validators.
 *
 * Nothing here stores, migrates or runs anything; see the module docs in
 * `./types` for the WP1 gate and `docs/proma-comparison/wp1-agent-domain-contract.md`
 * for the reviewable contract.
 */

export * from "./relations";
export * from "./types";
