/**
 * End-to-end settings round-trip for the length-stall circuit group.
 *
 * Mirrors `streaming-settings-e2e.test.ts` for doom-loop: confirms
 * `agent.lengthStall.*` survives `Settings.isolated()` + `getGroup("agent")`
 * so the wiring
 *
 *     user config.yml -> SETTINGS_SCHEMA -> Settings -> resolveLengthStallConfig -> Agent.lengthStall
 *
 * is whole.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * `Settings.getGroup(prefix)` strips the prefix and returns the remaining
 * suffix verbatim — flat keys, not nested. So `g["lengthStall.enabled"]` is
 * the right accessor, not `g.lengthStall.enabled`.
 */
type AgentGroup = {
	"lengthStall.enabled": boolean;
	"lengthStall.maxConsecutive": number;
};

function asAgent(g: Record<string, unknown>): AgentGroup {
	return g as unknown as AgentGroup;
}

describe("agent.lengthStall settings end-to-end", () => {
	it("default settings have the expected length-stall defaults", () => {
		const s = Settings.isolated();
		const g = asAgent(s.getGroup("agent"));
		expect(g["lengthStall.enabled"]).toBe(true);
		expect(g["lengthStall.maxConsecutive"]).toBe(3);
	});

	it("enabled:false and custom maxConsecutive round-trip", () => {
		const s = Settings.isolated({
			"agent.lengthStall.enabled": false,
			"agent.lengthStall.maxConsecutive": 5,
		});
		const g = asAgent(s.getGroup("agent"));
		expect(g["lengthStall.enabled"]).toBe(false);
		expect(g["lengthStall.maxConsecutive"]).toBe(5);
	});

	it("settings.get returns schema defaults and overrides", () => {
		const defaults = Settings.isolated();
		expect(defaults.get("agent.lengthStall.enabled")).toBe(true);
		expect(defaults.get("agent.lengthStall.maxConsecutive")).toBe(3);

		const overridden = Settings.isolated({
			"agent.lengthStall.enabled": false,
			"agent.lengthStall.maxConsecutive": 1,
		});
		expect(overridden.get("agent.lengthStall.enabled")).toBe(false);
		expect(overridden.get("agent.lengthStall.maxConsecutive")).toBe(1);
	});
});
