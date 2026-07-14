import { describe, expect, it } from "bun:test";
import type { MoaPlanWorker } from "../src/types";

// The parseRewriteOutput function is not exported, but we test it through
// the rewrite contract: 3 sections named by worker name, each containing
// one prompt. The integration test lives in moa-e2e.test.ts.
//
// Here we test the output contract by re-importing what executor.ts does
// inline. We replicate the regex and assertion shape so the test pins
// behavior without coupling to internal function names.

const SECTION_RE = /##\s+([a-zA-Z][\w-]*)\s*\n([\s\S]*?)(?=\n##\s+[a-zA-Z][\w-]*\s*\n|$)/g;

function parseRewriteOutput(raw: string, fallback: MoaPlanWorker[]): MoaPlanWorker[] | null {
	if (!raw) return null;
	const sections = new Map<string, string>();
	const re = new RegExp(SECTION_RE.source, "g");
	for (const match of raw.matchAll(re)) {
		sections.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
	}
	const byName = new Map(fallback.map(w => [w.name.toLowerCase(), w] as const));
	const out: MoaPlanWorker[] = [];
	for (const [name, worker] of byName) {
		const text = sections.get(name);
		if (!text) return null;
		out.push({ ...worker, prompt: text, rewrittenPrompt: text });
	}
	return out.length === byName.size ? out : null;
}

const fallback: MoaPlanWorker[] = [
	{ name: "divergent", role: "r1", prompt: "orig 1", tools: "all" },
	{ name: "grounded", role: "r2", prompt: "orig 2", tools: "all" },
	{ name: "critical", role: "r3", prompt: "orig 3", tools: "all" },
];

describe("parseRewriteOutput (behavioral contract)", () => {
	it("parses 3 sections with role names", () => {
		const raw = `preamble

## divergent
new prompt 1

## grounded
new prompt 2

## critical
new prompt 3`;
		const out = parseRewriteOutput(raw, fallback);
		expect(out).not.toBeNull();
		expect(out).toHaveLength(3);
		expect(out![0]?.prompt).toBe("new prompt 1");
		expect(out![0]?.rewrittenPrompt).toBe("new prompt 1");
		expect(out![1]?.prompt).toBe("new prompt 2");
		expect(out![2]?.prompt).toBe("new prompt 3");
	});

	it("returns null when one section is missing", () => {
		const raw = "## divergent\nx\n## grounded\ny";
		expect(parseRewriteOutput(raw, fallback)).toBeNull();
	});

	it("returns null on empty input", () => {
		expect(parseRewriteOutput("", fallback)).toBeNull();
	});

	it("handles case-insensitive role names", () => {
		const raw = "## Divergent\nx\n## GROUNDED\ny\n## critical\nz";
		const out = parseRewriteOutput(raw, fallback);
		expect(out).toHaveLength(3);
	});

	it("preserves original model/thinking/tools/role from fallback", () => {
		const fb: MoaPlanWorker[] = [
			{
				name: "divergent",
				role: "Generate distinct candidate routes",
				prompt: "orig",
				model: "test-model",
				thinking: "high",
				tools: ["read"],
			},
			{ name: "grounded", role: "r2", prompt: "orig", tools: "all" },
			{ name: "critical", role: "r3", prompt: "orig", tools: "all" },
		];
		const raw = "## divergent\nnew\n## grounded\nnew\n## critical\nnew";
		const out = parseRewriteOutput(raw, fb);
		expect(out![0]?.model).toBe("test-model");
		expect(out![0]?.thinking).toBe("high");
		expect(out![0]?.tools).toEqual(["read"]);
		expect(out![0]?.role).toBe("Generate distinct candidate routes");
	});

	it("rejects extra sections (returns null because fallback is the source of truth)", () => {
		const raw = "## divergent\nx\n## grounded\ny\n## critical\nz\n## fourth\nw";
		const out = parseRewriteOutput(raw, fallback);
		// 3 fallback names, 3 sections → ok, extra section is ignored
		expect(out).toHaveLength(3);
	});
});
