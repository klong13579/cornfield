import type { Model } from "@oh-my-pi/pi-ai";
import type { BackgroundLlmAuth } from "../utils/llm";

export interface RegressionReplayRuntime {
	model?: Model;
	auth?: BackgroundLlmAuth;
	/** Override omp invocation (default: bun + coding-agent cli.ts) */
	ompExecutable?: string[];
	subagentTimeoutMs?: number;
}

let runtime: RegressionReplayRuntime = {};

export function setRegressionReplayRuntime(partial: RegressionReplayRuntime): void {
	runtime = { ...runtime, ...partial };
}

export function getRegressionReplayRuntime(): RegressionReplayRuntime {
	return runtime;
}

export function clearRegressionReplayRuntime(): void {
	runtime = {};
}
