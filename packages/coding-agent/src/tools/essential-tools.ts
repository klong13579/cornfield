import type { ToolLoadMode } from "@cornfield/agent";

/**
 * Centralized essential tool-name list — the fallback source of truth for
 * `loadMode` (ADR-0003).
 *
 * A tool that does not declare `loadMode` resolves to "essential" when its name
 * is listed here, otherwise "discoverable". Keeping this list centralized in one
 * place prevents adapter/UI re-registration from silently downgrading a core
 * tool to "discoverable".
 */
export const ESSENTIAL_BUILTIN_TOOL_NAMES: readonly string[] = [
	"read",
	"write",
	"edit",
	"find",
	"search",
	"bash",
	"ask",
	"task",
	"job",
	"project_context",
	"todo_write",
	"exit_plan_mode",
	"identity",
];

/**
 * Default load mode for a tool that declares none:
 * in-list → "essential", otherwise → "discoverable".
 */
export function defaultLoadModeForToolName(toolName: string): "essential" | "discoverable" {
	return ESSENTIAL_BUILTIN_TOOL_NAMES.includes(toolName) ? "essential" : "discoverable";
}

/**
 * Effective load mode for a tool: an explicit declaration always wins over the
 * name-based default.
 */
export function resolveLoadMode(toolName: string, declared?: ToolLoadMode): ToolLoadMode {
	return declared ?? defaultLoadModeForToolName(toolName);
}
