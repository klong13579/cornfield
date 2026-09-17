/**
 * Memory 工作台的 scope 投影（WP10 · T10B）。
 *
 * 页面要回答「这条记忆属于谁、从哪儿读的、什么时候更新的、读失败还是真的空」，所以投影按
 * **真实范围**分区，每一区都锚在既有解析器上，不新建任何记忆存储：
 *
 *   user     `~/.cornfield/user.md`（身份画像，跨 Project）
 *   agent    Agent 自己的记忆 home：WP1 `WorkspaceContext.memoryDir`（`<agentDir>/<声明>`）
 *            + 旧版列布局 `<agentDir>/memories/<encoded-cwd>`（resolveGlobalMemoryRootCandidates）
 *   project  本会话所在 Project 的记忆投影（`getMemoryRoot` 的 canonical 目录 + 旧版回落）。
 *            canonical 根用**配置/记忆的项目根**（`anchor.configRoot` = 目标会话活着的
 *            `Settings#getCwd()`），与运行时（`sdk.ts` 的 `getMemoryRoot(agentDir, settings.getCwd())`）
 *            同一个根；用 `sessionCwd` 会让 default 的记忆面板与运行时各报一个根（会话在工作中，
 *            配置根却是它自己的家）。旧版安全回落仍按 `sessionCwd` 算（运行时那边也是 `ctx.cwd`）。
 *   session  本会话的 stage-1 记忆（evolution.db 的 threads ⨝ stage1_outputs，按会话文件）
 *   memoryStore ~/.cornfield/self-evolution 的 vector_embeddings 分区（全局库，跨 Project）
 *
 * 失败模型（这是本模块存在的另一半理由）：读不到 ≠ 空。旧实现把 zone 的读失败吞成 `null`
 * （「这个 zone 没内容」）并只写 logger.debug，页面于是把「读坏了」显示成「还没生成」。
 * 现在每个 zone 带 `error`，每一份文件缺失与读取失败分开，UI 必须分别渲染。
 *
 * 输出形状由 `@cornfield/wire` 拥有（`results/memory.ts`）：本模块是唯一生产者，不另立一份同形接口。
 */

import * as path from "node:path";
import { getMemoryRoot, resolveGlobalMemoryRootCandidates } from "@cornfield/self-evolution/paths";
import { getConfigRootDir, isEnoent } from "@cornfield/utils";
import type {
	MemoryEntryDto,
	MemoryFileZoneDto,
	MemoryProjectionDto,
	MemoryScope,
	MemorySectionDto,
	MemorySessionZoneDto,
	MemoryTextFileDto,
} from "@cornfield/wire";
// 读窄子路径而不是 `../memories` 桶：桶会把 self-evolution 的会话/模型依赖一并拉进来，
// 与 coding-agent 的 settings 形成初始化环（TDZ）。这里只需要 DB 访问 + 分区投影。
import { loadSectionsFromDb } from "../memories/projection";
import { getMemoryDb, readSessionMemory, releaseMemoryDb, resolveMemoryDbPath } from "../memories/storage";

/** 记忆文件投影上限（与 fs_read 同口径：>128KB 截断并标记）。 */
const MEMORY_FILE_MAX_BYTES = 128 * 1024;

/** 投影用的定位事实（调用方按焦点 Agent / 会话解析后传入，本模块不再自己猜）。 */
export interface MemoryScopeAnchor {
	agentId: string;
	/** Agent 的物理 home（default agent 用 getDefaultAgentHome()）。 */
	agentDir: string;
	/** 会话 cwd（未 attach 的 registry agent = agentDir，就是它会话的根）。 */
	sessionCwd: string;
	/**
	 * 配置/记忆的项目根（目标会话活着的 `Settings#getCwd()`；未 attach = agentDir）。
	 * canonical 记忆根按它算 —— 与 config 的 project 层、与运行时 `getMemoryRoot` 同一个根。
	 */
	configRoot: string;
	/** 会话所属 Project 的 root（未归属 = undefined）。 */
	projectRoot?: string;
	/** WP1 `WorkspaceContext.memoryDir`（agentDir 声明的记忆目录，绝对路径）。 */
	declaredMemoryDir?: string;
	/** 本会话的 session 文件（未 attach = undefined）。 */
	sessionFile?: string;
	/** 是否已 attach（false 时 sessionCwd/sessionFile 是按 Agent home 推的，不是会话事实）。 */
	attached: boolean;
}

