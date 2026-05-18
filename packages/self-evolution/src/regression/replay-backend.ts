/**
 * Pluggable regression replay backends: heuristic, LLM judge, or omp sub-agent rerun.
 */
import type { Convention, EvolvedSkill, RegressionFixture } from "../types";
import {
	evaluateConventionOnFixture,
	evaluateSkillOnFixture,
	type FixtureReplayResult,
	type RegressionGateResult,
	runRegressionGate,
	runRegressionGateEval,
	runSkillRegressionGate,
	runSkillRegressionGateEval,
} from "./replay";
import { evaluateConventionWithLlm, evaluateSkillWithLlm } from "./replay-llm";
import { getRegressionReplayRuntime } from "./replay-runtime";
import {
	evaluateConventionWithSubagent,
	evaluateSkillWithSubagent,
	REGRESSION_SUBAGENT_MAX_FIXTURES,
} from "./replay-subagent";

export interface RegressionReplayBackend {
	readonly kind: RegressionReplayBackendKind;
	evaluateConventionOnFixture(
		convention: Convention,
		fixture: RegressionFixture,
	): FixtureReplayResult | Promise<FixtureReplayResult>;
	evaluateSkillOnFixture(
		skill: EvolvedSkill,
		fixture: RegressionFixture,
	): FixtureReplayResult | Promise<FixtureReplayResult>;
	runConventionGate(
		convention: Convention,
		fixtures: RegressionFixture[],
	): RegressionGateResult | Promise<RegressionGateResult>;
	runSkillGate(
		skill: EvolvedSkill,
		fixtures: RegressionFixture[],
	): RegressionGateResult | Promise<RegressionGateResult>;
}

export class HeuristicRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "heuristic" as const;

	evaluateConventionOnFixture(convention: Convention, fixture: RegressionFixture): FixtureReplayResult {
		return evaluateConventionOnFixture(convention, fixture);
	}

	evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): FixtureReplayResult {
		return evaluateSkillOnFixture(skill, fixture);
	}

	runConventionGate(convention: Convention, fixtures: RegressionFixture[]): RegressionGateResult {
		return runRegressionGate(convention, fixtures);
	}

	runSkillGate(skill: EvolvedSkill, fixtures: RegressionFixture[]): RegressionGateResult {
		return runSkillRegressionGate(skill, fixtures);
	}
}

export class LlmRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "llm" as const;
	#heuristic = new HeuristicRegressionReplayBackend();

	async evaluateConventionOnFixture(convention: Convention, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const llm = await evaluateConventionWithLlm(convention, fixture, getRegressionReplayRuntime());
		if (llm) return llm;
		return this.#heuristic.evaluateConventionOnFixture(convention, fixture);
	}

	async evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const llm = await evaluateSkillWithLlm(skill, fixture, getRegressionReplayRuntime());
		if (llm) return llm;
		return this.#heuristic.evaluateSkillOnFixture(skill, fixture);
	}

	async runConventionGate(convention: Convention, fixtures: RegressionFixture[]): Promise<RegressionGateResult> {
		return await runRegressionGateEval(async f => this.evaluateConventionOnFixture(convention, f), fixtures);
	}

	async runSkillGate(skill: EvolvedSkill, fixtures: RegressionFixture[]): Promise<RegressionGateResult> {
		return await runSkillRegressionGateEval(async f => this.evaluateSkillOnFixture(skill, f), fixtures);
	}
}

export class SubAgentRegressionReplayBackend implements RegressionReplayBackend {
	readonly kind = "subagent" as const;
	#llm = new LlmRegressionReplayBackend();

	async evaluateConventionOnFixture(convention: Convention, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const sub = await evaluateConventionWithSubagent(convention, fixture, getRegressionReplayRuntime());
		if (sub) return sub;
		return this.#llm.evaluateConventionOnFixture(convention, fixture);
	}

	async evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): Promise<FixtureReplayResult> {
		const sub = await evaluateSkillWithSubagent(skill, fixture, getRegressionReplayRuntime());
		if (sub) return sub;
		return this.#llm.evaluateSkillOnFixture(skill, fixture);
	}

	async runConventionGate(convention: Convention, fixtures: RegressionFixture[]): Promise<RegressionGateResult> {
		return await runRegressionGateEval(async f => this.evaluateConventionOnFixture(convention, f), fixtures, {
			maxFixtures: REGRESSION_SUBAGENT_MAX_FIXTURES,
		});
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
