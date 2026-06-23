import { describe, expect, it } from "bun:test";
import { resolveAgentCwd } from "../src/scheduler/cli-commands";

type Cfg = Parameters<typeof resolveAgentCwd>[1];

describe("resolveAgentCwd", () => {
	const cfg: Cfg = {
		channels: {
			dingtalk: {
				accounts: {
					hr: { agentDir: "/Users/test/OMP-workspace-test/hr3" },
					opencode: { agentDir: "/Users/test/OMP-workspace-test/omp-atomix" },
					"ops/hr": { agentDir: "/Users/test/.omp/agents/ops/hr" },
					// Account with no agentDir (only credentials, no workspace)
					credentials_only: { agentDir: undefined as unknown as string },
				},
			},
		},
	};

	it("returns the agentDir for a known account", () => {
		expect(resolveAgentCwd("hr", cfg)).toBe("/Users/test/OMP-workspace-test/hr3");
	});

	it("returns the agentDir for accounts with slash in their key (ops/hr)", () => {
		expect(resolveAgentCwd("ops/hr", cfg)).toBe("/Users/test/.omp/agents/ops/hr");
	});

	it("returns undefined for an account that exists but has no agentDir", () => {
		// Task would fall back to gateway cwd with a warning. The resolver
		// must NOT throw or return the empty string — undefined is the
		// explicit "fall back" signal that cronRun checks for.
		expect(resolveAgentCwd("credentials_only", cfg)).toBeUndefined();
	});

	it("returns undefined for an accountId that is not in the accounts map", () => {
		expect(resolveAgentCwd("never-configured", cfg)).toBeUndefined();
	});

	it("returns undefined when dingtalk channel is missing entirely", () => {
		expect(resolveAgentCwd("hr", { channels: {} })).toBeUndefined();
	});

	it("returns undefined when the channels block is missing entirely", () => {
		expect(resolveAgentCwd("hr", {})).toBeUndefined();
	});

	it("returns undefined when the accounts map is undefined", () => {
		expect(resolveAgentCwd("hr", { channels: { dingtalk: {} } } as unknown as Cfg)).toBeUndefined();
	});

	it("does not silently coerce an empty-string agentDir into a cwd", () => {
		// An empty string is technically a valid path (relative to cwd).
		// The resolver returns whatever is stored; the contract is just
		// "return the field if present, undefined if absent". Pinning the
		// current behaviour here so a future nullish-coalesce change can't
		// accidentally start passing "" to Bun.spawn.
		const cfg2: Cfg = {
			channels: { dingtalk: { accounts: { broken: { agentDir: "" } } } },
		};
		expect(resolveAgentCwd("broken", cfg2)).toBe("");
	});

	it("does not look up across other channel types (only dingtalk is consulted)", () => {
		// The current resolver is dingtalk-specific because cron task
		// bindings today come from the dingtalk robot. If other channel
		// types later gain accountId-style bindings, this test will
		// fail and force a deliberate conversation about the lookup
		// surface, rather than silently reading from a future channel
		// key.
		const cfg3: Cfg = {
			channels: {
				dingtalk: { accounts: {} },
				// biome-ignore lint/suspicious/noExplicitAny: synthetic future-channel test fixture
				feishu: { accounts: { hr: { agentDir: "/wrong/path" } } } as any,
			},
		};
		expect(resolveAgentCwd("hr", cfg3)).toBeUndefined();
	});
});
