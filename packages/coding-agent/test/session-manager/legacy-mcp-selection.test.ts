import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@cornfield/coding-agent/session/session-manager";
import { buildSessionContext, parseSessionEntries } from "@cornfield/coding-agent/session/session-manager";

describe("legacy mcp_tool_selection session entries", () => {
	it("still parses and builds context without erroring", () => {
		const content = [
			JSON.stringify({
				type: "session",
				id: "old-sess",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			}),
			JSON.stringify({
				type: "mcp_tool_selection",
				id: "e1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				selectedToolNames: ["mcp__docs_search"],
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "e1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user", content: "hi" },
			}),
		].join("\n");

		// Lenient parse tolerates the now-unknown entry type.
		const entries = parseSessionEntries(content).filter(entry => entry.type !== "session") as SessionEntry[];
		expect(entries).toHaveLength(2);

		// Context building skips the orphaned entry instead of throwing,
		// and still surfaces the real conversation messages.
		const context = buildSessionContext(entries);
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]?.role).toBe("user");
		expect((context.messages[0] as { content: string }).content).toBe("hi");
	});
});
