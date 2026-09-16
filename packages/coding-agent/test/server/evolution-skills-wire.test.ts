/**
 * T13：`get_evolved_skills` 投影的单元测试 —— 真 SQLite + 真 schema + 真写入器，不打桩。
 *
 * 覆盖本模块存在的理由：**「库还没生成」「库在但读不出来」「读到了但个别行没读全」是三种事实**，
 * 不能都长成空数组。所以每个用例都在断言「这一种事实被答成了哪一种」：
 *   - 库不在 → `{ skills: [] }`，且**不建库**（连目录都不建）；
 *   - 库在但打不开 / 不是库 / 缺 skills 表 → 抛（命令回 ok:false）；
 *   - JSON 列坏了 → 清单照给 + `error` 点名哪一行哪一列。
 *
 * 隔离：整个文件把 HOME 指向临时目录，真机 `~/.cornfield/self-evolution/evolution.db` 不会被碰。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMemoryDbPath } from "@cornfield/self-evolution/memory/storage";
import { initSchema } from "@cornfield/self-evolution/storage/db";
import { SqliteSkillStore } from "@cornfield/self-evolution/storage/skills";
import type { EvolvedSkill } from "@cornfield/self-evolution/types";
import { readEvolvedSkills } from "../../src/server/evolution-skills-wire";

let isolatedHome = "";
let savedHome: string | undefined;
let sessionCwd = "";
let dbPath = "";

beforeEach(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-evolved-skills-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	sessionCwd = path.join(isolatedHome, "project");
	dbPath = resolveMemoryDbPath(sessionCwd);
	// 隔离断言：库必须落在临时 HOME 下（否则这条测试会去读写真机的演化库）。
	expect(dbPath.startsWith(isolatedHome)).toBe(true);
});

afterEach(async () => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

function skill(overrides: Partial<EvolvedSkill> & { name: string }): EvolvedSkill {
	return {
		description: "描述",
		taskPattern: "任务形态",
		approach: "做法",
		tools: [],
		pitfalls: [],
		createdAt: 1,
		usageCount: 0,
		lastUsedAt: 1,
		successCount: 0,
		failureCount: 0,
		version: 1,
		...overrides,
	};
}

/** 用真 schema + 真写入器造库（不手写 DDL：写法和产品里那一份是同一个）。 */
async function seed(skills: EvolvedSkill[]): Promise<void> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	// 与 getEvolutionDb 同一个 journal 模式：真机的库是 WAL，只读连接要能在这种库上工作。
	db.exec("PRAGMA journal_mode = WAL;");
	initSchema(db);
	const store = new SqliteSkillStore(db);
	for (const entry of skills) await store.upsert(entry);
	db.close();
}

/** 直接改库里的原始列（模拟「写坏了 / 不是本程序写的」那种行）。 */
async function patchColumn(name: string, column: string, value: string): Promise<void> {
	const db = new Database(dbPath);
	db.prepare(`UPDATE skills SET ${column} = ? WHERE name = ?`).run(value, name);
	db.close();
}

