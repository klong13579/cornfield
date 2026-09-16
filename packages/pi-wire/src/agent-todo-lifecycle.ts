/**
 * AgentTodo 生命周期（§37 D4）—— 全仓**唯一一份**词表。
 *
 * 两端问的是同一件事，只是问法不同：serve 的 `agent-domain/relations.ts`
 * （`validateAgentTodoTransition`）用它判写入合不合法 —— 它是唯一会拒绝写入的一方；
 * web-app 的 Todo 工作台用它决定渲染哪些状态按钮 —— 它是唯一把动作摆到用户面前的一方。
 * 表放两份时两边会漂移，而两个方向的危害不对称：
 *   - 表**收紧**（少一条合法边）→ 界面仍给出那个按钮 → serve 拒绝 → 拒绝原文显示在那条
 *     Todo 上，用户看得见（响的，可接受）。
 *   - 表**放宽**（多一条合法边）→ 界面**不显示**那个按钮 → 用户做不了本来合法的事，
 *     没有任何错误（静默的能力消失）。
 * 静默的那一侧才是要防的，所以规则只留一份：两个消费者都读这里。谁要再写第二份，
 * `test/agent-todo-lifecycle.test.ts` 会红（它扫全仓源码，只允许本文件出现这张表）。
 *
 * 纯数据 + 纯函数：无 I/O、不 import `@cornfield/utils`（那个包拉 `node:fs`/`node:os`），
 * 因为 web-app 会真的在浏览器里执行本文件的代码，而不只是 import type。
 */

import type { AgentTodoStatusDto } from "./results/agent-todos";

/**
 * 合法转移：`from` → 允许的每个 `to`（**含「转到自己」这条无操作转移**）。
 *
 * 每一行都必须列全，包括终态那两条只有自己的：行缺一个状态就等于那个状态没有任何合法
 * 目标（连原地不动都会被拒），调用方拿到的会是 `undefined` 而不是一条规则。
 */
export const AGENT_TODO_TRANSITIONS: Record<AgentTodoStatusDto, readonly AgentTodoStatusDto[]> = {
	open: ["open", "in_progress", "completed", "cancelled"],
	in_progress: ["open", "in_progress", "completed", "cancelled"],
	completed: ["completed"],
	cancelled: ["cancelled"],
};

/** 这次转移合不合法。`from === to` 是合法的无操作 —— 合法**不等于**界面上该给按钮。 */
export function isAgentTodoTransitionAllowed(from: AgentTodoStatusDto, to: AgentTodoStatusDto): boolean {
	return AGENT_TODO_TRANSITIONS[from].includes(to);
}

/**
 * 终态：离开不了的状态 —— 表里从它出发**只有它自己**这一条。
 *
 * 「只有自己一条」而不是「没有出路」：无操作转移是合法且必须保留的（重复写同一个状态是
 * 幂等的），所以终态的判据是「唯一的合法目标就是自己」，不是「一条转移都没有」。
 */
export function isTerminalAgentTodoStatus(status: AgentTodoStatusDto): boolean {
	const targets = AGENT_TODO_TRANSITIONS[status];
	return targets.length === 1 && targets[0] === status;
}

/**
 * 界面上值得渲染成按钮的转移：合法转移里去掉那条无操作。
 *
 * 终态因此返回空 —— 不是「按钮被置灰」，而是根本没有按钮可点。能点、但永远被 serve 拒绝
 * 的按钮，是把服务端的规则伪装成「界面卡了」。
 */
export function agentTodoStatusActions(status: AgentTodoStatusDto): readonly AgentTodoStatusDto[] {
	return AGENT_TODO_TRANSITIONS[status].filter(target => target !== status);
}
