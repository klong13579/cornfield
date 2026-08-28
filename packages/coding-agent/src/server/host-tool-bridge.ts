import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import { Snowflake } from "@cornfield/utils";
import type { HostToolCallPush, HostToolCancelPush, WireHostToolDefinition } from "@cornfield/wire";

/**
 * Wire 版 host tool bridge（P3 任务 C）——复刻 rpc-mode 的 RpcHostToolBridge 语义，
 * 把 stdio 帧换成 wire push 帧：
 *
 *   server → client：push host_tool_call {id, sessionId, toolCallId, toolName, arguments}
 *   server → client：push host_tool_cancel {id, sessionId, targetId}
 *   client → server：frame host_tool_result {id, result, isError?}
 *   client → server：frame host_tool_update {id, partialResult}
 *
 * 关键差异（vs rpc）：wire 是多连接的，host tool 的「执行者」是发 set_host_tools 的那个
 * 连接（responder）。call 帧只发给 responder；responder 断开时 pending 全部拒绝
 * （fail fast——不能把工具调用挂在一条死连接上）。
 */

type WireOutput = (push: HostToolCallPush | HostToolCancelPush) => void;

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

class WireHostToolAdapter implements AgentTool {
	readonly name: string;
	label: string;
	readonly description: string;
	readonly parameters: any;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	readonly #bridge: WireHostToolBridge;

	constructor(definition: WireHostToolDefinition, bridge: WireHostToolBridge) {
		this.name = definition.name;
		this.label = definition.label ?? definition.name;
		this.description = definition.description;
		this.parameters = definition.parameters;
		this.#bridge = bridge;
	}

	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(this.name, toolCallId, params as Record<string, unknown>, signal, onUpdate);
	}
}

export class WireHostToolBridge {
	#output: WireOutput | undefined;
	readonly #sessionId: string;
	#pendingCalls = new Map<string, PendingHostToolCall>();

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	/** 绑定执行者连接（set_host_tools 的来源连接）。换连接 = 换执行者。 */
	bindOutput(output: WireOutput): void {
		this.#output = output;
	}

	/** 执行者连接断开时调用：pending 全部拒绝。 */
	detachOutput(reason: string): void {
		this.#output = undefined;
		this.rejectAllPending(`host tool responder disconnected: ${reason}`);
	}

	setTools(tools: WireHostToolDefinition[]): AgentTool[] {
		// 注意：不持有 definitions——definitions 存在 adapter 里，生命周期随 setTools 返回值
		return tools.map(tool => new WireHostToolAdapter(tool, this));
	}

	handleResult(frame: { id: string; result: { content: unknown[] }; isError?: boolean }): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = (frame.result.content as Array<{ type?: string; text?: string }>)
				.filter(item => item?.type === "text" && typeof item.text === "string")
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result as AgentToolResult<unknown>);
		return true;
	}

	handleUpdate(frame: { id: string; partialResult: unknown }): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult as Parameters<NonNullable<AgentToolUpdateCallback<unknown>>>[0]);
		return true;
	}

	requestExecution(
		toolName: string,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		const output = this.#output;
		if (!output) {
			return Promise.reject(new Error(`Host tool "${toolName}" has no responder connection`));
		}
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${toolName}" was aborted`));
		}

		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			output({
				type: "host_tool_cancel",
				id: randomUUID(),
				sessionId: this.#sessionId,
				targetId: id,
			});
			reject(new Error(`Host tool "${toolName}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
		});

		output({
			type: "host_tool_call",
			id,
			sessionId: this.#sessionId,
			toolCallId,
			toolName,
			arguments: args,
		});
		// 注：Snowflake 仅作 id 参考备份；真实关联键是 randomUUID，与 wire 帧一一对应。
		void Snowflake;
		return promise;
	}

	rejectAllPending(message: string): void {
		if (this.#pendingCalls.size === 0) return;
		const error = new Error(message);
		const pendings = [...this.#pendingCalls.values()];
		this.#pendingCalls.clear();
		for (const pending of pendings) {
			pending.reject(error);
		}
	}
}
