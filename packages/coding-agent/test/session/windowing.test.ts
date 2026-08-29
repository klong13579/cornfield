import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@cornfield/agent";
import { applyWindowing, convertToLlm } from "../../src/session/messages";

// Minimal message builders (types are wide; tests assert behavior, not schema)
function userMsg(text: string, ts = 100): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as unknown as AgentMessage;
}
function assistantMsg(toolNames: string[], ts = 200, idSuffix = ""): AgentMessage {
	return {
		role: "assistant",
		content: toolNames.map(n => ({
			type: "toolCall",
			id: `tc-${n}${idSuffix}`,
			name: n,
			arguments: {},
		})),
		timestamp: ts,
	} as unknown as AgentMessage;
}
function toolResultMsg(toolId: string, text = "ok", ts = 300): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: toolId,
		content: [{ type: "text", text }],
		timestamp: ts,
	} as unknown as AgentMessage;
}
function developerMsg(text = "system rules", ts = 0): AgentMessage {
	return { role: "developer", content: [{ type: "text", text }], timestamp: ts } as unknown as AgentMessage;
}

/** One turn: user ask -> assistant toolCalls -> toolResults. */
function makeTurn(i: number): AgentMessage[] {
	const toolNames = i % 2 === 0 ? ["grep", "read"] : ["bash"];
	return [
		userMsg(`user question number ${i} about the login flow`, i * 10),
		assistantMsg(toolNames, i * 10 + 1, `-${i}`),
		...toolNames.map(n => toolResultMsg(`tc-${n}-${i}`, `result for ${n}`, i * 10 + 2)),
	];
}

describe("applyWindowing", () => {
	it("returns messages unchanged when disabled", () => {
		const msgs = [...makeTurn(0), ...makeTurn(1)];
		expect(applyWindowing(msgs, { enabled: false, keepRecentTurns: 10 })).toBe(msgs);
	});

	it("returns messages unchanged when turns fit inside the window", () => {
		const msgs = [...makeTurn(0), ...makeTurn(1), ...makeTurn(2)];
		const out = applyWindowing(msgs, { enabled: true, keepRecentTurns: 10 });
		expect(out).toHaveLength(msgs.length);
		expect(out[0].role).toBe("user");
	});

	it("archives turns older than the window, keeping recent turns verbatim", () => {
		const turns = Array.from({ length: 12 }, (_, i) => makeTurn(i)).flat();
		const msgs = [developerMsg(), ...turns];
		const out = applyWindowing(msgs, { enabled: true, keepRecentTurns: 10 });

		// developer + 2 archive notes + last 10 turns (even turns 4 msgs, odd 3 → 35)
		expect(out).toHaveLength(1 + 2 + 35);

		// archive notes are custom messages with a summary
		const archived = out.filter(m => m.role === "custom");
		expect(archived).toHaveLength(2);
		const text = String((archived[0] as { content: unknown }).content);
		expect(text).toContain("[会话归档");
		expect(text).toContain("user question number 0");
		expect(text).toContain("工具: grep, read");

		// recent turns intact: assistant toolCalls still paired with toolResults
		const kept = out.slice(3);
		expect(kept[0].role).toBe("user");
		expect(kept[0]).toHaveProperty("content", "user question number 2 about the login flow");
		const toolCalls = kept.filter(m => m.role === "assistant").length;
		const toolResults = kept.filter(m => m.role === "toolResult").length;
		expect(toolCalls).toBe(10);
		expect(toolResults).toBe(15); // turns 2-11: 5 even (2 results) + 5 odd (1 result)
	});

	it("keeps developer messages verbatim instead of archiving them", () => {
		const msgs = [developerMsg("hard rule"), ...makeTurn(0), ...makeTurn(1), ...makeTurn(2), ...makeTurn(3)];
		const out = applyWindowing(msgs, { enabled: true, keepRecentTurns: 2 });
		const dev = out.find(m => m.role === "developer");
		expect(dev).toBeDefined();
		expect(dev).toHaveProperty("content", [{ type: "text", text: "hard rule" }]);
	});

	it("never leaves a bare toolCall without its toolResult in the kept region", () => {
		const msgs = Array.from({ length: 8 }, (_, i) => makeTurn(i)).flat();
		const out = applyWindowing(msgs, { enabled: true, keepRecentTurns: 5 });
		// Every kept assistant message must have its toolResults right after.
		for (let i = 0; i < out.length; i++) {
			const m = out[i]!;
			if (m.role !== "assistant") continue;
			const calls = (m as { content: Array<{ type: string; id: string }> }).content.filter(
				b => b.type === "toolCall",
			);
			expect(calls.length).toBeGreaterThan(0);
			// walk forward until we've seen a toolResult for every call id
			const ids = new Set(calls.map(c => c.id));
			for (let j = i + 1; j < out.length && ids.size > 0; j++) {
				const next = out[j]!;
				if (next.role === "toolResult") {
					ids.delete(String((next as { toolCallId: string }).toolCallId));
				} else if (next.role === "user" || next.role === "custom") {
					break; // turn boundary without closing results — pairing broken
				}
			}
			expect(ids.size).toBe(0);
		}
	});

	describe("A/B canary: windowing on vs off over a long session", () => {
		function longSession(turns = 30): AgentMessage[] {
			const msgs: AgentMessage[] = [developerMsg("hard rules")];
			for (let i = 0; i < turns; i++) {
				msgs.push(userMsg(`turn ${i}: how do I fix the auth flow`, i * 100));
				msgs.push(assistantMsg(["grep", "read"], i * 100 + 1, `-${i}`));
				// large tool results (~2KB each) — the context rot source
				msgs.push(toolResultMsg(`tc-grep-${i}`, `match:${i}`.repeat(200), i * 100 + 2));
				msgs.push(toolResultMsg(`tc-read-${i}`, `content:${i}`.repeat(200), i * 100 + 3));
			}
			return msgs;
		}

		it("drops context size while preserving the recent tail and request validity", () => {
			const msgs = longSession(30);
			const baseline = convertToLlm(msgs);
			const windowed = convertToLlm(applyWindowing(msgs, { enabled: true, keepRecentTurns: 10 }));

			// 1. token-ish reduction: text payload shrinks substantially
			const size = (ms: typeof baseline) =>
				ms.reduce((acc, m) => {
					const c = m.content;
					return (
						acc +
						(typeof c === "string"
							? c.length
							: Array.isArray(c)
								? c.reduce((a, b) => a + (b.type === "text" ? b.text.length : 0), 0)
								: 0)
					);
				}, 0);
			const ratio = size(windowed) / size(baseline);
			expect(ratio).toBeLessThan(0.5); // >=50% payload reduction

			// 2. request stays valid: no assistant tool_use without its tool_result
			const toolUses = new Set<string>();
			for (const m of windowed) {
				if (m.role === "assistant") {
					const content = m.content as Array<{ type?: string; id?: string }>;
					if (Array.isArray(content)) {
						for (const b of content) if (b.type === "toolCall" && b.id) toolUses.add(b.id);
					}
				}
				if (m.role === "toolResult") toolUses.delete(String((m as { toolCallId: string }).toolCallId));
			}
			expect(toolUses.size).toBe(0);

			// 3. recent tail preserved verbatim (info safety for what the model is using)
			const tail = windowed.slice(-4); // last turn: user, assistant, 2 results
			expect(tail[0]).toHaveProperty("role", "user");
			expect(String((tail[0] as { content: unknown }).content)).toContain("turn 29");
			expect(tail.filter(m => m.role === "toolResult")).toHaveLength(2);
		});
	});
});
