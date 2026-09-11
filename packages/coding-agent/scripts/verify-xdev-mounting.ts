#!/usr/bin/env bun
/**
 * Verify the `xd://` device mounting pipeline (ADR-0003) and its prompt injection.
 *
 * Why this is a script and not a unit test: `xdevMountingActive()` has an
 * environment boundary — mounting is OFF under the bun test runtime, so every
 * `bun test` run exercises the legacy top-level list and never the mounted path.
 * A defect in that path is therefore invisible to the whole test suite while it
 * reports green. Measured 2026-09-11: `lsp` was mounted with an empty summary
 * (the device catalog rendered a blank entry) and 944 unit tests — including
 * ones asserting the mount invariants — all passed.
 *
 * Run it from the repository root:
 *   bun packages/coding-agent/scripts/verify-xdev-mounting.ts
 *
 * Exits non-zero on the first failed assertion, printing what failed and why.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { XdevProtocolHandler } from "@cornfield/coding-agent/internal-urls/xd-protocol";
import { buildSystemPrompt } from "@cornfield/coding-agent/system-prompt";
import { createTools, type ToolSession, WriteTool } from "@cornfield/coding-agent/tools";
import { buildXdevDeviceCatalog, splitPostRegistrationMCPToolsForXdev } from "@cornfield/coding-agent/tools/xdev";
import { Type } from "@sinclair/typebox";

type Tool = Awaited<ReturnType<typeof createTools>>[number];

/** Tools that must always stay callable by name, whatever the mounting state. */
const ESSENTIAL = [
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

/** Discoverable tools that stay top-level because prompts call them by name. */
const KEEP_TOP_LEVEL = ["web_search", "irc", "hub"];

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (!ok) failures.push(label);
	console.log(`${ok ? "OK  " : "FAIL"} | ${label}${detail ? `\n       ${detail}` : ""}`);
}

async function buildSession(
	settingsOverrides: Record<string, unknown>,
	toolNames?: string[],
): Promise<{ session: ToolSession; tools: Tool[] }> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xdev-verify-"));
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
	};
	return { session, tools: await createTools(session, toolNames) };
}

// Ground truth first: what does this environment construct at all? Comparing
// against it keeps "the session never built this tool" from being reported as
// "mounting dropped this tool".
const legacy = await buildSession({ "tools.xdev": false });
const legacyNames = legacy.tools.map(tool => tool.name);

// ── Case 1: real runtime, mounting on, no explicit tool list ────────────────
const mounted = await buildSession({ "tools.xdev": true });
const topNames = mounted.tools.map(tool => tool.name);
const devices = mounted.session.xdevDevices;
const deviceNames = devices ? [...devices.keys()] : [];
const deviceList = devices ? [...devices.values()] : [];

console.log(`[case 1] tools.xdev=true, no explicit toolNames`);
console.log(`  top-level (${topNames.length}): ${topNames.join(", ")}`);
console.log(`  mounted devices (${deviceNames.length}): ${deviceNames.join(", ")}\n`);

check(
	"mounting is ACTIVE outside the bun test runtime",
	deviceNames.length > 0,
	devices ? `xdevDevices=Map(${devices.size})` : "xdevDevices=undefined",
);
check(
	"every essential tool the session builds stays top-level",
	ESSENTIAL.filter(name => legacyNames.includes(name)).every(name => topNames.includes(name)),
	`missing: ${ESSENTIAL.filter(name => legacyNames.includes(name) && !topNames.includes(name)).join(", ") || "none"}` +
		` (not built here: ${ESSENTIAL.filter(name => !legacyNames.includes(name)).join(", ") || "none"})`,
);
check(
	"no tool is in both sets",
	topNames.every(name => !deviceNames.includes(name)),
	`overlap: ${topNames.filter(name => deviceNames.includes(name)).join(", ") || "none"}`,
);
check("keep-list tools are not mounted", !KEEP_TOP_LEVEL.some(name => deviceNames.includes(name)));
check(
	"read/write are never mounted (they ARE the transport)",
	!deviceNames.includes("read") && !deviceNames.includes("write"),
);
check(
	"every mounted device carries a non-empty summary",
	deviceList.length > 0 && deviceList.every(tool => (tool.summary ?? "").trim() !== ""),
	`without summary: ${
		deviceList
			.filter(tool => (tool.summary ?? "").trim() === "")
			.map(tool => tool.name)
			.join(", ") || "none"
	} — with no declared summary the catalog falls back to the description's first line
	(buildXdevDeviceCatalog), shipping description prose into the system prompt in place of a
	purpose-written one-liner`,
);

