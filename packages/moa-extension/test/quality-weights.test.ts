import { describe, expect, it } from "bun:test";
import { DEFAULT_ROLE_WEIGHTS, resolveRoleWeights, V1_FALLBACK_WEIGHTS } from "../src/quality/weights";

describe("resolveRoleWeights", () => {
	it("maps divergent/grounded/critical by worker name", () => {
		expect(resolveRoleWeights("divergent", "").required).toBe(DEFAULT_ROLE_WEIGHTS.divergent.required);
		expect(resolveRoleWeights("critical", "").assumptions).toBe(DEFAULT_ROLE_WEIGHTS.critical.assumptions);
	});

	it("falls back to v1 uniform weights for unknown roles", () => {
		expect(resolveRoleWeights("worker-9", "extra perspective")).toEqual(V1_FALLBACK_WEIGHTS);
	});

	it("maps by role string token when name is unknown", () => {
		expect(resolveRoleWeights("worker-1", "critical analyst").assumptions).toBe(
			DEFAULT_ROLE_WEIGHTS.critical.assumptions,
		);
		expect(resolveRoleWeights("worker-2", "grounded constraints").required).toBe(
			DEFAULT_ROLE_WEIGHTS.grounded.required,
		);
	});

	it("applies partial overrides from settings", () => {
		const w = resolveRoleWeights("critical", "", { critical: { assumptions: 40 } });
		expect(w.assumptions).toBe(40);
		expect(w.planSubstance).toBe(DEFAULT_ROLE_WEIGHTS.critical.planSubstance);
	});
});
