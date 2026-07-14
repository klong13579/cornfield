/**
 * agentDir skeleton creation.
 *
 * Per `packages/coding-agent/docs/agent-design-v1.md` §6.1:
 *   - `mission.md` missing → full creation (directories + content files + .gitkeep stubs).
 *   - `mission.md` present → additive update: only fill in files that are missing.
 *
 * Post-creation repair:
 *   - Legacy `.agent/SYSTEM.md` (deprecated path) is detected and removed.
 *   - `.omp/SYSTEM.md` is force-created from the skeleton template if missing.
 *
 * I/O failures bubble to the caller (gateway install / omp agent init) which decides
 * whether to abort or retry.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKELETON_FILES, type SkeletonFile } from "./assets";
import { SKELETON_DIRS } from "./dirs";

/**
 * Text prefix that identifies a legacy `.agent/SYSTEM.md` deployed by an older skeleton.
 * These files contain only comments telling the user to "leave empty" — no actionable instructions.
 * Matching files are safe to delete; customized files (non-matching) are preserved.
 */
const LEGACY_AGENT_SYSTEM_MD_PREFIX = "# 自定义系统提示词（可选）";

/**
 * Ensure `<agentDir>/.gitkeep` exists inside each skeleton directory so git tracks
 * the otherwise-empty directory. Content-bearing files are written by `writeSkeletonFiles`.
 */
async function writeGitkeepStubs(agentDir: string): Promise<void> {
	await Promise.all(
		SKELETON_DIRS.map(async dir => {
			const gitkeepPath = path.join(agentDir, dir, ".gitkeep");
			try {
				await fs.access(gitkeepPath);
				return;
			} catch {
				// fall through to create
			}
			await fs.mkdir(path.dirname(gitkeepPath), { recursive: true });
			await fs.writeFile(gitkeepPath, "", "utf-8");
		}),
	);
}

/**
 * Write all content-bearing skeleton files, skipping any that already exist.
 * Idempotent: re-running is a no-op for existing files.
 */
async function writeSkeletonFiles(agentDir: string, files: readonly SkeletonFile[]): Promise<void> {
	for (const file of files) {
		const filePath = path.join(agentDir, file.relPath);
		let exists = false;
		try {
			await fs.access(filePath);
			exists = true;
		} catch {
			exists = false;
		}
		if (exists) continue;
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, file.content, "utf-8");
	}
}

/**
 * Remove legacy `.agent/SYSTEM.md` if it matches the deprecated skeleton comment template.
 * Customized files (non-matching content) are preserved.
 */
async function removeLegacyAgentSystemMd(agentDir: string): Promise<void> {
	const filePath = path.join(agentDir, ".agent", "SYSTEM.md");
	try {
		const content = await Bun.file(filePath).text();
		if (content.startsWith(LEGACY_AGENT_SYSTEM_MD_PREFIX)) {
			await fs.rm(filePath);
		}
	} catch {
		// ENOENT → no file to clean up; fine
	}
}

/**
 * Ensure `.omp/SYSTEM.md` exists, creating it from the skeleton template if missing.
 */
async function ensureOmpSystemMd(agentDir: string): Promise<void> {
	const ompSystemMdEntry = SKELETON_FILES.find(f => f.relPath === ".omp/SYSTEM.md");
	if (!ompSystemMdEntry) return;

	const targetPath = path.join(agentDir, ".omp/SYSTEM.md");
	try {
		await fs.access(targetPath);
	} catch {
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, ompSystemMdEntry.content, "utf-8");
	}
}

/**
 * Regex to match a top-level YAML key declaration (active or commented-out).
 * Captures the key name in group 1.
 */
const TOP_LEVEL_KEY_RE = /^(?:#\s+)?([a-zA-Z_]\w+):/m;

/**
 * Relative paths of skeleton files that users heavily customize.
 * These are NEVER overwritten by `reconcileSkeletonFiles` — they
 * exist only via `writeSkeletonFiles` (create if missing).
 *
 * Rationale: the header lines of these files always match the skeleton
 * (e.g. "# AGENTS.md"), so a first-line baseline check would always
 * pass — we'd destroy user content on every --fix.
 */
const USER_CUSTOMIZED_FILES: ReadonlySet<string> = new Set([
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"TODO.md",
	"user.md",
	"knowledge/external-workspaces.md",
]);

/**
 * Number of significant lines to compare for skeleton baseline detection.
 * Applied to files whose first few lines are distinctive enough to tell
 * "still at skeleton" from "user-customized".
 */
const BASELINE_SIG_LINES = 5;

/**
 * For files the user has likely kept at skeleton baseline: overwrite with latest
 * skeleton content. Detection: read the file's first N significant lines
 * (non-empty, not `---`, not an HTML comment). If all N exactly match the
 * skeleton template's first N significant lines, the file is still
 * skeleton-derived and safe to update.
 */
async function isAtSkeletonBaseline(filePath: string, skeletonContent: string): Promise<boolean> {
	try {
		const existing = await Bun.file(filePath).text();
		const existingSig = significantLines(existing, BASELINE_SIG_LINES);
		const skelSig = significantLines(skeletonContent, BASELINE_SIG_LINES);
		if (existingSig.length !== skelSig.length) return false;
		return existingSig.every((line, i) => line === skelSig[i]);
	} catch {
		// ENOENT — file doesn't exist; treat as "not at baseline" (writeSkeletonFiles handles creation)
		return false;
	}
}

function significantLines(content: string, max: number): string[] {
	const lines: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed === "---") continue;
		if (trimmed.startsWith("<!--")) continue;
		lines.push(trimmed);
		if (lines.length >= max) break;
	}
	return lines;
}

