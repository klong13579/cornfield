/**
 * Directed Acyclic Graph operations for multi-agent dependency orchestration.
 *
 * Extracted from the retired `@oh-my-pi/swarm-extension` package (2026-08-14)
 * and genericized: the three functions only depend on node names and explicit
 * dependency edges, so future orchestration layers (see the kanban design in
 * `docs/todo/multi-agent-orchestration-design.md`) can build waves from any
 * dependency source without inheriting the swarm YAML schema.
 *
 * Semantics preserved from the original:
 * - `waits_for` declarations add a direct edge (A waits for B → edge A→B)
 * - `reports_to` is the inverse edge (A reports to B → B depends on A)
 * - when no explicit edge exists and chaining is enabled, agents run in
 *   declaration order (each waits for its predecessor)
 */

/**
 * Minimal agent shape the graph builder needs.
 */
export interface DependencyGraphAgent {
	name: string;
	waitsFor: readonly string[];
	reportsTo: readonly string[];
}

export interface DependencyGraphOptions {
	/** Agent declaration order, used for implicit chaining. */
	agentOrder: readonly string[];
	/**
	 * Whether to chain agents by declaration order when no explicit dependency
	 * exists. Corresponds to swarm's `pipeline`/`sequential` modes; parallel
	 * mode sets this to false.
	 */
	chainByOrder: boolean;
}

/**
 * Build a dependency map: node name → set of nodes it depends on.
 */
export function buildDependencyGraph(
	agents: ReadonlyMap<string, DependencyGraphAgent>,
	options: DependencyGraphOptions,
): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();

	for (const name of agents.keys()) {
		deps.set(name, new Set());
	}

	// Explicit waits_for
	for (const [name, agent] of agents) {
		for (const dep of agent.waitsFor) {
			if (deps.has(dep)) {
				deps.get(name)!.add(dep);
			}
		}
	}

	// reports_to implies the target waits for the reporter
	for (const [name, agent] of agents) {
		for (const target of agent.reportsTo) {
			if (deps.has(target)) {
				deps.get(target)!.add(name);
			}
		}
	}

	// With no explicit deps, chain by declaration order
	if (options.chainByOrder && !hasExplicitDeps(deps)) {
		for (let i = 1; i < options.agentOrder.length; i++) {
			deps.get(options.agentOrder[i])!.add(options.agentOrder[i - 1]);
		}
	}

	return deps;
}

function hasExplicitDeps(deps: Map<string, Set<string>>): boolean {
	for (const s of deps.values()) {
		if (s.size > 0) return true;
	}
	return false;
}

/**
 * Detect cycles in the dependency graph.
 * Returns the names of nodes involved in cycles, or null if acyclic.
 */
export function detectCycles(deps: Map<string, Set<string>>): string[] | null {
	// Kahn's algorithm: if topological sort doesn't include all nodes, cycles exist
	const inDegree = new Map<string, number>();
	const forward = new Map<string, string[]>(); // dependency → its dependents

	for (const [node, nodeDeps] of deps) {
		inDegree.set(node, nodeDeps.size);
		for (const dep of nodeDeps) {
			const list = forward.get(dep) ?? [];
			list.push(node);
			forward.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) queue.push(node);
	}

	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const dependent of forward.get(node) ?? []) {
			const newDegree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	if (sorted.length < deps.size) {
		return [...deps.keys()].filter(k => !sorted.includes(k));
	}

	return null;
}

/**
 * Build execution waves from a dependency graph via topological sort.
 *
 * Each wave contains nodes whose dependencies are all in earlier waves.
 * Nodes within a wave can execute in parallel.
 */
export function buildExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave: string[] = [];

		for (const node of remaining) {
			const nodeDeps = deps.get(node)!;
			let ready = true;
			for (const dep of nodeDeps) {
				if (!completed.has(dep)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				wave.push(node);
			}
		}

		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${[...remaining].join(", ")}] cannot make progress. This indicates a bug in cycle detection.`,
			);
		}

		// Sort for deterministic execution order
		wave.sort();

		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}

		waves.push(wave);
	}

	return waves;
}
