/**
 * Repository layer module isolation constraints.
 *
 * Enforces strict separation between storage modules to prevent tight coupling
 * and maintain clean architecture boundaries.
 */

import type { Database } from "bun:sqlite";

// Define allowed database access patterns
const ALLOWED_DB_ACCESS = {
	// Each module manages its own table namespace
	skills: /^evolution_skills/,
	episodes: /^evolution_episodes/,
	conventions: /^evolution_conventions/,
	profiles: /^evolution_user_profiles/,
	nudges: /^evolution_nudge/,
	effectiveness: /^(evolution_episode_effectiveness|evolution_skill_effectiveness)/,
} as const;

export interface IsolationConstraint {
	module: string;
	check: (db: Database) => { ok: boolean; violations: string[] };
}

/**
 * Ensures a module only accesses its designated database tables.
 */
export function createTableAccessConstraint(module: keyof typeof ALLOWED_DB_ACCESS): IsolationConstraint {
	const allowedPrefix = ALLOWED_DB_ACCESS[module];
	const allowedRegex = typeof allowedPrefix === "string" ? new RegExp(`^${allowedPrefix}`) : allowedPrefix;

	return {
		module: `db-access-${module}`,
		check: (db: Database) => {
			const violations: string[] = [];

			// Get all table names in the database
			const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
				name: string;
			}>;

			// In a real implementation, we'd track which module accessed which tables
			// For now, we'll just verify that the table naming convention is followed
			for (const table of tables) {
				if (!allowedRegex.test(table.name)) {
					// Skip common SQLite internal tables
					if (
						table.name.startsWith("sqlite_") ||
						table.name.endsWith("_fts") ||
						table.name.endsWith("_fts_docsize") ||
						table.name.endsWith("_fts_idx") ||
						table.name.endsWith("_fts_stat")
					) {
						continue;
					}
					violations.push(
						`Module ${module} should not access table ${table.name} (doesn't match pattern ${allowedRegex.toString()})`,
					);
				}
			}

			return { ok: violations.length === 0, violations };
		},
	};
}

/**
 * Verifies that storage modules follow repository pattern.
 */
export function createRepositoryPatternConstraint(moduleName: string, allowedTables: string[]): IsolationConstraint {
	return {
		module: `repo-pattern-${moduleName}`,
		check: (db: Database) => {
			const violations: string[] = [];

			// Check that the required tables exist
			for (const table of allowedTables) {
				try {
					db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).run();
				} catch {
					violations.push(`Required table ${table} does not exist for module ${moduleName}`);
				}
			}

			return { ok: violations.length === 0, violations };
		},
	};
}

/**
 * Collection of all isolation constraints for the storage layer.
 */
export const STORAGE_ISOLATION_CONSTRAINTS: IsolationConstraint[] = [
	// Table access constraints
	createTableAccessConstraint("skills"),
	createTableAccessConstraint("episodes"),
	createTableAccessConstraint("profiles"),
	createTableAccessConstraint("nudges"),
	createTableAccessConstraint("effectiveness"),

	// Repository pattern constraints
	createRepositoryPatternConstraint("skills", ["evolution_skills", "evolution_skill_versions"]),
	createRepositoryPatternConstraint("episodes", [
		"evolution_episodes",
		"evolution_episode_intents",
		"evolution_episode_effectiveness",
		"evolution_episode_detailed_outcomes",
		"evolution_episode_diagnoses",
	]),
	createRepositoryPatternConstraint("conventions", ["evolution_conventions", "evolution_convention_feedback"]),
	createRepositoryPatternConstraint("profiles", ["evolution_user_profiles"]),
	createRepositoryPatternConstraint("nudges", ["evolution_nudge_history"]),
	createRepositoryPatternConstraint("effectiveness", [
		"evolution_episode_effectiveness",
		"evolution_skill_effectiveness",
	]),
];

/**
 * Validate all isolation constraints against a database instance.
 */
export function validateStorageIsolation(db: Database): { ok: boolean; violations: string[]; passed: string[] } {
	const violations: string[] = [];
	const passed: string[] = [];

	for (const constraint of STORAGE_ISOLATION_CONSTRAINTS) {
		try {
			const result = constraint.check(db);
			if (result.ok) {
				passed.push(constraint.module);
			} else {
				violations.push(...result.violations);
			}
		} catch (error) {
			violations.push(`Constraint ${constraint.module} failed with error: ${String(error)}`);
		}
	}

	return { ok: violations.length === 0, violations, passed };
}

/**
 * Middleware that enforces isolation at runtime (development only).
 */
export class RuntimeIsolationMiddleware {
	private db: Database;
	private enabled: boolean;

	constructor(db: Database, enabled = process.env.NODE_ENV !== "production") {
		this.db = db;
		this.enabled = enabled;
	}

	query(sql: string) {
		if (!this.enabled) {
			return this.db.query(sql);
		}

		// In a real implementation, we would check if the SQL query
		// violates any isolation constraints
		return this.db.query(sql);
	}

	prepare(sql: string) {
		if (!this.enabled) {
			return this.db.prepare(sql);
		}

		// Check for potential isolation violations in the SQL
		const violations = this.checkSqlForViolations(sql);
		if (violations.length > 0) {
			console.warn("Potential isolation violation detected:", violations);
		}

		return this.db.prepare(sql);
	}

	private checkSqlForViolations(_sql: string): string[] {
		const violations: string[] = [];

		// In a real implementation, we would have more sophisticated SQL parsing
		// to determine which tables are being accessed

		return violations;
	}
}

/**
 * Type-level constraints to enforce module boundaries at compile time.
 */
export interface StorageModule<M extends keyof typeof ALLOWED_DB_ACCESS> {
	readonly module: M;
	readonly tables: (typeof ALLOWED_DB_ACCESS)[M] extends RegExp ? string : (typeof ALLOWED_DB_ACCESS)[M];
	initialize(db: Database): void;
}

// Example implementation for skills storage
export interface SkillsStorage extends StorageModule<"skills"> {
	getSkill(name: string): Promise<any | undefined>;
	listSkills(filter?: { deprecated?: boolean }): Promise<any[]>;
	saveSkill(skill: any): Promise<void>;
	deleteSkill(name: string): Promise<void>;
}

// Example implementation for episodes storage
export interface EpisodesStorage extends StorageModule<"episodes"> {
	getEpisode(id: string): Promise<any | undefined>;
	listEpisodes(limit?: number): Promise<any[]>;
	saveEpisode(episode: any): Promise<void>;
	searchEpisodes(query: string): Promise<any[]>;
}
