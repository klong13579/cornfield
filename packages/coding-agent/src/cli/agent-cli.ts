/**
 * `omp agent` subcommand handlers.
 *
 * Pure functions (no Command class) so they can be unit-tested without
 * standing up the CLI parser. The Command class in `../commands/agent.ts`
 * is a thin dispatcher that calls these.
 *
 * Subcommands (per `packages/coding-agent/docs/agent-design-v1.md` §6.2):
 *   - init <name>     create a new agentDir
 *   - list            list agentDirs under ~/.omp/agents/
 *   - show <name>     print identity / tools / skills / cron summary
 *   - validate <dir>  check always-on files + runtime artifacts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureAgentDir,
	findAgent,
	pruneStaleEntries,
	reconcileSkeletonFiles,
	registerAgent,
	resolveAgentDir,
	SKELETON_FILES,
	unregisterAgent,
} from "@oh-my-pi/pi-coding-agent/skeleton";
import { MECE_FILES, type MeceContext, runMeceChecks, runMeceRepairs } from "./mece-rules";
import { runSemanticAudit, type SemanticViolation } from "./semantic-audit";

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

	// Persist the (name, path) mapping so `omp agent list` / `show` can find
	// this agentDir regardless of where it lives (default `~/.omp/agents/`,
	// custom `--dir`, nested account id like `ops/hr`).
	await registerAgent(args.name, agentDir, args.template ?? "default");

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
	/** True if this entry was found in the registry; false if discovered via directory scan. */
	registered: boolean;
}

export type AgentStatus = "active" | "incomplete" | "broken";

export async function runAgentList(args: ListArgs): Promise<AgentSummary[]> {
	const summaries: AgentSummary[] = [];
	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();

	// Step 1: read the registry so custom `--dir` paths (e.g. `OMP-workspace-test/hr3`)
	// are visible without the user having to pass `--dir` again.
	if (!args.dir) {
		const { listRegistered } = await import("@oh-my-pi/pi-coding-agent/skeleton");
		const registered = await listRegistered();
		for (const { name, entry } of registered) {
			const status = await probeAgentStatus(entry.path);
			summaries.push({ name, agentDir: entry.path, status, registered: true });
			seenNames.add(name);
			seenPaths.add(entry.path);
		}
	}

	// Step 2: scan the directory (default `~/.omp/agents/`, or `--dir` if given).
	// This picks up legacy agentDirs created before the registry existed and entries
	// the user dropped into the default location without going through `omp agent init`.
	const root = path.resolve(args.dir ?? path.join(homeDir(), ".omp", "agents"));
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// root doesn't exist — that's fine if registry produced all results
		} else {
			throw err;
		}
		entries = [];
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		if (seenPaths.has(dir)) continue;
		// If a name is already registered, the registry entry wins (it's the
		// source of truth for where the agentDir lives).
		if (seenNames.has(entry.name)) continue;
		const status = await probeAgentStatus(dir);
		summaries.push({ name: entry.name, agentDir: dir, status, registered: false });
		seenNames.add(entry.name);
	}

	// Stable order: by name.
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}

/** `process.env.HOME ?? os.homedir()` so tests can point HOME at a temp dir. */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
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
	let agentDir: string;
	if (args.dir) {
		// Explicit --dir: same parent/name resolution as init.
		let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
		try {
			stat = await fs.stat(args.dir);
		} catch {
			stat = null;
		}
		agentDir = stat?.isDirectory() ? path.join(args.dir, args.name) : path.resolve(args.dir);
	} else {
		// Registry lookup first so custom --dir paths (e.g. nested account ids
		// like `ops/hr` stored under a non-default location) are found without
		// the user having to pass --dir again.
		const { findAgent } = await import("@oh-my-pi/pi-coding-agent/skeleton");
		const entry = await findAgent(args.name);
		agentDir = entry?.path ?? path.join(homeDir(), ".omp", "agents", args.name);
	}

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
		if (!entry.isDirectory()) continue;
		// Scan for SKILL.md inside each subdirectory — mirrors scanSkillsFromDir behavior
		const skillDir = path.join(skillsDir, entry.name);
		const skillMdPath = path.join(skillDir, "SKILL.md");
		try {
			await fs.access(skillMdPath);
			const desc = await readSkillDescription(skillMdPath);
			out.push({ name: entry.name, ...(desc ? { description: desc } : {}) });
		} catch {
			// No SKILL.md in this subdirectory — skip
		}
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
	fix?: boolean;
}

