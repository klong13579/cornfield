/**
 * Regression: config modules must load in any order.
 *
 * `settings-schema.ts` reads the built-in role ids while its module body
 * evaluates, and the settings singleton imports that schema. While the ids lived
 * in `model-registry.ts` (which imports the singleton) that was a load-order
 * cycle: whichever module was evaluated first decided whether the schema body
 * could read them. Loading the registry first threw
 * `ReferenceError: Cannot access 'MODEL_ROLE_IDS' before initialization` — from a
 * bare `import "./config/model-registry"`, not only from a test ordering.
 *
 * The shape that matters is "registry first", so this file imports it first, and
 * the subprocess case pins the same order in a fresh runtime (what an extension or
 * a new entry point sees).
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { MODEL_ROLE_IDS, MODEL_ROLES } from "../src/config/model-registry";
import { settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";

const packageRoot = path.resolve(import.meta.dir, "..");

describe("config module load order", () => {
	test("the registry and the settings singleton load with the registry imported first", () => {
		expect(MODEL_ROLE_IDS).toHaveLength(8);
		expect(Object.keys(MODEL_ROLES).sort()).toEqual([...MODEL_ROLE_IDS].sort());
		expect(settings).toBeDefined();
		// The schema body is where the role ids are read during module evaluation.
		expect(SETTINGS_SCHEMA["edit.autoRepair.modelRole"].values).toEqual([...MODEL_ROLE_IDS]);
	});

	test("a fresh runtime that touches the registry first does not throw", () => {
		const script = `
			import("./src/config/model-registry.ts")
				.then(m => console.log("ok", m.MODEL_ROLE_IDS.length))
				.catch(e => console.log("error", e.message));
		`;
		const result = Bun.spawnSync(["bun", "-e", script], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();

		expect(stderr).not.toContain("before initialization");
		expect(stdout).toContain("ok 8");
		expect(result.exitCode).toBe(0);
	});
});
