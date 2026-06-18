/**
 * Public API for the agentDir skeleton module.
 *
 * Consumed by:
 *   - `pi-gateway` (account install, gateway startup)
 *   - `omp agent init` (future CLI per design §6.2)
 *
 * Asset content lives in `./assets/*.md` etc. and is statically imported via Bun —
 * do not read those files at runtime.
 */

export { SKELETON_FILES, type SkeletonFile } from "./assets";
export { SKELETON_DIRS } from "./dirs";
export { ensureAgentDir } from "./ensure";
export { resolveAgentDir } from "./resolve";
export { buildAgentSessionPath } from "./session";