export interface ValidateIssue {
	level: "error" | "warning";
	file: string;
	message: string;
	rule?: string;
	repairable?: boolean;
}

export interface ValidateResult {
	agentDir: string;
	issues: ValidateIssue[];
	valid: boolean;
	mece?: {
		violations: import("./mece-rules").MeceViolation[];
		repaired: import("./mece-rules").MeceRepair[];
	};
	semantic?: {
		violations: SemanticViolation[];
		model?: string;
		error?: string;
	};
}

const ALWAYS_ON: ReadonlyArray<string> = [
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"TODO.md",
	"knowledge/external-workspaces.md",
];

const RUNTIME_HARD_DEPS: ReadonlyArray<string> = [".omp/config.yml"];

const RUNTIME_RECOMMENDED: ReadonlyArray<string> = ["prompt-includes.json", ".gitignore", ".omp/SYSTEM.md"];

export async function runAgentValidate(args: ValidateArgs): Promise<ValidateResult> {
	const agentDir = path.resolve(args.agentDir);
	const issues: ValidateIssue[] = [];

	// 0. Skeleton repair (--fix only): create missing skeleton dirs/files + reconcile existing
	if (args.fix) {
		await ensureAgentDir(agentDir);
		await reconcileSkeletonFiles(agentDir);
	}

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

	// 6. MECE validation
	const meceCtx: MeceContext = {
		files: new Map(),
		agentDir,
	};
	for (const rel of MECE_FILES) {
		const filePath = path.join(agentDir, rel);
		try {
			const content = await Bun.file(filePath).text();
			meceCtx.files.set(rel, content);
		} catch {
			// File missing — already flagged by checks 1-3
		}
	}

	const meceViolations = await runMeceChecks(meceCtx);
	let meceRepaired: import("./mece-rules").MeceRepair[] = [];

	if (args.fix && meceViolations.some(v => v.repairable)) {
		meceRepaired = runMeceRepairs(meceCtx, meceViolations);
		// Write repaired files back to disk
		for (const repair of meceRepaired) {
			for (const change of repair.changes) {
				const filePath = path.join(agentDir, change.file);
				await Bun.write(filePath, change.newContent);
			}
			// Execute filesystem operations (e.g., delete deprecated dirs)
			if (repair.fsOps) {
				for (const op of repair.fsOps) {
					if (op.type === "rmdir") {
						await fs.rm(path.join(agentDir, op.path), { recursive: true, force: true });
					}
				}
			}
		}
	}

	// Convert MECE violations to issues (skip repaired ones)
	for (const v of meceViolations) {
		if (args.fix && v.repairable) continue;
		issues.push({
			level: v.rule === "skills-path-format" || v.rule === "no-deprecated-agent-dir" ? "error" : "warning",
			file: v.file,
			message: v.message,
			rule: v.rule,
			repairable: v.repairable,
		});
	}

	// 7. Semantic MECE audit (always-on via LLM)
	let semanticResult: ValidateResult["semantic"];
	semanticResult = await runSemanticPhase(agentDir, meceCtx);
	// Merge semantic violations into issues as warnings
	for (const sv of semanticResult.violations) {
		issues.push({
			level: sv.severity,
			file: sv.files.join(", ") || "(multiple)",
			message: sv.message,
			rule: `semantic:${sv.rule}`,
			repairable: false,
		});
	}

	return {
		agentDir,
		issues,
		valid: !issues.some(i => i.level === "error"),
		mece: {
			violations: meceViolations,
			repaired: meceRepaired,
		},
		...(semanticResult ? { semantic: semanticResult } : {}),
	};
}

// ────────────────────────────────────────────────────────────────────────────
// semantic audit helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve model + apiKey from agentDir's .omp/config.yml, then run semantic audit.
 * Falls back to global Settings default model if agentDir config is missing.
 * Returns { violations: [] } with error set if model/apiKey unavailable.
 */
