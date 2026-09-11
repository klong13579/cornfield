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

/**
 * Legacy alias → canonical builtin registry key.
 *
 * `find → glob`, `search → grep`, `todo_write → todo` are the renames planned
 * for the name-normalization batch (ADR-0003); they are pre-wired here so that
 * references using the future canonical names already resolve to the current
 * registry keys.
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
	glob: "find",
	grep: "search",
	todo: "todo_write",
};

/**
 * Normalize a tool name to its canonical builtin registry key.
 *
 * Only names present in `LEGACY_TOOL_NAME_ALIASES` are rewritten; everything
 * else (including plugin/MCP/extension names) passes through untouched.
 */
export function normalizeToolName(name: string): string {
	return LEGACY_TOOL_NAME_ALIASES[name] ?? name;
}
