/**
 * 用量面板的 scope 归属推导（纯函数：无 React、无 I/O、无 store）。
 *
 * 回答一个问题：stats 的 byFolder 目录行属于哪个 Agent / 哪个 Project / 哪个 Session。
 * 三个事实源都是既有真数据，本模块只做推导，不引入任何新读面：
 *
 *   目录 key        stats `byFolder[].folder`（omp-stats parser 已把 `<encoded-cwd>` 解成绝对路径）
 *   Agent 归属      list_sessions：sessionFile 落在该目录的会话的 `agent` 字段
 *   Project 归属    list_projects：用目录绝对路径匹配已声明 root（最深祖先获胜，与 serve 同规则）
 *
 * 三条不能混的语义（UI 必须分开渲染，不许互相顶替）：
 *   读不到 ≠ 空           `projects` 缺省 = registry 还没读到 —— 此时**不得**判「未归属」
 *   没有会话 ≠ 没有用量    目录在 stats 里有行、索引里没有会话 → Agent 未知（单独成组，不并入任何 Agent）
 *   汇总 ≠ 原生指标        分组数字一律是把成员目录行**求和**得来，不是服务端原生指标
 *
 * 派生汇总口径（rollupByAgent / rollupByProject）：
 *   totalRequests / failedRequests / totalInputTokens / totalOutputTokens / totalCost = 成员行直接相加
 *   errorRate = ΣfailedRequests / ΣtotalRequests（加权重算，**不是**各行 errorRate 取平均）
 */

import type { AgentInfoDto, ProjectRecordDto, StatsFolderRowDto } from "@cornfield/wire";
import type { SessionRecordSummary } from "../../lib/records";

/**
 * 路径文本归一：`\` → `/`、折叠重复分隔符、去尾随分隔符（`/` 自身保留）。
 * 只做文本归一：不解析 symlink、不改大小写——浏览器里做不到的归一就不假装做了
 * （serve 侧 `matchProjectForPath` 会做 symlink 归一，前端命中不了就是未归属，不猜）。
 */
