/**
 * xd:// device mounting — Enabled Set computation (ADR-0003).
 *
 * Splits a fully constructed tool list into:
 * - `topLevel` — tools exposed directly to the model as callable tools;
 * - `devices`  — `discoverable` tools mounted as `xd://` devices, reachable
 *   only through the read/write transport.
 *
 * The split is derived from directory (load mode of every constructed tool) +
 * configuration (`tools.xdev`) + environment (bun test runtime) + agent
 * boundaries (explicitly requested tool names):
 * - `tools.xdev` off, bun-test runtime, or an explicit `toolNames` request →
 *   no mounting; top-level exposure is identical to pre-xdev behavior.
 * - `essential` tools (and runtime-injected `internal` tools) always stay
 *   top-level; `internal` tools never enter the mounted set.
 */

import type { AgentTool } from "@cornfield/agent";
import { isBunTestRuntime } from "@cornfield/utils";
import type { Settings } from "../config/settings";
import { isMCPToolName } from "../mcp/discoverable-tool-metadata";
import { resolveLoadMode } from "./essential-tools";

type Tool = AgentTool<any, any, any>;

/**
 * Discoverable tools that stay top-level even under mounting.
 *
 * First-version keep list per ADR-0003: tools that the model must be able to
 * call by name because prompts or harness flows reference them directly and the
 * model cannot be assumed to know the xd protocol (upstream incident #5973).
 */
export const XDEV_KEEP_TOP_LEVEL: readonly string[] = ["web_search", "irc", "hub"];

/** How many characters of device catalog may be injected into the system prompt. */
export const XDEV_PROMPT_BUDGET_CHARS = 2000;

export interface XdevSplit {
	/** Tools exposed directly to the model. */
	topLevel: Tool[];
	/** Tools mounted as xd:// devices, keyed by canonical tool name. */
	devices: Map<string, Tool>;
}

/**
 * Whether mounting applies to this session.
 *
 * Mounting is skipped when the caller explicitly requested a tool list (the
 * agent boundary — explicitly requested tools are always callable), under the
 * bun test runtime (environment boundary — keeps legacy-behavior tests valid),
 * or when `tools.xdev` is off (configuration boundary).
 */
export function xdevMountingActive(settings: Settings, hasExplicitToolNames: boolean): boolean {
	if (hasExplicitToolNames) return false;
	if (isBunTestRuntime()) return false;
	return settings.get("tools.xdev") === true;
}

/**
 * Split a fully constructed tool list (including runtime-injected tools) into
 * top-level tools and mounted devices.
 *
 * Invariant enforced here: a tool appears in exactly one of the two sets.
 * `internal` tools present in the list are runtime injections and stay
 * top-level — their "not selectable" guarantee is enforced at the enumeration
 * step in `createTools`, not here.
 */
export function splitToolsForXdev(tools: Tool[]): XdevSplit {
	const topLevel: Tool[] = [];
	const devices = new Map<string, Tool>();
	for (const tool of tools) {
		const mode = resolveLoadMode(tool.name, tool.loadMode);
		// `internal` tools resolve to a non-discoverable mode from their own
		// `loadMode` declaration, so they stay top-level here without a name list.
		const keepTopLevel = mode !== "discoverable" || XDEV_KEEP_TOP_LEVEL.includes(tool.name);
		if (!keepTopLevel) {
			if (devices.has(tool.name)) {
				throw new Error(`Duplicate xd device name: ${tool.name}`);
			}
			devices.set(tool.name, tool);
		} else {
			topLevel.push(tool);
		}
	}
	const overlap = topLevel.filter(t => devices.has(t.name));
	if (overlap.length > 0) {
		throw new Error(`xd split invariant violated, tools in both sets: ${overlap.map(t => t.name).join(", ")}`);
	}
	return { topLevel, devices };
}

/**
 * Split tools registered after `createTools` (MCP tools) for xd:// mounting.
 *
 * `createTools` splits built-in tools inside its own run; MCP tools are
 * registered afterwards, so they need their own pass. Only MCP tools move to
 * devices — extension and custom tools are deliberately left top-level:
 * mounting them is a separate decision and reclassifying them here would
 * silently change their reachability.
 */
export function splitPostRegistrationMCPToolsForXdev(tools: Tool[]): XdevSplit {
	const topLevel: Tool[] = [];
	const devices = new Map<string, Tool>();
	for (const tool of tools) {
		if (isMCPToolName(tool.name)) {
			devices.set(tool.name, tool);
		} else {
			topLevel.push(tool);
		}
	}
	return { topLevel, devices };
}

export interface XdevPromptCatalog {
	entries: Array<{ name: string; summary: string }>;
	/** Number of devices omitted from `entries` because of the budget. */
	truncated: number;
}

/**
 * Build the budget-constrained device catalog injected into the system prompt.
 *
 * Each entry is one device with a one-line summary; entries are dropped (not
 * truncated mid-line) once `XDEV_PROMPT_BUDGET_CHARS` is exhausted, and the
 * remainder is reported via `truncated` so the prompt can point at
 * `read xd://` for the full catalog.
 */
export function buildXdevDeviceCatalog(devices: Map<string, Tool>): XdevPromptCatalog {
	const entries: Array<{ name: string; summary: string }> = [];
	let used = 0;
	let truncated = 0;
	for (const [name, tool] of devices) {
		const summary = (tool.summary ?? tool.description ?? "").split("\n")[0]!.trim();
		const lineCost = name.length + summary.length + 8;
		if (used + lineCost > XDEV_PROMPT_BUDGET_CHARS) {
			truncated++;
			continue;
		}
		entries.push({ name, summary });
		used += lineCost;
	}
	return { entries, truncated };
}