// The prompt the model actually reads. `buildXdevDeviceCatalog` silently falls back
// to `tool.description` when no summary is declared, so checking `tool.summary` alone
// leaves that fallback free to ship arbitrary description prose into the catalog.
const catalog = buildXdevDeviceCatalog(devices ?? new Map());
const notDeclared = catalog.entries
	.filter(entry => entry.summary !== (devices?.get(entry.name)?.summary ?? "").trim())
	.map(entry => entry.name);
check(
	"the device catalog renders each device's declared summary, not a description fallback",
	notDeclared.length === 0,
	`fell back to description: ${notDeclared.join(", ") || "none"}`,
);

// ── Case 2: explicit tool list → mounting off (runtime injection boundary) ──
const explicit = await buildSession({ "tools.xdev": true }, ["read", "bash"]);
console.log(`\n[case 2] tools.xdev=true, explicit toolNames=["read","bash"]`);
console.log(`  top-level: ${explicit.tools.map(tool => tool.name).join(", ")}\n`);
check(
	"an explicit tool list disables mounting",
	explicit.session.xdevDevices === undefined || explicit.session.xdevDevices.size === 0,
);
check(
	"an explicit tool list still selects what was asked",
	["read", "bash"].every(name => explicit.tools.map(tool => tool.name).includes(name)),
);

// ── Case 3: switch off → legacy exposure, and the partition still holds ─────
const off = await buildSession({ "tools.xdev": false });
check(
	"tools.xdev=false disables mounting",
	off.session.xdevDevices === undefined || off.session.xdevDevices.size === 0,
);
check(
	"enabled set is partitioned: legacy == top-level ∪ devices, nothing lost or duplicated",
	JSON.stringify([...topNames, ...deviceNames].sort()) === JSON.stringify([...legacyNames].sort()),
	`lost: ${legacyNames.filter(n => !topNames.includes(n) && !deviceNames.includes(n)).join(", ") || "none"}; ` +
		`extra: ${[...topNames, ...deviceNames].filter(n => !legacyNames.includes(n)).join(", ") || "none"}`,
);

// ── Case 4: default settings → the ADR's "defaults on" claim ────────────────
const defaults = await buildSession({});
check(
	"ADR claim: tools.xdev defaults ON (mounting active with no override)",
	(defaults.session.xdevDevices?.size ?? 0) > 0,
);

// ── Case 5: both prompt paths must carry the device catalog ─────────────────
const sampleDevices = {
	entries: [
		{ name: "ast_grep", summary: "Structural code search." },
		{ name: "switch_model", summary: "Switch the active model." },
	],
	truncated: 0,
};
const defaultPrompt = await buildSystemPrompt({ cwd: os.tmpdir(), xdevDevices: sampleDevices });
const customPrompt = await buildSystemPrompt({
	cwd: os.tmpdir(),
	customPrompt: "You are a test agent.",
	xdevDevices: sampleDevices,
});
const noDevicePrompt = await buildSystemPrompt({ cwd: os.tmpdir() });
check("default prompt path renders the device catalog", defaultPrompt.includes("xd://ast_grep"));
check(
	"customSystemPrompt path ALSO renders it (otherwise mounted tools are unreachable for those users)",
	customPrompt.includes("xd://ast_grep"),
);
check(
	"no devices → no catalog section (no token cost when nothing is mounted)",
	!noDevicePrompt.includes("Mounted devices"),
);

