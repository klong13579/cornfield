/**
 * Canonical on-disk location for evolved + consolidated skills.
 *
 * All skill markdown lives under `<cwd>/.omp/skills/*.md` (project scope by default).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { getUnifiedSkillsDir, resolveLegacyMemoryRootCandidates } from "./paths";
import { ensureAgentBodyShape } from "./skill-format";
import { isValidSkillName } from "./skill-score";
import { normalizeSkillDescription, validateSkillContent } from "./skill-validation";
import { getEvolutionDb } from "./storage/db";
import { SqliteSkillStore } from "./storage/skills";

export {
	getUnifiedSkillsDir,
	resolveEvolutionProjectionDir,
	resolveEvolutionRoot,
} from "./paths";

export interface ConsolidationSkillInput {
	name: string;
	content: string;
	scripts?: Array<{ path: string; content: string }>;
	templates?: Array<{ path: string; content: string }>;
	examples?: Array<{ path: string; content: string }>;
}

function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function escapeYamlString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatConsolidationMarkdown(name: string, content: string): string {
	const body = ensureAgentBodyShape(content);
	const validationInput = {
		name,
		description: "",
		taskPattern: "",
		approach: body,
		pitfalls: [] as string[],
	};
	const description = normalizeSkillDescription(validationInput);
	const validation = validateSkillContent({ ...validationInput, description });
	const status = validation.ok ? "active" : "experimental";
	if (!validation.ok) {
		logger.debug("Memory skill written as experimental (template validation)", {
			name,
			failures: validation.failures,
		});
	}

	const now = new Date().toISOString();
	return [
		"---",
		`name: "${escapeYamlString(name)}"`,
		`version: "1"`,
		`source: "memory"`,
		`status: "${status}"`,
		`confidence_score: 0.6`,
		`last_used_at: "${now}"`,
		`description: "${escapeYamlString(description)}"`,
		"---",
		"",
		body,
		"",
	].join("\n");
}

/**
 * Move legacy memory consolidation layout (memoryRoot/skills/<name>/SKILL.md)
 * into the unified flat directory.
 */
export async function migrateLegacyMemorySkills(memoryRoot: string, unifiedDir: string): Promise<number> {
	const legacyDir = path.join(memoryRoot, "skills");
	let migrated = 0;

	try {
		const entries = await fs.readdir(legacyDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!isValidSkillName(entry.name)) continue;

			const skillPath = path.join(legacyDir, entry.name, "SKILL.md");
			let content: string;
			try {
				content = await Bun.file(skillPath).text();
			} catch {
				continue;
			}

			const { body } = parseBodyAfterFrontmatter(content);
			const target = path.join(unifiedDir, `${sanitizeFilename(entry.name)}.md`);
			try {
				await fs.access(target);
			} catch {
				await Bun.write(target, formatConsolidationMarkdown(entry.name, body || content));
				migrated++;
			}
		}

		if (entries.length > 0) {
			await fs.rm(legacyDir, { recursive: true, force: true });
			logger.debug("Removed legacy memory skills directory after migration", { legacyDir, migrated });
		}
	} catch {
		// No legacy directory
	}

	return migrated;
}

function parseBodyAfterFrontmatter(content: string): { body: string } {
	if (!content.startsWith("---")) {
		return { body: content };
	}
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { body: content };
	return { body: content.slice(end + 4).trim() };
}

/**
 * Write consolidation skills to the unified directory (flat .md + optional asset subdirs).
 */
