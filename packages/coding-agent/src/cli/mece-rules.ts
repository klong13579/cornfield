/**
 * MECE rules for `omp agent validate`.
 *
 * Each rule checks one ownership boundary violation across prompt files.
 * Rules with `repair` can auto-fix when `--fix` is passed.
 *
 * Ownership map (defined in AGENTS.md "文件职责边界"):
 *   identity          → mission.md
 *   tool rules        → TOOLS.md
 *   hard constraints  → AGENTS.md
 *   work discipline   → .omp/SYSTEM.md
 *   domain knowledge  → knowledge/handbook/*
 *   data source URLs  → knowledge/external-workspaces.md
 *   dws command ref   → .omp/skills/dws/SKILL.md
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface MeceContext {
	/** relPath → file content (only prompt-relevant files are loaded) */
	files: Map<string, string>;
	/** absolute agentDir path */
	agentDir: string;
}

export interface MeceViolation {
	rule: string;
	file: string;
	line?: number;
	message: string;
	repairable: boolean;
}

export interface MeceRepair {
	changes: { file: string; newContent: string }[];
	/** Filesystem operations to perform after content changes (e.g., delete deprecated dirs) */
	fsOps?: { type: "rmdir"; path: string }[];
	summary: string;
}

export interface MeceRule {
	id: string;
	severity: "error" | "warning";
	description: string;
	check: (ctx: MeceContext) => MeceViolation[] | Promise<MeceViolation[]>;
	repair?: (ctx: MeceContext, violations: MeceViolation[]) => MeceRepair;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function getFile(ctx: MeceContext, rel: string): string | undefined {
	return ctx.files.get(rel);
}

function linesOf(text: string): string[] {
	return text.split("\n");
}

/** Lines matching `predicate`, returned with their 1-indexed line numbers. */
function findLines(text: string, predicate: (line: string) => boolean): { line: number; content: string }[] {
	const result: { line: number; content: string }[] = [];
	const lines = linesOf(text);
	for (let i = 0; i < lines.length; i++) {
		if (predicate(lines[i]!)) {
			result.push({ line: i + 1, content: lines[i]! });
		}
	}
	return result;
}

// ────────────────────────────────────────────────────────────────────────────
// R1: no-skeleton-placeholder
// ────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS: RegExp[] = [
	/⚠️\s*\*\*请编辑本文件/,
	/<机器人名>/,
	/> Append project-specific tools here/i,
	/-\s*\[.\]\s*任务\s*[12]/,
	/YYYY-MM-DD\s+HH:MM\s*—\s*任务起点/,
];

