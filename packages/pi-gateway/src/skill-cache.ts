/**
 * Skill cache — lazy per-account skill discovery for the IM skill picker.
 *
 * Skills are loaded by the coding-agent's `loadSkills` (which scans
 * every configured source: native, claude, codex, opencode, agents,
 * plugins). We mirror that here so what the user sees in the IM
 * picker matches exactly what the agent already knows about.
 *
 * Cache is keyed by `accountId` because each account runs the agent
 * in its own `agentDir`, so the relevant project-level skills differ
 * across accounts (cwd-based walk-up reaches different ancestors).
 * User-level skills are shared but the cost of scanning twice is
 * negligible (a handful of small markdown files).
 *
 * The cache has a TTL (default 5 min) and supports explicit
 * `invalidate(accountId?)` for admin operations (e.g. after the user
 * adds a new skill file and types `/skills` expecting to see it).
 */
import {
	loadSkills as defaultLoadSkills,
	type LoadSkillsResult,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { logger } from "@oh-my-pi/pi-utils";

/** Function shape for the underlying skill loader. Replaces the real
 *  `loadSkills` in tests so HOME-override is unnecessary. Accepts a
 *  `LoadSkillsOptions` (not just `cwd`) so the default `loadSkills`
 *  export from coding-agent is assignable without a wrapper. */
export type SkillLoader = (options: {
	cwd: string;
	enabled?: boolean;
	disabledExtensions?: string[];
}) => Promise<LoadSkillsResult>;

export interface SkillCacheOptions {
	/** Resolves the cwd (agentDir) for a given accountId. */
	resolveCwd: (accountId: string) => string;
	/** Resolves per-account `disabledExtensions` to filter the picker.
	 *  Merges user-level + project-level config (see `config-settings.ts`).
	 *  Optional — when omitted, no disabledExtensions filtering is applied. */
	resolveDisabledExtensions?: (accountId: string) => string[] | Promise<string[]>;
	/** Cache TTL in ms. Default 5 min. */
	ttlMs?: number;
	/** Optional loader override (tests). Defaults to the real
	 *  `loadSkills` from coding-agent, which reads `os.homedir()`
	 *  (Bun-cached, so HOME overrides in tests don't propagate). */
	loader?: SkillLoader;
}

interface CacheEntry {
	skills: Skill[];
	loadedAt: number;
}

export class SkillCache {
	readonly #resolveCwd: (accountId: string) => string;
	readonly #resolveDisabledExtensions?: (accountId: string) => string[] | Promise<string[]>;
	readonly #ttlMs: number;
	readonly #loader: SkillLoader;
	readonly #cache = new Map<string, CacheEntry>();
	/** In-flight loads — collapse concurrent requests for the same account. */
	readonly #inflight = new Map<string, Promise<Skill[]>>();

	constructor(options: SkillCacheOptions) {
		this.#resolveCwd = options.resolveCwd;
		this.#resolveDisabledExtensions = options.resolveDisabledExtensions;
		this.#ttlMs = options.ttlMs ?? 5 * 60_000;
		this.#loader = options.loader ?? defaultLoadSkills;
	}

	/** Get skills for an account, using cache if fresh. */
	async getSkills(accountId: string): Promise<Skill[]> {
		const cached = this.#cache.get(accountId);
		if (cached && Date.now() - cached.loadedAt < this.#ttlMs) {
			return cached.skills;
		}

		const inflight = this.#inflight.get(accountId);
		if (inflight) return await inflight;

		const promise = this.#loadSkills(accountId);
		this.#inflight.set(accountId, promise);
		try {
			const skills = await promise;
			this.#cache.set(accountId, { skills, loadedAt: Date.now() });
			return skills;
		} finally {
			this.#inflight.delete(accountId);
		}
	}

	async #loadSkills(accountId: string): Promise<Skill[]> {
		const cwd = this.#resolveCwd(accountId);
		const disabledExtensions = this.#resolveDisabledExtensions
			? await this.#resolveDisabledExtensions(accountId)
			: [];
		try {
			const result = await this.#loader({ cwd, enabled: true, disabledExtensions });
			return result.skills;
		} catch (err) {
			logger.warn("[SkillCache] failed to load skills", {
				accountId,
				cwd,
				disabledCount: disabledExtensions.length,
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/**
	 * Read the full SKILL.md content for a named skill. Returns null if the
	 * skill is not in the cached list (caller can fall back to /skills list).
	 */
	async getSkillContent(name: string, accountId: string): Promise<string | null> {
		const skills = await this.getSkills(accountId);
		const skill = skills.find(s => s.name === name);
		if (!skill) return null;
		try {
			return await Bun.file(skill.filePath).text();
		} catch (err) {
			logger.warn("[SkillCache] failed to read skill file", {
				name,
				filePath: skill.filePath,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/** Drop cached skills for an account (or all accounts). */
	invalidate(accountId?: string): void {
		if (accountId) {
			this.#cache.delete(accountId);
			this.#inflight.delete(accountId);
		} else {
			this.#cache.clear();
			this.#inflight.clear();
		}
	}
}
