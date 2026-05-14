import { describe, expect, test } from "bun:test";
import { alibabaCodingPlanAuthorizationHeader } from "../src/utils/oauth/alibaba-coding-plan";

describe("alibabaCodingPlanAuthorizationHeader", () => {
	test("prefixes sk-sp keys with Bearer for DashScope coding compatibility", () => {
		expect(alibabaCodingPlanAuthorizationHeader("  sk-sp-abc  ")).toBe("Bearer sk-sp-abc");
	});

	test("passes classic keys through unchanged (trimmed)", () => {
		expect(alibabaCodingPlanAuthorizationHeader("  sk-not-sp  ")).toBe("sk-not-sp");
	});
});
