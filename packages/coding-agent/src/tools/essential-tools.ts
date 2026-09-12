import type { ToolLoadMode } from "@cornfield/agent";

/**
 * Centralized essential tool-name list — the fallback source of truth for
 * `loadMode` (ADR-0003).
 *
 * A tool that does not declare `loadMode` resolves to "essential" when its name
 * is listed here, otherwise "discoverable". Keeping this list centralized in one
 * place prevents adapter/UI re-registration from silently downgrading a core
 * tool to "discoverable".
 *
 * `web_search` is listed here even though `WebSearchTool` already declares
 * `loadMode: "essential"`. The declaration alone loses to adapter/UI
 * re-registration that drops the field (upstream #5764), leaving a harness-
 * coupled tool to be mounted as a device the model can no longer call by name
 * (#5973). Name-listing it keeps the fallback authoritative.
 */
export const ESSENTIAL_BUILTIN_TOOL_NAMES: readonly string[] = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"bash",
	"ask",
	"task",
	"job",
	"project_context",
	"todo",
	"exit_plan_mode",
	"identity",
	"web_search",
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
