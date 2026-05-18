import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SourceMeta } from "../src/capability/types";
import * as mcpClient from "../src/mcp/client";
import { MCPManager } from "../src/mcp/manager";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const testSource: SourceMeta = {
	provider: "mcp",
	providerName: "MCP",
	path: "/tmp/.mcp.json",
	level: "project",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCP startup window", () => {
	it("connectServers returns before slow handshakes finish", async () => {
		const slowConnection = createMockConnection(
			{ tools: {} },
			createMockTransport(new Map([["tools/list", [{ tools: [] }]]])),
		);

		vi.spyOn(mcpClient, "connectToServer").mockImplementation(
			() =>
				new Promise(resolve => {
					setTimeout(() => resolve(slowConnection), 60_000);
				}),
		);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const manager = new MCPManager("/tmp");
		const started = Date.now();
		const result = await manager.connectServers(
			{ slow: { type: "stdio", command: "sleep", args: ["999"] } },
			{ slow: testSource },
		);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(3_000);
		expect(result.tools).toEqual([]);
		expect(result.errors.size).toBe(0);

		await manager.disconnectAll();
	});
});
