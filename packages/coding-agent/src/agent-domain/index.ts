/**
 * Agent-first domain contract (WP1).
 *
 * Public surface:
 *   - `./types` — vocabulary, authorities, read models, Session Todo re-exports.
 *   - `./relations` — relation invariants and their validators.
 *   - `./profile-registry` — read the existing registry/declaration authorities and
 *     resolve an Agent binding (identity + home).
 *
 * Nothing here stores, migrates or owns a runtime; see the module docs in
 * `./types` for the WP1 gate and `docs/proma-comparison/wp1-agent-domain-contract.md`
 * for the reviewable contract. `./profile-registry` reads the two existing stores and
 * writes neither.
 */

export * from "./profile-registry";
export * from "./relations";
export * from "./types";
