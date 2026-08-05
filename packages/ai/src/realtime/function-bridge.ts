/**
 * Function-calling bridge for realtime sessions.
 *
 * Subscribes to the transport, invokes the registered handler when the model
 * completes a function call, and pipes the result back as `function_call_output`
 * followed by `response.create` so the model verbalizes it.
 */
import type { RealtimeFunctionTool, RealtimeServerEvent } from "./protocol";
import type { RealtimeWsTransport } from "./transport";

export interface RealtimeFunctionCall {
	callId: string;
	name: string;
	/** Raw JSON arguments string, exactly as emitted by the model. */
	arguments: string;
}

export type RealtimeFunctionHandler = (call: RealtimeFunctionCall) => Promise<string>;

export class RealtimeFunctionBridge {
	readonly #transport: RealtimeWsTransport;
	readonly #tools: RealtimeFunctionTool[] = [];
	#handler: RealtimeFunctionHandler | undefined;
	#unsubscribe: (() => void) | undefined;
	/** Serializes result submission so overlapping calls never interleave on the wire. */
	#chain: Promise<void> = Promise.resolve();

	constructor(transport: RealtimeWsTransport) {
		this.#transport = transport;
	}

	get tools(): readonly RealtimeFunctionTool[] {
		return this.#tools;
	}

	registerTool(tool: Omit<RealtimeFunctionTool, "type">): void {
		this.#tools.push({ type: "function", ...tool });
	}

	/** Starts intercepting function calls. One bridge, one handler. */
	attach(handler: RealtimeFunctionHandler): void {
		this.detach();
		this.#handler = handler;
		this.#unsubscribe = this.#transport.addEventListener(event => {
			if (event.type === "response.function_call_arguments.done") {
				this.#dispatch(event);
			}
		});
	}

	detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#handler = undefined;
	}

	#dispatch(event: Extract<RealtimeServerEvent, { type: "response.function_call_arguments.done" }>): void {
		const handler = this.#handler;
		if (!handler) return;
		this.#chain = this.#chain.then(async () => {
			let output: string;
			try {
				output = await handler({ callId: event.callId, name: event.name, arguments: event.arguments });
			} catch (err) {
				// The model MUST receive a syntactically valid result either way,
				// or it waits forever and the voice loop stalls.
				output = JSON.stringify({ error: String(err instanceof Error ? err.message : err) });
			}
			// Cancel before creating: if a response is still in progress (e.g. a
			// previous function round's verbalization, or parallel calls in one
			// response), the bare create is rejected with "Cannot create response
			// while another response is in progress". Cancel is benign when nothing
			// is active. Item lands after the cancel so the new response sees it.
			this.#transport.send({ type: "response.cancel" });
			this.#transport.send({
				type: "conversation.item.create",
				item: { type: "function_call_output", call_id: event.callId, output },
			});
			this.#transport.send({ type: "response.create" });
		});
	}
}
