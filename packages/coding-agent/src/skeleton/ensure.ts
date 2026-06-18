/**
 * agentDir skeleton creation.
 *
 * Per `packages/agent/docs/agent-design-v1.md` §6.1:
 *   - `mission.md` missing → full creation (directories + content files + .gitkeep stubs).
 *   - `mission.md` present → additive update: only fill in files that are missing.
 *
 * I/O failures bubble to the caller (gateway install / omp agent init) which decides
 * whether to abort or retry.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SKELETON_FILES, type SkeletonFile } from "./assets";
import { SKELETON_DIRS } from "./dirs";

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

	return !missionExists;
}
