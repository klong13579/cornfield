import { describe, expect, test } from "bun:test";
import { buildDependencyGraph, buildExecutionWaves, type DependencyGraphAgent, detectCycles } from "../../src/task/dag";

function agents(entries: Record<string, Partial<DependencyGraphAgent>>): Map<string, DependencyGraphAgent> {
	const m = new Map<string, DependencyGraphAgent>();
	for (const [name, a] of Object.entries(entries)) {
		m.set(name, { name, waitsFor: a.waitsFor ?? [], reportsTo: a.reportsTo ?? [] });
	}
	return m;
}

describe("buildDependencyGraph", () => {
	test("explicit waits_for produces direct edges", () => {
		const deps = buildDependencyGraph(
			agents({
				b: { waitsFor: ["a"] },
				a: {},
			}),
			{ agentOrder: ["a", "b"], chainByOrder: false },
		);
		expect(deps.get("b")).toEqual(new Set(["a"]));
		expect(deps.get("a")).toEqual(new Set());
	});

	test("reports_to is the inverse edge", () => {
		const deps = buildDependencyGraph(
			agents({
				a: { reportsTo: ["b"] },
				b: {},
			}),
			{ agentOrder: ["a", "b"], chainByOrder: false },
		);
		expect(deps.get("b")).toEqual(new Set(["a"]));
		expect(deps.get("a")).toEqual(new Set());
	});

	test("unknown dependency names are ignored", () => {
		const deps = buildDependencyGraph(
			agents({
				a: { waitsFor: ["missing"] },
			}),
			{ agentOrder: ["a"], chainByOrder: true },
		);
		expect(deps.get("a")).toEqual(new Set());
	});

	test("chains by declaration order only when no explicit deps and chainByOrder", () => {
		const chain = buildDependencyGraph(agents({ a: {}, b: {}, c: {} }), {
			agentOrder: ["a", "b", "c"],
			chainByOrder: true,
		});
		expect(chain.get("b")).toEqual(new Set(["a"]));
		expect(chain.get("c")).toEqual(new Set(["b"]));

		const noChain = buildDependencyGraph(agents({ a: {}, b: {}, c: {} }), {
			agentOrder: ["a", "b", "c"],
			chainByOrder: false,
		});
		expect(noChain.get("b")).toEqual(new Set());
	});

	test("explicit deps suppress declaration-order chaining", () => {
		const deps = buildDependencyGraph(agents({ a: {}, b: { waitsFor: ["a"] }, c: {} }), {
			agentOrder: ["a", "b", "c"],
			chainByOrder: true,
		});
		expect(deps.get("c")).toEqual(new Set());
	});
});

describe("detectCycles", () => {
	test("returns null for acyclic graphs", () => {
		const deps = buildDependencyGraph(agents({ a: {}, b: { waitsFor: ["a"] }, c: { waitsFor: ["b"] } }), {
			agentOrder: ["a", "b", "c"],
			chainByOrder: false,
		});
		expect(detectCycles(deps)).toBeNull();
	});

	test("detects a direct self-loop", () => {
		const deps = buildDependencyGraph(agents({ a: { waitsFor: ["a"] } }), {
			agentOrder: ["a"],
			chainByOrder: false,
		});
		expect(detectCycles(deps)).toEqual(["a"]);
	});

	test("detects a two-node cycle", () => {
		const deps = buildDependencyGraph(
			agents({
				a: { waitsFor: ["b"] },
				b: { waitsFor: ["a"] },
			}),
			{ agentOrder: ["a", "b"], chainByOrder: false },
		);
		expect(detectCycles(deps)?.sort()).toEqual(["a", "b"]);
	});

	test("detects a cycle hidden under an acyclic prefix", () => {
		const deps = buildDependencyGraph(
			agents({
				root: {},
				a: { waitsFor: ["root", "b"] },
				b: { waitsFor: ["a"] },
			}),
			{ agentOrder: ["root", "a", "b"], chainByOrder: false },
		);
		expect(detectCycles(deps)?.sort()).toEqual(["a", "b"]);
	});
});

describe("buildExecutionWaves", () => {
	test("empty graph yields no waves", () => {
		expect(buildExecutionWaves(new Map())).toEqual([]);
	});

	test("single node is a single wave", () => {
		const deps = new Map<string, Set<string>>([["a", new Set()]]);
		expect(buildExecutionWaves(deps)).toEqual([["a"]]);
	});

	test("independent nodes share one wave", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set()],
			["b", new Set()],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["a", "b"]]);
	});

	test("dependent nodes split across waves", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set()],
			["b", new Set(["a"])],
			["c", new Set(["b"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["a"], ["b"], ["c"]]);
	});

	test("diamond dependency collapses correctly", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set()],
			["b", new Set(["a"])],
			["c", new Set(["a"])],
			["d", new Set(["b", "c"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["a"], ["b", "c"], ["d"]]);
	});

	test("wave order is deterministic", () => {
		const deps = new Map<string, Set<string>>([
			["zeta", new Set()],
			["alpha", new Set()],
			["mid", new Set(["zeta"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["alpha", "zeta"], ["mid"]]);
	});

	test("throws on deadlock for graphs with cycles", () => {
		const deps = new Map<string, Set<string>>([
			["a", new Set(["b"])],
			["b", new Set(["a"])],
		]);
		expect(() => buildExecutionWaves(deps)).toThrow(/Deadlock/);
	});
});
