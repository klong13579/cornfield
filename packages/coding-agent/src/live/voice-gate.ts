/**
 * VoiceGate — the tiered voice confirmation gate (P1 design §5).
 *
 * Registers a scoped tool_call handler on the MAIN session's extension runner
 * (via addInternalExtension) while voice mode is active. The handler only
 * intervenes while a voice task is in flight — typed turns and the consult
 * session never trigger voice confirmations.
 *
 * Yellow tools get one voice confirmation per task (sticky); red tools are
 * asked every time. Timeout / unclear-twice / refusal block the tool with an
 * agent-readable reason. Fail-safe: disarming (voice mode exit) settles any
 * pending confirmation as cancel.
 */
import { logger } from "@cornfield/utils";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import type { Extension, ToolCallEvent, ToolCallEventResult } from "../extensibility/extensions/types";
import { classifyToolRisk, describeToolCall, type ToolRiskLevel } from "./tool-risk";
import type { VoiceConfirmDecision } from "./types";

const DEFAULT_CONFIRM_TIMEOUT_MS = 15_000;
/** Ask once more after an "unclear", then give up (design §5 two-strike rule). */
const MAX_UNCLEAR_RETRIES = 1;

export interface VoiceConfirmChannel {
	/** Inject text into the realtime conversation and trigger a model response. */
	speak(text: string): boolean;
}

export interface VoiceGateOptions {
	channel: VoiceConfirmChannel;
	/** How long to wait for the spoken answer per round. Default 15s (design §5). */
	confirmTimeoutMs?: number;
}

interface PendingConfirmation {
	resolve(decision: VoiceConfirmDecision): void;
	timer: ReturnType<typeof setTimeout>;
}

export class VoiceGate {
	readonly #channel: VoiceConfirmChannel;
	readonly #confirmTimeoutMs: number;

	#disposer: (() => void) | undefined;
	#inFlight = false;
	#sticky = new Set<string>();
	#pending: PendingConfirmation | undefined;
	/** Serializes overlapping confirmations — parallel tool calls must not both start speaking. */
	#confirmChain: Promise<void> = Promise.resolve();

	constructor(options: VoiceGateOptions) {
		this.#channel = options.channel;
		this.#confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
	}

	/** Whether the gate is registered on a runner. */
	get armed(): boolean {
		return this.#disposer !== undefined;
	}

	/** Whether a voice task is currently executing (the gate's scope). */
	get inFlight(): boolean {
		return this.#inFlight;
	}

	/** Whether a confirmation question is waiting for the user's spoken answer. */
	get confirmationPending(): boolean {
		return this.#pending !== undefined;
	}

	arm(runner: Pick<ExtensionRunner, "addInternalExtension">): void {
		if (this.#disposer) return;
		const extension: Extension = {
			path: "<voice-gate>",
			resolvedPath: "<voice-gate>",
			label: "voice-gate",
			handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
				["tool_call", [this.#handleToolCall]],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		this.#disposer = runner.addInternalExtension(extension);
		logger.info("voice confirmation gate armed");
	}

	disarm(): void {
		if (!this.#disposer) return;
		this.#disposer();
		this.#disposer = undefined;
		this.#inFlight = false;
		this.#sticky.clear();
		// Voice session gone — a pending question can never be answered.
		this.#settlePending("cancel");
		logger.info("voice confirmation gate disarmed");
	}

	/** Voice task starting: open the scope and reset sticky approvals. */
	beginTask(): void {
		this.#inFlight = true;
		this.#sticky.clear();
	}

	/** Voice task finished: close the scope. */
	endTask(): void {
		this.#inFlight = false;
		this.#sticky.clear();
		this.#settlePending("cancel");
	}

	/** The realtime model reported the user's spoken answer (omp_voice_confirm). */
	resolveDecision(decision: VoiceConfirmDecision): void {
		this.#settlePending(decision);
	}

	#handleToolCall = async (event: unknown): Promise<ToolCallEventResult | undefined> => {
		if (!this.#inFlight) return undefined;
		const toolCall = event as ToolCallEvent;
		// Union member inputs are typed per tool; the gate treats them as value bags.
		const input = toolCall.input as Record<string, unknown>;
		const risk = classifyToolRisk(toolCall.toolName, input);
		if (risk === "green") return undefined;
		if (risk === "yellow" && this.#sticky.has(toolCall.toolName)) return undefined;

		// Parallel tool calls: queue confirmation rounds behind each other.
		let decision = "cancel" as VoiceConfirmDecision;
		const turn = this.#confirmChain.then(async () => {
			// A previous round in the chain may have approved this tool already.
			if (risk === "yellow" && this.#sticky.has(toolCall.toolName)) {
				decision = "confirm";
				return;
			}
			decision = await this.#confirmRound(risk, toolCall.toolName, input);
		});
		this.#confirmChain = turn.catch(() => {});
		await turn;

		if (decision === "confirm") {
			if (risk === "yellow") this.#sticky.add(toolCall.toolName);
			return undefined;
		}
		return {
			block: true,
			reason: `用户在语音确认环节取消了该操作（${describeToolCall(toolCall.toolName, input)}）。不要重试同一操作；先向用户说明，再决定下一步。`,
		};
	};

	async #confirmRound(
		risk: ToolRiskLevel,
		toolName: string,
		input: Record<string, unknown>,
	): Promise<VoiceConfirmDecision> {
		for (let attempt = 0; attempt <= MAX_UNCLEAR_RETRIES; attempt++) {
			const note = this.#buildConfirmNote(risk, toolName, input, attempt > 0);
			if (!this.#channel.speak(note)) return "cancel";
			const decision = await this.#waitDecision();
			if (decision !== "unclear") {
				if (decision === "cancel") {
					this.#channel.speak(
						"（系统：用户取消了该操作，不会执行。除非用户主动开口，否则不要说话——安静等待下一句即可。）",
					);
				}
				return decision;
			}
		}
		this.#channel.speak(
			"（系统：没有听清用户的答复，该操作已放弃执行。除非用户主动开口，否则不要说话——安静等待下一句即可。）",
		);
		return "cancel";
	}

	#buildConfirmNote(risk: ToolRiskLevel, toolName: string, input: Record<string, unknown>, retry: boolean): string {
		const level = risk === "red" ? "红色（高风险副作用，必须用户明确同意）" : "黄色（文件/状态变更）";
		const lines = [
			"（系统：主会话正在执行语音任务，下一个操作需要用户确认。",
			`操作级别：${level}`,
			`操作内容：${describeToolCall(toolName, input)}`,
			"请向用户口头复述这个操作并请求确认，然后等待用户回答，不要自问自答。",
			"用户回答后调用 omp_voice_confirm：明确同意→confirm；拒绝/取消/算了→cancel；没听清或答非所问→unclear。",
			"在用户明确回答前，不要调用其他工具。）",
		];
		if (retry) lines.splice(1, 0, "注意：上一次没有听清用户的答复，这是再次询问。");
		return lines.join("\n");
	}

	#waitDecision(): Promise<VoiceConfirmDecision> {
		this.#settlePending("cancel"); // defensive: at most one pending round
		const { promise, resolve } = Promise.withResolvers<VoiceConfirmDecision>();
		const timer = setTimeout(() => this.#settlePending("cancel"), this.#confirmTimeoutMs);
		timer.unref?.();
		this.#pending = { resolve, timer };
		return promise;
	}

	#settlePending(decision: VoiceConfirmDecision): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(decision);
	}
}
