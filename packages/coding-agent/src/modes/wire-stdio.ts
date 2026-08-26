/**
 * wire-stdio mode — Wire 协议跑在 stdin/stdout（gateway 子进程通道，P2）。
 *
 * 替代 rpc-mode 的 JSON-line 协议：同一套 AgentSession 命令语义，帧格式换成
 * pi-wire frames.ts 的 ClientFrame/ServerFrame（每行一个 JSON 帧）。
 *
 * 与 rpc-mode 的差异：
 * - 握手：hello → hello_ack（rpc 是 ready）
 * - 响应：{ type: "response", id, ok, result|error }（rpc 是 command/success/data）
 * - 事件：push 帧（progress/session_snapshot）（rpc 是裸事件帧）
 * - host tool：HostToolCallPush / host_tool_result / host_tool_update（带 sessionId）
 * - extension UI：bridge 场景无 UI，自动默认响应（select→undefined/confirm→false/...）
 *
 * gateway 的 AgentBridge 切到本协议后，rpc-mode + agent-transport 旧协议层删除。
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	ClientFrame,
	HostToolCallPush,
	HostToolCancelPush,
	ServerFrame,
	WireCommand,
	WireHostToolDefinition,
	WireServerEvent,
} from "@oh-my-pi/pi-wire";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { AgentSession } from "../session/agent-session";
import { type Theme, theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Host tools（wire 帧版）——pending map 模式与 RpcHostToolBridge 同构
// ═══════════════════════════════════════════════════════════════════════════

type WireHostToolOutput = (frame: HostToolCallPush | HostToolCancelPush) => void;

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isWireHostToolResult(
	value: unknown,
): value is { type: "host_tool_result"; id: string; result: AgentToolResult<unknown>; isError?: boolean } {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isWireHostToolUpdate(
	value: unknown,
): value is { type: "host_tool_update"; id: string; partialResult: AgentToolResult<unknown> } {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class WireHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme>
	implements AgentTool<TParams, unknown, TTheme>
{
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	#bridge: WireHostToolBridge;
	#definition: WireHostToolDefinition;

	constructor(definition: WireHostToolDefinition, bridge: WireHostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

class WireHostToolBridge {
	#output: WireHostToolOutput;
	#sessionId: string;
	#definitions = new Map<string, WireHostToolDefinition>();
	#pendingCalls = new Map<string, PendingHostToolCall>();

	constructor(output: WireHostToolOutput, sessionId: string) {
		this.#output = output;
		this.#sessionId = sessionId;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	setTools(tools: WireHostToolDefinition[]): AgentTool[] {
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		return tools.map(tool => new WireHostToolAdapter(tool, this));
	}

	handleResult(frame: {
		type: "host_tool_result";
		id: string;
		result: AgentToolResult<unknown>;
		isError?: boolean;
	}): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: { type: "host_tool_update"; id: string; partialResult: AgentToolResult<unknown> }): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: WireHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		const id = Snowflake.next() as string;
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
			this.#output({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				sessionId: this.#sessionId,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
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
		this.#output({
			type: "host_tool_call",
			id,
			sessionId: this.#sessionId,
			toolCallId,
			toolName: definition.name,
			arguments: args,
		});
		return promise;
	}

	rejectAllPending(reason: string): void {
		for (const pending of this.#pendingCalls.values()) {
			pending.reject(new Error(reason));
		}
		this.#pendingCalls.clear();
	}
}

export function normalizeWireHostToolDefinitions(tools: WireHostToolDefinition[]): WireHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			...tool,
			name,
			description,
			label,
		};
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension UI context（wire-stdio：bridge 无 UI，全部默认响应，不发帧）
// ═══════════════════════════════════════════════════════════════════════════

class WireExtensionUIContext implements ExtensionUIContext {
	onTerminalInput(): () => void {
		return () => {};
	}

	notify(): void {}

	setStatus(): void {}

	setWorkingMessage(): void {}

	setWidget(): void {}

	setFooter(): void {}

	setHeader(): void {}

	setTitle(): void {}

	async custom(): Promise<never> {
		return undefined as never;
	}

	pasteToEditor(text: string): void {
		this.setEditorText(text);
	}

	setEditorText(_text: string): void {}

	getEditorText(): string {
		return "";
	}

	async editor(
		_title: string,
		_prefill?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return undefined;
	}

	async select(
		_title: string,
		_options: string[],
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return undefined;
	}

	async confirm(_title: string, _message: string, _dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return false;
	}

	async input(
		_title: string,
		_placeholder?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return undefined;
	}

	get theme(): Theme {
		return theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Theme switching not supported in wire-stdio mode" });
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(): void {}

	setEditorComponent(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// wire-stdio mode
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run in wire-stdio mode.
 * Reads ClientFrame lines on stdin, writes ServerFrame lines on stdout.
 */
