/**
 * serve 侧的 Agent Todo 桥 —— 把 Agent 级 Todo 板搬到 wire 面。
 *
 * 桥不拥有语义：
 *   - 存储、生命周期、id 与时间戳的权威是 `agent-domain/agent-todo-store`
 *     （`<agentDir>/.cornfield/agent-todos.json`，WP10）；
 *   - 关系不变量（owner、Project 存在、Agent 的 Project 绑定）的权威是
 *     `agent-domain/relations`，这里只是把两边数据凑成一次窄校验。
 *
 * 失败模型照抄存储层，不自己发明一条更宽松的：
 *   - 文件不存在 → 空板（「还没记过」是明确的事实）；
 *   - 文件在但损坏 / 版本不符 / 记录形状不对 → **抛**，由命令回 ok:false。
 *   把后者降级成空板，就是把「记过但读坏了」显示成「没有任务」。
 *
 * ## 为什么 owner 校验在桥上而不是存储里
 *
 * 存储层回答的永远是「这个 agentDir 的板子怎么读写」；「A Agent 不许改 B Agent 的板子」
 * 是 A 与 B 之间的关系，需要两边同时在场，所以它属于桥（`validateAgentTodos`）。
 */

import { declaredProjectIds } from "../agent-domain/agent-directory";
import { loadAgentTodos, removeAgentTodo, upsertAgentTodo } from "../agent-domain/agent-todo-store";
import { loadProjects } from "../agent-domain/project-store";
import { validateAgentTodos } from "../agent-domain/relations";
import type { AgentRecord, AgentTodo, AgentTodoId, ProjectRecord } from "../agent-domain/types";
import { loadWorkspace } from "../skeleton/workspace";

/**
 * Agent Todo 的命令面。
 *
 * 这三条命令尚未登记进 pi-wire 的 `WireCommand` union —— 登记要改 `packages/pi-wire`，
 * 不属于 T10A 的 scope（web-app / coding-agent / gateway）。所以按运行期 type 分派，与
 * `list_remote_skills` 落地时的先行实现同型（pi-wire 的注释里也记了这个约定：wire 新增
 * 命令由 coding-agent 侧先行实现，登记收口另做）。登记完成后这个联合体应当消失。
 */
export type AgentTodoCommand =
	| { type: "list_agent_todos"; sessionId?: string }
	| { type: "set_agent_todo"; sessionId?: string; todo: unknown }
	| { type: "delete_agent_todo"; sessionId?: string; todoId: unknown };

/** 认出一条 Agent Todo 命令，否则 null（调用方继续走原来的分派）。 */
export function asAgentTodoCommand(command: { type: string }): AgentTodoCommand | null {
	switch (command.type) {
		case "list_agent_todos":
		case "set_agent_todo":
		case "delete_agent_todo":
			return command as AgentTodoCommand;
		default:
			return null;
	}
}

/** 一次读写针对哪个 Agent —— owner 身份与它的 home 必须一起给：缺任一个都无法判断归属。 */
export interface AgentTodoTarget {
	agentId: string;
	agentDir: string;
}

/**
 * 一个 Agent 的整块 Todo 板。
 *
 * `agentId` 随板子一起回，因为「这是谁的板子」和「板子上有什么」是两件事：前端切换焦点
 * Agent 时靠它判定这次响应是不是当前 Agent 的（迟到的响应不得落进别人的视图）。
 *
 * `projectIds` 是这个 Agent 声明过的 Project 绑定（上限）：写面拿它当约束，读面拿它决定
 * 选择器里能选什么。**缺省 = 无声明绑定**（未约束），与「绑不了任何 Project」不是一回事 ——
 * 两条语义都跟 `AgentRecord.projectIds` 走。
 */
export interface AgentTodoListDto {
	agentId: string;
	projectIds?: string[];
	todos: AgentTodo[];
}

