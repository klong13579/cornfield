import { describe, expect, it, vi } from "bun:test";
import { MULTIPLEXERS, type Multiplexer, resolveLspCommand } from "../src/lsp/multiplexer";

/**
 * Unit tests for the command resolver that decides how a configured language
 * server is spawned.
 *
 * The resolver takes its multiplexer list as an argument, so these tests inject
 * fakes instead of mocking the drey/lspmux modules: the contract under test is
 * "first accepting multiplexer wins, everything else degrades to a direct
 * spawn".
 */

function accepting(name: string, wrapped: { command: string; args: string[] }): Multiplexer {
	return {
		name,
		supports: () => true,
		wrap: async () => ({ ...wrapped }),
	};
}

function declining(name: string): Multiplexer {
	return {
		name,
		supports: () => true,
		wrap: async (command, args) => ({ command, args }),
	};
}

function exploding(name: string): Multiplexer {
	return {
		name,
		supports: () => true,
		wrap: async () => {
			throw new Error(`${name} exploded`);
		},
	};
}

describe("resolveLspCommand", () => {
	it("returns the first multiplexer that accepts", async () => {
		const resolved = await resolveLspCommand(
			"typescript-language-server",
			["--stdio"],
			[
				accepting("drey", { command: "/fake/bin/drey", args: ["serve", "typescript"] }),
				accepting("lspmux", { command: "/fake/bin/lspmux", args: [] }),
			],
		);
		expect(resolved).toEqual({ command: "/fake/bin/drey", args: ["serve", "typescript"] });
	});

	it("falls through to the next multiplexer when one declines", async () => {
		const resolved = await resolveLspCommand(
			"rust-analyzer",
			[],
			[declining("drey"), accepting("lspmux", { command: "/fake/bin/lspmux", args: [] })],
		);
		expect(resolved).toEqual({ command: "/fake/bin/lspmux", args: [] });
	});

	it("falls through to the next multiplexer when one throws", async () => {
		const resolved = await resolveLspCommand(
			"rust-analyzer",
			[],
			[exploding("drey"), accepting("lspmux", { command: "/fake/bin/lspmux", args: [] })],
		);
		expect(resolved).toEqual({ command: "/fake/bin/lspmux", args: [] });
	});

	it("spawns directly when every multiplexer declines", async () => {
		const resolved = await resolveLspCommand(
			"bash-language-server",
			["--stdio"],
			[declining("drey"), declining("lspmux")],
		);
		expect(resolved).toEqual({ command: "bash-language-server", args: ["--stdio"] });
	});

	it("spawns directly when every multiplexer throws", async () => {
		const resolved = await resolveLspCommand(
			"typescript-language-server",
			["--stdio"],
			[exploding("drey"), exploding("lspmux")],
		);
		expect(resolved).toEqual({ command: "typescript-language-server", args: ["--stdio"] });
	});

	it("does not consult a multiplexer that does not support the command", async () => {
		const wrap = vi.fn();
		const unsupporting: Multiplexer = { name: "never", supports: () => false, wrap };
		await resolveLspCommand("rust-analyzer", [], [unsupporting]);
		expect(wrap).not.toHaveBeenCalled();
	});

	it("normalizes absent args to an empty list", async () => {
		expect(await resolveLspCommand("bash-language-server", undefined, [])).toEqual({
			command: "bash-language-server",
			args: [],
		});
	});

	it("passes an unknown server straight through with the real list", async () => {
		// Deterministic regardless of what is installed: no multiplexer claims it.
		expect(await resolveLspCommand("bash-language-server", ["--stdio"])).toEqual({
			command: "bash-language-server",
			args: ["--stdio"],
		});
	});
});

describe("MULTIPLEXERS routing", () => {
	const byName = new Map(MULTIPLEXERS.map(multiplexer => [multiplexer.name, multiplexer]));

	it("routes typescript-language-server to drey only", () => {
		expect(byName.get("drey")?.supports("typescript-language-server")).toBe(true);
		expect(byName.get("lspmux")?.supports("typescript-language-server")).toBe(false);
	});

	it("routes rust-analyzer to lspmux only", () => {
		expect(byName.get("lspmux")?.supports("rust-analyzer")).toBe(true);
		expect(byName.get("drey")?.supports("rust-analyzer")).toBe(false);
	});
});
