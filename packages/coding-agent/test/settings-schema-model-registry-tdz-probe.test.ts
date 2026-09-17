/**
 * Regression probe for the `settings-schema ↔ model-registry` TDZ cycle
 * (issue 29). A bare static import of `config/model-registry` must not
 * throw `Cannot access 'MODEL_ROLE_IDS' before initialization`. If anyone
 * re-introduces the cycle, this file fails fast at module load time.
 *
 * Keep this file minimal — no business code, no extra imports, no mocks.
 */
import { describe, expect, it } from "bun:test";
import { MODEL_ROLE_IDS } from "@cornfield/coding-agent/config/model-registry";

describe("settings-schema ↔ model-registry TDZ (issue 29)", () => {
	it("static import of model-registry does not throw TDZ", () => {
		expect(MODEL_ROLE_IDS.length).toBeGreaterThan(0);
	});
});
