/**
 * Read coding-agent config files for the gateway's SkillCache.
 *
 * The coding-agent's `Settings` class is a global singleton tied to a single
 * cwd/agentDir. The gateway runs multiple accounts in one process, each with
 * its own agentDir, so we can't use `Settings.init()` directly. This module
 * reads the relevant fields out of the same yaml files (`<home>/.omp/agent/config.yml`
 * + `<agentDir>/.omp/config.yml`) and merges them with the same precedence
 * the agent runtime applies: project-level entries are appended after
 * user-level entries (so a project can extend the global disable list).
 *
 * The merge is intentionally simple — same key, both kept, dedup. We don't
 * try to mirror every edge of the SettingsManager merge logic; the goal is
 * to make `disabledExtensions` actually flow into the gateway's SkillCache.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Read a single YAML config file and extract a string-array field.
 *  Returns [] on ENOENT, parse error, or missing/wrong-shape field. */
async function readStringArrayField(file: string, field: string): Promise<string[]> {
	let content: string;
	try {
		content = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("[config-settings] failed to read config file", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
	let data: unknown;
	try {
		data = Bun.YAML.parse(content);
	} catch (err) {
		logger.warn("[config-settings] failed to parse config yaml", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
	if (!data || typeof data !== "object") return [];
	const ext = (data as Record<string, unknown>)[field];
	if (!Array.isArray(ext)) return [];
	return ext.filter((x): x is string => typeof x === "string");
}

/** Merge two string arrays, dedup-preserving order (first occurrence wins). */
function dedupeConcat(a: string[], b: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of a) {
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	}
	for (const x of b) {
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	}
	return out;
}

/**
 * Resolve the merged `disabledExtensions` list for a given account agentDir.
 *
 * Sources, in order:
 *   1. `<home>/.omp/agent/config.yml`  (user-level)
 *   2. `<agentDir>/.omp/config.yml`    (project-level)
 *
 * Returns deduped union. Empty array if neither file has the field.
 */
export async function resolveDisabledExtensions(agentDir: string): Promise<string[]> {
	// The user-level config path uses `process.env.PI_CONFIG_DIR ?? ~/.omp`
	// the same way `getAgentDir()` in @oh-my-pi/pi-utils does, so a test
	// override of PI_CONFIG_DIR is honored here too.
	const configDirName = process.env.PI_CONFIG_DIR ?? ".omp";
	const userConfigRoot = path.isAbsolute(configDirName) ? configDirName : path.join(os.homedir(), configDirName);
	const userFile = path.join(userConfigRoot, "agent", "config.yml");
	const projectFile = path.join(agentDir, ".omp", "config.yml");

	const [userExt, projectExt] = await Promise.all([
		readStringArrayField(userFile, "disabledExtensions"),
		readStringArrayField(projectFile, "disabledExtensions"),
	]);

	const merged = dedupeConcat(userExt, projectExt);
	if (merged.length === 0) return merged;
	logger.debug("[config-settings] resolved disabledExtensions", {
		agentDir,
		user: userExt.length,
		project: projectExt.length,
		merged: merged.length,
	});
	return merged;
}