/** 读一份投影文件：文件不存在与读取失败分开返回（null ≠ error）。 */
async function readMemoryFile(filePath: string): Promise<{ file: MemoryTextFileDto | null; error?: string }> {
	try {
		// 单 handle 读内容 + mtime（同一个 fd，不重复打开同一路径）。
		const handle = Bun.file(filePath);
		const content = await handle.text();
		const file: MemoryTextFileDto = {
			path: filePath,
			content: content.length > MEMORY_FILE_MAX_BYTES ? content.slice(0, MEMORY_FILE_MAX_BYTES) : content,
			truncated: content.length > MEMORY_FILE_MAX_BYTES,
		};
		try {
			// mtimeMs 在 macOS 上是小数毫秒：除成整数，与库里其它时间戳同一形状。
			file.updatedAt = Math.floor((await handle.stat()).mtimeMs);
		} catch {
			// 读完到 stat 之间被删/换掉：内容仍然有效，只是没有 mtime —— 不编一个时间出来。
		}
		return { file };
	} catch (err) {
		if (isEnoent(err)) return { file: null };
		return { file: null, error: `${filePath} 读取失败：${err instanceof Error ? err.message : String(err)}` };
	}
}

/** 一个候选根：路径 + 它是哪条解析规则给的（canonical / legacy / declared）。 */
interface MemoryZoneCandidate {
	path: string;
	kind: string;
}

/**
 * 读一个 scope 的目录投影：按候选根优先级取第一个有文件的根（全空则采用首个候选根并如实置空）。
 * 与既有 project 区行为一致，只是多了 rootKind / searchedRoots / error。
 */
async function readFileZone(
	scope: MemoryScope,
	candidates: readonly MemoryZoneCandidate[],
): Promise<MemoryFileZoneDto> {
	const seen = new Set<string>();
	const unique: MemoryZoneCandidate[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		unique.push(candidate);
	}
	const searchedRoots = unique.map(candidate => candidate.path);
	let emptyFallback: MemoryFileZoneDto | undefined;
	for (const candidate of unique) {
		const [memoryMd, summaryMd, rawMd] = await Promise.all([
			readMemoryFile(path.join(candidate.path, "MEMORY.md")),
			readMemoryFile(path.join(candidate.path, "memory_summary.md")),
			readMemoryFile(path.join(candidate.path, "raw_memories.md")),
		]);
		const errors = [memoryMd.error, summaryMd.error, rawMd.error].filter((e): e is string => e !== undefined);
		const zone: MemoryFileZoneDto = {
			scope,
			memoryRoot: candidate.path,
			rootKind: candidate.kind,
			searchedRoots,
			memoryMd: memoryMd.file,
			summaryMd: summaryMd.file,
			rawMd: rawMd.file,
		};
		if (errors.length > 0) zone.error = errors.join("；");
		if (zone.memoryMd || zone.summaryMd || zone.rawMd) return zone;
		emptyFallback ??= zone;
	}
	return (
		emptyFallback ?? {
			scope,
			memoryRoot: null,
			searchedRoots,
			memoryMd: null,
			summaryMd: null,
			rawMd: null,
		}
	);
}

/** 读会话记忆：自己吞下失败（返回带 error 的 zone，不抛），refcount 无论如何都归还。 */
function readSessionZone(anchor: MemoryScopeAnchor, cwd: string): MemorySessionZoneDto | null {
	if (!anchor.sessionFile) return null;
	const sessionFile = anchor.sessionFile;
	const zone: MemorySessionZoneDto = { scope: "session", rolloutPath: sessionFile, pending: false };
	let db: ReturnType<typeof getMemoryDb> | undefined;
	try {
		db = getMemoryDb(cwd);
		const row = readSessionMemory(db, sessionFile);
		if (!row) {
			// 管线还没处理过这个会话 —— 「未沉淀」不是「没有记忆」。
			zone.pending = true;
			return zone;
		}
		zone.threadId = row.threadId;
		zone.rawMemory = row.rawMemory;
		zone.summary = row.summary;
		if (row.generatedAt > 0) zone.generatedAt = row.generatedAt;
		if (row.sourceUpdatedAt > 0) zone.sourceUpdatedAt = row.sourceUpdatedAt;
		return zone;
	} catch (err) {
		zone.error = `会话记忆读取失败：${err instanceof Error ? err.message : String(err)}`;
		return zone;
	} finally {
		if (db) releaseMemoryDb(cwd);
	}
}

/**
 * 组装按 scope 分区的记忆投影。
 *
 * `projectRoot` / `declaredMemoryDir` 由调用方从既有解析器（Project store、WP1
 * `deriveWorkspaceContext`）取，本函数不重新推导它们 —— 两处推导不一致时，页面会读一个
 * Agent、显示另一个的路径。
 */
