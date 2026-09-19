/**
 * serve 侧的 Project 只读桥 —— 把客户端级 Project registry 搬到 wire 面。
 *
 * 桥不拥有语义：Project 的权威是 `agent-domain/project-store`（`~/.cornfield/agent/projects.json`，
 * WP4），一个 root 只能被一个 Project 声明，root 比较按 symlink 归一。这里只做两件事：
 * 投影成 wire 形状，以及把**会话的归属**原样搬过来 —— 归属的唯一判定在 `session/session-workspace`
 * （会话记录的 `header.projectId` 权威 → 按 cwd 匹配回落 → 没有人声明过），桥不在这里再写一份。
 *
 * 归属的输入是**会话本身**，不是它的 cwd 字符串：只拿到一个目录的桥只能按路径猜，而
 * 「这个会话属于哪个 Project」是会话记录下来的事实，猜出来的归属会让调用方把一个会话
 * 放到它从未声明过的 Project 下。来源随归属一起返回（`currentProjectSource`）：
 * 「会话记的」与「按目录算的」不是一个可信度。
 *
 * 失败模型照抄存储层与 resolver，不自己发明一条更宽松的：
 *   - 文件不存在 → 空数组（「没声明过」是明确的事实）；
 *   - 文件在但损坏 / 版本不符 / 条目形状不对 → **抛**，由命令回 ok:false；
 *   - 会话记录的 Project 注册表里不存在、声明文件读不出来 → 同样**抛**（resolver 的判决）。
 * 把任何一种降级成空列表或「没归属」，都会把「声明过但读坏了」显示成「没声明过」——
 * 用户会以为自己的项目消失了，或者以为会话没有被归属。
 *
 * 写面（`set_project` / `delete_project`）同样只搬存储的判决：谁占用 root、版本、读写失败都由
 * 存储说了算，这里只补上「调用方给进来的形状本身不成立」这一层（见 `projectInputError`），
 * 并把「删一个本来就不在的 Project」当成错误、而不是一次成功的空删除。
 *
 * 调用方不写 `projectId` / `name` 时由这里从 root 的目录名推导（`projectIdentity`）。放在这里而不是
 * 客户端：目录名是**跑 serve 那台机器**的路径语义，而「这个 root 是不是已经被别的 Project 占用」要按
 * symlink 归一比较 —— 两样都只有 serve 手上有。
 */

import * as path from "node:path";

import type { ProjectDeleteDto, ProjectListDto, ProjectRecordDto, ProjectUpsertDto } from "@cornfield/wire";
import {
	loadProjects,
	matchProjectByRoot,
	projectsFilePath,
	removeProject,
	upsertProject,
} from "../agent-domain/project-store";
import type { ProjectRecord } from "../agent-domain/types";
import { resolveSessionWorkspace, type SessionWorkspaceSource } from "../session/session-workspace";

/**
 * 问「这个会话属于哪个 Project」时要给的东西。
 *
 * `session` 是**会话本身**（`SessionManager` 结构上就满足它）：它的头记着归属，它的 cwd 是旧会话的
 * 回落依据。只给一个 cwd 字符串的旧签名已经删掉 —— 那个形状答不了这个问题，只能按路径猜。
 * `agentDir` 是 resolver 要的身份根（它不是从 cwd 推出来的）。
 */
export interface SessionProjectQuery {
	session: SessionWorkspaceSource;
	agentDir: string;
}

/**
 * 已声明的 Project + （可选）会话所在的 Project 及其来源。
 *
 * 没给查询（`query` 缺省）= 调用方只要列表，不做归属判断 —— 不拿别的路径（agentDir、进程 cwd）
 * 冒充会话上下文：那会得出一个看起来像答案的猜测。给了查询就不再有「猜」这一步：归属由
 * `session/session-workspace` 判，来源原样带出来（`"none"` 也是事实：问了，没人声明过）。
 *
 * 列表顺序即存储里的声明顺序（Object key 顺序，稳定）。这里不排序：排序是展示决定，
 * 链路里第一个「重排过的列表」会让「我上次看到的第 3 个」失去意义。
 */
export async function readProjectContext(query?: SessionProjectQuery): Promise<ProjectListDto> {
	const records = await loadProjects();
	const result: ProjectListDto = { projects: records.map(toProjectRecordDto) };
	if (!query) return result;
	const workspace = await resolveSessionWorkspace({ session: query.session, agentDir: query.agentDir });
	result.currentProjectSource = workspace.projectSource;
	if (workspace.projectId !== undefined) result.currentProjectId = workspace.projectId;
	return result;
}

/**
 * 声明或更新一个 Project（`set_project`）：写入存储后回**存储里现在那一份**（root 已归一）。
 *
 * 不把发出去的输入原样当答复回：`root` 落盘时由存储做 `path.resolve`，回发送的那份就是在
 * 告诉调用方一个盘上并不存在的路径。回读一次多读一遍文件，但答复与磁盘一致 —— 命令的
 * 承诺是「现在存储里是这个」，不是「我发出去的是这个」。
 *
 * 不做任何静默改写：调用方给的名字就按原样落盘、原样回（要不要 trim 是调用方的事）。
 */
