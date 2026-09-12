/**
 * Canonical builtin tool names and legacy alias normalization (ADR-0003).
 *
 * The canonical name of a builtin tool is its registry key in `BUILTIN_TOOLS` /
 * `HIDDEN_TOOLS` (see `tools/index.ts`). This module owns the alias layer that
 * maps legacy/alternate spellings onto the same tool, so old names keep
 * resolving to the same tool when a registry key is later renamed.
 *
 * Names that are not builtin aliases (plugin tools, MCP tools, extension tools)
 * are returned unchanged by `normalizeToolName` — normalization MUST never
 * rewrite names outside the builtin alias table.
 */

import { logger } from "@cornfield/utils";

/**
 * Legacy alias → canonical builtin registry key.
 *
 * `find → glob`, `search → grep`, `todo_write → todo` are the renames landed by
 * the name-normalization batch (ADR-0003). The canonical registry keys are now
 * `glob` / `grep` / `todo`; the legacy names above map onto them so old
 * references keep resolving to the same tool.
 *
 * The aliases are on their way out (ADR-0003 "旧名移除"). This ticket adds the
 * explicit deprecation warning below so the eventual alias removal cannot break
 * anyone silently; the aliases themselves are removed in a follow-up ticket once
 * users have had a release to migrate.
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
	find: "glob",
	search: "grep",
	todo_write: "todo",
};

/** Legacy names already warned once, so the deprecation notice doesn't spam the log. */
const warnedLegacyToolNames = new Set<string>();

/**
 * Normalize a tool name to its canonical builtin registry key.
 *
 * Legacy names still resolve to their canonical tool (compat), and each legacy
 * name is warned exactly once per process so the deprecation is never silent.
 * Everything other than a legacy builtin alias (including plugin/MCP/extension
 * names) passes through untouched.
 */
export function normalizeToolName(name: string): string {
	const canonical = LEGACY_TOOL_NAME_ALIASES[name];
	if (canonical !== undefined && !warnedLegacyToolNames.has(name)) {
		warnedLegacyToolNames.add(name);
		logger.warn(`Tool name "${name}" is deprecated — use "${canonical}" instead`, {
			legacyName: name,
			canonicalName: canonical,
		});
	}
	return canonical ?? name;
}

/**
 * Reset the per-process deprecated-name warning cache for testing.
 * @internal
 */
export function _resetToolNameWarningsForTest(): void {
	warnedLegacyToolNames.clear();
}