async function pathKind(target: string): Promise<"missing" | "file" | "dir"> {
	try {
		const stat = await fs.stat(target);
		return stat.isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

async function failureOf(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
	try {
		await run();
	} catch (err) {
		const error = err as { code?: string; message?: string };
		return { ...(error.code === undefined ? {} : { code: error.code }), message: error.message ?? String(err) };
	}
	throw new Error("expected the read to fail, but it resolved");
}

describe("readEvolvedSkills — 读到了", () => {
	test("逐字段投影：有值的带上，没记过的字段不出现，optimizationCount 不进形状", async () => {
		await seed([
			skill({
				name: "b-minimal",
				description: "精简技能",
				taskPattern: "小任务",
				approach: "直接做",
				createdAt: 11,
				lastUsedAt: 100,
			}),
			skill({
				name: "a-full",
				description: "完整技能",
				taskPattern: "大任务",
				approach: "分三步",
				tools: ["grep", "read"],
				pitfalls: ["别跳过确认"],
				createdAt: 22,
				usageCount: 7,
				lastUsedAt: 200,
				successCount: 5,
				failureCount: 2,
				version: 3,
				qualityScore: 88,
				optimizedPrompt: "优化后的片段",
				deprecated: true,
				deprecationReason: "被更好的替代",
				autonomyNotes: "可自主",
				lastOptimizedAt: 999,
				userRating: 4,
			}),
		]);

		const dto = await readEvolvedSkills(sessionCwd);

		// last_used_at DESC：最近用过的在前
		expect(dto.skills.map(entry => entry.name)).toEqual(["a-full", "b-minimal"]);
		expect(dto.skills[0]).toEqual({
			name: "a-full",
			description: "完整技能",
			taskPattern: "大任务",
			approach: "分三步",
			tools: ["grep", "read"],
			pitfalls: ["别跳过确认"],
			createdAt: 22,
			usageCount: 7,
			lastUsedAt: 200,
			successCount: 5,
			failureCount: 2,
			version: 3,
			qualityScore: 88,
			optimizedPrompt: "优化后的片段",
			deprecated: true,
			deprecationReason: "被更好的替代",
			autonomyNotes: "可自主",
			lastOptimizedAt: 999,
			userRating: 4,
		});
		// 没记过的可选字段是「不出现」，不是 0 / 空串
		expect(Object.hasOwn(dto.skills[1], "qualityScore")).toBe(false);
		expect(Object.hasOwn(dto.skills[1], "optimizedPrompt")).toBe(false);
		expect(Object.hasOwn(dto.skills[1], "userRating")).toBe(false);
		// deprecated 是 NOT NULL 列，所以恒有值（false = 没废弃，不是「没记过」）
		expect(dto.skills[1]).toEqual({
			name: "b-minimal",
			description: "精简技能",
			taskPattern: "小任务",
			approach: "直接做",
			tools: [],
			pitfalls: [],
			createdAt: 11,
			usageCount: 0,
			lastUsedAt: 100,
			successCount: 0,
			failureCount: 0,
			version: 1,
			deprecated: false,
		});
		// EvolvedSkill 上有、skills 表里没有的字段不许跟着出来（否则「没优化过」与「没记录」混淆）
		expect(Object.hasOwn(dto.skills[0], "optimizationCount")).toBe(false);
		expect(dto.error).toBeUndefined();
	});

	test("写者正连着这个库（WAL）时也读得出来", async () => {
		await seed([skill({ name: "concurrent", lastUsedAt: 5 })]);
		const writer = new Database(dbPath);
		try {
			const dto = await readEvolvedSkills(sessionCwd);
			expect(dto.skills.map(entry => entry.name)).toEqual(["concurrent"]);
			expect(dto.error).toBeUndefined();
		} finally {
			writer.close();
		}
	});

	test("库里一条技能都没有：空数组 + 没有 error（这份清单是完整的）", async () => {
		await seed([]);

		const dto = await readEvolvedSkills(sessionCwd);

		expect(dto).toEqual({ skills: [] });
	});
});

describe("readEvolvedSkills — 读不到", () => {
	test("库还没生成：明确空集，且不建库（连目录都不建）", async () => {
		const dto = await readEvolvedSkills(sessionCwd);

		expect(dto).toEqual({ skills: [] });
		expect(await pathKind(dbPath)).toBe("missing");
		expect(await pathKind(path.dirname(dbPath))).toBe("missing");
	});

	test("库路径上是个目录（打不开）：抛，不退化成空清单", async () => {
		await fs.mkdir(dbPath, { recursive: true });

		const failure = await failureOf(() => readEvolvedSkills(sessionCwd));

		expect(failure.code).toBe("SQLITE_CANTOPEN");
		expect(failure.message.length).toBeGreaterThan(0);
	});

	test("路径上是个不是 SQLite 的文件：抛（查询时才报 NOTADB，也不能当成空）", async () => {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(dbPath, `${"this is not a sqlite database\n".repeat(20)}`);

		const failure = await failureOf(() => readEvolvedSkills(sessionCwd));

		expect(failure.code).toBe("SQLITE_NOTADB");
	});

	test("库读得开但没有 skills 表（表结构不对）：抛", async () => {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.exec("CREATE TABLE unrelated (x TEXT)");
		db.close();

		const failure = await failureOf(() => readEvolvedSkills(sessionCwd));

		expect(failure.message).toContain("no such table: skills");
	});
});

describe("readEvolvedSkills — 读到了但没读全", () => {
	test("JSON 列坏掉：清单照给，error 点名是哪一行哪一列", async () => {
		await seed([skill({ name: "broken", description: "坏行", lastUsedAt: 10 })]);
		await patchColumn("broken", "tools", "not json at all");
		await patchColumn("broken", "pitfalls", '{"not":"an array"}');

		const dto = await readEvolvedSkills(sessionCwd);

		expect(dto.skills.map(entry => entry.name)).toEqual(["broken"]);
		expect(dto.skills[0]?.tools).toEqual([]);
		expect(dto.skills[0]?.pitfalls).toEqual([]);
		expect(dto.error).toContain("tools");
		expect(dto.error).toContain("pitfalls");
		expect(dto.error).toContain("broken");
	});

	test("数组里混了非字符串：确定的那部分照给，其余记进 error", async () => {
		await seed([skill({ name: "mixed", lastUsedAt: 10 })]);
		await patchColumn("mixed", "tools", '["grep", 3, null]');

		const dto = await readEvolvedSkills(sessionCwd);

		expect(dto.skills[0]?.tools).toEqual(["grep"]);
		expect(dto.error).toContain("非字符串");
	});

	test("读全了的行不带任何 error", async () => {
		await seed([skill({ name: "clean", tools: ["grep"], pitfalls: ["p"], lastUsedAt: 10 })]);

		const dto = await readEvolvedSkills(sessionCwd);

		expect(dto.skills[0]?.tools).toEqual(["grep"]);
		expect(dto.error).toBeUndefined();
	});
});
