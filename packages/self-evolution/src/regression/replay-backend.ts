/**
 * Pluggable regression replay backends: heuristic, LLM judge, or omp sub-agent rerun.
 */
import type { EvolvedSkill, RegressionFixture } from "../types";
import {
	evaluateSkillOnFixture,
	type FixtureReplayResult,
	type RegressionGateResult,
	runSkillRegressionGate,
	runSkillRegressionGateEval,
} from "./replay";
import { evaluateSkillWithLlm } from "./replay-llm";
import { getRegressionReplayRuntime } from "./replay-runtime";
import { evaluateSkillWithSubagent, REGRESSION_SUBAGENT_MAX_FIXTURES } from "./replay-subagent";

export interface RegressionReplayBackend {
	readonly kind: RegressionReplayBackendKind;
	evaluateSkillOnFixture(
		skill: EvolvedSkill,
		fixture: RegressionFixture,
	): FixtureReplayResult | Promise<FixtureReplayResult>;
	runSkillGate(
		skill: EvolvedSkill,
		fixtures: RegressionFixture[],
	): RegressionGateResult | Promise<RegressionGateResult>;
}

export class HeuristicRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "heuristic" as const;

	evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): FixtureReplayResult {
		return evaluateSkillOnFixture(skill, fixture);
	}

	runSkillGate(skill: EvolvedSkill, fixtures: RegressionFixture[]): RegressionGateResult {
		return runSkillRegressionGate(skill, fixtures);
	}
}

export class LlmRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "llm" as const;
	#heuristic = new HeuristicRegressionReplayBackend();

	async evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const llm = await evaluateSkillWithLlm(skill, fixture, getRegressionReplayRuntime());
		if (llm) return llm;
		return this.#heuristic.evaluateSkillOnFixture(skill, fixture);
	}

	async runSkillGate(skill: EvolvedSkill, fixtures: RegressionFixture[]): Promise<RegressionGateResult> {
		return await runSkillRegressionGateEval(async f => this.evaluateSkillOnFixture(skill, f), fixtures);
	}
}

export class SubAgentRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "subagent" as const;
	#llm = new LlmRegressionReplayBackend();

	async evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const sub = await evaluateSkillWithSubagent(skill, fixture, getRegressionReplayRuntime());
		if (sub) return sub;
		return this.#llm.evaluateSkillOnFixture(skill, fixture);
	}

	async runSkillGate(skill: EvolvedSkill, fixtures: RegressionFixture[]): Promise<RegressionGateResult> {
		return await runSkillRegressionGateEval(async f => this.evaluateSkillOnFixture(skill, f), fixtures, {
			maxFixtures: REGRESSION_SUBAGENT_MAX_FIXTURES,
		});
	}
}

export type RegressionReplayBackendKind = "heuristic" | "llm" | "subagent";

export function parseRegressionReplayBackendKind(value: boolean | string | undefined): RegressionReplayBackendKind {
	if (value === "subagent") return "subagent";
	if (value === "llm") return "llm";
	return "heuristic";
}

export function createRegressionReplayBackend(
	kind: RegressionReplayBackendKind = "heuristic",
): RegressionReplayBackend {
	if (kind === "subagent") {
		return new SubAgentRegressionReplayBackend();
	}
	if (kind === "llm") {
		return new LlmRegressionReplayBackend();
	}
	return new HeuristicRegressionReplayBackend();
}
