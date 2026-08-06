/**
 * Tool risk classification for the voice confirmation gate (P1 design §5).
 *
 * Default-deny: any tool not explicitly green is at least yellow; unknown,
 * MCP, and extension-registered tools are red. bash is classified by its
 * command text — destructive patterns escalate to red.
 */

export type ToolRiskLevel = "green" | "yellow" | "red";

/** Read-only or harness-internal tools — execute without asking. */
const GREEN_TOOLS = new Set([
	"read",
	"search",
	"find",
	"ast_grep",
	"lsp",
	"web_search",
	"calc",
	"list_models",
	"inspect_image",
	"render_mermaid",
	"ask",
	"switch_model",
	"yield",
	"report_finding",
	"report_tool_issue",
	"checkpoint",
	// Read-only custom tools from the voice consult profile (harmless if they
	// ever surface in a gated session).
	"git_status",
	"weather",
]);

/** File/state mutation — one voice confirmation, then sticky for the task. */
const YELLOW_TOOLS = new Set([
	"edit",
	"write",
	"ast_edit",
	"notebook",
	"todo_write",
	"task",
	"irc",
	"identity",
	"rewind",
	"job",
]);

/** Arbitrary code execution, remote hosts, or external side effects — always ask. */
const RED_TOOLS = new Set([
	"python",
	"debug",
	"recipe",
	"ssh",
	"github",
	"browser",
	"puppeteer",
	"resolve",
	"exit_plan_mode",
]);

/**
 * bash command patterns that escalate to red. Kept conservative and explicit;
 * anything unmatched stays yellow (still confirmed, but sticky applies).
 */
const DESTRUCTIVE_BASH_PATTERNS: readonly RegExp[] = [
	/\brm\b/,
	/\brmdir\b/,
	/\bunlink\b/,
	/\bshred\b/,
	/\bsudo\b/,
	/\bgit\s+push\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b/,
	/\bkill\b/,
	/\bpkill\b/,
	/\bkillall\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/\bdrop\s+(database|table|schema)\b/i,
	/\btruncate\s+table\b/i,
	/\b(npm|bun|pnpm|yarn)\s+publish\b/,
	/\bcurl\b[^\n]*(--data|--form|-X\s*(POST|PUT|DELETE))/i,
	/>\s*\/dev\//,
];

/**
 * Commands statically provable read-only — green even through bash, so voice
 * workspace queries ("还有什么没提交") don't pay a confirmation round. Each
 * pipe segment must validate; any chaining/redirection/substitution operator
 * disqualifies the whole command.
 */
/** git subcommands that never mutate regardless of flags. */
const READONLY_GIT_ANY_ARGS = /^git\s+(status|log|diff|show|ls-files|rev-parse|describe)(\s|$)/;
/** git forms where flags decide read-only-ness — exact segment match only. */
const READONLY_GIT_EXACT = new Set([
	"git branch",
	"git branch -v",
	"git branch -a",
	"git branch -r",
	"git branch --list",
	"git tag",
	"git tag -l",
	"git remote",
	"git remote -v",
]);
/** Plain commands that cannot mutate without redirection (already excluded). */
const READONLY_SIMPLE_COMMANDS =
	/^(ls|cat|head|tail|grep|rg|find|wc|stat|file|which|pwd|echo|ps|df|du|env|date|whoami|uname)(\s|$)/;

/** Shell operators that can chain, redirect, or substitute — never statically read-only. */
const SHELL_OPERATOR_PATTERN = /(\$\(|`|;|&&|\|\||>>?|<)/;

export function isReadonlyShellCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed || SHELL_OPERATOR_PATTERN.test(trimmed)) return false;
	const segments = trimmed
		.split("|")
		.map(segment => segment.trim().replace(/\s+/g, " "))
		.filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every(
		segment =>
			READONLY_GIT_ANY_ARGS.test(segment) ||
			READONLY_GIT_EXACT.has(segment) ||
			READONLY_SIMPLE_COMMANDS.test(segment),
	);
}

export function classifyToolRisk(toolName: string, input: Record<string, unknown>): ToolRiskLevel {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (DESTRUCTIVE_BASH_PATTERNS.some(pattern => pattern.test(command))) return "red";
		if (isReadonlyShellCommand(command)) return "green";
		return "yellow";
	}
	if (GREEN_TOOLS.has(toolName)) return "green";
	if (RED_TOOLS.has(toolName)) return "red";
	if (YELLOW_TOOLS.has(toolName)) return "yellow";
	// Unknown / MCP / extension tools: fail safe.
	return "red";
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function clip(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Short spoken-friendly description of a pending tool call ("修改 src/foo.ts"). */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	const path = firstString(input, ["path", "file", "notebook_path"]);
	switch (toolName) {
		case "edit":
		case "ast_edit":
			return path ? `修改 ${path}` : "修改文件";
		case "write":
			return path ? `写入 ${path}` : "写入文件";
		case "notebook":
			return path ? `编辑 ${path}` : "编辑 notebook";
		case "todo_write":
			return "更新任务清单";
		case "bash": {
			const command = firstString(input, ["command"]);
			return command ? `执行命令：${clip(command, 80)}` : "执行命令";
		}
		case "task": {
			const description = firstString(input, ["description", "assignment"]);
			return description ? `派发子任务：${clip(description, 60)}` : "派发子任务";
		}
		case "irc": {
			const to = firstString(input, ["to"]);
			return to ? `发送消息给 ${to}` : "发送消息给其他 agent";
		}
		case "rewind":
			return "回退会话历史";
		case "identity":
			return "更新用户人设文件";
		default: {
			const anyString = Object.values(input).find((value): value is string => typeof value === "string");
			return anyString ? `${toolName}：${clip(anyString, 60)}` : toolName;
		}
	}
}
