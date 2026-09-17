/**
 * Directories the agentDir skeleton creates.
 *
 * Each entry gets a `.gitkeep` stub (empty file) so git tracks the otherwise-empty directory.
 * Content-bearing files (e.g. `mission.md`) are listed in `assets.ts` instead.
 *
 * Per `docs/gateway/agent-bridge.md`（Agent Design V1）§6.3 principle 5: optional / user-created directories (scripts, external, weekly-reports,
 * examples, docs) are NOT in this list and must not raise errors when missing.
 *
 * `topics/` 是 default Agent workspace 的 Topic 存放处（长期背景/设计/决策/整体验收），
 * 与 `TODO.md` 同为骨架的一部分：见 `docs/agent-task-control-plane-v1.md` §47/§163 与
 * `docs/agent-task-control-plane-v1-implementation.md` §45。
 */
export const SKELETON_DIRS: readonly string[] = [
	".cornfield",
	".cornfield/skills",
	".cornfield/skills/lint",
	"knowledge",
	"knowledge/handbook",
	"cron",
	"cron/tasks",
	"cron/logs",
	"sessions",
	"raw",
	"wiki",
	"topics",
] as const;
