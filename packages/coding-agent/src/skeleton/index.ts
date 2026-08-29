/**
 * Public API for the agentDir skeleton module.
 *
 * Consumed by:
 *   - `cornfield-gateway` (account install, gateway startup)
 *   - `omp agent init` (future CLI per design §6.2)
 *
 * Asset content lives in `./assets/*.md` etc. and is statically imported via Bun —
 * do not read those files at runtime.
 */

export { SKELETON_FILES, type SkeletonFile } from "./assets";
export { SKELETON_DIRS } from "./dirs";
export { ensureAgentDir, reconcileSkeletonFiles } from "./ensure";
export {
	type AgentEntry,
	findAgent,
	findStaleEntries,
	listRegistered,
	loadRegistry,
	pruneStaleEntries,
	REGISTRY_FILE_PATH,
	type Registry,
	registerAgent,
	saveRegistry,
	unregisterAgent,
} from "./registry";
export { resolveAgentDir } from "./resolve";
export { buildAgentSessionPath } from "./session";
export {
	ensureWorkspace,
	loadWorkspace,
	WORKSPACE_SCHEMA_VERSION,
	type WorkspaceDeclaration,
	type WorkspaceKnowledgePaths,
	workspaceFilePath,
} from "./workspace";
