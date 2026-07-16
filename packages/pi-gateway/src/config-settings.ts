/**
 * Read coding-agent config files for the gateway (SkillCache + channel UX).
 *
 * The coding-agent's `Settings` class is a global singleton tied to a single
 * cwd/agentDir. The gateway runs multiple accounts in one process, each with
 * its own agentDir, so we can't use `Settings.init()` directly. This module
 * reads the relevant fields out of the same yaml files (`<home>/.omp/agent/config.yml`
 * + `<agentDir>/.omp/config.yml`) and merges them with the same precedence
 * the agent runtime applies.
 *
 * - `disabledExtensions`: project entries are appended after user-level
 *   (union / dedup) so a project can extend the global disable list.
 * - `hideThinkingBlock`: `<agentDir>/.omp/config.yml` is canonical (same
 *   key the omp TUI reads). User-level config is fallback; `gateway.json`
 *   account field is last resort only.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Read + parse a YAML config file. Returns null on ENOENT / parse / non-object. */
async function readConfigObject(file: string): Promise<Record<string, unknown> | null> {
	let content: string;
	try {
		content = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("[config-settings] failed to read config file", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	let data: unknown;
	try {
		data = Bun.YAML.parse(content);
	} catch (err) {
		logger.warn("[config-settings] failed to parse config yaml", {
			file,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	return data as Record<string, unknown>;
}

/** Read a single YAML config file and extract a string-array field.
 *  Returns [] on ENOENT, parse error, or missing/wrong-shape field. */
async function readStringArrayField(file: string, field: string): Promise<string[]> {
	const data = await readConfigObject(file);
	if (!data) return [];
	const ext = data[field];
	if (!Array.isArray(ext)) return [];
	return ext.filter((x): x is string => typeof x === "string");
}

/** Read a boolean field. Returns `undefined` when missing or wrong type. */
async function readBooleanField(file: string, field: string): Promise<boolean | undefined> {
	const data = await readConfigObject(file);
	if (!data) return undefined;
	const value = data[field];
	return typeof value === "boolean" ? value : undefined;
}

function configPaths(agentDir: string): { userFile: string; projectFile: string } {
	const configDirName = process.env.PI_CONFIG_DIR ?? ".omp";
	const userConfigRoot = path.isAbsolute(configDirName) ? configDirName : path.join(os.homedir(), configDirName);
	return {
		userFile: path.join(userConfigRoot, "agent", "config.yml"),
		projectFile: path.join(agentDir, ".omp", "config.yml"),
	};
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
	const { userFile, projectFile } = configPaths(agentDir);

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

/**
 * Resolve whether the DingTalk AI Card should drop thinking blocks.
 *
 * Precedence (first defined boolean wins):
 *   1. `<agentDir>/.omp/config.yml` — canonical (same as omp TUI)
 *   2. `<home>/.omp/agent/config.yml` — user-level fallback
 *   3. `gatewayFallback` — legacy `gateway.json` `accounts.*.hideThinkingBlock`
 *   4. `false`
 */
export async function resolveHideThinkingBlock(
	agentDir: string,
	gatewayFallback: boolean = false,
): Promise<boolean> {
	const { userFile, projectFile } = configPaths(agentDir);
	const [projectValue, userValue] = await Promise.all([
		readBooleanField(projectFile, "hideThinkingBlock"),
		readBooleanField(userFile, "hideThinkingBlock"),
	]);
	const resolved = projectValue ?? userValue ?? gatewayFallback;
	logger.debug("[config-settings] resolved hideThinkingBlock", {
		agentDir,
		project: projectValue,
		user: userValue,
		gatewayFallback,
		resolved,
	});
	return resolved;
}
