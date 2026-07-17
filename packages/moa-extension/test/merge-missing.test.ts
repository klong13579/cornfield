import { describe, expect, it } from "bun:test";
import { mergeMissingInputs } from "../src/merge-missing";
import type { TcoMissingInput } from "../src/tco";

function a(key: string, question: string, required = true): TcoMissingInput {
	return { key, question, type: "text", required, why_critical: "a", source: "discovery" };
}

function b(key: string, question: string, role: string, required = false): TcoMissingInput {
	return { key, question, type: "text", required, why_critical: "b", source: "worker", roles: [role] };
}

describe("mergeMissingInputs (once-right P2, A∪B)", () => {
	it("unions disjoint A and B", () => {
		const out = mergeMissingInputs([a("goal", "目标？")], [b("env", "环境？", "grounded")], { maxItems: 5 });
		expect(out.map(m => m.key).sort()).toEqual(["env", "goal"]);
	});

	it("dedupes by identical key, ORs required, keeps discovery source, unions roles", () => {
		const out = mergeMissingInputs(
			[a("budget", "预算上限？", false)],
			[b("budget", "预算是多少", "critical", true)],
			{ maxItems: 5 },
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.source).toBe("discovery");
		expect(out[0]?.required).toBe(true);
		expect(out[0]?.roles).toContain("critical");
	});

	it("dedupes synonymous questions even when keys differ (punctuation-insensitive)", () => {
		const out = mergeMissingInputs([a("budget_a", "预算多少？")], [b("cost", "预算多少", "grounded")], {
			maxItems: 5,
		});
		expect(out).toHaveLength(1);
	});

	it("accumulates roles from multiple B workers asking the same input", () => {
		const out = mergeMissingInputs(
			[],
			[b("format", "线上还是线下", "divergent"), b("format", "线上还是线下", "grounded")],
			{ maxItems: 5 },
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.roles?.sort()).toEqual(["divergent", "grounded"]);
	});

	it("orders required first, then discovery, then multi-role B, then single-role B", () => {
		const out = mergeMissingInputs(
			[a("goal", "目标？", true), a("scope", "范围？", false)],
			[
				b("multi", "多角色需要？", "divergent"),
				b("multi", "多角色需要？", "grounded"),
				b("single", "单角色需要？", "critical"),
			],
			{ maxItems: 5 },
		);
		expect(out[0]?.key).toBe("goal"); // required
		// remaining optional: discovery(scope) before multi-role(multi) before single
		const optionalOrder = out.slice(1).map(m => m.key);
		expect(optionalOrder).toEqual(["scope", "multi", "single"]);
	});

	it("caps at maxItems, keeping required items first", () => {
		const out = mergeMissingInputs(
			[a("r1", "必答1？", true), a("r2", "必答2？", true)],
			[b("o1", "可选1？", "divergent"), b("o2", "可选2？", "grounded")],
			{ maxItems: 2 },
		);
		expect(out).toHaveLength(2);
		expect(out.map(m => m.key).sort()).toEqual(["r1", "r2"]);
	});

	it("does not mutate inputs", () => {
		const av = [a("k", "q？")];
		const bv = [b("k", "q", "divergent")];
		const snapshotA = JSON.stringify(av);
		const snapshotB = JSON.stringify(bv);
		mergeMissingInputs(av, bv, { maxItems: 5 });
		expect(JSON.stringify(av)).toBe(snapshotA);
		expect(JSON.stringify(bv)).toBe(snapshotB);
	});
});