export function normalizePath(value: string): string {
	const slashed = value.trim().replaceAll("\\", "/");
	const collapsed = slashed.replace(/\/{2,}/g, "/");
	return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * list_sessions sessionFile → stats byFolder 的目录 key（与 omp-stats parser 同规则）：
 * `<sessionsRoot>/<encoded-cwd>/by-date/...` 取 `<encoded-cwd>` 段，`--` 分隔符还原为 `/`。
 *
 * 返回 null = 不是目录布局（gateway 的扁平文件 `<agentDir>/sessions/<convId>.jsonl`）——
 * 它不落在任何目录行下，调用方不得把它硬塞给某个目录。
 */
export function folderKeyOf(sessionFile: string | undefined): string | null {
	if (!sessionFile) return null;
	const segments = sessionFile.replaceAll("\\", "/").split("/");
	const idx = segments.lastIndexOf("sessions");
	const enc = idx >= 0 && idx + 1 < segments.length ? segments[idx + 1] : undefined;
	if (!enc || enc.includes(".")) return null; // 扁平文件（如 gateway convId.jsonl）非目录布局
	return enc.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * 目录编码名 → 绝对路径（编码规则见 folderKeyOf：`--` 是分隔符、前导 `--` 是根）。
 *
 * 只有**以 `--` 开头**才解码：`byFolder[].folder` 与 folderKeyOf 返回的都已是解码后的路径，
 * 盲目把其中的 `--` 当分隔符会把目录名里合法的 `--`（`/a/foo--bar`）拆成两段。
 *
 * 返回 null = 空串，或解出来不是绝对路径（相对路径无法与任何已声明 root 比较）。
 */
export function decodeFolderPath(folderKey: string): string | null {
	const trimmed = folderKey.trim();
	if (!trimmed) return null;
	const slashed = trimmed.replaceAll("\\", "/");
	const decoded = slashed.startsWith("--") ? slashed.replace(/^--/, "/").replace(/--/g, "/") : slashed;
	const normalized = normalizePath(decoded);
	return normalized.startsWith("/") ? normalized : null;
}

/**
 * 一个归属轴的判定结果 —— 三态**不能互相顶替**：
 *
 *   known       名单已加载且判过（值在 `value` 里）
 *   unassigned  名单已加载，但这个目录不落在任何项上（确实未归属）
 *   unknown     名单没加载 / 读失败 —— 这时**不能**下任何结论（尤其不能当「未归属」）
 *
 * 用带标签的 union 而不是「一个可选值 + 一个布尔」：后者的两个字段可以互相矛盾，
 * 而这里的状态与数据不可能不一致。
 */
export type AttributionAxis<T> = { state: "known"; value: T } | { state: "unassigned" } | { state: "unknown" };

/** 目录的 Agent 归属值：会话身份串（id + 显示名，同序）。 */
export interface AgentAttributionValue {
	ids: string[];
	names: string[];
}

/** 一个目录的归属（两个轴各自带状态）。 */
export interface FolderAttribution {
	agents: AttributionAxis<AgentAttributionValue>;
	/** Project 归属值 = 命中的 projectId（最深的祖先 root 获胜）。 */
	project: AttributionAxis<string>;
	/** 目录绝对路径（Project 匹配的解码结果）；非绝对路径 = null。 */
	path: string | null;
}

export interface FolderAttributionSources {
	/**
	 * list_sessions 真索引（Agent 归属的唯一来源）。
	 * **undefined = 索引未加载/读失败** —— 此时 Agent 归属是 unknown，不得判「未归属」。
	 */
	sessions?: readonly SessionRecordSummary[];
	/**
	 * list_projects 的 projects。**undefined = registry 还没读到**；
	 * `[]` = 读到了、确实没声明过。两者不可混：前者不得判「未归属」。
	 */
	projects?: readonly ProjectRecordDto[];
	/** list_agents 注册表（把会话身份串解析成显示名/ id）；缺省 = 不解析，原样回落。 */
	agents?: readonly AgentInfoDto[];
}

/** 目录 key → 归属（attributeFolders 的产物，一次建索引供所有行复用）。 */
export type FolderAttributionIndex = ReadonlyMap<string, FolderAttribution>;

/** 目录 → 落在该目录的会话（folderKeyOf === key；扁平文件不参与）。 */
function indexSessionsByFolder(sessions: readonly SessionRecordSummary[]): Map<string, SessionRecordSummary[]> {
	const index = new Map<string, SessionRecordSummary[]>();
	for (const session of sessions) {
		const key = folderKeyOf(session.sessionFile);
		if (key === null) continue;
		const bucket = index.get(key);
		if (bucket) bucket.push(session);
		else index.set(key, [session]);
	}
	return index;
}

function resolveAgentIdentity(
	identity: string,
	agents: readonly AgentInfoDto[] | undefined,
): { id: string; name: string } {
	const meta = agents?.find(agent => agent.id === identity || agent.name === identity);
	return meta ? { id: meta.id, name: meta.name } : { id: identity, name: identity };
}

/**
 * 最深的祖先 root 命中者（root 自身或其后代；嵌套声明遮蔽父级）——serve
 * `matchProjectForPath` 的同规则前端版本，用于把目录绝对路径挂到 Project 上。
 * `projects` 缺省 = registry 未读到 → 没有答案（undefined），不是「未归属」。
 */
export function matchProjectForPath(
	projects: readonly ProjectRecordDto[] | undefined,
	targetPath: string,
): ProjectRecordDto | undefined {
	if (!projects) return undefined;
	const wanted = normalizePath(targetPath);
	let best: ProjectRecordDto | undefined;
	let bestLength = -1;
	for (const project of projects) {
		const root = normalizePath(project.root);
		if (!root) continue;
		const prefix = root.endsWith("/") ? root : `${root}/`;
		if (wanted !== root && !wanted.startsWith(prefix)) continue;
		if (root.length > bestLength) {
			best = project;
			bestLength = root.length;
		}
	}
	return best;
}

function attributeFromIndex(
	folderKey: string,
	sources: FolderAttributionSources,
	byFolder: Map<string, SessionRecordSummary[]> | undefined,
): FolderAttribution {
	const path = decodeFolderPath(folderKey);
	return {
		agents: attributeAgents(folderKey, sources, byFolder),
		project: attributeProject(path, sources),
		path,
	};
}

/** Agent 轴：索引未加载 → unknown（不是未归属）。 */
function attributeAgents(
	folderKey: string,
	sources: FolderAttributionSources,
	byFolder: Map<string, SessionRecordSummary[]> | undefined,
): AttributionAxis<AgentAttributionValue> {
	if (!byFolder) return { state: "unknown" };
	const identities: string[] = [];
	for (const session of byFolder.get(folderKey) ?? []) {
		if (!identities.includes(session.agent)) identities.push(session.agent);
	}
	if (identities.length === 0) return { state: "unassigned" };
	// 身份串无序，先排序再解析：同一份输入永远得到同一份分组（排序不稳定会让 UI 抖）。
	identities.sort((a, b) => a.localeCompare(b));
	const resolved = identities.map(identity => resolveAgentIdentity(identity, sources.agents));
	return { state: "known", value: { ids: resolved.map(row => row.id), names: resolved.map(row => row.name) } };
}

/** Project 轴：registry 未加载 → unknown（不是未归属）。 */
function attributeProject(path: string | null, sources: FolderAttributionSources): AttributionAxis<string> {
	if (!sources.projects) return { state: "unknown" };
	if (path === null) return { state: "unassigned" };
	const project = matchProjectForPath(sources.projects, path);
	return project ? { state: "known", value: project.projectId } : { state: "unassigned" };
}

/** 单个目录的归属（内部分配索引只建一次，适合零散查询）。 */
export function attributeFolder(folderKey: string, sources: FolderAttributionSources): FolderAttribution {
	return attributeFromIndex(
		folderKey,
		sources,
		sources.sessions ? indexSessionsByFolder(sources.sessions) : undefined,
	);
}

/** 一批目录的归属（会话索引只扫一遍；用量面板对所有 stats 行走这条）。 */
export function attributeFolders(
	folderKeys: Iterable<string>,
	sources: FolderAttributionSources,
): FolderAttributionIndex {
	const byFolder = sources.sessions ? indexSessionsByFolder(sources.sessions) : undefined;
	const index = new Map<string, FolderAttribution>();
	for (const key of folderKeys) {
		if (index.has(key)) continue;
		index.set(key, attributeFromIndex(key, sources, byFolder));
	}
	return index;
}

/** 分组种类：未知（名单未加载）、未归属、多 Agent 都不并入任何具名组。 */
export type ScopeGroupKind = "agent" | "shared" | "unassigned" | "unknown" | "project";

/**
 * 一个 scope 分组的求和结果（口径见文件头；`errorRate` 是加权重算出来的）。
 * `key` 形如 `agent:<身份串>` / `project:<id>` / `unassigned` / `shared:<身份串列表>`。
 */
export interface ScopeRollupRow {
	key: string;
	label: string;
	kind: ScopeGroupKind;
	/** 参与求和的目录行数（同一目录在 stats 里出现两行就算两行——stats 说了算）。 */
	folderCount: number;
	totalRequests: number;
	failedRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	/** ΣfailedRequests / ΣtotalRequests；无请求时为 0（UI 需另行说明「无请求」，别把它读成 0% 错误率）。 */
	errorRate: number;
}

type RollupAccumulator = Omit<ScopeRollupRow, "errorRate">;

function groupOf(
	groups: Map<string, RollupAccumulator>,
	key: string,
	kind: ScopeGroupKind,
	label: string,
): RollupAccumulator {
	const existing = groups.get(key);
	if (existing) return existing;
	const created: RollupAccumulator = {
		key,
		label,
		kind,
		folderCount: 0,
		totalRequests: 0,
		failedRequests: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCost: 0,
	};
	groups.set(key, created);
	return created;
}

function addRow(group: RollupAccumulator, row: StatsFolderRowDto): void {
	group.folderCount += 1;
	group.totalRequests += row.totalRequests;
	group.failedRequests += row.failedRequests;
	group.totalInputTokens += row.totalInputTokens;
	group.totalOutputTokens += row.totalOutputTokens;
	group.totalCost += row.totalCost;
}

function finalize(groups: Map<string, RollupAccumulator>): ScopeRollupRow[] {
	return [...groups.values()]
		.map(group => ({ ...group, errorRate: group.totalRequests > 0 ? group.failedRequests / group.totalRequests : 0 }))
		.sort((a, b) => b.totalCost - a.totalCost || a.key.localeCompare(b.key));
}

const UNASSIGNED_AGENT_LABEL = "未归属（索引里没有落在这个目录的会话）";
const UNKNOWN_AGENT_LABEL = "归属未知（会话索引未加载）";
const SHARED_AGENT_LABEL = "多 Agent 目录（会话索引指向多个 Agent）";
const UNASSIGNED_PROJECT_LABEL = "未归属（目录路径不落在任何已声明 Project）";
const UNKNOWN_PROJECT_LABEL = "归属未知（Project registry 未加载）";

/**
 * 按 Agent 汇总。归属未知（索引未加载）与未归属、多 Agent 各自成组：
 * 三者都**不并入任何 Agent**（把未知当未归属是拿一个没读过的名单下结论；
 * 把多 Agent 目录整份计给每个 Agent 就是重复计数，拆开是编数据）。
 */
export function rollupByAgent(
	rows: readonly StatsFolderRowDto[],
	attribution: FolderAttributionIndex,
): ScopeRollupRow[] {
	const groups = new Map<string, RollupAccumulator>();
	for (const row of rows) {
		const agents = attribution.get(row.folder)?.agents;
		if (!agents || agents.state === "unknown") {
			addRow(groupOf(groups, "unknown", "unknown", UNKNOWN_AGENT_LABEL), row);
			continue;
		}
		if (agents.state === "unassigned") {
			addRow(groupOf(groups, "unassigned", "unassigned", UNASSIGNED_AGENT_LABEL), row);
			continue;
		}
		const { ids, names } = agents.value;
		if (names.length > 1) {
			addRow(
				groupOf(groups, `shared:${ids.join("|")}`, "shared", `${SHARED_AGENT_LABEL}：${names.join(" + ")}`),
				row,
			);
			continue;
		}
		addRow(groupOf(groups, `agent:${ids[0]}`, "agent", names[0]!), row);
	}
	return finalize(groups);
}

/**
 * 按 Project 汇总。`projects` 只用来把 projectId 显示成人读名字（必须与 attributeFolders
 * 用同一份 registry）；查不到名字时回落显示 id —— 显示 id 是事实，编一个名字不是。
 */
export function rollupByProject(
	rows: readonly StatsFolderRowDto[],
	attribution: FolderAttributionIndex,
	projects?: readonly ProjectRecordDto[],
): ScopeRollupRow[] {
	const groups = new Map<string, RollupAccumulator>();
	for (const row of rows) {
		const project = attribution.get(row.folder)?.project;
		if (!project || project.state === "unknown") {
			addRow(groupOf(groups, "unknown", "unknown", UNKNOWN_PROJECT_LABEL), row);
			continue;
		}
		if (project.state === "unassigned") {
			addRow(groupOf(groups, "unassigned", "unassigned", UNASSIGNED_PROJECT_LABEL), row);
			continue;
		}
		const label = projects?.find(item => item.projectId === project.value)?.name ?? project.value;
		addRow(groupOf(groups, `project:${project.value}`, "project", label), row);
	}
	return finalize(groups);
}

/** 当前会话在 list_sessions 索引里的位置（四态：没身份 / 索引未加载 / 有身份但不在索引 / 命中）。 */
export type CurrentSessionFacts =
	| { state: "no-identity" }
	| { state: "unknown" }
	| { state: "unindexed"; sessionFile?: string; sessionId?: string }
	| { state: "indexed"; session: SessionRecordSummary; folderKey: string | null };

/**
 * 在当前会话与 list_sessions 索引之间做匹配。
 *
 * 优先按 sessionFile 精确匹配（两份路径都做归一）；只有拿不到 sessionFile 时才按会话 id 匹配：
 * 有 sessionFile 却匹配不上就是「不在索引里」——再按 id 猜一次会把索引里的另一个会话认成当前会话。
 * `sessions === undefined`（索引未加载/读失败）→ `unknown`：不能断言「不在索引里」。
 */
export function findCurrentSession(
	sessions: readonly SessionRecordSummary[] | undefined,
	current: { sessionFile?: string; sessionId?: string },
): CurrentSessionFacts {
	if (!sessions) return { state: "unknown" };
	if (current.sessionFile) {
		const wanted = normalizePath(current.sessionFile);
		const hit = sessions.find(
			session => session.sessionFile !== undefined && normalizePath(session.sessionFile) === wanted,
		);
		return hit
			? { state: "indexed", session: hit, folderKey: folderKeyOf(hit.sessionFile) }
			: { state: "unindexed", sessionFile: current.sessionFile };
	}
	if (current.sessionId) {
		const hit = sessions.find(session => session.id === current.sessionId);
		return hit
			? { state: "indexed", session: hit, folderKey: folderKeyOf(hit.sessionFile) }
			: { state: "unindexed", sessionId: current.sessionId };
	}
	return { state: "no-identity" };
}

export interface ScopeSectionsInput {
	rows: readonly StatsFolderRowDto[];
	attribution: FolderAttributionIndex;
	/** 已声明的 Project（仅用于显示名）；缺省 = registry 未读到。 */
	projects?: readonly ProjectRecordDto[];
	/** 当前会话所在目录 key（findCurrentSession 的产物）；null / 缺省 = 无法确定。 */
	sessionFolderKey?: string | null;
}

/**
 * 把 stats 目录行分到各桶（每个轴各自分开未知/未归属）：
 *   byAgent            单一 Agent 的目录行汇总（kind "agent"）
 *   byProject          命中 Project 的目录行汇总（kind "project"）
 *   unknownAgent       名单未加载（会话索引没读到）→ 归属未知，不判未归属
 *   unassignedAgent    未归属 / 多 Agent 的目录行汇总（kind "unassigned" | "shared"）——
 *                      不并入任何 Agent
 *   unknownProject     registry 未加载 → Project 归属未知
 *   unassignedProject  未归属 Project 的目录行汇总
 *   sessionRows        当前会话所在目录的**原始行**（目录级，不是会话级；调用方必须标注）
 */
export interface ScopeSections {
	byAgent: ScopeRollupRow[];
	byProject: ScopeRollupRow[];
	unknownAgent: ScopeRollupRow[];
	unassignedAgent: ScopeRollupRow[];
	unknownProject: ScopeRollupRow[];
	unassignedProject: ScopeRollupRow[];
	sessionRows: StatsFolderRowDto[];
}

export function scopeSections(input: ScopeSectionsInput): ScopeSections {
	const agentGroups = rollupByAgent(input.rows, input.attribution);
	const projectGroups = rollupByProject(input.rows, input.attribution, input.projects);
	const sessionFolderKey = input.sessionFolderKey ?? null;
	return {
		byAgent: agentGroups.filter(group => group.kind === "agent"),
		unknownAgent: agentGroups.filter(group => group.kind === "unknown"),
		unassignedAgent: agentGroups.filter(group => group.kind === "unassigned" || group.kind === "shared"),
		byProject: projectGroups.filter(group => group.kind === "project"),
		unknownProject: projectGroups.filter(group => group.kind === "unknown"),
		unassignedProject: projectGroups.filter(group => group.kind === "unassigned"),
		sessionRows: sessionFolderKey === null ? [] : input.rows.filter(row => row.folder === sessionFolderKey),
	};
}
