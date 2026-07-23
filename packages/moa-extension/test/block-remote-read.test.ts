import { describe, expect, it } from "bun:test";
import { createBlockRemoteReadExtension, isRemoteReadPath } from "../src/block-remote-read";

describe("isRemoteReadPath", () => {
	it("detects http(s) URLs", () => {
		expect(isRemoteReadPath("https://docs.openclaw.ai/")).toBe(true);
		expect(isRemoteReadPath("http://example.com/a")).toBe(true);
		expect(isRemoteReadPath("  https://x.com  ")).toBe(true);
	});

	it("allows local paths", () => {
		expect(isRemoteReadPath("packages/moa-extension/src/tco.ts")).toBe(false);
		expect(isRemoteReadPath("/Users/me/repo/README.md")).toBe(false);
		expect(isRemoteReadPath("./relative.ts")).toBe(false);
	});
});

describe("createBlockRemoteReadExtension", () => {
	it("blocks read of https URLs and allows local read", async () => {
		const handlers: Array<(e: { toolName: string; input: Record<string, unknown> }) => unknown> = [];
		const pi = {
			on(event: string, handler: (e: { toolName: string; input: Record<string, unknown> }) => unknown) {
				if (event === "tool_call") handlers.push(handler);
			},
		};
		createBlockRemoteReadExtension()(pi as never);
		expect(handlers).toHaveLength(1);
		const handler = handlers[0]!;

		const blocked = await handler({
			toolName: "read",
			input: { path: "https://openclaw.ai/" },
		});
		expect(blocked).toMatchObject({ block: true });
		expect(String((blocked as { reason?: string }).reason)).toMatch(/research_pack|Remote URL/i);

		const allowed = await handler({
			toolName: "read",
			input: { path: "src/index.ts" },
		});
		expect(allowed).toBeUndefined();

		const other = await handler({
			toolName: "search",
			input: { path: "https://evil.com" },
		});
		expect(other).toBeUndefined();
	});
});
