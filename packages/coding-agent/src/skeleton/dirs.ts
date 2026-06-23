/**
 * Directories the agentDir skeleton creates.
 *
 * Each entry gets a `.gitkeep` stub (empty file) so git tracks the otherwise-empty directory.
 * Content-bearing files (e.g. `mission.md`) are listed in `assets.ts` instead.
 *
 * Per design §6.3 principle 5: optional / user-created directories (scripts, external, weekly-reports,
 * examples, docs) are NOT in this list and must not raise errors when missing.
 */
export const SKELETON_DIRS: readonly string[] = [
	".omp",
	".omp/skills",
	"knowledge",
	"knowledge/handbook",
	"cron",
	"cron/tasks",
	"cron/logs",
	"sessions",
] as const;
