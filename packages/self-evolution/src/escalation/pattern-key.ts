import type { RegressionFixture } from "../types";

export function regressionPatternKey(fixture: RegressionFixture): string {
	const label = (fixture.dominantErrorPattern ?? fixture.dominantErrorTool ?? "unknown")
		.toLowerCase()
		.trim()
		.slice(0, 160);
	return `reg:${Bun.hash(label).toString(36)}`;
}

export function errorPatternKey(patternId: string): string {
	return `ep:${patternId}`;
}

export function regressionPatternKeyFromLabels(pattern?: string, tool?: string): string {
	const label = (pattern ?? tool ?? "unknown").toLowerCase().trim().slice(0, 160);
	return `reg:${Bun.hash(label).toString(36)}`;
}