export async function listAgentTodos(target: AgentTodoTarget): Promise<AgentTodoListDto> {
	const projects = await loadProjects();
	const projectIds = await bindingOf(target, projects);
	const dto: AgentTodoListDto = { agentId: target.agentId, todos: await loadAgentTodos(target.agentDir) };
	if (projectIds) dto.projectIds = projectIds;
	return dto;
}

/**
 * 新建或更新一条 Todo，返回存储层真正落盘的那一份。
 *
 * 返回值即权威：`createdAt` / `updatedAt` 由存储盖章，`sessionRefs` 由存储保留，所以调用方
 * 必须用返回的记录替换自己手上那份，不能假定自己发的字段原样存下了。
 */
export async function writeAgentTodo(target: AgentTodoTarget, todo: AgentTodo): Promise<AgentTodo> {
	const raw = todo as Partial<AgentTodo> | null;
	if (!raw || typeof raw !== "object") throw new Error("set_agent_todo requires a todo object.");
	if (typeof raw.agentId !== "string" || raw.agentId !== target.agentId) {
		throw new Error(
			`Todo agentId "${String(raw.agentId)}" is not the target Agent "${target.agentId}"; ` +
				`an AgentTodo is owned by exactly one Agent and only that Agent may write its board.`,
		);
	}
	await assertRelations(target, raw);
	return await upsertAgentTodo(target.agentDir, todo);
}

/** 删除一条 Todo。幂等：本来就不在板上返回 false，不是错误。 */
export async function dropAgentTodo(target: AgentTodoTarget, todoId: unknown): Promise<boolean> {
	if (typeof todoId !== "string" || todoId === "") throw new Error("delete_agent_todo requires a non-empty todoId.");
	return await removeAgentTodo(target.agentDir, todoId as AgentTodoId);
}

/**
 * owner 与 Project 绑定关系，按 `relations` 的窄校验器判。
 *
 * snapshot 只声明这次写入真正声称的事实：这一个 Agent、已声明的 Project、这一条 Todo。
 * `sessions` 刻意留空、待写记录的 `sessionRefs` 也故意清空，两个理由：
 *   1. sessionRefs 不是调用方能写的东西（存储层拒绝与已存值不一致的提交），调用方对它
 *      没有任何声称；
 *   2. 拿一份「没有任何 session」的快照去校验它，只会报一条调用方没有造成的违规。
 * 于是留下的正好是这次写入真正要过的关系：Project 必须真的声明过，且在这个 Agent 的
 * 绑定范围内（`projectIds` 缺省 = 未约束）。
 */
async function assertRelations(target: AgentTodoTarget, todo: Partial<AgentTodo>): Promise<void> {
	const projects = await loadProjects();
	const agent: AgentRecord = {
		agentId: target.agentId,
		agentDir: target.agentDir,
		displayName: target.agentId,
		enabled: true,
	};
	const projectIds = await bindingOf(target, projects);
	if (projectIds) agent.projectIds = projectIds;
	const candidate: AgentTodo = { ...(todo as AgentTodo), agentId: target.agentId, sessionRefs: [] };
	const violations = validateAgentTodos({ agents: [agent], projects, sessions: [], todos: [candidate] });
	const first = violations[0];
	if (first) throw new Error(`${first.rule}: ${first.message}`);
}

/**
 * 这个 agentDir 的声明绑定到哪些 Project —— 复用 `agent-directory` 的那条规则，不在这里
 * 另写一份（同一份 `projectRoot` 匹配出两个不同答案，就是两条互不一致的真相）。
 *
 * 声明读不出来（缺失 / 损坏）当「无声明绑定」：绑定是不可选的上限，不是这个 Agent 能否
 * 使用的开关，所以它不该把 Todo 板整个卡死。
 */
async function bindingOf(target: AgentTodoTarget, projects: readonly ProjectRecord[]): Promise<string[] | undefined> {
	const declaration = (await loadWorkspace(target.agentDir).catch(() => null)) ?? undefined;
	return declaredProjectIds(target.agentDir, declaration, projects);
}