export async function runWireStdioMode(session: AgentSession): Promise<never> {
	// 同 rpc-mode：未捕获错误显式退出（exit code != 0），让 gateway bridge 能检测子进程死亡。
	process.on("uncaughtException", err => {
		logger.error("[wire-stdio] uncaughtException, exiting", {
			error: err.message,
			stack: err.stack,
		});
		process.exit(1);
	});
	process.on("unhandledRejection", reason => {
		logger.error("[wire-stdio] unhandledRejection, exiting", {
			reason: reason instanceof Error ? reason.message : String(reason),
		});
		process.exit(1);
	});

	const writeFrame = (frame: ServerFrame<unknown, unknown>) => {
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	};

	const sessionId = session.sessionId;

	// ── 单流循环状态机：首帧必须 hello，之后 request / host_tool_result / host_tool_update ──
	// 注意：不能在 hello 预读循环里 break 后重开 Bun.stdin.stream()（同 fd 流会被消费，
	// 剩余帧丢失）。全部帧走同一迭代器，hello 只做状态门。
	let helloDone = false;
	const helloDeadline = Date.now() + 30_000;

	const hostToolBridge = new WireHostToolBridge(event => writeFrame({ type: "push", event }), sessionId);
	const shutdownState = { requested: false };

	const success = (id: string, result?: unknown): ServerFrame => ({
		type: "response",
		id,
		ok: true,
		...(result === undefined ? {} : { result }),
	});

	const fail = (id: string, message: string): ServerFrame => ({
		type: "response",
		id,
		ok: false,
		error: message,
	});

	// ── Extension runner（actions 与 rpc-mode 同构）──
	const extensionRunner = session.extensionRunner;
	if (extensionRunner) {
		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					session.sendCustomMessage(message, options).catch(e => {
						logger.error("[wire-stdio] extension send failed", { error: e.message });
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch(e => {
						logger.error("[wire-stdio] extension send_user failed", { error: e.message });
					});
				},
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => {
					const runner = session.extensionRunner;
					if (!runner) return [];
					return runner.getAllRegisteredTools().map(tool => ({
						name: tool.definition.name,
						description: tool.definition.description,
						parameters: tool.definition.parameters,
						promptGuidelines: tool.definition.promptGuidelines,
						extensionPath: tool.extensionPath,
					}));
				},
				setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
				getCommands: () =>
					session.extensionRunner?.getRegisteredCommands().map(cmd => ({
						name: cmd.name,
						description: cmd.description,
						source: "extension" as const,
					})) ?? [],
				setModel: model => runExtensionSetModel(session, model),
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await session.sessionManager.setSessionName(name, "user");
				},
				unregisterProvider: name => session.modelRegistry.unregisterProvider?.(name),
			},
			{
				getModel: () => session.agent.state.model,
				getScopedModels: () =>
					(session.scopedModels ?? []).map(scoped => ({
						model: scoped.model,
						thinkingLevel: scoped.thinkingLevel,
						explicitThinkingLevel: false,
					})),
				getThinkingLevel: () => session.thinkingLevel,
				getSignal: () => undefined,
				isIdle: () => !session.isStreaming,
				abort: () => session.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => {
					shutdownState.requested = true;
				},
				getContextUsage: () => session.getContextUsage(),
				getSystemPrompt: () => session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async options => {
					const success2 = await session.newSession({ parentSession: options?.parentSession });
					if (success2 && options?.setup) {
						await options.setup(session.sessionManager);
					}
					return { cancelled: !success2 };
				},
				branch: async entryId => {
					const result = await session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success2 = await session.switchSession(sessionPath);
					return { cancelled: !success2 };
				},
				reload: async () => {
					await session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			new WireExtensionUIContext(),
			"wire-stdio",
		);
		extensionRunner.onError(err => {
			writeFrame({ type: "response", id: "", ok: false, error: `extension_error: ${err.error}` });
		});
		await extensionRunner.emit({
			type: "session_start",
			reason: "new",
		});
	}

	// ── 事件 → push（progress 帧）──
	session.subscribe(event => {
		const progressEvent: WireServerEvent = {
			type: "progress",
			sessionId,
			event,
		};
		writeFrame({ type: "push", event: progressEvent });
	});

	// ── 命令分发 ──
	const handleCommand = async (command: WireCommand): Promise<ServerFrame> => {
		const id = command.id ?? (Snowflake.next() as string);

		switch (command.type) {
			// Prompting
			case "prompt": {
				logger.info("[wire-stdio] prompt received", {
					currentModel: session.model ? `${session.model.provider}/${session.model.id}` : "none",
					messagePreview: command.message?.slice(0, 50),
				});
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
					})
					.catch(e => writeFrame(fail(id, e.message)));
				return success(id);
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id);
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id);
			}

			case "abort": {
				await session.abort();
				return success(id);
			}

			case "abort_and_prompt": {
				await session.abort();
				session.prompt(command.message, { images: command.images }).catch(e => writeFrame(fail(id, e.message)));
				return success(id);
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, { cancelled });
			}

			// State
			case "get_state": {
				const state = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				};
				return success(id, state);
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeWireHostToolDefinitions(command.tools);
				const wireTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(wireTools);
				return success(id, { toolNames: tools.map(tool => tool.name) });
			}

			// Model
			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return fail(id, `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) return success(id, null);
				return success(id, result);
			}

			case "get_available_models": {
				return success(id, { models: session.getAvailableModels() });
			}

			// Thinking
			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id);
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) return success(id, null);
				return success(id, { level });
			}

			// Tool control
			case "set_disabled_toolsets": {
				const allTools = session.getAllToolNames();
				const disabled = new Set(command.toolsets ?? []);
				const enabled = allTools.filter(name => !disabled.has(name));
				if (disabled.has("report_tool_issue")) {
					enabled.push("report_tool_issue");
				}
				await session.setActiveToolsByName(enabled);
				return success(id, { disabled: Array.from(disabled) });
			}

			// Queue modes
			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id);
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id);
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id);
			}

			// Compaction
			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id);
			}

			// Retry
			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id);
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id);
			}

			// Bash
			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id);
			}

			// Session
			case "get_session_stats": {
				return success(id, session.getSessionStats());
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, { path });
			}

			case "switch_session": {
				// 与 RPC 模式同语义：切换当前 agent 的会话文件。
				// （WireCommand.switch_session 的注册表语义仅 serve/wire-server 面使用；
				// bridge 在此传 sessionPath，语义等于 RPC 模式。）
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, { cancelled });
			}

			case "branch": {
				const result = await session.branch(command.entryId);
				return success(id, { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_branch_messages": {
				return success(id, { messages: session.getUserMessagesForBranching() });
			}

			case "get_last_assistant_text": {
				return success(id, { text: session.getLastAssistantText() });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return fail(id, "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return fail(id, "Session name cannot be empty");
				}
				return success(id);
			}

			// Messages
			case "get_messages": {
				return success(id, { messages: session.messages });
			}

			// wire 专属命令（serve 面实现；wire-stdio 子进程暂不支持）
			case "subscribe":
			case "unsubscribe":
			case "get_snapshot":
			case "attach":
			case "detach":
			case "list_agents":
			case "list_sessions":
			case "get_session_messages":
			case "fs_list":
			case "fs_read":
			case "fs_read_image":
			case "gateway_status":
			case "get_stats":
			case "get_memory":
			case "get_skills":
			case "list_commands":
			case "set_skill_enabled":
			case "set_model_disabled":
			case "inject_permission":
			case "permission_respond":
			case "record_transcribe":
			case "listen_list":
			case "list_remote_skills":
			case "install_remote_skill":
			case "get_mcp_servers":
			case "set_mcp_server":
			case "remove_mcp_server":
			case "test_mcp_server":
			case "get_cron_tasks":
			case "get_cron_logs":
			case "fork_from":
			case "undo_exchange":
			case "retry_from":
				return fail(id, `Command not implemented in wire-stdio mode: ${command.type}`);

			default: {
				const unknownCommand = command as { type: string };
				return fail(id, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// ── 主循环（与 hello 同一流迭代器）──
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		try {
			// 首帧握手门：等 hello（30s 超时），收到前拒绝 request
			if (!helloDone) {
				if (Date.now() > helloDeadline) {
					logger.error("[wire-stdio] timeout waiting for hello frame");
					process.exit(1);
				}
				const helloFrame = parsed as ClientFrame;
				if (helloFrame.type === "hello") {
					helloDone = true;
					writeFrame({ type: "hello_ack", connectionId: "stdio", protocolVersion: 1 });
					continue;
				}
				if (helloFrame.type === "request") {
					writeFrame({ type: "hello_error", error: "Expected hello before request" });
					process.exit(1);
				}
				continue;
			}

			if (isWireHostToolResult(parsed)) {
				hostToolBridge.handleResult(parsed);
				continue;
			}
			if (isWireHostToolUpdate(parsed)) {
				hostToolBridge.handleUpdate(parsed);
				continue;
			}

			const frame = parsed as ClientFrame;
			if (frame.type !== "request") continue;

			const response = await handleCommand(frame.command);
			writeFrame(response);

			if (shutdownState.requested) {
				process.exit(0);
			}
		} catch (e) {
			writeFrame(fail("", `Failed to parse command: ${e instanceof Error ? e.message : String(e)}`));
		}
	}

	// stdin closed — client gone, exit cleanly
	hostToolBridge.rejectAllPending("wire-stdio client disconnected before host tool execution completed");
	process.exit(0);
}
