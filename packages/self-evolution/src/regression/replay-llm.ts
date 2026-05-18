import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import regressionReplaySystemTemplate from "../prompts/regression-replay.md" with { type: "text" };
import regressionReplayInputTemplate from "../prompts/regression-replay-input.md" with { type: "text" };
import type { Convention, EvolvedSkill, RegressionFixture } from "../types";
import { type BackgroundLlmAuth, callBackgroundLlm } from "../utils/llm";
import { formatFixtureToolChainSummary } from "./fixture-tool-chain";
import { parseReplayVerdictFromResponse } from "./replay-contract";

export { parseReplayVerdictFromResponse } from "./replay-contract";

import { type FixtureReplayResult, fixtureLogText } from "./replay";
import type { RegressionReplayRuntime } from "./replay-runtime";

function conventionBody(convention: Convention): string {
	return `type=${convention.type}\n${convention.content}`;
}

function skillBody(skill: EvolvedSkill): string {
	return `${skill.description}\n${skill.taskPattern}\n${skill.approach}\ntools: ${skill.tools.join(", ")}`;
}

function renderReplayInput(targetType: "convention" | "skill", assetBody: string, fixture: RegressionFixture): string {
	return prompt.render(regressionReplayInputTemplate, {
		target_type: targetType,
		asset_body: assetBody,
		session_id: fixture.sessionId,
		cwd: fixture.cwd,
		user_prompt: fixture.userPrompt.slice(0, 500),
		dominant_error_tool: fixture.dominantErrorTool ?? "unknown",
		dominant_error_pattern: fixture.dominantErrorPattern ?? "unknown",
		error_count: String(fixture.errorCount),
		completed_successfully: String(fixture.completedSuccessfully),
		tool_chain_summary: formatFixtureToolChainSummary(fixture).slice(0, 6000),
		failure_log: fixtureLogText(fixture).slice(0, 8000),
	});
}

export async function evaluateConventionWithLlm(
	convention: Convention,
	fixture: RegressionFixture,
	runtime: RegressionReplayRuntime,
): Promise<FixtureReplayResult | undefined> {
	const model = runtime.model;
	if (!model) return undefined;

	const userPrompt = renderReplayInput("convention", conventionBody(convention), fixture);
	const response = await callBackgroundLlm(model, regressionReplaySystemTemplate, userPrompt, {
		auth: runtime.auth,
		maxTokens: 512,
	});
	const verdict = parseReplayVerdictFromResponse(response);
	if (!verdict) {
		logger.debug("LLM regression replay returned unparseable response", {
			conventionId: convention.id,
			fixtureId: fixture.id,
			snippet: response.slice(0, 120),
		});
	}
	return verdict;
}

export async function evaluateSkillWithLlm(
	skill: EvolvedSkill,
	fixture: RegressionFixture,
	runtime: RegressionReplayRuntime,
): Promise<FixtureReplayResult | undefined> {
	const model = runtime.model;
	if (!model) return undefined;

	const userPrompt = renderReplayInput("skill", skillBody(skill), fixture);
	const response = await callBackgroundLlm(model, regressionReplaySystemTemplate, userPrompt, {
		auth: runtime.auth,
		maxTokens: 512,
	});
	return parseReplayVerdictFromResponse(response);
}

export type { BackgroundLlmAuth, Model };
