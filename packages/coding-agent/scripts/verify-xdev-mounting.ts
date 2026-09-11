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
import { buildSystemPrompt } from "@cornfield/coding-agent/system-prompt";
import { createTools, type ToolSession } from "@cornfield/coding-agent/tools";

type Tool = Awaited<ReturnType<typeof createTools>>[number];

/** Tools that must always stay callable by name, whatever the mounting state. */
const ESSENTIAL = [
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
	"web_search",
	"search_tool_bm25",
];

/** Discoverable tools that stay top-level because prompts call them by name. */
const KEEP_TOP_LEVEL = ["web_search", "search_tool_bm25", "irc", "hub"];

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
	} — an empty summary renders a blank entry in the device catalog the model reads`,
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

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILURE(S):\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