async function runSemanticPhase(
	agentDir: string,
	meceCtx: MeceContext,
): Promise<{ violations: SemanticViolation[]; model?: string; error?: string }> {
	// Wrap in a timeout to avoid hanging on model discovery in restricted environments
	const TIMEOUT_MS = 120000; // 2 min — LLM semantic audit can take a while
	const timeoutPromise = new Promise<{ violations: SemanticViolation[]; error: string }>(resolve =>
		setTimeout(() => resolve({ violations: [], error: "Semantic audit timed out" }), TIMEOUT_MS),
	);
	const workPromise = runSemanticPhaseInner(agentDir, meceCtx);
	return Promise.race([workPromise, timeoutPromise]);
}

async function runSemanticPhaseInner(
	agentDir: string,
	meceCtx: MeceContext,
): Promise<{ violations: SemanticViolation[]; model?: string; error?: string }> {
	try {
		// Read agentDir's .omp/config.yml for modelRoles.default
		const configPath = path.join(agentDir, ".omp", "config.yml");
		let modelRoleStr: string | undefined;
		try {
			const configText = await Bun.file(configPath).text();
			if (typeof Bun.YAML?.parse === "function") {
				const parsed = Bun.YAML.parse(configText) as Record<string, unknown>;
				const roles = parsed?.modelRoles as Record<string, string> | undefined;
				modelRoleStr = roles?.default ?? roles?.smol;
			}
		} catch {
			// Config read failed — fall back to global
		}

		// Use global Settings + ModelRegistry to resolve the model
		const { Settings } = await import("../config/settings");
		const { ModelRegistry } = await import("../config/model-registry");
		const { resolveRoleSelection } = await import("../config/model-resolver");
		const { discoverAuthStorage } = await import("../sdk");

		const settings = await Settings.init();
		const authStorage = await discoverAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		// Use offline-first refresh to avoid long network timeouts in CI/test
		// environments. If cached models exist, they'll be used; otherwise falls back.
		try {
			await modelRegistry.refresh("offline");
		} catch {
			// Offline refresh failed — try online-if-uncached with a timeout
			await Promise.race([
				modelRegistry.refresh("online-if-uncached"),
				new Promise<void>(resolve => setTimeout(resolve, 15000)),
			]).catch(() => {});
		}

		// If agentDir config specifies a model, override the default role
		if (modelRoleStr) {
			settings.setModelRole("default", modelRoleStr);
		}

		const available = modelRegistry.getAvailable();
		const resolved = resolveRoleSelection(
			["default", "smol", ...MODEL_ROLE_IDS_FALLBACK],
			settings,
			available,
			modelRegistry,
		);

		if (!resolved?.model) {
			return { violations: [], error: "No model available for semantic audit" };
		}

		const apiKey = await modelRegistry.getApiKey(resolved.model);
		if (!apiKey) {
			return { violations: [], error: `No API key for model ${resolved.model.provider}/${resolved.model.id}` };
		}

		const violations = await runSemanticAudit(meceCtx, {
			model: resolved.model,
			apiKey,
			thinkingLevel: resolved.thinkingLevel,
		});

		return {
			violations,
			model: `${resolved.model.provider}/${resolved.model.id}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { violations: [], error: msg };
	}
}

const MODEL_ROLE_IDS_FALLBACK = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "task"] as const;

// ────────────────────────────────────────────────────────────────────────────
// register / unregister / reconcile
// ────────────────────────────────────────────────────────────────────────────

export interface RegisterArgs {
	name: string;
	dir?: string;
	json?: boolean;
}

export interface RegisterResult {
	name: string;
	agentDir: string;
	registered: boolean;
}

export async function runAgentRegister(args: RegisterArgs): Promise<RegisterResult> {
	if (!args.name || args.name.includes("\0")) {
		throw new Error(`Invalid agent name: "${args.name}". Names cannot contain NUL.`);
	}
	if (args.name.split(/[/\\]/).some(seg => seg === "..")) {
		throw new Error(`Invalid agent name: "${args.name}". Names cannot contain '..' segments.`);
	}
	if (!args.dir) {
		throw new Error("register requires --dir <path> (or positional dir): the path to the existing agentDir.");
	}
	// For register, `dir` is the full path to the existing agentDir (unlike init,
	// which uses dir as a parent and appends <name>). Users point at the dir they
	// want to track; we don't try to derive a child path.
	const agentDir = path.resolve(args.dir);
	if (!(await pathExists(agentDir))) {
		throw new Error(`AgentDir does not exist: ${agentDir}`);
	}
	const stat = await fs.stat(agentDir);
	if (!stat.isDirectory()) {
		throw new Error(`Path is not a directory: ${agentDir}`);
	}
	await registerAgent(args.name, agentDir, "default");
	return { name: args.name, agentDir, registered: true };
}

export interface UnregisterArgs {
	name: string;
	/** Also rm -rf the agentDir directory on disk. Off by default. */
	deleteFiles?: boolean;
	json?: boolean;
}

export interface UnregisterResult {
	name: string;
	removed: boolean;
	/** agentDir path that was registered (when the entry existed). */
	agentDir?: string;
	/** Echo of the --delete-files flag, for renderer transparency. */
	deleteFiles?: boolean;
	/** True if --delete-files actually deleted a directory from disk. */
	deletedFiles?: boolean;
}

export async function runAgentUnregister(args: UnregisterArgs): Promise<UnregisterResult> {
	// Look up first so we still know the path after unregisterAgent wipes the entry.
	const entry = await findAgent(args.name);

	let deletedFiles: boolean | undefined;
	if (args.deleteFiles && entry) {
		// Safety: never wipe filesystem root, even if a corrupt registry points there.
		// Run the safety check + rm BEFORE unregisterAgent so a throw leaves the
		// registry entry intact — the user can retry or re-register.
		if (entry.path === "/" || entry.path === "") {
			throw new Error(
				`Refusing to --delete-files a path of "${entry.path}". Check the registry entry for "${args.name}".`,
			);
		}
		const stat = await fs.stat(entry.path).catch(() => null);
		if (stat?.isDirectory()) {
			await fs.rm(entry.path, { recursive: true, force: true });
			deletedFiles = true;
		} else {
			deletedFiles = false;
		}
	}

	const removed = await unregisterAgent(args.name);

	return {
		name: args.name,
		removed,
		...(entry ? { agentDir: entry.path } : {}),
		...(args.deleteFiles ? { deleteFiles: true, deletedFiles: deletedFiles ?? false } : {}),
	};
}

export interface ReconcileArgs {
	json?: boolean;
}

export interface ReconcileResult {
	pruned: string[];
	registered: string[];
	skipped: string[];
}

/**
 * Reconcile the registry against the filesystem:
 *   1. Remove entries whose path no longer exists.
 *   2. Scan the default `~/.omp/agents/` for agentDirs not yet in the registry
 *      and add them (so legacy agents are visible).
 *   3. Surface names that could not be auto-registered.
 */
export async function runAgentReconcile(_args: ReconcileArgs = {}): Promise<ReconcileResult> {
	const pruned = await pruneStaleEntries();
	const { listRegistered, registerAgent: reg } = await import("@oh-my-pi/pi-coding-agent/skeleton");
	const existing = await listRegistered();
	const knownPaths = new Set(existing.map(e => e.entry.path));

	const registered: string[] = [];
	const skipped: string[] = [];
	const defaultRoot = path.join(homeDir(), ".omp", "agents");
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(defaultRoot, { withFileTypes: true });
	} catch {
		entries = [];
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const fullPath = path.join(defaultRoot, e.name);
		if (knownPaths.has(fullPath)) continue;
		try {
			await reg(e.name, fullPath, "default");
			registered.push(e.name);
		} catch {
			skipped.push(e.name);
		}
	}

	return { pruned, registered, skipped };
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
	const header: [string, string, string, string] = ["NAME", "AGENT_DIR", "STATUS", "REG"];
	const rows: Array<[string, string, string, string]> = summaries.map(s => [
		s.name,
		s.agentDir,
		s.status,
		s.registered ? "*" : "",
	]);
	const widths = [0, 0, 0, 0];
	for (const r of rows) for (let i = 0; i < 4; i++) widths[i] = Math.max(widths[i]!, r[i]!.length);
	for (let i = 0; i < 4; i++) widths[i] = Math.max(widths[i]!, header[i]!.length);
	const fmt = (cells: [string, string, string, string]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i]! + (i < 3 ? colGap : 0)))
			.join("")
			.trimEnd();
	const lines: string[] = [fmt(header), "─".repeat(widths.reduce((a, b) => a + b, 0) + colGap * 3), ...rows.map(fmt)];
	lines.push("");
	lines.push("REG: *=registered in ~/.omp/agent/registry.json  (blank)=filesystem scan only");
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
	const lines: string[] = [];

	// Issues
	if (result.issues.length === 0) {
		lines.push(`✓ ${result.agentDir} — valid (no issues)`);
	} else {
		for (const issue of result.issues) {
			const tag = issue.level === "error" ? "✗" : "!";
			const repair = issue.repairable ? " [auto-repairable]" : "";
			lines.push(`${tag} ${issue.file} — ${issue.message}${repair}`);
		}
		lines.push("");
		lines.push(
			result.valid
				? "→ Valid (warnings only)"
				: `→ Invalid: ${result.issues.filter(i => i.level === "error").length} error(s)`,
		);
	}

	// MECE repair summary
	if (result.mece?.repaired && result.mece.repaired.length > 0) {
		lines.push("");
		lines.push("MECE auto-repairs applied:");
		for (const repair of result.mece.repaired) {
			lines.push(`  + ${repair.summary}`);
		}
	}

	// Semantic violations are already in issues, but add a summary
	if (result.semantic) {
		lines.push("");
		if (result.semantic.error) {
			lines.push(`Semantic audit: skipped (${result.semantic.error})`);
		} else {
			const count = result.semantic.violations.length;
			const modelTag = result.semantic.model ? ` (model: ${result.semantic.model})` : "";
			lines.push(`Semantic audit: ${count} violation${count === 1 ? "" : "s"} found${modelTag}`);
			for (const sv of result.semantic.violations) {
				lines.push(`  [${sv.rule}] ${sv.message}`);
				if (sv.files.length > 0) {
					lines.push(`    files: ${sv.files.join(", ")}`);
				}
				if (sv.suggestion) {
					lines.push(`    fix: ${sv.suggestion}`);
				}
			}
		}
	}

	return lines.join("\n");
}

// Re-export SKELETON_FILES for callers that want to enumerate the layout.
export { SKELETON_FILES };

export function renderRegister(result: RegisterResult, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	return `✓ Registered ${result.name} -> ${result.agentDir}`;
}

export function renderUnregister(result: UnregisterResult, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	if (!result.removed) return `! ${result.name} was not in the registry`;
	const where = result.agentDir ? `: ${result.agentDir}` : "";
	if (result.deletedFiles) return `✓ Unregistered ${result.name}; deleted agentDir${where}`;
	if (result.deleteFiles) {
		return result.agentDir
			? `✓ Unregistered ${result.name}; --delete-files had nothing to delete at ${result.agentDir}`
			: `✓ Unregistered ${result.name}; --delete-files had nothing to delete (no agentDir path)`;
	}
	return `✓ Unregistered ${result.name} (agentDir on disk is untouched${where})`;
}

export function renderReconcile(result: ReconcileResult, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	const lines: string[] = [];
	if (result.pruned.length > 0) {
		lines.push(`✗ Pruned ${result.pruned.length} stale entries: ${result.pruned.join(", ")}`);
	} else {
		lines.push("✓ No stale entries to prune");
	}
	if (result.registered.length > 0) {
		lines.push(
			`+ Auto-registered ${result.registered.length} from default location: ${result.registered.join(", ")}`,
		);
	}
	if (result.skipped.length > 0) {
		lines.push(`! Skipped ${result.skipped.length} (could not register): ${result.skipped.join(", ")}`);
	}
	return lines.join("\n");
}
