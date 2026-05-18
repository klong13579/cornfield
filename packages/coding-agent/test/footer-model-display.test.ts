/**
 * Footer and status-line model segment use the same `provider/model-id` convention as CLI and session APIs.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { renderSegment, type SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as piUtils from "@oh-my-pi/pi-utils";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function minimalSession(mock: unknown): AgentSession {
	return mock as AgentSession;
}

function minimalSegmentCtx(model: Model | undefined, thinkingLevel: Effort | undefined): SegmentContext {
	return {
		session: {
			state: { model, thinkingLevel },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {
			path: { abbreviate: false, maxLength: 40, stripWorkPrefix: false },
		},
		planMode: null,
		loopMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: model?.contextWindow ?? 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
	};
}

describe("CLI footer and status-line model label", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const width = 200;

	const baseModel = {
		provider: "alibaba-coding-plan",
		id: "qwen3.6-plus",
		contextWindow: 1_000_000,
	} as Model;

	describe("FooterComponent model display", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("right-aligns provider/model-id when a model is active", () => {
			vi.spyOn(piUtils, "getProjectDir").mockReturnValue("/tmp/omp-footer-test");

			const session = minimalSession({
				state: {
					model: baseModel,
					thinkingLevel: undefined,
				},
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
				modelRegistry: { isUsingOAuth: () => false },
			});

			const footer = new FooterComponent(session);
			const lines = footer.render(width);
			expect(lines.length).toBeGreaterThanOrEqual(2);

			const statsLine = stripAnsi(lines[1]!);
			expect(statsLine.endsWith(`${baseModel.provider}/${baseModel.id}`)).toBe(true);
			expect(statsLine).not.toContain("no-model");
		});

		it("appends thinking level after provider/model-id when reasoning is enabled", () => {
			vi.spyOn(piUtils, "getProjectDir").mockReturnValue("/tmp/omp-footer-test");

			const modelWithThinking = {
				...baseModel,
				thinking: { mode: "effort", minLevel: "minimal", maxLevel: "high" },
			} as Model;

			const session = minimalSession({
				state: {
					model: modelWithThinking,
					thinkingLevel: Effort.Medium,
				},
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
				modelRegistry: { isUsingOAuth: () => false },
			});

			const footer = new FooterComponent(session);
			const statsLine = stripAnsi(footer.render(width)[1]!);
			expect(statsLine.endsWith(`${baseModel.provider}/${baseModel.id} • ${Effort.Medium}`)).toBe(true);
		});

		it("shows no-model when agent has no resolved model", () => {
			vi.spyOn(piUtils, "getProjectDir").mockReturnValue("/tmp/omp-footer-test");

			const session = minimalSession({
				state: { model: undefined, thinkingLevel: undefined },
				sessionManager: { getEntries: () => [] },
				getContextUsage: () => undefined,
				modelRegistry: { isUsingOAuth: () => false },
			});

			const footer = new FooterComponent(session);
			const statsLine = stripAnsi(footer.render(width)[1]!);
			expect(statsLine.endsWith("no-model")).toBe(true);
		});
	});

	describe("Status line model segment", () => {
		it("shows provider/model-id matching the footer convention", () => {
			const rendered = renderSegment("model", minimalSegmentCtx(baseModel, undefined));
			expect(rendered.visible).toBe(true);
			const plain = stripAnsi(rendered.content);
			expect(plain).toContain(`${baseModel.provider}/${baseModel.id}`);
			expect(plain).not.toContain("no-model");
		});

		it("shows no-model when there is no resolved model", () => {
			const rendered = renderSegment("model", minimalSegmentCtx(undefined, undefined));
			expect(rendered.visible).toBe(true);
			expect(stripAnsi(rendered.content)).toContain("no-model");
		});
	});
});
