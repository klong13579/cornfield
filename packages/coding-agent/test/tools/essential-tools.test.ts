import { describe, expect, it } from "bun:test";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
	resolveLoadMode,
} from "@cornfield/coding-agent/tools/essential-tools";

describe("defaultLoadModeForToolName", () => {
	it("judges every essential-list name as essential", () => {
		for (const name of ESSENTIAL_BUILTIN_TOOL_NAMES) {
			expect(defaultLoadModeForToolName(name)).toBe("essential");
		}
	});

	it("judges names outside the essential list as discoverable", () => {
		for (const name of ["github", "browser", "notebook", "__unknown__", ""]) {
			expect(defaultLoadModeForToolName(name)).toBe("discoverable");
		}
	});
});

describe("resolveLoadMode", () => {
	it("falls through to the name-based default when loadMode is undeclared", () => {
		expect(resolveLoadMode("read", undefined)).toBe("essential");
		expect(resolveLoadMode("github", undefined)).toBe("discoverable");
	});

	it("lets an explicit declaration win over the essential default", () => {
		expect(resolveLoadMode("read", "discoverable")).toBe("discoverable");
		expect(resolveLoadMode("bash", "internal")).toBe("internal");
	});

	it("lets an explicit declaration win over the discoverable default", () => {
		expect(resolveLoadMode("github", "essential")).toBe("essential");
		expect(resolveLoadMode("notebook", "internal")).toBe("internal");
	});
});
