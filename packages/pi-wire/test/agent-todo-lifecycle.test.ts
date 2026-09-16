import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT_TODO_TRANSITIONS,
	agentTodoStatusActions,
	isAgentTodoTransitionAllowed,
	isTerminalAgentTodoStatus,
} from "../src/agent-todo-lifecycle";
import type { AgentTodoStatusDto } from "../src/results/agent-todos";

/**
 * AgentTodo 生命周期词表（wire 唯一一份）。
 *
 * 这里盯两件事，因为危害不对称：
 *   - **全仓只有一处定义**：表放宽时前端不显示那个按钮，用户的能力静默消失、没有任何错误。
 *     第二份定义就是这条漂移的入口，所以扫源码把它拦下来（不是靠人记得同步）。
 *   - **规则本身**：终态只有自己一条出路、同态转移合法但不渲染成按钮、按钮集合就是合法转移
 *     去掉无操作的那一条。两个消费者（serve 的校验、web-app 的按钮）读的都是这份表，
 *     它们的对拍在两边的包内用例里（relations.ts / agent-todo-logic.ts 的消费者测试）。
 */

/** 表覆盖的状态。从表自身取，避免在测试里长出第二份词表。 */
const STATUSES = Object.keys(AGENT_TODO_TRANSITIONS) as AgentTodoStatusDto[];

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** 全仓源码：每个包的 `src` 与 `test` 目录下的 .ts / .tsx（生成物与 node_modules 不在其中）。 */
function sourceFiles(): string[] {
	return [...new Bun.Glob("packages/*/{src,test}/**/*.{ts,tsx}").scanSync({ cwd: REPO_ROOT })].map(relative =>
		path.join(REPO_ROOT, relative),
	);
}

/** 这张表的形状：一个以 `open` 开头的转移行。`STATUSES` 那种扁平清单不匹配（它不是表）。 */
const TRANSITION_ROW = /open\s*:\s*\[\s*"open"\s*,\s*"in_progress"/;

describe("AgentTodo 生命周期词表", () => {
	it("覆盖全部四个状态，且没有空行", () => {
		expect([...STATUSES].sort()).toEqual(["cancelled", "completed", "in_progress", "open"]);
		for (const status of STATUSES) expect(AGENT_TODO_TRANSITIONS[status].length).toBeGreaterThan(0);
	});

	it("终态只有自我转移这一条出路，不再可重开（§37）", () => {
		expect(AGENT_TODO_TRANSITIONS.completed).toEqual(["completed"]);
		expect(AGENT_TODO_TRANSITIONS.cancelled).toEqual(["cancelled"]);
		expect(isTerminalAgentTodoStatus("completed")).toBe(true);
		expect(isTerminalAgentTodoStatus("cancelled")).toBe(true);
		expect(isTerminalAgentTodoStatus("open")).toBe(false);
		expect(isTerminalAgentTodoStatus("in_progress")).toBe(false);
	});

	it("同态转移是合法的无操作，但永远不渲染成按钮", () => {
		for (const status of STATUSES) {
			expect(isAgentTodoTransitionAllowed(status, status)).toBe(true);
			expect(agentTodoStatusActions(status)).not.toContain(status);
		}
	});

	it("按钮集合 = 该状态的合法转移去掉无操作那一条", () => {
		for (const status of STATUSES) {
			const actions = agentTodoStatusActions(status);
			for (const action of actions) {
				expect(isAgentTodoTransitionAllowed(status, action)).toBe(true);
				expect(action).not.toBe(status);
			}
			expect(actions).toEqual(AGENT_TODO_TRANSITIONS[status].filter(target => target !== status));
		}
		// 具体值：界面上真正会出现的按钮（终态为空 —— 不是置灰，是没有按钮）
		expect(agentTodoStatusActions("open")).toEqual(["in_progress", "completed", "cancelled"]);
		expect(agentTodoStatusActions("in_progress")).toEqual(["open", "completed", "cancelled"]);
		expect(agentTodoStatusActions("completed")).toEqual([]);
		expect(agentTodoStatusActions("cancelled")).toEqual([]);
	});

	it("合法性判定与表逐对一致（含终态不可重开）", () => {
		for (const from of STATUSES) {
			for (const to of STATUSES) {
				expect(isAgentTodoTransitionAllowed(from, to)).toBe(AGENT_TODO_TRANSITIONS[from].includes(to));
			}
		}
		expect(isAgentTodoTransitionAllowed("completed", "open")).toBe(false);
		expect(isAgentTodoTransitionAllowed("completed", "in_progress")).toBe(false);
		expect(isAgentTodoTransitionAllowed("cancelled", "open")).toBe(false);
		expect(isAgentTodoTransitionAllowed("open", "completed")).toBe(true);
	});

	it("这张表在全仓只有一处定义 —— 再写一份就是漂移的入口", () => {
		const files = sourceFiles();
		// 扫描得真的覆盖到两个曾经的镜像点，否则「只找到一处」只是因为没扫到
		expect(files).toContain(path.join(REPO_ROOT, "packages/coding-agent/src/agent-domain/relations.ts"));
		expect(files).toContain(path.join(REPO_ROOT, "packages/web-app/src/pages/todo/agent-todo-logic.ts"));

		const defining = files.filter(file => TRANSITION_ROW.test(fs.readFileSync(file, "utf8")));
		expect(defining.map(file => path.relative(REPO_ROOT, file))).toEqual([
			"packages/pi-wire/src/agent-todo-lifecycle.ts",
		]);
	});
});
