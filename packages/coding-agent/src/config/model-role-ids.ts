/**
 * Canonical built-in model role ids.
 *
 * This is a leaf module on purpose: it has no imports, so nothing can create a
 * load-order dependency through it.
 *
 * `settings-schema.ts` reads the id list while its module body evaluates, and the
 * settings singleton imports that schema. While the list lived in
 * `model-registry.ts` (which imports the singleton) that was a cycle, and the
 * module evaluated first decided whether the schema body could read it — loading
 * the registry first threw `ReferenceError: Cannot access 'MODEL_ROLE_IDS' before
 * initialization`, from a bare `import "./config/model-registry"`.
 *
 * `model-registry.ts` re-exports both names, so importers keep their path.
 */
export const MODEL_ROLE_IDS = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "task"] as const;

/**
 * A built-in role. Custom roles are strings from settings (`cycleOrder`,
 * `modelTags`, model routes) and are not part of this union.
 */
export type ModelRole = (typeof MODEL_ROLE_IDS)[number];
