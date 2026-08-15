/**
 * HostToolDispatcher — bridges OMP RPC `host_tool_call` frames to gateway-side
 * tool implementations.
 *
 * The OMP subprocess is a generic OMP CLI binary; it knows nothing about
 * cron or any other gateway-specific tool. Instead, the gateway registers
 * tool definitions via the `set_host_tools` RPC command, and the OMP
 * subprocess wraps them as `AgentTool` adapters (see
 * `packages/coding-agent/src/modes/rpc/host-tools.ts`). When the LLM
 * invokes one of those tools, the OMP subprocess emits a `host_tool_call`
 * frame back to the host (the gateway); the host runs the tool locally
 * and responds with a `host_tool_result` frame.
 *
 * This dispatcher is the gateway-side of that contract. It owns:
 *   - a name → handler map,
 *   - a one-shot map from `id` (the RPC call id) → resolver,
 *   - translation between OMP's frame shape and the gateway's tool
 *     handler signature.
 *
 * The dispatcher is intentionally transport-agnostic; it doesn't know
 * about stdin/stdout framing. The transport (`agent-transport.ts`)
 * forwards parsed `host_tool_call` frames here and writes the result
 * frames back via `RpcTransport.sendFrame(...)`.
 */

import { logger } from "@oh-my-pi/pi-utils";

/**
 * OpenAI / Anthropic tool-calling schema requires the `name` field to match
 * `^[a-zA-Z0-9_-]+$` (1-64 chars). Backends that strictly enforce this (e.g.
 * DeepSeek V4 via OpenAI-compat) return 400 invalid_request_error if a host
 * tool's name contains `.` / `:` / `/` / spaces / non-ASCII characters.
 *
 * The LLM also has to copy-paste this name verbatim into a tool_call, so
 * simpler character sets reduce copy errors. Host tools MUST be named with
 * snake_case only.
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
	return TOOL_NAME_RE.test(name);
}

export function assertValidToolName(name: string): void {
	if (!TOOL_NAME_RE.test(name)) {
		throw new Error(
			`Host tool name "${name}" violates OpenAI tool-calling schema (must match ^[a-zA-Z0-9_-]{1,64}$). ` +
				`Rename to snake_case before registering.`,
		);
	}
}

/**
 * Mirrors the OMP `RpcHostToolDefinition` shape — see
 * `packages/coding-agent/src/modes/rpc/rpc-types.ts`. We redeclare it here
 * (rather than importing from `@oh-my-pi/pi-coding-agent`) because the
 * gateway should not take a runtime dependency on the agent's RPC types:
 * the contract is the JSON shape on the wire, not the TS type.
 */
export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

/** Inbound `host_tool_call` frame. */
export interface HostToolCall {
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Outbound `host_tool_result` frame body (excludes the `id` / `type`). */
export interface HostToolResultBody {
	type: "tool_result";
	tool_use_id: string;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/**
 * A single registered tool: its definition (sent to OMP) plus the handler
 * the dispatcher invokes when the LLM calls it.
 */
export interface HostToolHandler {
	definition: RpcHostToolDefinition;
	/** Handle a single call. Thrown errors become `isError: true` results. */
	handle(args: Record<string, unknown>): Promise<HostToolResultBody> | HostToolResultBody;
}

/**
 * Writer for outbound frames. The transport supplies this so the
 * dispatcher can stay decoupled from stdin/stdout mechanics.
 */
export type HostToolResultWriter = (id: string, body: HostToolResultBody) => void;

export class HostToolDispatcher {
	#handlers = new Map<string, HostToolHandler>();
	#registered: RpcHostToolDefinition[] = [];
	#writer: HostToolResultWriter | undefined;

	/** Bind the outbound frame writer. Called by the transport during init. */
	setWriter(writer: HostToolResultWriter): void {
		this.#writer = writer;
	}

	/** Replace the registered tool set. Returns the definitions in registration order. */
	setTools(tools: HostToolHandler[]): RpcHostToolDefinition[] {
		// Validate every tool name against the OpenAI tool-calling schema BEFORE
		// building the dispatch map. Failing here surfaces the bad name at OMP
		// startup (or first host-tool set), not at first LLM request where it
		// would surface as an opaque 400 from the upstream provider.
		for (const t of tools) {
			assertValidToolName(t.definition.name);
		}
		this.#handlers = new Map(tools.map(t => [t.definition.name, t]));
		this.#registered = tools.map(t => t.definition);
		return this.#registered;
	}

	getToolNames(): string[] {
		return Array.from(this.#handlers.keys());
	}

	/** Return the current set of registered tool definitions (for `set_host_tools`). */
	getDefinitions(): RpcHostToolDefinition[] {
		return this.#registered;
	}

	/**
	 * Handle a parsed `host_tool_call` frame from the OMP subprocess.
	 * Resolves to `true` if the call matched a registered tool, `false`
	 * if the call is unknown (the transport will then write a generic
	 * "unknown tool" error result).
	 */
	async handleCall(call: HostToolCall): Promise<boolean> {
		const handler = this.#handlers.get(call.toolName);
		logger.info("[HostToolDispatcher] call received", {
			toolName: call.toolName,
			argKeys: call.arguments ? Object.keys(call.arguments) : [],
		});
		if (!handler) {
			logger.warn("[HostToolDispatcher] unknown tool", { toolName: call.toolName });
			this.#replyError(call, `Unknown tool: ${call.toolName}`);
			return false;
		}
		try {
			const result = await handler.handle(call.arguments);
			this.#writer?.(call.id, result);
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("[HostToolDispatcher] handler threw", {
				toolName: call.toolName,
				error: message,
			});
			this.#replyError(call, message);
			return true;
		}
	}

	#replyError(call: HostToolCall, message: string): void {
		this.#writer?.(call.id, {
			type: "tool_result",
			tool_use_id: call.toolCallId,
			content: [{ type: "text", text: message }],
			isError: true,
		});
	}
}