export async function declareProject(input: {
	/** 缺省 = 从 root 的目录名推导（见 `projectIdentity`）。 */
	projectId?: string;
	/** 缺省 = 跟随 projectId。 */
	name?: string;
	root: string;
	defaultAgentId?: string;
}): Promise<ProjectUpsertDto> {
	const invalid = projectInputError(input);
	if (invalid) throw new Error(invalid);

	const identity = projectIdentity(input, await loadProjects());
	const record: ProjectRecord = { projectId: identity.projectId, name: identity.name, root: input.root };
	if (input.defaultAgentId !== undefined) record.defaultAgentId = input.defaultAgentId;
	await upsertProject(record);

	const stored = (await loadProjects()).find(project => project.projectId === record.projectId);
	if (!stored) {
		throw new Error(
			`Project "${record.projectId}" was written but is not in the store at "${projectsFilePath()}"; ` +
				"the write did not land.",
		);
	}
	return { project: toProjectRecordDto(stored) };
}

/**
 * 删掉一个已声明的 Project（`delete_project`）。
 *
 * 存储的 `removeProject` 用布尔回答「它本来在不在」；**这里把「本来就不在」升成错误**：一次删除
 * 的真实结果是「它消失了」，而「它本来就不在」不是这次调用的结果 —— 回一个成功，会让调用方把
 * 别人的删除（或一个写错的名字）记成自己的。
 */
export async function dropProject(projectId: string): Promise<ProjectDeleteDto> {
	if (projectId.trim() === "") throw new Error("projectId must not be empty.");
	const removed = await removeProject(projectId);
	if (!removed) throw new Error(`no Project declared with projectId "${projectId}"; nothing was removed.`);
	return { projectId };
}

/**
 * 缺省身份：把「只给了一个 root」补成一条完整的声明。
 *
 * 三条规则，各自对应一件不能猜错的事：
 *   - **同一个目录再声明一次是更新**：root 相同（按 symlink 归一）就复用原来那一条的 `projectId`，
 *     否则第二次点「声明」会在注册表里多出一个 `<目录名>-2`，而用户以为自己在更新同一个项目；
 *   - **目录名撞了要避让**：`projectId` 是存储的键，直接拿目录名当键会把另一个目录已经声明过的
 *     Project **覆盖掉**（`upsertProject` 就是按 id 覆盖）。所以撞名时加 `-2` / `-3` 后缀，
 *     不覆盖别人的声明，也不把用户堵在一个他改不了的输入框前；
 *   - **名字跟随 id，但已有记录的名字优先**：给一个已声明的 root 换地方时不该顺手把用户起的名字
 *     改成目录名。
 *
 * 显式给的值一律原样用（调用方是权威），本函数只补缺省。
 */
export function projectIdentity(
	input: { projectId?: string; name?: string; root: string },
	declared: readonly ProjectRecord[],
): { projectId: string; name: string } {
	const explicitId = input.projectId?.trim() ?? "";
	const explicitName = input.name?.trim() ?? "";

	const byRoot = matchProjectByRoot(declared, input.root);
	const projectId =
		explicitId !== ""
			? explicitId
			: (byRoot?.projectId ?? freeProjectId(path.basename(path.resolve(input.root)), declared));
	const existing = declared.find(project => project.projectId === projectId);

	return { projectId, name: explicitName !== "" ? explicitName : (existing?.name ?? projectId) };
}

/**
 * 一个还没被占用的 `projectId`：目录名在前，撞名时依次试 `<目录名>-2` / `-3` …。
 *
 * 试到空位为止（集合有限，循环一定终止）；不抛「重名」错让用户去改一个已经没有输入框的 id。
 */
function freeProjectId(base: string, declared: readonly ProjectRecord[]): string {
	if (base === "" || base === "." || base === "..") {
		throw new Error(
			`cannot derive a project id from the root directory name (got "${base}"): ` +
				"the filesystem root has no name. Pick a folder inside it.",
		);
	}
	const taken = new Set(declared.map(project => project.projectId));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * 调用方输入不成立时的判决文本；输入成立时返回 undefined。
 *
 * 这几条不是存储的义务，而是「这个命令的入参形状」：存储会照单全收 —— 空的 projectId 是一个
 * 永远匹配不上、也读不回来的键；空的 root 会被 `path.resolve` 解析成 serve 进程自己的 cwd，
 * 凭空把一个目录声明成项目。所以宁可 ok:false，也不写一条谁也读不懂的声明。
 *
 * 缺省（字段不出现）与空串是两件事，三个字段同一套口径：缺省有明确含义（projectId/name 由 root 推导，
 * defaultAgentId = 没有默认 Agent），空串两不像，不能被静默读成缺省。
 */
function projectInputError(input: {
	projectId?: string;
	name?: string;
	root: string;
	defaultAgentId?: string;
}): string | undefined {
	if (input.projectId !== undefined && input.projectId.trim() === "") {
		return "projectId must not be empty; omit the field to derive it from the root directory name.";
	}
	if (input.name !== undefined && input.name.trim() === "") {
		return "name must not be empty; omit the field to derive it from the project id.";
	}
	if (input.root.trim() === "") return "root must not be empty.";
	if (!path.isAbsolute(input.root)) {
		return `root must be an absolute path (got "${input.root}"); a relative root would resolve against the serve process cwd.`;
	}
	if (input.defaultAgentId !== undefined && input.defaultAgentId.trim() === "") {
		return "defaultAgentId must be a non-empty agent id; omit the field to declare no default agent.";
	}
	return undefined;
}

/** `ProjectRecord` → wire 投影：字段一一对应，缺省不补（没有 defaultAgentId 就是没有）。 */
function toProjectRecordDto(record: ProjectRecord): ProjectRecordDto {
	const dto: ProjectRecordDto = {
		projectId: record.projectId,
		root: record.root,
		name: record.name,
	};
	if (record.defaultAgentId !== undefined) dto.defaultAgentId = record.defaultAgentId;
	return dto;
}