export async function buildMemoryScopeProjection(anchor: MemoryScopeAnchor): Promise<MemoryProjectionDto> {
	const notes: string[] = [];

	// user：身份画像（跨 Project 的用户记忆；与 identity 工具同路径）
	const userRead = await readMemoryFile(path.join(getConfigRootDir(), "user.md"));

	// agent：Agent 自己的记忆 home（声明目录优先，旧版 agentDir/memories 列布局回落）
	const agentCandidates: MemoryZoneCandidate[] = [];
	if (anchor.declaredMemoryDir) agentCandidates.push({ path: anchor.declaredMemoryDir, kind: "declared" });
	try {
		for (const legacy of resolveGlobalMemoryRootCandidates(anchor.agentDir, anchor.configRoot)) {
			agentCandidates.push({ path: legacy, kind: "legacy" });
		}
	} catch (err) {
		notes.push(`Agent 记忆目录解析失败：${err instanceof Error ? err.message : String(err)}`);
	}
	const agent = agentCandidates.length > 0 ? await readFileZone("agent", agentCandidates) : null;
	if (!agent) notes.push("没有可解析的 Agent 记忆目录");

	// project：canonical 解析根优先，旧版扁平目录回落（与既有 project 区行为一致）。
	// 系统路径下 `getMemoryRoot` 会把根指向 project-store 目录（`<cwd>/.cornfield/memory`）而不是
	// canonical 全局库路径 —— 这是解析器自己的规则，这里原样反映，不另外发明一条「不适用」。
	const projectCandidates: MemoryZoneCandidate[] = [];
	const canonicalProjectRoot = getMemoryRoot(anchor.configRoot);
	if (canonicalProjectRoot) projectCandidates.push({ path: canonicalProjectRoot, kind: "canonical" });
	try {
		for (const legacy of resolveGlobalMemoryRootCandidates(anchor.agentDir, anchor.configRoot)) {
			projectCandidates.push({ path: legacy, kind: "legacy" });
		}
	} catch {
		// 旧目录解析失败不影响 canonical
	}
	const project = projectCandidates.length > 0 ? await readFileZone("project", projectCandidates) : null;

	// session：本会话在记忆管线里的 stage-1 输出（唯一按会话键取的记忆）
	const session = readSessionZone(anchor, anchor.sessionCwd);
	if (!anchor.sessionFile) {
		notes.push("会话未 attach —— 会话记忆要等会话事实（session 文件）才可读");
	}

	// memoryStore：全局 self-evolution 库（跨 Project；行按 MEMORY.md 分区名分组）
	let sections: MemorySectionDto[] = [];
	let storeError: string | undefined;
	let dbPath = "";
	try {
		dbPath = resolveMemoryDbPath(anchor.sessionCwd);
	} catch {
		// 路径是纯计算，理论上不抛；真抛了也不阻止其它 zone 渲染
	}
	let db: ReturnType<typeof getMemoryDb> | undefined;
	try {
		db = getMemoryDb(anchor.sessionCwd);
		sections = loadSectionsFromDb(db).map(
			(section): MemorySectionDto => ({
				namespace: section.namespace,
				entries: section.entries.map(
					(entry): MemoryEntryDto => ({
						id: entry.id,
						content: entry.content,
						importance: entry.importance,
						lastAccessedAt: entry.lastAccessedAt,
					}),
				),
			}),
		);
	} catch (err) {
		// 旧实现把它吞成空列表：页面于是显示「暂无记忆条目」。读失败必须可见，
		// 且不能连坐其它 zone —— 库坏了不代表 user/agent/project 也读不出来。
		storeError = `记忆库读取失败：${err instanceof Error ? err.message : String(err)}`;
		notes.push(storeError);
	} finally {
		if (db) releaseMemoryDb(anchor.sessionCwd);
	}
	const totalEntries = sections.reduce((sum, s) => sum + s.entries.length, 0);
	if (!anchor.attached) {
		notes.push("Agent 未 attach：项目/会话记忆按 Agent home 作为会话根推算，不是会话事实");
	}

	return {
		user: userRead.file,
		...(userRead.error ? { userError: userRead.error } : {}),
		agent,
		project,
		session,
		memoryStore: {
			scope: "global",
			dbPath,
			sections,
			totalEntries,
			...(storeError ? { error: storeError } : {}),
		},
		resolution: {
			agentId: anchor.agentId,
			agentDir: anchor.agentDir,
			sessionCwd: anchor.sessionCwd,
			projectRoot: anchor.projectRoot ?? null,
			sessionFile: anchor.sessionFile ?? null,
			attached: anchor.attached,
			storeScope: "global",
			notes,
		},
	};
}