export async function writeConsolidationSkills(unifiedDir: string, skills: ConsolidationSkillInput[]): Promise<void> {
	await fs.mkdir(unifiedDir, { recursive: true });
	const keepFiles = new Set<string>();

	for (const skill of skills) {
		if (!isValidSkillName(skill.name)) continue;

		const filename = `${sanitizeFilename(skill.name)}.md`;
		keepFiles.add(filename);
		await Bun.write(path.join(unifiedDir, filename), formatConsolidationMarkdown(skill.name, skill.content));

		const hasAssets =
			(skill.scripts?.length ?? 0) > 0 || (skill.templates?.length ?? 0) > 0 || (skill.examples?.length ?? 0) > 0;
		if (!hasAssets) continue;

		const assetDir = path.join(unifiedDir, skill.name);
		await fs.mkdir(assetDir, { recursive: true });
		const writeBucket = async (bucket: string, items: Array<{ path: string; content: string }>) => {
			for (const item of items) {
				const dest = path.join(assetDir, bucket, item.path);
				await fs.mkdir(path.dirname(dest), { recursive: true });
				await Bun.write(dest, `${item.content.trim()}\n`);
			}
		};
		await writeBucket("scripts", skill.scripts ?? []);
		await writeBucket("templates", skill.templates ?? []);
		await writeBucket("examples", skill.examples ?? []);
	}

	const keepDirs = new Set(skills.filter(s => isValidSkillName(s.name)).map(s => s.name));
	const entries = await fs.readdir(unifiedDir, { withFileTypes: true }).catch(() => []);

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			if (keepFiles.has(entry.name)) continue;
			try {
				const content = await fs.readFile(path.join(unifiedDir, entry.name), "utf-8");
				if (content.includes('source: "memory"')) {
					await fs.unlink(path.join(unifiedDir, entry.name));
				}
			} catch {
				// ignore
			}
			continue;
		}

		if (entry.isDirectory() && !keepDirs.has(entry.name)) {
			await fs.rm(path.join(unifiedDir, entry.name), { recursive: true, force: true });
		}
	}
}

/**
 * Upsert consolidation skills into evolution.db (same store as trace-extracted skills).
 */
export async function importConsolidationSkillsToDb(
	cwd: string,
	skills: ConsolidationSkillInput[],
	globalStore = false,
): Promise<void> {
	if (skills.length === 0) return;

	const db = getEvolutionDb(cwd, globalStore);
	const store = new SqliteSkillStore(db);
	const now = Math.floor(Date.now() / 1000);

	for (const skill of skills) {
		if (!isValidSkillName(skill.name)) continue;

		const existing = await store.get(skill.name);
		const record = {
			name: skill.name,
			description: existing?.description ?? "",
			taskPattern: existing?.taskPattern ?? "",
			approach: skill.content.trim(),
			tools: existing?.tools ?? [],
			pitfalls: existing?.pitfalls ?? [],
			createdAt: existing?.createdAt ?? now,
			usageCount: existing?.usageCount ?? 0,
			lastUsedAt: existing?.lastUsedAt ?? now,
			successCount: existing?.successCount ?? 0,
			failureCount: existing?.failureCount ?? 0,
			version: existing ? existing.version + 1 : 1,
			qualityScore: existing?.qualityScore ?? 60,
			deprecated: false,
			userRating: existing?.userRating,
			optimizedPrompt: existing?.optimizedPrompt,
			deprecationReason: existing?.deprecationReason,
			autonomyNotes: existing?.autonomyNotes,
			lastOptimizedAt: existing?.lastOptimizedAt,
		};
		await store.upsert(record);
	}
}

export async function ensureUnifiedSkillStorage(cwd: string, memoryRoot: string, globalStore = false): Promise<string> {
	const unifiedDir = getUnifiedSkillsDir(cwd, globalStore);
	await fs.mkdir(unifiedDir, { recursive: true });
	await migrateLegacyMemorySkills(memoryRoot, unifiedDir);
	if (!globalStore) {
		for (const legacyMemoryRoot of resolveLegacyMemoryRootCandidates(getAgentDir(), cwd)) {
			if (legacyMemoryRoot === memoryRoot) continue;
			await migrateLegacyMemorySkills(legacyMemoryRoot, unifiedDir);
		}
	}
	return unifiedDir;
}
