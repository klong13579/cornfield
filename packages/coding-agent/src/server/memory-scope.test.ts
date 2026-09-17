/**
 * T10B：Memory scope 投影的单元测试（真文件系统 + 真 SQLite，不打桩）。
 *
 * 覆盖：五个 scope 的取值来源（user/agent/project/session/全局库）、候选根优先级、
 * 系统路径下项目记忆「不适用」而不是「空」、会话记忆的 pending 与命中、读失败可见（不吞成空态）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeProjectPathForGlobalMemory } from "@cornfield/self-evolution/paths";
import { setConfigRootDir } from "@cornfield/utils";
import { getMemoryDb, openMemoryDb, releaseMemoryDb, resolveMemoryDbPath } from "../memories/storage";
import { buildMemoryScopeProjection, type MemoryScopeAnchor } from "./memory-scope";

const encodeProjectPath = encodeProjectPathForGlobalMemory;
const cleanups: string[] = [];
let savedHome: string | undefined;
let isolatedHome = "";

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

/** 每个用例给一份新的隔离 HOME + config root（记忆库/记忆目录都在 HOME 下）。 */
async function isolateHome(): Promise<void> {
	isolatedHome = await tmpDir("scope-memory-home-");
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	setConfigRootDir(path.join(isolatedHome, ".cornfield"));
}

async function writeFile(filePath: string, content: string): Promise<string> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
	return filePath;
}

function baseFacts(
	overrides: Partial<MemoryScopeAnchor> & Pick<MemoryScopeAnchor, "agentDir" | "sessionCwd">,
): MemoryScopeAnchor {
	// `configRoot` 缺省 = `sessionCwd`：registry agent 的常态（会话工作根就是它的配置根）。
	// default Agent 里两者不同（会话在工作中、配置根是它自己的家）—— 那是单独一条用例。
	return { agentId: "hr", attached: true, configRoot: overrides.sessionCwd, ...overrides };
}

afterEach(async () => {
	releaseMemoryDb(process.cwd());
	setConfigRootDir(undefined);
	if (savedHome !== undefined) process.env.HOME = savedHome;
	savedHome = undefined;
	await Promise.all(cleanups.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildMemoryScopeProjection — Agent / Project / User 分区", () => {
	test("user 区读隔离 HOME 的 user.md；agent 区用声明的记忆目录", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-agent-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const declared = path.join(agentDir, "memory");
		await writeFile(path.join(isolatedHome, ".cornfield", "user.md"), "# 测试用户画像\n");
		await writeFile(path.join(declared, "MEMORY.md"), "# Memory Report\n\n- agent seed\n");

		const projection = await buildMemoryScopeProjection(
			baseFacts({ agentDir, sessionCwd, declaredMemoryDir: declared }),
		);

		expect(projection.user?.path).toBe(path.join(isolatedHome, ".cornfield", "user.md"));
		expect(projection.user?.content).toContain("测试用户画像");
		expect(projection.agent?.scope).toBe("agent");
		expect(projection.agent?.memoryRoot).toBe(declared);
		expect(projection.agent?.rootKind).toBe("declared");
		expect(projection.agent?.memoryMd?.content).toContain("agent seed");
		expect(projection.agent?.error).toBeUndefined();
	});

	test("agent 区没有声明目录时回落到 agentDir/memories/<encoded-cwd>（旧版列布局）", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-legacy-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const legacy = path.join(agentDir, "memories", encodeProjectPath(sessionCwd));
		await writeFile(path.join(legacy, "MEMORY.md"), "- legacy seed\n");

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd }));

		expect(projection.agent?.memoryRoot).toBe(legacy);
		expect(projection.agent?.rootKind).toBe("legacy");
		expect(projection.agent?.memoryMd?.content).toContain("legacy seed");
		expect(projection.agent?.scope).toBe("agent");
	});

	test("project 区锚在配置项目根的 canonical 记忆根，并列出搜过的候选根", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-project-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const canonical = path.join(
			isolatedHome,
			".cornfield",
			"self-evolution",
			"memory",
			encodeProjectPath(sessionCwd),
		);
		await writeFile(path.join(canonical, "MEMORY.md"), "- project seed\n");
		await writeFile(path.join(canonical, "memory_summary.md"), "- summary seed\n");

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd, projectRoot: sessionCwd }));

		expect(projection.project?.scope).toBe("project");
		expect(projection.project?.memoryRoot).toBe(canonical);
		expect(projection.project?.memoryMd?.content).toContain("project seed");
		expect(projection.project?.summaryMd?.content).toContain("summary seed");
		expect(projection.project?.rawMd).toBeNull();
		expect(projection.project?.searchedRoots).toContain(canonical);
		expect(projection.resolution.projectRoot).toBe(sessionCwd);
	});

	test("会话 cwd 是系统路径 → 项目区按解析器规则指向 project-store 目录（不是 canonical 全局库路径）", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-system-");
		const agentDir = path.join(root, "agents", "hr");

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd: isolatedHome }));

		// `resolveEvolutionPathLayout` 对系统路径用 resolveProjectMemoryDir(cwd)，
		// 而不是 self-evolution/memory/<encoded> —— 这是解析器自己的规则，投影原样反映。
		expect(projection.project?.memoryRoot).toBe(path.join(isolatedHome, ".cornfield", "memory"));
		expect(projection.project?.rootKind).toBe("canonical");
	});

	test("canonical 根跟**配置项目根**走，不是会话 cwd（default Agent 的形状）", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-config-root-");
		const configRoot = path.join(root, ".cornfield", "agents", "default"); // 它的家 = 配置项目根
		const sessionCwd = path.join(root, "project"); // 会话在别处干活
		const agentDir = configRoot;
		const canonical = path.join(
			isolatedHome,
			".cornfield",
			"self-evolution",
			"memory",
			encodeProjectPath(configRoot),
		);
		await writeFile(path.join(canonical, "MEMORY.md"), "- config-root seed\n");

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd, configRoot }));

		expect(projection.project?.memoryRoot).toBe(canonical);
		expect(projection.project?.memoryMd?.content).toContain("config-root seed");
		expect(projection.project?.searchedRoots).toContain(canonical);
		// 拿会话 cwd 算出来的两个候选根都不在搜索路径里（canonical 与 agent 级 legacy 都按 memoryKey）：
		// 换错参数就会让面板与运行时各报一个根，也会去读已经被换掉的旧 key。
		expect(projection.project?.searchedRoots).not.toContain(
			path.join(isolatedHome, ".cornfield", "self-evolution", "memory", encodeProjectPath(sessionCwd)),
		);
		expect(projection.project?.searchedRoots).not.toContain(
			path.join(agentDir, "memories", encodeProjectPath(sessionCwd)),
		);
		expect(projection.agent?.searchedRoots).not.toContain(
			path.join(agentDir, "memories", encodeProjectPath(sessionCwd)),
		);
	});
});

