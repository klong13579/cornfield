/**
 * serve 侧的 Agent Todo 桥 —— 把领域层的板子读写搬成 wire 面的 DTO 形状。
 *
 * 语义不在这里：存储与生命周期归 `agent-domain/agent-todo-store`，读写与关系校验（owner、
 * Project 绑定）归 `agent-domain/agent-todo-board` —— **那一份与 agent 的 `agent_todo` 工具共用**，
 * 两条入口写同一块板子时过的是同一套规则。
 *
 * 失败模型照抄下层，不降级成空结果：文件损坏 / 版本不符 / 关系不合法一律抛，由命令回 ok:false。
 */

import type { AgentTodoDto, AgentTodoListDto } from "@cornfield/wire";
import {
	type AgentTodoTarget,
	putAgentTodo,
	readAgentTodoBoard,
	removeAgentTodoRecord,
} from "../agent-domain/agent-todo-board";

export type { AgentTodoTarget };

export async function listAgentTodos(target: AgentTodoTarget): Promise<AgentTodoListDto> {
	const board = await readAgentTodoBoard(target);
	const dto: AgentTodoListDto = { agentId: target.agentId, todos: board.todos };
	return board.projectIds ? { ...dto, projectIds: board.projectIds } : dto;
}

export async function writeAgentTodo(target: AgentTodoTarget, todo: AgentTodoDto): Promise<AgentTodoDto> {
	return await putAgentTodo(target, todo);
}

export async function dropAgentTodo(target: AgentTodoTarget, todoId: string): Promise<boolean> {
	return await removeAgentTodoRecord(target, todoId);
}
