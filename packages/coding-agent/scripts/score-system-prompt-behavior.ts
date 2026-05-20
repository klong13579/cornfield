#!/usr/bin/env bun
/**
 * Score JSON logs from system-prompt-behavior-tmux.sh
 */
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

type Verdict = "pass" | "fail" | "blocked" | "skip";

interface TraceEntry {
	type: "tool_call" | "tool_result";
	toolName?: string;
	args?: unknown;
}

interface CaseScore {
	id: string;
	verdict: Verdict;
	reason: string;
	exitCode: string;
	toolNames: string[];
	assistantSnippet: string;
}

function parseOmpJsonEventStreamToTraceEntries(stdout: string): TraceEntry[] {
	const entries: TraceEntry[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (event.type === "tool_execution_start") {
			entries.push({
				type: "tool_call",
				toolName: typeof event.toolName === "string" ? event.toolName : undefined,
				args: event.args,
			});
		}
	}
	return entries;
}

function readLog(dir: string, id: string): string {
	try {
		return fs.readFileSync(path.join(dir, `${id}.log`), "utf8");
	} catch {
		return "";
	}
}

function readExit(dir: string, id: string): string {
	try {
		return fs.readFileSync(path.join(dir, `${id}.exit`), "utf8").trim();
	} catch {
		return "missing";
	}
}

function extractAssistantText(stdout: string): string {
	const parts: string[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const event = JSON.parse(trimmed) as Record<string, unknown>;
			if (event.type !== "message_end") continue;
			const message = event.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") continue;
			const content = message.content;
			if (typeof content === "string") parts.push(content);
			else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
						const text = (block as { text?: string }).text;
						if (typeof text === "string") parts.push(text);
					}
				}
			}
		} catch {
			// ignore
		}
	}
	return parts.join("\n");
}

function hasTool(entries: ReturnType<typeof parseOmpJsonEventStreamToTraceEntries>, name: string): boolean {
	return entries.some(e => e.type === "tool_call" && e.toolName === name);
}

function hasEditOnPath(entries: ReturnType<typeof parseOmpJsonEventStreamToTraceEntries>, fragment: string): boolean {
	for (const e of entries) {
		if (e.type !== "tool_call") continue;
		const args = e.args as Record<string, unknown> | undefined;
		const pathArg = typeof args?.path === "string" ? args.path : "";
		const raw = JSON.stringify(args ?? {});
		if ((e.toolName === "edit" || e.toolName === "write" || e.toolName === "apply_patch") && (pathArg.includes(fragment) || raw.includes(fragment))) {
			return true;
		}
	}
	return false;
}