describe("buildMemoryScopeProjection — 会话记忆与全局库", () => {
	test("会话记忆：库里没有这个会话 = pending；有行则带回原始记忆与摘要", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-session-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const sessionFile = path.join(agentDir, "sessions", "conv.jsonl");

		const before = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd, sessionFile }));
		expect(before.session?.pending).toBe(true);
		expect(before.session?.rawMemory).toBeUndefined();
		expect(before.session?.error).toBeUndefined();

		// 记忆管线的落库形状：threads（按 rollout 路径）+ stage1_outputs
		const db = openMemoryDb(resolveMemoryDbPath(sessionCwd));
		db.prepare("INSERT INTO threads (id, updated_at, rollout_path, cwd, source_kind) VALUES (?, ?, ?, ?, ?)").run(
			"thread-1",
			1700000000,
			sessionFile,
			sessionCwd,
			"cli",
		);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at) VALUES (?, ?, ?, ?, ?)",
		).run("thread-1", 1700000001, "raw memory seed", "summary seed", 1700000002);

		const after = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd, sessionFile }));
		expect(after.session?.pending).toBe(false);
		expect(after.session?.threadId).toBe("thread-1");
		expect(after.session?.rawMemory).toBe("raw memory seed");
		expect(after.session?.summary).toBe("summary seed");
		expect(after.session?.generatedAt).toBe(1700000002);
		expect(after.session?.scope).toBe("session");
	});

	test("未 attach：会话记忆不可读（null）且有说明；全局库读得出条目", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-store-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");

		const db = getMemoryDb(sessionCwd);
		db.prepare(
			"INSERT INTO vector_embeddings (id, namespace, content, embedding_json, metadata_json, importance, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("e1", "facts", "记忆库条目", "[]", null, 0.9, 1700000000, 1700000000);

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd, attached: false }));

		expect(projection.session).toBeNull();
		expect(projection.resolution.notes.some(note => note.includes("未 attach"))).toBe(true);
		expect(projection.memoryStore.scope).toBe("global");
		expect(projection.memoryStore.totalEntries).toBe(1);
		expect(projection.memoryStore.sections[0]?.namespace).toBe("facts");
		expect(projection.memoryStore.error).toBeUndefined();
	});

	test("全局库读不出来 → error 带上原因（旧实现会吞成「暂无记忆条目」）", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-store-broken-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		// 让 evolution.db 这个路径是个目录：sqlite 打不开 → 读失败必须可见
		await fs.mkdir(path.join(isolatedHome, ".cornfield", "self-evolution", "evolution.db"), { recursive: true });

		const projection = await buildMemoryScopeProjection(baseFacts({ agentDir, sessionCwd }));

		expect(projection.memoryStore.sections).toEqual([]);
		expect(projection.memoryStore.totalEntries).toBe(0);
		expect(projection.memoryStore.error).toContain("记忆库读取失败");
		expect(projection.resolution.notes.some(note => note.includes("记忆库读取失败"))).toBe(true);
	});
});

describe("buildMemoryScopeProjection — 读失败不是空", () => {
	test("记忆文件不可读 → 该区 error 有原因、文件为 null（不显示成「未生成」）", async () => {
		await isolateHome();
		const root = await tmpDir("scope-memory-eacces-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const declared = path.join(agentDir, "memory");
		const memoryMd = await writeFile(path.join(declared, "MEMORY.md"), "- 不该被读到\n");
		await fs.chmod(memoryMd, 0o000);

		const projection = await buildMemoryScopeProjection(
			baseFacts({ agentDir, sessionCwd, declaredMemoryDir: declared }),
		);

		expect(projection.agent?.memoryMd).toBeNull();
		expect(projection.agent?.error).toContain("读取失败");
		expect(projection.agent?.memoryRoot).toBe(declared);
	});
});
