/**
 * Heuristic replay of skills against failed-session fixtures.
 * Full sub-agent rerun is pluggable via `replay-backend.ts` (defaults to this module).
 */
import type { EvolvedSkill, RegressionFixture } from "../types";

export interface FixtureReplayResult {
	passed: boolean;
	reason: string;
}

export interface RegressionGateResult {
	verdict: "keep" | "discard";
	passCount: number;
	failCount: number;
	reason: string;
}

export const REGRESSION_MIN_PASS_RATE = 0.6;
export const REGRESSION_MAX_FIXTURES = 5;

export function fixtureLogText(fixture: RegressionFixture): string {
	const parts = [fixture.userPrompt, fixture.dominantErrorPattern ?? "", fixture.dominantErrorTool ?? ""];
	for (const entry of fixture.entries) {
		if (entry.type === "tool_result" && entry.isError) {
			parts.push(String(entry.result ?? ""));
			parts.push(entry.toolName ?? "");
		}
		if (entry.type === "model_error" && entry.content) {
			parts.push(entry.content);
		}
	}
	return parts.join("\n").toLowerCase();
}

function tokenOverlap(a: string, b: string): number {
	const wordsA = new Set(a.split(/\W+/).filter(w => w.length > 3));
	if (wordsA.size === 0) return 0;
	let matches = 0;
	for (const word of wordsA) {
		if (b.includes(word)) matches++;
	}
	return matches / wordsA.size;
}

/** ENOENT / path / read / find heuristics for common failure fixtures. */
function matchesErrorTheme(conventionText: string, logText: string): boolean {
	const c = conventionText.toLowerCase();
	const hasPathTheme =
		/(verify|before\s+(calling\s+)?read|use find|path exists|unknown path|missing file)/.test(c) &&
		/(enoent|no such file|missing|not found)/.test(logText);
	const hasEditTheme =
		/(edit|patch|anchor|before verifying)/.test(c) && /(edit|patch|failed to match|anchor)/.test(logText);
	const hasSearchTheme =
		/(ast_grep|redundant search|narrowing your search)/.test(c) && /(search|grep|ast_grep|too many)/.test(logText);
	return hasPathTheme || hasEditTheme || hasSearchTheme;
}

export function evaluateSkillOnFixture(skill: EvolvedSkill, fixture: RegressionFixture): FixtureReplayResult {
	const logText = fixtureLogText(fixture);
	const body = `${skill.description}\n${skill.taskPattern}\n${skill.approach}`.toLowerCase();

	if (matchesErrorTheme(body, logText)) {
		return { passed: true, reason: "Skill approach matches fixture error pattern." };
	}

	const overlap = tokenOverlap(body, logText);
	if (overlap >= 0.15) {
		return { passed: true, reason: `Skill keyword overlap ${(overlap * 100).toFixed(0)}% with fixture errors.` };
	}

	for (const tool of skill.tools) {
		if (logText.includes(tool.toLowerCase()) && body.includes(tool.toLowerCase())) {
			return { passed: true, reason: `Skill tool "${tool}" aligns with fixture errors.` };
		}
	}

	return { passed: false, reason: "Skill does not address this fixture failure pattern." };
}

export async function runSkillRegressionGateEval(
	evaluate: (fixture: RegressionFixture) => FixtureReplayResult | Promise<FixtureReplayResult>,
	fixtures: RegressionFixture[],
	opts?: { minPassRate?: number; maxFixtures?: number; emptyReason?: string },
): Promise<RegressionGateResult> {
	const minPassRate = opts?.minPassRate ?? REGRESSION_MIN_PASS_RATE;
	const maxFixtures = opts?.maxFixtures ?? REGRESSION_MAX_FIXTURES;
	const emptyReason = opts?.emptyReason ?? "No regression fixtures; cannot promote skill without replay evidence.";

	if (fixtures.length === 0) {
		return { verdict: "discard", passCount: 0, failCount: 0, reason: emptyReason };
	}

	const slice = fixtures.slice(0, maxFixtures);
	let passCount = 0;
	for (const fixture of slice) {
		const result = await evaluate(fixture);
		if (result.passed) {
			passCount++;
		}
	}
	const failCount = slice.length - passCount;
	const passRate = passCount / slice.length;

	if (passRate >= minPassRate) {
		return {
			verdict: "keep",
			passCount,
			failCount,
			reason: `Skill regression keep: ${passCount}/${slice.length} fixtures passed (${(passRate * 100).toFixed(0)}%).`,
		};
	}

	return {
		verdict: "discard",
		passCount,
		failCount,
		reason: `Skill regression discard: ${passCount}/${slice.length} fixtures passed (need ${(minPassRate * 100).toFixed(0)}%).`,
	};
}

export function runSkillRegressionGate(
	skill: EvolvedSkill,
	fixtures: RegressionFixture[],
	opts?: { minPassRate?: number; maxFixtures?: number },
): RegressionGateResult {
	const minPassRate = opts?.minPassRate ?? REGRESSION_MIN_PASS_RATE;
	const maxFixtures = opts?.maxFixtures ?? REGRESSION_MAX_FIXTURES;

	if (fixtures.length === 0) {
		return {
			verdict: "discard",
			passCount: 0,
			failCount: 0,
			reason: "No regression fixtures; cannot promote skill without replay evidence.",
		};
	}

	const slice = fixtures.slice(0, maxFixtures);
	let passCount = 0;
	for (const fixture of slice) {
		if (evaluateSkillOnFixture(skill, fixture).passed) {
			passCount++;
		}
	}
	const failCount = slice.length - passCount;
	const passRate = passCount / slice.length;

	if (passRate >= minPassRate) {
		return {
			verdict: "keep",
			passCount,
			failCount,
			reason: `Skill regression keep: ${passCount}/${slice.length} fixtures passed (${(passRate * 100).toFixed(0)}%).`,
		};
	}

	return {
		verdict: "discard",
		passCount,
		failCount,
		reason: `Skill regression discard: ${passCount}/${slice.length} fixtures passed (need ${(minPassRate * 100).toFixed(0)}%).`,
	};
}