// ── Case 6: post-registration MCP tools mount as devices ────────────────────
// MCP tools register after createTools (sdk.ts), so their device split is a
// separate pass. Prove the reachability chain in a real bun process: the split
// mounts only MCP tools, read xd:// lists them all (surviving the prompt-catalog
// budget truncation), and write xd://<name> executes one.
function fakeRegisteredTool(name: string, description: string): Tool {
	return {
		name,
		description,
		parameters: Type.Object({ query: Type.String() }),
		execute: async (_toolCallId: string, args: { query: string }) => ({
			content: [{ type: "text", text: `executed ${name} (${args.query})` }],
			details: {},
		}),
	} as unknown as Tool;
}

const postRegTools = [
	fakeRegisteredTool("mcp__github_create_issue", "Create a GitHub issue"),
	fakeRegisteredTool("mcp__github_list_pull_requests", "List pull requests"),
	fakeRegisteredTool("my_custom_tool", "A non-MCP custom tool"),
];
const postSplit = splitPostRegistrationMCPToolsForXdev(postRegTools);
check(
	"post-registration split mounts only MCP tools as devices",
	[...postSplit.devices.keys()].sort().join(",") === "mcp__github_create_issue,mcp__github_list_pull_requests",
	`devices: ${[...postSplit.devices.keys()].join(", ") || "none"}`,
);
check(
	"post-registration split keeps non-MCP tools top-level",
	postSplit.topLevel.map(tool => tool.name).join(",") === "my_custom_tool",
	`topLevel: ${postSplit.topLevel.map(tool => tool.name).join(", ") || "none"}`,
);

const mcpHandler = new XdevProtocolHandler({ getDevices: () => postSplit.devices });
const mcpCatalog = await mcpHandler.resolve({ rawHost: "" } as never);
check(
	"read xd:// lists every mounted MCP device",
	mcpCatalog.content.includes("xd://mcp__github_create_issue") &&
		mcpCatalog.content.includes("xd://mcp__github_list_pull_requests"),
);
const mcpManual = await mcpHandler.resolve({ rawHost: "mcp__github_create_issue" } as never);
check("read xd://<mcp tool> returns its wire schema", mcpManual.content.includes('"query"'));

const mcpSession: ToolSession = {
	cwd: fs.mkdtempSync(path.join(os.tmpdir(), "xdev-verify-mcp-")),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({ "tools.xdev": true }),
	xdevDevices: postSplit.devices,
};
const mcpWrite = new WriteTool(mcpSession);
const mcpExec = await mcpWrite.execute("mcp-exec", {
	path: "xd://mcp__github_create_issue",
	content: JSON.stringify({ query: "hello" }),
});
check(
	"write xd://<mcp tool> executes the device",
	(mcpExec.content[0] as { text?: string }).text === "executed mcp__github_create_issue (hello)",
);

const manyDevices = new Map<string, Tool>();
for (let i = 0; i < 500; i++) {
	manyDevices.set(`mcp__server_tool_${i}`, fakeRegisteredTool(`mcp__server_tool_${i}`, `Tool ${i}`));
}
const promptCatalog = buildXdevDeviceCatalog(manyDevices);
const fullCatalogHandler = new XdevProtocolHandler({ getDevices: () => manyDevices });
const fullCatalog = await fullCatalogHandler.resolve({ rawHost: "" } as never);
check(
	"read xd:// returns the FULL catalog even when the prompt catalog truncates",
	promptCatalog.truncated > 0 && fullCatalog.content.includes("xd://mcp__server_tool_499"),
	`prompt catalog: ${promptCatalog.entries.length} entries (+${promptCatalog.truncated} truncated); read xd:// reaches the last device`,
);

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILURE(S):\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