/**
 * Extract a set of top-level YAML key names (active or commented-out) from config.yml text.
 */
function extractYamlKeys(content: string): Set<string> {
	const keys = new Set<string>();
	for (const line of content.split("\n")) {
		const m = line.match(TOP_LEVEL_KEY_RE);
		if (m) keys.add(m[1]!);
	}
	return keys;
}

/**
 * Split skeleton config.yml into "key blocks": each block starts at a top-level
 * key (active or commented-out) and continues until the next top-level key or EOF.
 * Returns `{ key, block }` in document order, skipping the preamble (lines before
 * the first key).
 */
function splitSkeletonYamlIntoBlocks(content: string): Array<{ key: string; block: string }> {
	const lines = content.split("\n");
	const blocks: Array<{ key: string; block: string }> = [];
	let currentKey: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		const m = line.match(TOP_LEVEL_KEY_RE);
		if (m) {
			if (currentKey) {
				blocks.push({ key: currentKey, block: currentLines.join("\n") });
			}
			currentKey = m[1]!;
			currentLines = [line];
		} else if (currentKey) {
			currentLines.push(line);
		}
		// lines before the first key are the preamble → discard
	}
	if (currentKey) {
		blocks.push({ key: currentKey, block: currentLines.join("\n") });
	}
	return blocks;
}

/**
 * Additively reconcile existing skeleton files with the latest skeleton template.
 *
 * - `.omp/config.yml`: YAML key-level merge — adds skeleton keys that don't exist
 *   in the existing config (text-level, preserves comments and formatting).
 * - Other skeleton files: if the file's first significant line matches the skeleton
 *   template, overwrite with latest content. Customized files (first line differs)
 *   are left untouched.
 */
export async function reconcileSkeletonFiles(agentDir: string): Promise<void> {
	const configEntry = SKELETON_FILES.find(f => f.relPath === ".omp/config.yml");
	if (configEntry) {
		await reconcileConfigYml(path.join(agentDir, configEntry.relPath), configEntry.content);
	}

	for (const entry of SKELETON_FILES) {
		if (entry.relPath === ".omp/config.yml") continue; // handled above
		if (USER_CUSTOMIZED_FILES.has(entry.relPath)) continue; // user content, never overwrite
		const filePath = path.join(agentDir, entry.relPath);
		if (await isAtSkeletonBaseline(filePath, entry.content)) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, entry.content, "utf-8");
		}
	}
}

/**
 * Reconcile `.omp/config.yml`: append skeleton key blocks whose top-level keys
 * don't exist in the current config. Preserves all existing content including
 * comments, user-chosen model roles, custom theme, etc.
 */
async function reconcileConfigYml(filePath: string, skeletonContent: string): Promise<void> {
	let existingText: string;
	try {
		existingText = await Bun.file(filePath).text();
	} catch {
		// File doesn't exist → writeSkeletonFiles handles creation; nothing to reconcile
		return;
	}

	const existingKeys = extractYamlKeys(existingText);
	const skeletonBlocks = splitSkeletonYamlIntoBlocks(skeletonContent);

	const lines: string[] = existingText.split("\n");
	let appended = false;

	for (const { key, block } of skeletonBlocks) {
		if (existingKeys.has(key)) continue;
		// Ensure a blank line before each added block (unless last line is already blank)
		if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
			lines.push("");
		}
		lines.push(block);
		appended = true;
	}

	if (appended) {
		await fs.writeFile(filePath, lines.join("\n"), "utf-8");
	}
}

/**
 * Ensure `<agentDir>` exists with the full skeleton layout.
 *
 * @returns `true` if a fresh full creation was performed (no prior `mission.md`),
 *          `false` if an additive update was performed (`mission.md` already existed).
 */
export async function ensureAgentDir(agentDir: string): Promise<boolean> {
	const missionPath = path.join(agentDir, "mission.md");
	let missionExists = false;
	try {
		await fs.access(missionPath);
		missionExists = true;
	} catch {
		missionExists = false;
	}

	if (!missionExists) {
		for (const dir of SKELETON_DIRS) {
			await fs.mkdir(path.join(agentDir, dir), { recursive: true });
		}
	}

	await writeGitkeepStubs(agentDir);
	await writeSkeletonFiles(agentDir, SKELETON_FILES);

	// Post-creation repair: clean up legacy trap file, ensure gateway prompt exists
	await removeLegacyAgentSystemMd(agentDir);
	await ensureOmpSystemMd(agentDir);

	return !missionExists;
}