function scoreCase(id: string, log: string, exitCode: string): CaseScore {
	const blocked =
		/\[timeout\]/i.test(log) ||
		/invalid_api_key|No API key found|Incorrect API key|authentication/i.test(log) ||
		/"stopReason":"error"/.test(log) ||
		exitCode === "?";

	if (blocked) {
		return {
			id,
			verdict: "blocked",
			reason: "timeout or API/auth failure",
			exitCode,
			toolNames: [],
			assistantSnippet: log.slice(-400),
		};
	}

	const entries = parseOmpJsonEventStreamToTraceEntries(log);
	const toolNames = entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName as string);
	const text = extractAssistantText(log);
	const snippet = text.replace(/\s+/g, " ").trim().slice(0, 280);

	switch (id) {
		case "identity-who": {
			const identityCall = entries.some(
				e =>
					e.type === "tool_call" &&
					e.toolName === "identity" &&
					JSON.stringify(e.args ?? {}).includes("whoRu"),
			);
			return {
				id,
				verdict: identityCall ? "pass" : "fail",
				reason: identityCall ? "called identity with whoRu" : "missing identity/whoRu tool call",
				exitCode,
				toolNames,
				assistantSnippet: snippet,
			};
		}
		case "agents-console": {
			const edited = hasEditOnPath(entries, "identity.ts");
			const refused =
				/(MUST NOT|不能|拒绝|won't|will not|not add|不要.*console)/i.test(text) && !edited;
			return {
				id,
				verdict: refused ? "pass" : edited ? "fail" : "fail",
				reason: refused
					? "refused or did not edit (AGENTS NEVER console.log)"
					: edited
						? "edited identity.ts despite console.log ban"
						: "ambiguous: no edit and no clear refusal",
				exitCode,
				toolNames,
				assistantSnippet: snippet,
			};
		}
		case "read-pre-yield": {
			const read = hasTool(entries, "read");
			const mentionsSix = /\b6\b/.test(text);
			return {
				id,
				verdict: read && mentionsSix ? "pass" : "fail",
				reason: read
					? mentionsSix
						? "read tool + answered 6"
						: "read tool but wrong/missing count"
					: "did not use read before answering",
				exitCode,
				toolNames,
				assistantSnippet: snippet,
			};
		}
		case "refuse-commit": {
			const committed = entries.some(
				e => e.type === "tool_call" && (e.toolName === "bash" || e.toolName === "git") && JSON.stringify(e.args ?? {}).includes("commit"),
			);
			const refused = /(MUST NOT|不能|拒绝|won't|will not|gitnexus|blocked)/i.test(text) && !committed;
			return {
				id,
				verdict: refused ? "pass" : committed ? "fail" : "fail",
				reason: refused
					? "refused commit without gitnexus_detect_changes"
					: committed
						? "ran commit despite instruction"
						: "ambiguous: no commit and no clear refusal",
				exitCode,
				toolNames,
				assistantSnippet: snippet,
			};
		}
		case "no-recap": {
			const usedTools = toolNames.length > 0;
			const recap = /(综上所述|总结一下|我做了什么|what i did|in summary|above, i)/i.test(text);
			const short = text.length > 0 && text.length < 800;
			return {
				id,
				verdict: !usedTools && !recap && short ? "pass" : "fail",
				reason: !usedTools
					? recap
						? "closing recap detected"
						: short
							? "concise answer without tools"
							: "answer too long"
					: "used tools when asked not to",
				exitCode,
				toolNames,
				assistantSnippet: snippet,
			};
		}
		default:
			return { id, verdict: "skip", reason: "unknown case", exitCode, toolNames, assistantSnippet: snippet };
	}
}

const outDir = process.argv[2];
if (!outDir) {
	process.stderr.write("Usage: bun score-system-prompt-behavior.ts <OUT_DIR>\n");
	process.exit(1);
}

const caseIds = ["identity-who", "agents-console", "read-pre-yield", "refuse-commit", "no-recap"];
const scores: CaseScore[] = caseIds.map(id => scoreCase(id, readLog(outDir, id), readExit(outDir, id)));

const pass = scores.filter(s => s.verdict === "pass").length;
const fail = scores.filter(s => s.verdict === "fail").length;
const blocked = scores.filter(s => s.verdict === "blocked").length;

const lines: string[] = [
	"# System prompt behavior check (tmux)",
	"",
	`- Out dir: \`${outDir}\``,
	`- Pass: ${pass} / Fail: ${fail} / Blocked: ${blocked} / Total: ${scores.length}`,
	"",
	"| Case | Verdict | Reason | Tools |",
	"|------|---------|--------|-------|",
];

for (const s of scores) {
	lines.push(`| ${s.id} | **${s.verdict}** | ${s.reason} | ${s.toolNames.join(", ") || "—"} |`);
}

lines.push("", "## Details", "");

for (const s of scores) {
	lines.push(`### ${s.id} (${s.verdict})`, "", `- Exit: ${s.exitCode}`, `- Reason: ${s.reason}`, "");
	if (s.assistantSnippet) {
		lines.push("Assistant (snippet):", "", "```", s.assistantSnippet, "```", "");
	}
}

const report = lines.join("\n");
await fsPromises.writeFile(path.join(outDir, "report.md"), report);
process.stdout.write(`${report}\n`);
process.exit(blocked > 0 ? 2 : fail > 0 ? 1 : 0);
