/**
 * Regression probe for the `settings-schema ↔ model-registry` TDZ cycle
 * (issue 29). A bare static import of `config/model-registry` must not
 * throw `Cannot access 'MODEL_ROLE_IDS' before initialization`. If anyone
 * re-introduces the cycle, this file fails fast at module load time.
 *
 * Keep this file minimal — no business code, no extra imports, no mocks.
 *
 * --- Division of labor with `config-module-init-order.test.ts` (3d9ddde07f) ---
 *
 * The other regression (`config-module-init-order.test.ts`) covers the **full
 * loop** including the `settings` singleton + `SETTINGS_SCHEMA` body — i.e. it
 * triggers `settings → settings-schema → model-registry` plus a fresh-runtime
 * subprocess case. It pins the loop on both sides.
 *
 * This probe is intentionally narrower: **only `MODEL_ROLE_IDS`** is imported,
 * so it exercises the half-cycle that does not go through the `settings`
 * singleton. The minimal-import shape matters because the cycle's failure
 * mode is order-dependent — whichever module evaluates first decides whether
 * the schema body can read the ids. By importing nothing else, this file
 * pins the failure mode regardless of where future tests sit in the import
 * graph. Anyone reverting to "我 import 了别的兄弟模块就能不拑" cannot use
 * the other test as cover.
 *
 * Both belong. Removing either would leave a path where the cycle can be
 * re-introduced without either test catching it.
 */
import { describe, expect, it } from "bun:test";
import { MODEL_ROLE_IDS } from "@cornfield/coding-agent/config/model-registry";

describe("settings-schema ↔ model-registry TDZ (issue 29)", () => {
	it("static import of model-registry does not throw TDZ", () => {
		expect(MODEL_ROLE_IDS.length).toBeGreaterThan(0);
	});
});
