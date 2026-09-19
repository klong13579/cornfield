/**
 * Agent Todo 板的读写面（领域层）—— serve 的 wire 命令与 agent 的 `agent_todo` 工具**共用这一份**。
 *
 * 它不拥有语义：
 *   - 存储、生命周期、id 与时间戳的权威是 `./agent-todo-store`
 *     （`<agentDir>/.cornfield/agent-todos.json`，WP10）；
 *   - 关系不变量（owner、Project 存在、Agent 的 Project 绑定）的权威是 `./relations`，
 *     这里只是把两边数据凑成一次窄校验。
 *
 * 为什么单独一层（而不是让工具直接调 store）：工具与 wire 命令是两个入口、同一块板子。
 * 各写一遍校验就是两条会漂的真相 —— 一条走 GUI 会被拒的写入，从工具进去就会成功。
 *
 * 失败模型照抄存储层，不自己发明一条更宽松的：
 *   - 文件不存在 → 空板（「还没记过」是明确的事实）；
 *   - 文件在但损坏 / 版本不符 / 记录形状不对 → **抛**。
 *   把后者降级成空板，就是把「记过但读坏了」显示成「没有任务」。
 *
 * ## 为什么 owner 校验在这一层而不是存储里
 *
 * 存储层回答的永远是「这个 agentDir 的板子怎么读写」；「A Agent 不许改 B Agent 的板子」
 * 是 A 与 B 之间的关系，需要两边同时在场，所以它属于这一层（`assertRelations`）。
 */

import { readWorkspaceDeclaration, workspaceFilePath } from "../skeleton/workspace";
import { declaredProjectIds } from "./agent-directory";
import { loadAgentTodos, removeAgentTodo, upsertAgentTodo } from "./agent-todo-store";
import { loadProjects } from "./project-store";
import { validateAgentTodos } from "./relations";
import type { AgentRecord, AgentTodo, ProjectRecord } from "./types";

/** 一次读写针对哪个 Agent —— owner 身份与它的 home 必须一起给：缺任一个都无法判断归属。 */
export interface AgentTodoTarget {
	agentId: string;
	agentDir: string;
}

/** 一块板子 + 这个 Agent 声明的 Project 绑定上限（`undefined` = 未约束）。 */
export interface AgentTodoBoard {
	todos: AgentTodo[];
	projectIds?: string[];
}

export async function readAgentTodoBoard(target: AgentTodoTarget): Promise<AgentTodoBoard> {
	const projects = await loadProjects();
	const projectIds = await bindingOf(target, projects);
	const todos = await loadAgentTodos(target.agentDir);
	return projectIds ? { todos, projectIds } : { todos };
}

/**
 * 新建或更新一条 Todo，返回存储层真正落盘的那一份。
 *
 * 返回值即权威：`createdAt` / `updatedAt` 由存储盖章，`sessionRefs` 由存储保留，所以调用方
 * 必须用返回的记录替换自己手上那份，不能假定自己发的字段原样存下了。
 */
export async function putAgentTodo(target: AgentTodoTarget, todo: AgentTodo): Promise<AgentTodo> {
	const raw: Partial<AgentTodo> | null = todo;
	if (!raw || typeof raw !== "object") throw new Error("write requires a todo object.");
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
export async function removeAgentTodoRecord(target: AgentTodoTarget, todoId: string): Promise<boolean> {
	if (todoId === "") throw new Error("delete requires a non-empty todo id.");
	return await removeAgentTodo(target.agentDir, todoId);
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
 * 声明读取的三种结果**分开处理**：
 *   - `absent`（文件不存在）→ 确实没声明过 → 未约束，放行；
 *   - `declared` → 按 `declaredProjectIds` 算上限；
 *   - `invalid`（文件在但不是合法 v2 声明）→ **硬报错**。
 *
 * 第三条是安全边界，不是灵活性：一份读不出内容的声明*可能*正在声明绑定，把它当「未约束」
 * 就是绕开 Project 隔离，让 Todo 落到这个 Agent 不该碰的 Project 上。宁可让整个板子报错
 * 让人去修声明，也不要静默放大范围。其他 I/O 错误（EACCES 等）由
 * `readWorkspaceDeclaration` 直接抛出，这里不接。
 */
async function bindingOf(target: AgentTodoTarget, projects: readonly ProjectRecord[]): Promise<string[] | undefined> {
	const read = await readWorkspaceDeclaration(target.agentDir);
	if (read.state === "invalid") {
		throw new Error(
			`workspace declaration at "${workspaceFilePath(target.agentDir)}" is ${read.reason}; ` +
				`which Projects this Agent is bound to cannot be determined, and reading that as "unconstrained" ` +
				`would let a Todo bind outside the Agent's declared scope. Fix or remove the declaration ` +
				`(a missing declaration IS unconstrained).`,
		);
	}
	const declaration = read.state === "declared" ? read.declaration : undefined;
	return declaredProjectIds(target.agentDir, declaration, projects);
}
