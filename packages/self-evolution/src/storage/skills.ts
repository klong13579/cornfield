/**
 * Skill and skill-version storage.
 */
import type { Database } from "bun:sqlite";
import type { EvolvedSkill, SkillVersion } from "../types";
import type { SkillStore, SkillVersionStore, StatsStore } from "./types";

export class SqliteSkillStore implements SkillStore {
	constructor(private db: Database) {}

	async get(name: string): Promise<EvolvedSkill | undefined> {
		const stmt = this.db.prepare(`SELECT * FROM skills WHERE name = ?`);
		const row = stmt.get(name) as RawSkillRow | undefined;
		stmt.finalize();
		return row ? projectSkillRow(row).skill : undefined;
	}

	async list(filter?: { deprecated?: boolean }): Promise<EvolvedSkill[]> {
		const stmt = this.db.prepare(buildSkillListSql(filter));
		const rows = stmt.all(...skillListParams(filter)) as RawSkillRow[];
		stmt.finalize();
		return projectSkillRows(rows).skills;
	}

	async upsert(skill: EvolvedSkill): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO skills (
				name, description, task_pattern, approach, tools, pitfalls,
				created_at, usage_count, last_used_at, success_count, failure_count,
				version, quality_score, optimized_prompt, deprecated, deprecation_reason,
				autonomy_notes, last_optimized_at, user_rating
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(name) DO UPDATE SET
				description = excluded.description,
				task_pattern = excluded.task_pattern,
				approach = excluded.approach,
				tools = excluded.tools,
				pitfalls = excluded.pitfalls,
				usage_count = excluded.usage_count,
				last_used_at = excluded.last_used_at,
				success_count = excluded.success_count,
				failure_count = excluded.failure_count,
				version = excluded.version,
				quality_score = excluded.quality_score,
				optimized_prompt = excluded.optimized_prompt,
				deprecated = excluded.deprecated,
				deprecation_reason = excluded.deprecation_reason,
				autonomy_notes = excluded.autonomy_notes,
				last_optimized_at = excluded.last_optimized_at,
				user_rating = excluded.user_rating
		`);
		stmt.run(
			skill.name,
			skill.description,
			skill.taskPattern,
			skill.approach,
			JSON.stringify(skill.tools),
			JSON.stringify(skill.pitfalls),
			skill.createdAt,
			skill.usageCount,
			skill.lastUsedAt,
			skill.successCount,
			skill.failureCount,
			skill.version,
			skill.qualityScore ?? null,
			skill.optimizedPrompt ?? null,
			skill.deprecated ? 1 : 0,
			skill.deprecationReason ?? null,
			skill.autonomyNotes ?? null,
			skill.lastOptimizedAt ?? null,
			skill.userRating ?? null,
		);
		stmt.finalize();
	}

	async delete(name: string): Promise<void> {
		const stmt = this.db.prepare(`DELETE FROM skills WHERE name = ?`);
		stmt.run(name);
		stmt.finalize();
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM skills`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

export class SqliteSkillVersionStore implements SkillVersionStore {
	constructor(private db: Database) {}

	async record(version: SkillVersion): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO skill_versions (name, version, skill_json, changed_at, change_type, change_reason)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(name, version) DO UPDATE SET
				skill_json = excluded.skill_json,
				changed_at = excluded.changed_at,
				change_type = excluded.change_type,
				change_reason = excluded.change_reason
		`);
		stmt.run(
			version.name,
			version.version,
			JSON.stringify(version.skill),
			version.changedAt,
			version.changeType,
			version.changeReason ?? null,
		);
		stmt.finalize();
	}

	async getHistory(name: string): Promise<SkillVersion[]> {
		const stmt = this.db.prepare(`
			SELECT * FROM skill_versions WHERE name = ? ORDER BY version DESC
		`);
		const rows = stmt.all(name) as RawVersionRow[];
		stmt.finalize();
		return rows.map(rowToVersion);
	}

	async getSpecific(name: string, version: number): Promise<SkillVersion | undefined> {
		const stmt = this.db.prepare(`
			SELECT * FROM skill_versions WHERE name = ? AND version = ?
		`);
		const row = stmt.get(name, version) as RawVersionRow | undefined;
		stmt.finalize();
		return row ? rowToVersion(row) : undefined;
	}

	async prune(name: string, keepCount: number): Promise<number> {
		const countStmt = this.db.prepare(`
			SELECT COUNT(*) as c FROM skill_versions WHERE name = ?
		`);
		const countRow = countStmt.get(name) as { c: number };
		countStmt.finalize();

		const toDelete = countRow.c - keepCount;
		if (toDelete <= 0) return 0;

		const stmt = this.db.prepare(`
			DELETE FROM skill_versions
			WHERE name = ? AND version IN (
				SELECT version FROM skill_versions WHERE name = ? ORDER BY version ASC LIMIT ?
			)
		`);
		stmt.run(name, name, toDelete);
		stmt.finalize();
		return toDelete;
	}

	async count(): Promise<number> {
		const stmt = this.db.prepare(`SELECT COUNT(*) as c FROM skill_versions`);
		const row = stmt.get() as { c: number };
		stmt.finalize();
		return row.c;
	}
}

export class SqliteStatsStore implements StatsStore {
	constructor(private db: Database) {}

	async get(key: string): Promise<number> {
		const stmt = this.db.prepare(`SELECT value FROM stats WHERE key = ?`);
		const row = stmt.get(key) as { value: number } | undefined;
		stmt.finalize();
		return row?.value ?? 0;
	}

	async increment(key: string, delta = 1): Promise<void> {
		const stmt = this.db.prepare(`
			INSERT INTO stats (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
		`);
		stmt.run(key, delta);
		stmt.finalize();
	}
}

export interface RawSkillRow {
	name: string;
	description: string;
	task_pattern: string;
	approach: string;
	tools: string;
	pitfalls: string;
	created_at: number;
	usage_count: number;
	last_used_at: number;
	success_count: number;
	failure_count: number;
	version: number;
	quality_score: number | null;
	optimized_prompt: string | null;
	deprecated: number;
	deprecation_reason: string | null;
	autonomy_notes: string | null;
	last_optimized_at: number | null;
	user_rating: number | null;
}

/**
 * 「这个库里的技能」的读语句 —— 一条，不是一个调用方一条。
 *
 * 存在理由与 {@link projectSkillRow} 相同：`SqliteSkillStore.list()`（演进管线自己读）与
 * serve 侧的只读投影（技能页读）问的是同一个问题，各写一条 SQL 迟早会分叉成两个答案
 * （排序一处改、过滤一处加，另一个调用方就悄悄读到了不同的集合）。
 *
 * `filter` 只影响 WHERE，排序恒为 `last_used_at DESC`（稳定：名字再兜一层，避免同一毫秒写入的
 * 两行在两次读之间换位）。
 */
export function buildSkillListSql(filter?: { deprecated?: boolean }): string {
	let sql = `SELECT * FROM skills`;
	if (filter?.deprecated !== undefined) sql += ` WHERE deprecated = ?`;
	return `${sql} ORDER BY last_used_at DESC, name ASC`;
}

/** {@link buildSkillListSql} 的绑定参数（与它的 WHERE 子句一一对应）。 */
export function skillListParams(filter?: { deprecated?: boolean }): (string | number)[] {
	return filter?.deprecated === undefined ? [] : [filter.deprecated ? 1 : 0];
}

/**
 * 一行技能的投影结果：技能本身 + **这一行没能读全的事实**。
 *
 * 为什么把降级报出来而不是继续 `safeJsonParse` 一个空数组了事：`tools` / `pitfalls` 是 JSON
 * 文本列，解析失败时「这条技能没有工具」与「这条技能的工具没读出来」在结果里长得一模一样。
 * 前者是事实，后者是读丢了 —— 调用方要能不靠猜区分它们（serve 侧把它变成答复的 `error`）。
 */
export interface SkillRowProjection {
	skill: EvolvedSkill;
	/** 这一行没读全的地方（现在是 JSON 列解析失败 / 形状不对）；空数组 = 这一行读全了。 */
	degradations: string[];
}

export interface SkillListProjection {
	skills: EvolvedSkill[];
	/** 所有行的降级原因汇总（空 = 这份清单是完整的）。 */
	degradations: string[];
}

/** 把一个技能行投影成 {@link EvolvedSkill}，并如实报出读不出来的列。 */
export function projectSkillRow(row: RawSkillRow): SkillRowProjection {
	const tools = readStringArrayColumn(row.name, "tools", row.tools);
	const pitfalls = readStringArrayColumn(row.name, "pitfalls", row.pitfalls);
	const skill: EvolvedSkill = {
		name: row.name,
		description: row.description,
		taskPattern: row.task_pattern,
		approach: row.approach,
		tools: tools.values,
		pitfalls: pitfalls.values,
		createdAt: row.created_at,
		usageCount: row.usage_count,
		lastUsedAt: row.last_used_at,
		successCount: row.success_count,
		failureCount: row.failure_count,
		version: row.version,
		qualityScore: row.quality_score ?? undefined,
		optimizedPrompt: row.optimized_prompt ?? undefined,
		deprecated: Boolean(row.deprecated),
		deprecationReason: row.deprecation_reason ?? undefined,
		autonomyNotes: row.autonomy_notes ?? undefined,
		lastOptimizedAt: row.last_optimized_at ?? undefined,
		userRating: row.user_rating ?? undefined,
	};
	return { skill, degradations: [...tools.degradations, ...pitfalls.degradations] };
}

/** 逐行投影（`list` 与只读投影共用：同一个行形状，同一套降级判定）。 */
export function projectSkillRows(rows: readonly RawSkillRow[]): SkillListProjection {
	const skills: EvolvedSkill[] = [];
	const degradations: string[] = [];
	for (const row of rows) {
		const projection = projectSkillRow(row);
		skills.push(projection.skill);
		degradations.push(...projection.degradations);
	}
	return { skills, degradations };
}

/**
 * `tools` / `pitfalls` 列的读取：**声明是 `string[]`，读出来不是 `string[]` 就是没读全**。
 *
 * 旧实现直接 `JSON.parse(...) as string[]`，于是一个存成对象/字符串、甚至被写坏的值会一路
 * 冒充成 `string[]` 流到调用方（`for (const tool of skill.tools)` 才炸）。这里把「合法 JSON
 * 但不是数组」「数组里混了非字符串」都当作降级：值退成能确定的那部分，原因报出去。
 */
function readStringArrayColumn(
	skillName: string,
	column: string,
	raw: string,
): { values: string[]; degradations: string[] } {
	const parsed = safeJsonParse<unknown>(raw, undefined);
	const prefix = `技能 ${JSON.stringify(skillName)} 的 ${column} 列`;
	if (parsed === undefined) return { values: [], degradations: [`${prefix}不是合法 JSON`] };
	if (!Array.isArray(parsed)) return { values: [], degradations: [`${prefix}不是数组`] };
	const values = parsed.filter((item): item is string => typeof item === "string");
	if (values.length !== parsed.length) {
		return { values, degradations: [`${prefix}含非字符串元素`] };
	}
	return { values, degradations: [] };
}

interface RawVersionRow {
	name: string;
	version: number;
	skill_json: string;
	changed_at: number;
	change_type: string;
	change_reason: string | null;
}

function rowToVersion(row: RawVersionRow): SkillVersion {
	return {
		name: row.name,
		version: row.version,
		skill: safeJsonParse(row.skill_json, {} as EvolvedSkill),
		changedAt: row.changed_at,
		changeType: row.change_type as SkillVersion["changeType"],
		changeReason: row.change_reason ?? undefined,
	};
}

function safeJsonParse<T>(json: string, fallback: T): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
