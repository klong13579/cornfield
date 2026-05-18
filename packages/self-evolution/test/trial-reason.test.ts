import { describe, expect, test } from "bun:test";
import {
	formatRegressionTrialReason,
	parseReplayBackendFromTrialReason,
	parseToolchainTagFromTrialReason,
} from "../src/regression/trial-reason";

describe("trial-reason", () => {
	test("formats replay and toolchain tags", () => {
		const reason = formatRegressionTrialReason({
			replayBackend: "subagent",
			toolChainTag: "overturn",
			body: "Replay repeated failing tool chain",
		});
		expect(reason).toContain("[replay:subagent]");
		expect(reason).toContain("[toolchain:overturn]");
	});

	test("does not double-tag when body already tagged", () => {
		const body = "[replay:llm] already tagged";
		expect(formatRegressionTrialReason({ replayBackend: "heuristic", body })).toBe(body);
	});

	test("parses tags back from reason", () => {
		const reason = "[replay:subagent] [toolchain:confirm] ok";
		expect(parseReplayBackendFromTrialReason(reason)).toBe("subagent");
		expect(parseToolchainTagFromTrialReason(reason)).toBe("confirm");
	});
});
