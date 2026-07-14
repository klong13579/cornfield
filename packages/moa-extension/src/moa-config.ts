import { existsSync } from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { MoaSettings } from "./types";

/**
 * MOA config file loader.
 *
 * Mirrors pi-fusion's `presets.ts` file-locator pattern, simplified: we
 * support a single layout (no named presets) loaded from either a global
 * or a project config file, merged with project winning on conflict.
 *
 * Locations:
 *   - Global:  `~/.omp/agent/moa.{yml,yaml,json}` (first match)
 *   - Project: walk up from cwd looking for `.git`, then check
 *              `<root>/.omp/moa.{yml,yaml,json}` (first match)
 *
 * Malformed YAML, unknown fields, or unreadable files are tolerated: the
 * loader logs a warning and returns whatever it could parse (or an empty
 * object). A bad config file must never block the user's `/moa run`.
 */

const FILENAMES = ["moa.yml", "moa.yaml", "moa.json"] as const;

function tryReadText(filePath: string): Promise<string | undefined> {
	return Bun.file(filePath)
		.text()
		.catch((err: unknown) => {
			if (!isEnoent(err)) {
				logger.warn("moa config read failed", { path: filePath, err: String(err) });
			}
			return undefined;
		});
}

function parseMoaConfigText(filePath: string, text: string): Partial<MoaSettings> {
	const ext = path.extname(filePath).toLowerCase();
	let parsed: unknown;
	try {
		parsed = ext === ".json" ? JSON.parse(text) : Bun.YAML.parse(text);
	} catch (err) {
		logger.warn("moa config parse failed; using empty overrides", { path: filePath, err: String(err) });
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		logger.warn("moa config must be a YAML/JSON object; using empty overrides", { path: filePath });
		return {};
	}
	return parsed as Partial<MoaSettings>;
}

async function readMoaConfigFile(filePath: string): Promise<Partial<MoaSettings> | undefined> {
	const text = await tryReadText(filePath);
	if (text === undefined || text.trim().length === 0) return undefined;
	return parseMoaConfigText(filePath, text);
}

function findExistingConfigFile(dir: string): string | undefined {
	for (const filename of FILENAMES) {
		const candidate = path.join(dir, filename);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function findProjectRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	const visited = new Set<string>();
	while (!visited.has(current)) {
		visited.add(current);
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

function getGlobalMoaConfigPath(): string | undefined {
	const home = process.env.HOME;
	if (!home) return undefined;
	return findExistingConfigFile(path.join(home, ".omp", "agent"));
}

function getProjectMoaConfigPath(cwd: string): string | undefined {
	const root = findProjectRoot(cwd);
	if (!root) return undefined;
	return findExistingConfigFile(path.join(root, ".omp"));
}

export interface MoaConfigLoadResult {
	overrides: Partial<MoaSettings>;
	globalPath?: string;
	projectPath?: string;
}

/**
 * Load MOA config overrides from global + project files, merged with
 * project winning on conflict. Returns an empty object if neither file
 * exists or both are unreadable.
 */
export async function loadMoaConfigOverrides(cwd?: string): Promise<MoaConfigLoadResult> {
	const result: MoaConfigLoadResult = { overrides: {} };

	const globalPath = getGlobalMoaConfigPath();
	if (globalPath) {
		const parsed = await readMoaConfigFile(globalPath);
		if (parsed) {
			result.overrides = { ...parsed };
			result.globalPath = globalPath;
		}
	}

	if (cwd) {
		const projectPath = getProjectMoaConfigPath(cwd);
		if (projectPath) {
			const parsed = await readMoaConfigFile(projectPath);
			if (parsed) {
				result.overrides = { ...result.overrides, ...parsed };
				result.projectPath = projectPath;
			}
		}
	}

	if (result.globalPath || result.projectPath) {
		logger.info("moa config loaded", { global: result.globalPath, project: result.projectPath });
	}

	return result;
}
