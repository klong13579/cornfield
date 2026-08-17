/**
 * Deterministic tests for the intercom `ask` target-routing decision.
 *
 * The routing rule (see src/intercom-extension/ask-routing.ts):
 *   cwd > explicit to > parent (child mode) > missing.
 * These tests pin every branch and every precedence — including the edge
 * cases a tired maintainer would break: empty-string to/cwd, child metadata
 * present alongside an explicit target, and the parent-id fallback.
 */
import { describe, expect, test } from "bun:test";
import type { ChildOrchestratorMetadataLike } from "../../src/intercom-extension/ask-routing";
import { resolveAskRouting } from "../../src/intercom-extension/ask-routing";

const childWithSessionId: ChildOrchestratorMetadataLike = {
	orchestratorTarget: "main-omp",
	orchestratorSessionId: "main-session-id",
};
const childTargetOnly: ChildOrchestratorMetadataLike = {
	orchestratorTarget: "main-omp",
};

describe("resolveAskRouting", () => {
	describe("missing target", () => {
		test("no to, no cwd, no parent → missing", () => {
			expect(resolveAskRouting({ to: undefined, cwd: undefined, childMetadata: null })).toEqual({
				mode: "missing",
			});
		});

		test("empty-string to is treated as missing (same as the old falsy check)", () => {
			expect(resolveAskRouting({ to: "", cwd: undefined, childMetadata: null })).toEqual({ mode: "missing" });
		});

		test("empty-string cwd is treated as missing", () => {
			expect(resolveAskRouting({ to: undefined, cwd: "", childMetadata: null })).toEqual({ mode: "missing" });
		});
	});

	describe("cwd precedence", () => {
		test("cwd alone → cwd mode carries the non-empty cwd, no to filter", () => {
			expect(resolveAskRouting({ to: undefined, cwd: "/tmp/x", childMetadata: null })).toEqual({
				mode: "cwd",
				cwd: "/tmp/x",
				to: undefined,
			});
		});

		test("cwd beats explicit to → cwd mode carries to as a filter", () => {
			expect(resolveAskRouting({ to: "worker", cwd: "/tmp/x", childMetadata: null })).toEqual({
				mode: "cwd",
				cwd: "/tmp/x",
				to: "worker",
			});
		});

		test("cwd beats parent routing (child mode never hijacks a cwd ask)", () => {
			expect(resolveAskRouting({ to: undefined, cwd: "/tmp/x", childMetadata: childWithSessionId })).toEqual({
				mode: "cwd",
				cwd: "/tmp/x",
				to: undefined,
			});
		});
	});

	describe("explicit to precedence", () => {
		test("to alone → explicit", () => {
			expect(resolveAskRouting({ to: "worker", cwd: undefined, childMetadata: null })).toEqual({
				mode: "explicit",
				to: "worker",
			});
		});

		test("explicit to beats parent routing (child mode never hijacks an addressed ask)", () => {
			expect(resolveAskRouting({ to: "worker", cwd: undefined, childMetadata: childWithSessionId })).toEqual({
				mode: "explicit",
				to: "worker",
			});
		});
	});

	describe("parent routing (child mode)", () => {
		test("no to/cwd with parent → parent using orchestratorSessionId first", () => {
			expect(resolveAskRouting({ to: undefined, cwd: undefined, childMetadata: childWithSessionId })).toEqual({
				mode: "parent",
				parentTarget: "main-session-id",
			});
		});

		test("no orchestratorSessionId → parent falls back to the target name", () => {
			expect(resolveAskRouting({ to: undefined, cwd: undefined, childMetadata: childTargetOnly })).toEqual({
				mode: "parent",
				parentTarget: "main-omp",
			});
		});

		test("parent target containing empty-but-present sessionId still prefers it? (empty sessionId is not falsy-filtered)", () => {
			// The old code used `??`, so an empty-string sessionId WOULD win over
			// the target and drop the effective target to "". We keep that
			// behaviour verbatim (a real session id is never empty).
			expect(
				resolveAskRouting({
					to: undefined,
					cwd: undefined,
					childMetadata: { orchestratorTarget: "main-omp", orchestratorSessionId: "" },
				}),
			).toEqual({ mode: "parent", parentTarget: "" });
		});
	});
});
