/**
 * serve 侧的 Project 只读桥 —— 把客户端级 Project registry 搬到 wire 面。
 *
 * 桥不拥有语义：Project 的权威是 `agent-domain/project-store`（`~/.cornfield/agent/projects.json`，
 * WP4），一个 root 只能被一个 Project 声明，root 比较按 symlink 归一。这里只做两件事：
 * 投影成 wire 形状，以及在调用方给出会话 cwd 时用**域里那条匹配规则**
 * （`matchProjectForPath`，最深声明的祖先 root 获胜）算出会话所在的 Project ——
 * 不在前端另写一份匹配规则。
 *
 * 失败模型照抄存储层，不自己发明一条更宽松的：
 *   - 文件不存在 → 空数组（「没声明过」是明确的事实）；
 *   - 文件在但损坏 / 版本不符 / 条目形状不对 → **抛**，由命令回 ok:false。
 * 把后者降级成空列表，会把「声明过但读坏了」显示成「没声明过」—— 用户会以为自己的项目消失了。
 */

import type { ProjectListDto, ProjectRecordDto } from "@cornfield/wire";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { ProjectRecord } from "../agent-domain/types";

/**
 * 已声明的 Project + （可选）会话所在的 Project。
 *
 * `sessionCwd` 缺省 = 调用方只要列表，不要归属判断 —— 不拿别的路径（agentDir、进程 cwd）
 * 冒充会话上下文：那会得出一个看起来像答案的猜测。
 *
 * 列表顺序即存储里的声明顺序（Object key 顺序，稳定）。这里不排序：排序是展示决定，
 * 链路里第一个「重排过的列表」会让「我上次看到的第 3 个」失去意义。
 */
export async function readProjectContext(sessionCwd?: string): Promise<ProjectListDto> {
	const records = await loadProjects();
	const result: ProjectListDto = { projects: records.map(toProjectRecordDto) };
	if (sessionCwd !== undefined) {
		const match = matchProjectForPath(records, sessionCwd);
		if (match) result.currentProjectId = match.projectId;
	}
	return result;
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