const noSkeletonPlaceholder: MeceRule = {
	id: "no-skeleton-placeholder",
	severity: "warning",
	description: "No skeleton placeholder text should remain in prompt files",
	check(ctx) {
		const violations: MeceViolation[] = [];
		for (const [rel, content] of ctx.files) {
			for (const pattern of PLACEHOLDER_PATTERNS) {
				const matches = findLines(content, line => pattern.test(line));
				for (const m of matches) {
					violations.push({
						rule: this.id,
						file: rel,
						line: m.line,
						message: `Skeleton placeholder residue: "${m.content.trim().slice(0, 60)}"`,
						repairable: true,
					});
				}
			}
		}
		return violations;
	},
	repair(ctx) {
		const changes: { file: string; newContent: string }[] = [];
		for (const [rel, content] of ctx.files) {
			let modified = content;
			for (const pattern of PLACEHOLDER_PATTERNS) {
				modified = modified
					.split("\n")
					.filter(line => !pattern.test(line))
					.join("\n");
			}
			// Clean up: collapse 3+ consecutive blank lines to 2
			modified = modified.replace(/\n{3,}/g, "\n\n");
			// Trim trailing blank lines, ensure single trailing newline
			modified = modified.replace(/\s+$/g, "\n");
			if (modified !== content) {
				changes.push({ file: rel, newContent: modified });
			}
		}
		return { changes, summary: `Removed skeleton placeholders from ${changes.length} file(s)` };
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R2: no-tool-list-in-mission
// ────────────────────────────────────────────────────────────────────────────

const TOOL_LIST_RE = /^-\s+使用\s+`(read|search|find|bash|write|edit|ast_grep|ast_edit|lsp|grep)`\s/;
// Reference lines that are allowed (don't list specific tools, just point to TOOLS.md)
const TOOL_REF_RE = /见\s+`?TOOLS\.md|不重复工具列表|工具.*见.*TOOLS/i;

const noToolListInMission: MeceRule = {
	id: "no-tool-list-in-mission",
	severity: "warning",
	description: "mission.md should not list specific tools (TOOLS.md's responsibility)",
	check(ctx) {
		const mission = getFile(ctx, "mission.md");
		if (!mission) return [];
		const matches = findLines(mission, line => TOOL_LIST_RE.test(line) && !TOOL_REF_RE.test(line));
		return matches.map(m => ({
			rule: this.id,
			file: "mission.md",
			line: m.line,
			message: `Tool list in mission.md (belongs in TOOLS.md): "${m.content.trim()}"`,
			repairable: true,
		}));
	},
	repair(ctx) {
		const mission = getFile(ctx, "mission.md");
		if (!mission) return { changes: [], summary: "No mission.md to repair" };
		const lines = linesOf(mission);
		const filtered = lines.filter(line => !(TOOL_LIST_RE.test(line) && !TOOL_REF_RE.test(line)));
		// If we removed lines, ensure there's a reference to TOOLS.md
		const hasRef = filtered.some(line => TOOL_REF_RE.test(line));
		let newContent = filtered.join("\n");
		if (!hasRef) {
			// Add a reference under the 工具 section if it exists
			newContent = newContent.replace(
				/(##\s*工具[^\n]*)/,
				"$1\n\n- 工具使用规则见 `TOOLS.md`（always-on），此处不重复。",
			);
		}
		newContent = newContent.replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "\n");
		return {
			changes: [{ file: "mission.md", newContent }],
			summary: "Replaced tool list in mission.md with reference to TOOLS.md",
		};
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R3: no-safety-duplication
// ────────────────────────────────────────────────────────────────────────────

const MUST_NOT_RE = /^-\s*(MUST\s+NOT|NEVER)\s/i;

const noSafetyDuplication: MeceRule = {
	id: "no-safety-duplication",
	severity: "warning",
	description: "SYSTEM.md should not duplicate MUST NOT/NEVER lines from AGENTS.md",
	check(ctx) {
		const agents = getFile(ctx, "AGENTS.md");
		const system = getFile(ctx, ".omp/SYSTEM.md");
		if (!agents || !system) return [];

		// Extract MUST NOT / NEVER lines from AGENTS.md hard-constraints section
		const agentsLines = linesOf(agents);
		const hardConstraintLines = new Set<string>();
		let inHardConstraints = false;
		for (const line of agentsLines) {
			if (/##\s*Global hard constraints/i.test(line)) {
				inHardConstraints = true;
				continue;
			}
			if (inHardConstraints && /^##\s/.test(line)) {
				inHardConstraints = false;
			}
			if (inHardConstraints && MUST_NOT_RE.test(line)) {
				hardConstraintLines.add(line.trim());
			}
		}

		const violations: MeceViolation[] = [];
		const systemLines = linesOf(system);
		for (let i = 0; i < systemLines.length; i++) {
			const trimmed = systemLines[i]!.trim();
			if (MUST_NOT_RE.test(systemLines[i]!)) {
				// Check if this line's constraint text matches any AGENTS.md line
				for (const agentsLine of hardConstraintLines) {
					// Normalize both for comparison: remove leading "- MUST NOT" / "- NEVER"
					const normalize = (s: string) => s.replace(/^-\s*(MUST\s+NOT|NEVER)\s+/i, "").trim();
					if (normalize(trimmed) === normalize(agentsLine)) {
						violations.push({
							rule: this.id,
							file: ".omp/SYSTEM.md",
							line: i + 1,
							message: `Duplicates AGENTS.md hard constraint: "${trimmed.slice(0, 60)}"`,
							repairable: true,
						});
					}
				}
			}
		}
		return violations;
	},
	repair(ctx) {
		const agents = getFile(ctx, "AGENTS.md");
		const system = getFile(ctx, ".omp/SYSTEM.md");
		if (!agents || !system) return { changes: [], summary: "Nothing to repair" };

		const agentsLines = linesOf(agents);
		const hardConstraintTexts = new Set<string>();
		let inHardConstraints = false;
		for (const line of agentsLines) {
			if (/##\s*Global hard constraints/i.test(line)) {
				inHardConstraints = true;
				continue;
			}
			if (inHardConstraints && /^##\s/.test(line)) {
				inHardConstraints = false;
			}
			if (inHardConstraints && MUST_NOT_RE.test(line)) {
				const normalize = (s: string) => s.replace(/^-\s*(MUST\s+NOT|NEVER)\s+/i, "").trim();
				hardConstraintTexts.add(normalize(line));
			}
		}

		const systemLines = linesOf(system);
		const filtered = systemLines.filter(line => {
			if (!MUST_NOT_RE.test(line)) return true;
			const normalize = (s: string) => s.replace(/^-\s*(MUST\s+NOT|NEVER)\s+/i, "").trim();
			return !hardConstraintTexts.has(normalize(line));
		});

		// Check if a reference to AGENTS.md already exists
		const hasRef = filtered.some(line => /AGENTS\.md.*hard.constraint|hard.constraint.*AGENTS\.md/i.test(line));
		let newContent = filtered.join("\n");
		if (!hasRef) {
			// Insert reference after the 安全与授权 heading
			newContent = newContent.replace(
				/(##\s*安全[^\n]*)/,
				"$1\n\n> 硬约束见 `AGENTS.md`，此处不重复。",
			);
		}
		newContent = newContent.replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "\n");
		return {
			changes: [{ file: ".omp/SYSTEM.md", newContent }],
			summary: "Removed duplicated hard constraints from SYSTEM.md, added reference to AGENTS.md",
		};
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R4: no-space-urls-in-mission
// ────────────────────────────────────────────────────────────────────────────

const ALIDOC_URL_RE = /alidocs\.dingtalk\.com/i;

const noSpaceUrlsInMission: MeceRule = {
	id: "no-space-urls-in-mission",
	severity: "warning",
	description: "mission.md should not contain alidocs URLs (external-workspaces.md's responsibility)",
	check(ctx) {
		const mission = getFile(ctx, "mission.md");
		if (!mission) return [];
		const matches = findLines(mission, line => ALIDOC_URL_RE.test(line));
		return matches.map(m => ({
			rule: this.id,
			file: "mission.md",
			line: m.line,
			message: `Space URL in mission.md (belongs in external-workspaces.md): "${m.content.trim().slice(0, 60)}"`,
			repairable: true,
		}));
	},
	repair(ctx) {
		const mission = getFile(ctx, "mission.md");
		if (!mission) return { changes: [], summary: "No mission.md to repair" };
		const lines = linesOf(mission);
		const filtered = lines.filter(line => !ALIDOC_URL_RE.test(line));
		let newContent = filtered.join("\n");
		// Add reference if not present
		if (!/external-workspaces\.md/i.test(newContent)) {
			newContent = newContent.replace(
				/(##\s*知识库[^\n]*)/,
				"$1\n\n> 完整数据源 URL 见 `knowledge/external-workspaces.md`。",
			);
		}
		newContent = newContent.replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "\n");
		return {
			changes: [{ file: "mission.md", newContent }],
			summary: "Removed alidocs URLs from mission.md, added reference to external-workspaces.md",
		};
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R5: no-dws-commands-in-tools
// ────────────────────────────────────────────────────────────────────────────

// Match lines like "- `dws wiki space list`" or "- dws doc list --workspace"
const DWS_CMD_RE = /^[-\s]*`?dws\s+\w+\s+\w+/;
// Constraint lines (MUST/MUST NOT) are allowed
const CONSTRAINT_RE = /^[-\s]*(MUST|MUST\s+NOT|NEVER)\b/i;

const noDwsCommandsInTools: MeceRule = {
	id: "no-dws-commands-in-tools",
	severity: "warning",
	description: "TOOLS.md should not contain dws command examples (skill://dws's responsibility)",
	check(ctx) {
		const tools = getFile(ctx, "TOOLS.md");
		if (!tools) return [];
		const matches = findLines(tools, line => DWS_CMD_RE.test(line) && !CONSTRAINT_RE.test(line));
		return matches.map(m => ({
			rule: this.id,
			file: "TOOLS.md",
			line: m.line,
			message: `dws command in TOOLS.md (belongs in skill://dws): "${m.content.trim().slice(0, 60)}"`,
			repairable: true,
		}));
	},
	repair(ctx) {
		const tools = getFile(ctx, "TOOLS.md");
		if (!tools) return { changes: [], summary: "No TOOLS.md to repair" };
		const lines = linesOf(tools);
		const filtered = lines.filter(line => !(DWS_CMD_RE.test(line) && !CONSTRAINT_RE.test(line)));
		let newContent = filtered.join("\n");
		// Add reference if not present
		if (!/skill:\/\/dws/i.test(newContent)) {
			// Insert after the dws section heading
			newContent = newContent.replace(
				/(###\s*`dws`[^\n]*)/,
				"$1\n\n- 完整命令速查见 `skill://dws`。",
			);
		}
		newContent = newContent.replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "\n");
		return {
			changes: [{ file: "TOOLS.md", newContent }],
			summary: "Removed dws command examples from TOOLS.md, added reference to skill://dws",
		};
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R6: skills-path-format
// ────────────────────────────────────────────────────────────────────────────

const OLD_SKILLS_PATH_RE = /\.omp\/skills\/<name>\.md/;
const NEW_SKILLS_PATH = ".omp/skills/<name>/SKILL.md";

const skillsPathFormat: MeceRule = {
	id: "skills-path-format",
	severity: "error",
	description: "AGENTS.md File Map should use .omp/skills/<name>/SKILL.md (not <name>.md)",
	check(ctx) {
		const agents = getFile(ctx, "AGENTS.md");
		if (!agents) return [];
		const matches = findLines(agents, line => OLD_SKILLS_PATH_RE.test(line));
		return matches.map(m => ({
			rule: this.id,
			file: "AGENTS.md",
			line: m.line,
			message: `Skills path format is <name>.md, should be <name>/SKILL.md`,
			repairable: true,
		}));
	},
	repair(ctx) {
		const agents = getFile(ctx, "AGENTS.md");
		if (!agents) return { changes: [], summary: "No AGENTS.md to repair" };
		const newContent = agents.replace(OLD_SKILLS_PATH_RE, NEW_SKILLS_PATH);
		return {
			changes: [{ file: "AGENTS.md", newContent }],
			summary: "Fixed skills path format in AGENTS.md",
		};
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R7: filemap-accuracy
// ────────────────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";

const filemapAccuracy: MeceRule = {
	id: "filemap-accuracy",
	severity: "warning",
	description: "AGENTS.md File Map paths should match actual files on disk",
	async check(ctx) {
		const agents = getFile(ctx, "AGENTS.md");
		if (!agents) return [];
		const violations: MeceViolation[] = [];
		// Extract paths from File Map table rows
		const tableRowRe = /^\|\s*`([^`]+)`\s*\|/;
		const lines = linesOf(agents);
		let inFileMap = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (/##\s*File Map/i.test(line)) {
				inFileMap = true;
				continue;
			}
			if (inFileMap && /^##\s/.test(line)) {
				inFileMap = false;
			}
			if (!inFileMap) continue;
			const m = tableRowRe.exec(line);
			if (!m) continue;
			const relPath = m[1]!;
			// Skip wildcard paths and placeholder patterns like <name>
			if (relPath.includes("*") || relPath.includes("<")) continue;
			// Skip optional files marker
			if (relPath.includes("(optional)") || relPath.includes("(可选)")) continue;
			const fullPath = path.join(ctx.agentDir, relPath);
			try {
				await fs.access(fullPath);
			} catch {
				violations.push({
					rule: this.id,
					file: "AGENTS.md",
					line: i + 1,
					message: `File Map lists "${relPath}" but file does not exist on disk`,
					repairable: false,
				});
			}
		}
		return violations;
	},
};

// ────────────────────────────────────────────────────────────────────────────
// R8: no-deprecated-agent-dir
// ────────────────────────────────────────────────────────────────────────────

const DEPRECATED_AGENT_PATH_RE = /\.agent\//;

const noDeprecatedAgentDir: MeceRule = {
	id: "no-deprecated-agent-dir",
	severity: "error",
	description: "No .agent/ directory should exist (deprecated, replaced by .omp/)",
	async check(ctx) {
		const violations: MeceViolation[] = [];

		// Check 1: .agent/ directory exists on disk
		const agentDirPath = path.join(ctx.agentDir, ".agent");
		try {
			await fs.access(agentDirPath);
			violations.push({
				rule: this.id,
				file: ".agent/",
				message: "Deprecated .agent/ directory exists (should be .omp/)",
				repairable: true,
			});
		} catch {
			// .agent/ doesn't exist — good
		}

		// Check 2: AGENTS.md references .agent/ paths
		const agents = getFile(ctx, "AGENTS.md");
		if (agents) {
			const matches = findLines(agents, line => DEPRECATED_AGENT_PATH_RE.test(line));
			for (const m of matches) {
				violations.push({
					rule: this.id,
					file: "AGENTS.md",
					line: m.line,
					message: `References deprecated .agent/ path: "${m.content.trim().slice(0, 60)}"`,
					repairable: true,
				});
			}
		}

		return violations;
	},
	repair(ctx) {
		const changes: { file: string; newContent: string }[] = [];
		const fsOps: { type: "rmdir"; path: string }[] = [];

		// Fix AGENTS.md references
		const agents = getFile(ctx, "AGENTS.md");
		if (agents && DEPRECATED_AGENT_PATH_RE.test(agents)) {
			// Line-by-line: .agent/SYSTEM.md → .omp/SYSTEM.md (valid mapping),
			// other .agent/ paths (prompts/, rules/) are deleted — new design has no equivalent.
			const lines = linesOf(agents);
			const fixed = lines
				.map(line => {
					if (/\.agent\/SYSTEM\.md/.test(line)) {
						return line.replace(/\.agent\/SYSTEM\.md/g, ".omp/SYSTEM.md");
					}
					if (DEPRECATED_AGENT_PATH_RE.test(line)) {
						return null; // delete line
					}
					return line;
				})
				.filter((line): line is string => line !== null)
				.join("\n");
			changes.push({ file: "AGENTS.md", newContent: fixed });
		}

		// Delete .agent/ directory
		fsOps.push({ type: "rmdir", path: ".agent" });

		return {
			changes,
			fsOps,
			summary: "Removed deprecated .agent/ directory and fixed AGENTS.md references",
		};
	},
};


// ────────────────────────────────────────────────────────────────────────────
// Rule registry
// ────────────────────────────────────────────────────────────────────────────

export const MECE_RULES: MeceRule[] = [
	noSkeletonPlaceholder,
	noToolListInMission,
	noSafetyDuplication,
	noSpaceUrlsInMission,
	noDwsCommandsInTools,
	skillsPathFormat,
	filemapAccuracy,
	noDeprecatedAgentDir,
];

/** Files that MECE rules need to read (rel paths from agentDir root). */
export const MECE_FILES: ReadonlyArray<string> = [
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"TODO.md",
	"knowledge/external-workspaces.md",
	".omp/SYSTEM.md",
];

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

export interface MeceResult {
	violations: MeceViolation[];
	repaired: MeceRepair[];
}

export async function runMeceChecks(ctx: MeceContext): Promise<MeceViolation[]> {
	const allViolations: MeceViolation[] = [];
	for (const rule of MECE_RULES) {
		const violations = await rule.check(ctx);
		allViolations.push(...violations);
	}
	return allViolations;
}

export function runMeceRepairs(
	ctx: MeceContext,
	violations: MeceViolation[],
): MeceRepair[] {
	const repairs: MeceRepair[] = [];
	const repairableViolations = violations.filter(v => v.repairable);
	if (repairableViolations.length === 0) return repairs;

	// Group violations by rule
	const byRule = new Map<string, MeceViolation[]>();
	for (const v of repairableViolations) {
		const list = byRule.get(v.rule) ?? [];
		list.push(v);
		byRule.set(v.rule, list);
	}

	// Run repairs per rule
	for (const rule of MECE_RULES) {
		const ruleViolations = byRule.get(rule.id);
		if (!ruleViolations || !rule.repair) continue;
		const repair = rule.repair(ctx, ruleViolations);
		if (repair.changes.length > 0) {
			// Apply changes to the context so subsequent rules see updated content
			for (const change of repair.changes) {
				ctx.files.set(change.file, change.newContent);
			}
			repairs.push(repair);
		}
	}
	return repairs;
}
