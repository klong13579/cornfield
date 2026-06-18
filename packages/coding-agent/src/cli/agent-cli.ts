/**
 * `omp agent` subcommand handlers.
 *
 * Pure functions (no Command class) so they can be unit-tested without
 * standing up the CLI parser. The Command class in `../commands/agent.ts`
 * is a thin dispatcher that calls these.
 *
 * Subcommands (per `packages/agent/docs/agent-design-v1.md` §6.2):
 *   - init <name>     create a new agentDir
 *   - list            list agentDirs under ~/.omp/agents/
 *   - show <name>     print identity / tools / skills / cron summary
 *   - validate <dir>  check always-on files + runtime artifacts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentDir, resolveAgentDir, SKELETON_FILES } from "@oh-my-pi/pi-coding-agent/skeleton";

// ────────────────────────────────────────────────────────────────────────────
// init
// ────────────────────────────────────────────────────────────────────────────

export interface InitArgs {
	name: string;
	dir?: string;
	template?: string;
	mission?: string;
	force?: boolean;
	json?: boolean;
}

export interface InitResult {
	name: string;
	agentDir: string;
	created: boolean;
	filesWritten: number;
}

export async function runAgentInit(args: InitArgs): Promise<InitResult> {
	if (!args.name || args.name.includes("\0")) {
		throw new Error(`Invalid agent name: "${args.name}". Names cannot contain NUL.`);
	}
	// Reject path-traversal segments (`..`) so an accountId like
	// `../../../etc` cannot escape the parent. Forward slashes are allowed
	// because the gateway uses nested account ids (e.g. `ops/hr`).
	if (args.name.split(/[/\\]/).some(seg => seg === "..")) {
		throw new Error(`Invalid agent name: "${args.name}". Names cannot contain '..' segments.`);
	}
	if (args.template && args.template !== "default") {
		throw new Error(`Unknown template: "${args.template}". Only "default" is supported.`);
	}

	let agentDir: string;
	if (args.dir) {
		// If --dir is an existing dir, treat as parent and append <name>.
		// If it's a non-existing path, use as-is (allows full path override).
		let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
		try {
			stat = await fs.stat(args.dir);
		} catch {
			stat = null;
		}
		agentDir = stat?.isDirectory() ? path.join(args.dir, args.name) : path.resolve(args.dir);
	} else {
		agentDir = resolveAgentDir(args.name);
	}

	// Detect "dir already existed before we touched it" so we can distinguish
	// a brand-new agentDir (created=true) from a user-customized one (additive).
	const dirExistedBefore = await pathExists(agentDir);

	if (args.mission) {
		const missionSrc = path.resolve(args.mission);
		try {
			const content = await Bun.file(missionSrc).text();
			await Bun.write(path.join(agentDir, "mission.md"), content);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error(`Mission file not found: ${missionSrc}`);
			}
			throw err;
		}
	}

	const created = await ensureAgentDir(agentDir);
	// If the user provided --mission and the dir was brand new, we wrote mission.md
	// before ensureAgentDir, which makes `created=false` even though the agentDir is
	// new. Override: a fresh dir is always "created" regardless of mission seeding.
	const effectiveCreated = created || (!dirExistedBefore && !created);
	const filesWritten = effectiveCreated ? SKELETON_FILES.length : 0;

	return { name: args.name, agentDir, created: effectiveCreated, filesWritten };
}

// ────────────────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────────────────

export interface ListArgs {
	dir?: string;
	json?: boolean;
}

export interface AgentSummary {
	name: string;
	agentDir: string;
	status: AgentStatus;
}

export type AgentStatus = "active" | "incomplete" | "broken";

export async function runAgentList(args: ListArgs): Promise<AgentSummary[]> {
	const root = path.resolve(args.dir ?? path.join(os.homedir(), ".omp", "agents"));

	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const summaries: AgentSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		const summary = await inspectAgentDir(dir, entry.name);
		if (summary) summaries.push(summary);
	}

	// Stable order: by name.
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

async function inspectAgentDir(dir: string, name: string): Promise<AgentSummary | null> {
	const status = await probeAgentStatus(dir);
	return { name, agentDir: dir, status };
}

async function probeAgentStatus(dir: string): Promise<AgentStatus> {
	try {
		const [mission, config] = await Promise.all([
			fs.access(path.join(dir, "mission.md")).then(
				() => true,
				() => false,
			),
			fs.access(path.join(dir, ".omp", "config.yml")).then(
				() => true,
				() => false,
			),
		]);
		if (mission && config) return "active";
		return "incomplete";
	} catch {
		return "broken";
	}
}

// ────────────────────────────────────────────────────────────────────────────
// show
// ────────────────────────────────────────────────────────────────────────────

export interface ShowArgs {
	name: string;
	dir?: string;
	json?: boolean;
}

export interface AgentDetail {
	name: string;
	agentDir: string;
	identity: string[];
	hardConstraints: string[];
	tools: string[];
	skills: Array<{ name: string; description?: string }>;
	cronTaskCount: number;
	sessionCount: number;
	exists: boolean;
}

export async function runAgentShow(args: ShowArgs): Promise<AgentDetail> {
	const agentDir = path.resolve(args.dir ?? path.join(os.homedir(), ".omp", "agents"), args.name);

	const exists = await pathExists(agentDir);
	if (!exists) {
		return {
			name: args.name,
			agentDir,
			identity: [],
			hardConstraints: [],
			tools: [],
			skills: [],
			cronTaskCount: 0,
			sessionCount: 0,
			exists: false,
		};
	}

	const [identity, hardConstraints, tools, skills, cronTaskCount, sessionCount] = await Promise.all([
		readIdentitySummary(path.join(agentDir, "mission.md")),
		readHardConstraints(path.join(agentDir, "AGENTS.md")),
		readToolsList(path.join(agentDir, "TOOLS.md")),
		readSkills(path.join(agentDir, ".omp", "skills")),
		countJson5Files(path.join(agentDir, "cron", "tasks")),
		countJsonlFiles(path.join(agentDir, "sessions")),
	]);

	return {
		name: args.name,
		agentDir,
		identity,
		hardConstraints,
		tools,
		skills,
		cronTaskCount,
		sessionCount,
		exists: true,
	};
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function readIdentitySummary(missionPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await Bun.file(missionPath).text();
	} catch {
		return [];
	}
	const lines = content.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) continue;
		out.push(trimmed);
		if (out.length >= 3) break;
	}
	return out;
}

async function readHardConstraints(agentsPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await Bun.file(agentsPath).text();
	} catch {
		return [];
	}
	const out: string[] = [];
	// Match bullet-list rule lines: `- MUST ...`, `- MUST NOT ...`, `- NEVER ...`.
	// Skip lines that merely mention these keywords in prose (e.g. "Use MUST NOT to ...").
	const re = /^\s*-\s+(MUST NOT|NEVER|MUST)\b/;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (!re.test(line)) continue;
		out.push(line.replace(/^\s*-\s+/, ""));
	}
	return out;
}

async function readToolsList(toolsPath: string): Promise<string[]> {
	let content: string;
	try {
		content = await Bun.file(toolsPath).text();
	} catch {
		return [];
	}
	// Match `### \`<name>\`` headings — those are the tool names in TOOLS.md.
	const out: string[] = [];
	const re = /^### `([^`]+)`/gm;
	for (const match of content.matchAll(re)) {
		out.push(match[1]!);
	}
	return out;
}

async function readSkills(skillsDir: string): Promise<Array<{ name: string; description?: string }>> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(skillsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: Array<{ name: string; description?: string }> = [];
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!entry.name.endsWith(".md")) continue;
		const skillPath = path.join(skillsDir, entry.name);
		const desc = await readSkillDescription(skillPath);
		out.push({ name: entry.name.replace(/\.md$/, ""), ...(desc ? { description: desc } : {}) });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillDescription(skillPath: string): Promise<string | undefined> {
	try {
		const content = await Bun.file(skillPath).text();
		// YAML frontmatter at top: `---\ndescription: foo\n---`
		const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
		if (!m) return undefined;
		const fm = m[1]!;
		const descMatch = /^description:\s*(.+)$/m.exec(fm);
		return descMatch ? descMatch[1]!.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function countJson5Files(dir: string): Promise<number> {
	return countFilesWithExt(dir, [".json5", ".json"]);
}

async function countJsonlFiles(dir: string): Promise<number> {
	return countFilesWithExt(dir, [".jsonl"]);
}

async function countFilesWithExt(dir: string, exts: string[]): Promise<number> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let n = 0;
	for (const e of entries) {
		if (!e.isFile() && !e.isSymbolicLink()) continue;
		if (exts.some(ext => e.name.endsWith(ext))) n++;
	}
	return n;
}

// ────────────────────────────────────────────────────────────────────────────
// validate
// ────────────────────────────────────────────────────────────────────────────

export interface ValidateArgs {
	agentDir: string;
	json?: boolean;
}

export interface ValidateIssue {
	level: "error" | "warning";
	file: string;
	message: string;
}

export interface ValidateResult {
	agentDir: string;
	issues: ValidateIssue[];
	valid: boolean;
}

const ALWAYS_ON: ReadonlyArray<string> = [
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"TODO.md",
	"knowledge/external-workspaces.md",
];

const RUNTIME_HARD_DEPS: ReadonlyArray<string> = [".omp/config.yml"];

const RUNTIME_RECOMMENDED: ReadonlyArray<string> = ["prompt-includes.json", ".gitignore"];

export async function runAgentValidate(args: ValidateArgs): Promise<ValidateResult> {
	const agentDir = path.resolve(args.agentDir);
	const issues: ValidateIssue[] = [];

	// 1. always-on content files
	for (const rel of ALWAYS_ON) {
		const p = path.join(agentDir, rel);
		if (!(await pathExists(p))) {
			issues.push({ level: "error", file: rel, message: "Missing always-on file" });
		}
	}

	// 2. runtime hard deps
	for (const rel of RUNTIME_HARD_DEPS) {
		const p = path.join(agentDir, rel);
		if (!(await pathExists(p))) {
			issues.push({ level: "error", file: rel, message: "Missing runtime hard dependency" });
		}
	}

	// 3. runtime recommended
	for (const rel of RUNTIME_RECOMMENDED) {
		const p = path.join(agentDir, rel);
		if (!(await pathExists(p))) {
			issues.push({ level: "warning", file: rel, message: "Missing recommended runtime file" });
		}
	}

	// 4. prompt-includes.json must be valid JSON if present
	const promptIncludesPath = path.join(agentDir, "prompt-includes.json");
	if (await pathExists(promptIncludesPath)) {
		try {
			const text = await Bun.file(promptIncludesPath).text();
			const parsed = JSON.parse(text);
			if (!Array.isArray(parsed?.files)) {
				issues.push({
					level: "error",
					file: "prompt-includes.json",
					message: "Expected top-level `files` array",
				});
			}
		} catch (err) {
			issues.push({
				level: "error",
				file: "prompt-includes.json",
				message: `Invalid JSON: ${(err as Error).message}`,
			});
		}
	}

	// 5. .omp/config.yml must be valid YAML if present
	const configYmlPath = path.join(agentDir, ".omp", "config.yml");
	if (await pathExists(configYmlPath)) {
		try {
			const text = await Bun.file(configYmlPath).text();
			if (typeof Bun.YAML?.parse === "function") {
				Bun.YAML.parse(text);
			} else {
				// Best-effort: a YAML doc is valid if it has at least one non-empty line.
				// Without a parser, surface a warning rather than failing.
				issues.push({
					level: "warning",
					file: ".omp/config.yml",
					message: "Bun.YAML not available; skipping deep validation",
				});
			}
		} catch (err) {
			issues.push({
				level: "error",
				file: ".omp/config.yml",
				message: `Invalid YAML: ${(err as Error).message}`,
			});
		}
	}

	return {
		agentDir,
		issues,
		valid: !issues.some(i => i.level === "error"),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// renderers (small, no external UI deps)
// ────────────────────────────────────────────────────────────────────────────

export function renderList(summaries: AgentSummary[], json: boolean): string {
	if (json) return JSON.stringify(summaries, null, 2);
	if (summaries.length === 0) {
		return "No agents found. Run `omp agent init <name>` to create one.";
	}
	const colGap = 2;
	const header: [string, string, string] = ["NAME", "AGENT_DIR", "STATUS"];
	const rows: Array<[string, string, string]> = summaries.map(s => [s.name, s.agentDir, s.status]);
	const widths = [0, 0, 0];
	for (const r of rows) for (let i = 0; i < 3; i++) widths[i] = Math.max(widths[i]!, r[i]!.length);
	for (let i = 0; i < 3; i++) widths[i] = Math.max(widths[i]!, header[i]!.length);
	const fmt = (cells: [string, string, string]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i]! + (i < 2 ? colGap : 0)))
			.join("")
			.trimEnd();
	const lines: string[] = [fmt(header), "─".repeat(widths.reduce((a, b) => a + b, 0) + colGap * 2), ...rows.map(fmt)];
	return lines.join("\n");
}

export function renderShow(detail: AgentDetail, json: boolean): string {
	if (json) return JSON.stringify(detail, null, 2);
	if (!detail.exists) return `Agent "${detail.name}" not found at ${detail.agentDir}`;
	const lines: string[] = [];
	lines.push(`# ${detail.name}`);
	lines.push("");
	lines.push(`Path: ${detail.agentDir}`);
	lines.push("");
	if (detail.identity.length > 0) {
		lines.push("## Identity");
		for (const l of detail.identity) lines.push(`  ${l}`);
		lines.push("");
	}
	if (detail.hardConstraints.length > 0) {
		lines.push("## Hard constraints");
		for (const c of detail.hardConstraints) lines.push(`  - ${c}`);
		lines.push("");
	}
	if (detail.tools.length > 0) {
		lines.push("## Tools");
		lines.push(`  ${detail.tools.join(", ")}`);
		lines.push("");
	}
	if (detail.skills.length > 0) {
		lines.push("## Skills");
		for (const s of detail.skills) {
			lines.push(`  - ${s.name}${s.description ? ` — ${s.description}` : ""}`);
		}
		lines.push("");
	}
	lines.push("## Activity");
	lines.push(`  Cron tasks: ${detail.cronTaskCount}`);
	lines.push(`  Sessions:   ${detail.sessionCount}`);
	return lines.join("\n");
}

export function renderValidate(result: ValidateResult, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	if (result.issues.length === 0) return `✓ ${result.agentDir} — valid (no issues)`;
	const lines: string[] = [];
	for (const issue of result.issues) {
		const tag = issue.level === "error" ? "✗" : "!";
		lines.push(`${tag} ${issue.file} — ${issue.message}`);
	}
	lines.push("");
	lines.push(
		result.valid
			? "→ Valid (warnings only)"
			: `→ Invalid: ${result.issues.filter(i => i.level === "error").length} error(s)`,
	);
	return lines.join("\n");
}

// Re-export SKELETON_FILES for callers that want to enumerate the layout.
export { SKELETON_FILES };
