import type { RegressionReplayBackendKind } from "./replay-backend";

export type ToolChainTrialTag = "overturn" | "confirm" | "only" | "repeat" | "skip";

export function formatRegressionTrialReason(opts: {
	replayBackend: RegressionReplayBackendKind;
	toolChainTag?: ToolChainTrialTag;
	body: string;
}): string {
	const tags: string[] = [`[replay:${opts.replayBackend}]`];
	if (opts.toolChainTag) {
		tags.push(`[toolchain:${opts.toolChainTag}]`);
	}
	const body = opts.body.trim();
	if (body.startsWith("[replay:")) {
		return body;
	}
	return `${tags.join(" ")} ${body}`;
}

export function parseReplayBackendFromTrialReason(reason: string): RegressionReplayBackendKind | undefined {
	const match = reason.match(/\[replay:(heuristic|llm|subagent)\]/);
	if (!match) return undefined;
	return match[1] as RegressionReplayBackendKind;
}

export function parseToolchainTagFromTrialReason(reason: string): ToolChainTrialTag | undefined {
	const match = reason.match(/\[toolchain:(overturn|confirm|only|repeat|skip)\]/);
	if (!match) return undefined;
	return match[1] as ToolChainTrialTag;
}
