import * as path from "node:path";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import regressionReplaySubagentTemplate from "../prompts/regression-replay-subagent.md" with { type: "text" };
import type { Convention, EvolvedSkill, RegressionFixture } from "../types";
import { applyToolChainCompareToVerdict, compareFixtureToReplayChain } from "./compare-tool-chains";
import { formatFixtureToolChainSummary } from "./fixture-tool-chain";
import { extractReplayVerdictFromJsonStream, parseOmpJsonEventStreamToTraceEntries } from "./parse-omp-json-events";
import { type FixtureReplayResult, fixtureLogText } from "./replay";
import { fixtureReplayResultFromInterpretation, interpretSubagentReplayOutcome } from "./replay-contract";
import type { RegressionReplayRuntime } from "./replay-runtime";

export const REGRESSION_SUBAGENT_MAX_FIXTURES = 2;
export const REGRESSION_SUBAGENT_DEFAULT_TIMEOUT_MS = 90_000;

function defaultOmpExecutable(): string[] {
	const cliPath = path.join(import.meta.dir, "../../../coding-agent/src/cli.ts");
	return ["bun", cliPath];
}

function renderSubagentPrompt(
	targetType: "convention" | "skill",
	assetBody: string,
	fixture: RegressionFixture,
): string {
	return prompt.render(regressionReplaySubagentTemplate, {
		target_type: targetType,
		asset_body: assetBody,
		user_prompt: fixture.userPrompt.slice(0, 400),
		dominant_error_tool: fixture.dominantErrorTool ?? "unknown",
		dominant_error_pattern: fixture.dominantErrorPattern ?? "unknown",
		tool_chain_summary: formatFixtureToolChainSummary(fixture).slice(0, 6000),
		failure_log: fixtureLogText(fixture).slice(0, 4000),
	});
}

async function runSubagentReplay(
	userPrompt: string,
	fixture: RegressionFixture,
	runtime: RegressionReplayRuntime,
	logContext: { targetId: string; fixtureId: string },
): Promise<FixtureReplayResult | undefined> {
	const executable = runtime.ompExecutable ?? defaultOmpExecutable();
	const timeoutMs = runtime.subagentTimeoutMs ?? REGRESSION_SUBAGENT_DEFAULT_TIMEOUT_MS;

	const proc = Bun.spawn([...executable, "--no-self-evolution", "--mode", "json", "-p", userPrompt], {
		cwd: fixture.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OMP_REGRESSION_REPLAY_SUBPROCESS: "1" },
	});

	const exitCode = await Promise.race([
		proc.exited,
		Bun.sleep(timeoutMs).then(() => {
			proc.kill();
			return -1;
		}),
	]);

	const stdout = await readChildOutput(proc.stdout);
	const stderr = await readChildOutput(proc.stderr);
	const combined = `${stdout}\n${stderr}`;
	const replayEntries = parseOmpJsonEventStreamToTraceEntries(stdout);
	const chainCompare = replayEntries.length > 0 ? compareFixtureToReplayChain(fixture, replayEntries) : undefined;

	const jsonVerdict = extractReplayVerdictFromJsonStream(stdout);
	if (jsonVerdict) {
		return applyToolChainCompareToVerdict(jsonVerdict, chainCompare).result;
	}

	const interpretation = interpretSubagentReplayOutcome({ exitCode, combinedOutput: combined });
	const verdict = fixtureReplayResultFromInterpretation(interpretation);
	if (verdict) {
		return applyToolChainCompareToVerdict(verdict, chainCompare).result;
	}

	if (chainCompare && chainCompare.replayToolCallCount > 0) {
		if (chainCompare.avoidedDominantError) {
			return {
				passed: true,
				reason: `Tool-chain replay only: ${chainCompare.reason}`,
			};
		}
		return {
			passed: false,
			reason: `Tool-chain replay only: ${chainCompare.reason}`,
		};
	}

	logger.debug("Sub-agent regression replay no contract verdict", {
		...logContext,
		status: interpretation.status,
		exitCode,
		replayToolCalls: chainCompare?.replayToolCallCount ?? 0,
		snippet: combined.slice(0, 200),
	});
	return undefined;
}

async function readChildOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}

export async function evaluateConventionWithSubagent(
	convention: Convention,
	fixture: RegressionFixture,
	runtime: RegressionReplayRuntime,
): Promise<FixtureReplayResult | undefined> {
	if (process.env.OMP_REGRESSION_REPLAY_SUBPROCESS === "1") {
		return undefined;
	}

	const userPrompt = renderSubagentPrompt("convention", `type=${convention.type}\n${convention.content}`, fixture);
	return runSubagentReplay(userPrompt, fixture, runtime, {
		targetId: convention.id,
		fixtureId: fixture.id,
	});
}

export async function evaluateSkillWithSubagent(
	skill: EvolvedSkill,
	fixture: RegressionFixture,
	runtime: RegressionReplayRuntime,
): Promise<FixtureReplayResult | undefined> {
	if (process.env.OMP_REGRESSION_REPLAY_SUBPROCESS === "1") {
		return undefined;
	}

	const body = `${skill.description}\n${skill.taskPattern}\n${skill.approach}`;
	const userPrompt = renderSubagentPrompt("skill", body, fixture);
	return runSubagentReplay(userPrompt, fixture, runtime, {
		targetId: skill.name,
		fixtureId: fixture.id,
	});
}
