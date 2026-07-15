import type { MoaQualityRoleWeights } from "./types";

export const V1_FALLBACK_WEIGHTS: MoaQualityRoleWeights = {
	required: 30,
	planSubstance: 20,
	openQuestions: 20,
	assumptions: 10,
	noRefusal: 20,
};

export const DEFAULT_ROLE_WEIGHTS = {
	divergent: {
		required: 25,
		planSubstance: 30,
		openQuestions: 15,
		assumptions: 10,
		noRefusal: 20,
	},
	grounded: {
		required: 30,
		planSubstance: 25,
		openQuestions: 20,
		assumptions: 15,
		noRefusal: 10,
	},
	critical: {
		required: 25,
		planSubstance: 15,
		openQuestions: 15,
		assumptions: 30,
		noRefusal: 15,
	},
} as const satisfies Record<string, MoaQualityRoleWeights>;

type KnownRoleKey = keyof typeof DEFAULT_ROLE_WEIGHTS;

const KNOWN_ROLE_KEYS: readonly KnownRoleKey[] = ["divergent", "grounded", "critical"];

function isKnownRoleKey(key: string): key is KnownRoleKey {
	return (KNOWN_ROLE_KEYS as readonly string[]).includes(key);
}

export function resolveRoleKey(name: string, role: string): KnownRoleKey | "fallback" {
	const normalizedName = name.toLowerCase();
	if (isKnownRoleKey(normalizedName)) {
		return normalizedName;
	}

	const normalizedRole = role.toLowerCase();
	for (const key of KNOWN_ROLE_KEYS) {
		if (normalizedRole.includes(key)) {
			return key;
		}
	}

	return "fallback";
}

export function resolveRoleWeights(
	name: string,
	role: string,
	overrides?: Partial<Record<string, Partial<MoaQualityRoleWeights>>>,
): MoaQualityRoleWeights {
	const roleKey = resolveRoleKey(name, role);
	const base = roleKey === "fallback" ? V1_FALLBACK_WEIGHTS : DEFAULT_ROLE_WEIGHTS[roleKey];
	const roleOverride = roleKey !== "fallback" ? overrides?.[roleKey] : undefined;

	if (!roleOverride) {
		return { ...base };
	}

	return {
		required: roleOverride.required ?? base.required,
		planSubstance: roleOverride.planSubstance ?? base.planSubstance,
		openQuestions: roleOverride.openQuestions ?? base.openQuestions,
		assumptions: roleOverride.assumptions ?? base.assumptions,
		noRefusal: roleOverride.noRefusal ?? base.noRefusal,
	};
}
