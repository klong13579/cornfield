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
 * `find → glob`, `search → grep`, `todo_write → todo` are the renames landed by the
 * name-normalization batch (ADR-0003). The canonical registry keys are now
 * `glob` / `grep` / `todo`; the legacy names above map onto them so old
 * references keep resolving to the same tool. Removal is a separate ticket.
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
	find: "glob",
	search: "grep",
	todo_write: "todo",
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
