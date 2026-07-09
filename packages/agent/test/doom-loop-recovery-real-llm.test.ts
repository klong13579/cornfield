/**
 * Real-LLM end-to-end: send 143736 c31's exact user prompt to a real
 * model with recovery enabled. Two outcomes are valid:
 *
 *   1. The model stays coherent — recovery is a no-op, the test
 *      asserts the final user-visible message is non-trivial.
 *   2. The model enters doom — the recovery path fires (maxRetries=1,
 *      strip thinking, no-thinking retry), the test asserts the final
 *      user-visible message is NOT a doom echo.
 *
 * Either outcome proves the system works on a real LLM. The test
 * distinguishes the two by counting `message_end` events and
 * `errorMessage` on the final assistant message; it logs which path
 * was exercised so the run is informative even when it does not
 * trigger doom.
 *
 * The test does NOT override `streamFn` — the Agent's default
 * `streamSimple` performs the actual API call. This is the first
 * `packages/agent/test/*` test that hits the network.
 *
 * Opt-in: requires real provider auth. Run with `bun test <path>` —
 * the test is intentionally not gated behind E2E=1 because the
 * 143736 regression suite is part of the doom-loop safety net.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel, type TextContent } from "@oh-my-pi/pi-ai";

const PROMPT =
	"为什么一直在重复输出：All 78 channel tests pass. Run biome + related. （请直接回答，不要重复）";

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("");
}

describe("doom-loop recovery: real LLM (143736 prompt)", () => {
	let agent: Agent | undefined;
	const events: Array<{ type: string; message?: unknown }> = [];

	afterEach(() => {
		agent?.abort();
		agent = undefined;
		events.length = 0;
	});

	it(
		"final user-visible message is not a doom echo",
		async () => {
			agent = new Agent({
				initialState: {
					model: getBundledModel("alibaba-coding-plan", "glm-4.7"),
					systemPrompt: "你是一个简洁的中文助手。用1-2句话回答。",
					messages: [],
					tools: [],
				},
				doomLoop: {
					enabled: true,
					// Realistic thresholds; the 143736 case had ~17K chars of
					// repeated "All 78..." thinking, well past all of these.
					thinking: { minChars: 5000, uniqueRatioThreshold: 0.15, minPhraseRepeat: 200, minPhraseLength: 20 },
					text: { minChars: 500, ngramSize: 60, minNgramRepeat: 4 },
					maxThinkingChars: 16384,
					maxRetries: 1,
				},
			});
			agent.subscribe(e => {
				events.push(e as { type: string; message?: unknown });
			});

			const t0 = Date.now();
			await agent.prompt(PROMPT);
			const elapsed = Date.now() - t0;

			// 1. Lifecycle: agent_end fired.
			const eventTypes = events.map(e => e.type);
			expect(eventTypes).toContain("agent_start");
			expect(eventTypes).toContain("agent_end");

			// 2. At most 2 assistant message_end events (1 attempt + 1 retry).
			const assistantEnds = events
				.filter(e => e.type === "message_end")
				.map(e => (e as { message?: AssistantMessage }).message)
				.filter((m): m is AssistantMessage => !!m && m.role === "assistant");
			expect(assistantEnds.length).toBeLessThanOrEqual(2);

			// 3. Final assistant message in state.messages.
			const finalAssistant = agent.state.messages.find(m => m.role === "assistant") as
				| AssistantMessage
				| undefined;
			expect(finalAssistant).toBeDefined();
			if (!finalAssistant) return;

			const finalText = extractText(finalAssistant);
			const finalThinking = finalAssistant.content
				.filter(c => c.type === "thinking")
				.map(c => (c as { thinking: string }).thinking)
				.join("");

			// 4. The doom phrase must not dominate. 143736 had 277× in
			// thinking; even one stray echo in a multi-turn context is
			// suspicious. We allow up to 2 (defensive against coincidental
			// word use) but flag anything more in the run log.
			const textEchoes = (finalText.match(/All 78 channel tests pass/g) ?? []).length;
			const thinkingEchoes = (finalThinking.match(/All 78 channel tests pass/g) ?? []).length;
			expect(textEchoes).toBeLessThan(3);
			expect(thinkingEchoes).toBeLessThan(10);

			// 5. The final response is meaningful.
			expect(finalText.length).toBeGreaterThan(5);

			// 6. Path taken: clean first try, or doom + recovery. Both
			// are valid outcomes. The path is informational, not asserted.
			const didRecover = assistantEnds.length === 2;
			const firstEnded = assistantEnds[0];
			const path = didRecover
				? `recovered (retry succeeded; first was ${firstEnded?.stopReason}${firstEnded?.errorMessage ? ` / ${firstEnded.errorMessage}` : ""})`
				: `clean (no recovery needed; stopReason=${finalAssistant.stopReason})`;

			// biome-ignore lint/suspicious/noConsoleLog: run-summary for the user
			console.log(
				`[real-llm] model=alibaba-coding-plan/glm-4.7 elapsed=${elapsed}ms path=${path}`,
			);
			// biome-ignore lint/suspicious/noConsoleLog: run-summary for the user
			console.log(
				`[real-llm] finalTextLen=${finalText.length} finalThinkingLen=${finalThinking.length} textEchoes=${textEchoes} thinkingEchoes=${thinkingEchoes}`,
			);
			// biome-ignore lint/suspicious/noConsoleLog: run-summary for the user
			console.log(`[real-llm] finalText=${JSON.stringify(finalText.slice(0, 200))}`);
			// biome-ignore lint/suspicious/noConsoleLog: diagnostic dump
			console.log(`[real-llm] event types: ${eventTypes.join(",")}`);
			for (let i = 0; i < assistantEnds.length; i++) {
				const ae = assistantEnds[i];
				const aeText = extractText(ae);
				const aeThinking = ae.content.filter(c => c.type === "thinking").map(c => (c as { thinking: string }).thinking).join("");
				// biome-ignore lint/suspicious/noConsoleLog: diagnostic dump
				console.log(`[real-llm] attempt ${i}: stopReason=${ae.stopReason} textLen=${aeText.length} thinkingLen=${aeThinking.length} err=${ae.errorMessage ?? ""}`);
				if (aeText) // biome-ignore lint/suspicious/noConsoleLog: diagnostic dump
				console.log(`[real-llm] attempt ${i} text: ${JSON.stringify(aeText.slice(0, 200))}`);
				if (aeThinking) // biome-ignore lint/suspicious/noConsoleLog: diagnostic dump
				console.log(`[real-llm] attempt ${i} thinking[0..200]: ${JSON.stringify(aeThinking.slice(0, 200))}`);
			}
		},
		{ timeout: 90_000 },
	);
});
