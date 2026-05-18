/**
 * Pick regression fixtures relevant to a convention or skill (error-tool affinity).
 */
import type { RegressionFixtureStore } from "../storage/types";
import type { Convention, EvolvedSkill, RegressionFixture } from "../types";
import { REGRESSION_MAX_FIXTURES } from "./replay";

const TOOL_HINTS = ["bash", "read", "edit", "write", "grep", "search", "patch", "find"] as const;

function inferToolHint(text: string): string | undefined {
	const lower = text.toLowerCase();
	for (const tool of TOOL_HINTS) {
		if (lower.includes(tool)) return tool;
	}
	return undefined;
}

export async function selectFixturesForConvention(
	fixtureStore: RegressionFixtureStore,
	convention: Convention,
	limit = REGRESSION_MAX_FIXTURES,
): Promise<RegressionFixture[]> {
	const hint = inferToolHint(convention.content);
	const targeted = hint ? await fixtureStore.listForErrorTool(hint, limit * 2) : [];
	if (targeted.length >= 2) {
		return dedupeBySession(targeted).slice(0, limit);
	}
	const recent = await fixtureStore.listRecent(limit * 2);
	return dedupeBySession([...targeted, ...recent]).slice(0, limit);
}

export async function selectFixturesForSkill(
	fixtureStore: RegressionFixtureStore,
	skill: EvolvedSkill,
	limit = REGRESSION_MAX_FIXTURES,
): Promise<RegressionFixture[]> {
	const hint =
		skill.tools.find(t => TOOL_HINTS.includes(t as (typeof TOOL_HINTS)[number])) ??
		inferToolHint(`${skill.description} ${skill.taskPattern} ${skill.approach}`);
	const targeted = hint ? await fixtureStore.listForErrorTool(hint, limit * 2) : [];
	if (targeted.length >= 2) {
		return dedupeBySession(targeted).slice(0, limit);
	}
	const recent = await fixtureStore.listRecent(limit * 2);
	return dedupeBySession([...targeted, ...recent]).slice(0, limit);
}

function dedupeBySession(fixtures: RegressionFixture[]): RegressionFixture[] {
	const seen = new Set<string>();
	const out: RegressionFixture[] = [];
	for (const f of fixtures) {
		if (seen.has(f.sessionId)) continue;
		seen.add(f.sessionId);
		out.push(f);
	}
	return out;
}
