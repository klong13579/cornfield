/**
 * The intercom edge of a supervised Child Session.
 *
 * Two things are pinned here:
 *   1. the env contract that gives a child its parent edge — written once in
 *      `child-session-metadata.ts` and read back in `intercom-extension/index.ts`,
 *   2. the probe that refuses to call a child "started" until the parent can
 *      actually see it on the broker.
 *
 * The roster is a stub: it is the one thing the probe deliberately does not own.
 */

import { describe, expect, test } from "bun:test";
import {
	ChildSessionEdgeMismatchError,
	createIntercomRegistrationProbe,
} from "../../src/intercom-extension/child-session-edge";
import { CHILD_SESSION_ENV, childSessionEnv } from "../../src/intercom-extension/child-session-metadata";
import type { SessionInfo } from "../../src/intercom-extension/types";

function sessionRow(overrides: Partial<SessionInfo> & { pid: number }): SessionInfo {
	return {
		id: `sess-${overrides.pid}`,
		cwd: "/tmp",
		model: "test/model",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
	};
}

/** A roster whose answer the test controls, counting how often it was asked. */
function controllableRoster() {
	const sessions: SessionInfo[] = [];
	let calls = 0;
	let error: Error | undefined;
	return {
		sessions,
		get calls() {
			return calls;
		},
		failWith(cause: Error) {
			error = cause;
		},
		roster: {
			async listSessions(): Promise<SessionInfo[]> {
				calls += 1;
				if (error) throw error;
				return [...sessions];
			},
		},
	};
}

describe("childSessionEnv", () => {
	test("renders the orchestrator edge under the five contract names", () => {
		const env = childSessionEnv({
			parentTarget: "coordinator",
			parentSessionId: "01a0a484",
			runId: "run-1",
			agent: "coding",
			index: "2",
		});

		expect(env).toEqual({
			[CHILD_SESSION_ENV.orchestratorTarget]: "coordinator",
			[CHILD_SESSION_ENV.orchestratorSessionId]: "01a0a484",
			[CHILD_SESSION_ENV.runId]: "run-1",
			[CHILD_SESSION_ENV.childAgent]: "coding",
			[CHILD_SESSION_ENV.childIndex]: "2",
		});
	});

	test("falls back to the parent target when no exact session id is known", () => {
		const env = childSessionEnv({ parentTarget: "coordinator", runId: "r", agent: "a", index: "0" });

		expect(env[CHILD_SESSION_ENV.orchestratorSessionId]).toBe("coordinator");
	});
});

describe("createIntercomRegistrationProbe", () => {
	test("resolves once the child appears on the roster under its parent", async () => {
		const roster = controllableRoster();
		roster.sessions.push(sessionRow({ pid: 4242, parentId: "parent-1" }));
		const probe = createIntercomRegistrationProbe({ roster: roster.roster, parentId: "parent-1", pollMs: 5 });

		await probe.awaitRegistration({
			sessionId: "child-1",
			bootId: 1,
			pid: 4242,
			signal: new AbortController().signal,
		});

		expect(roster.calls).toBe(1);
	});

	test("waits for the edge instead of accepting a child that is not yet visible", async () => {
		const roster = controllableRoster();
		const probe = createIntercomRegistrationProbe({ roster: roster.roster, parentId: "parent-1", pollMs: 5 });

		let resolved = false;
		const pending = probe
			.awaitRegistration({ sessionId: "child-1", bootId: 1, pid: 4242, signal: new AbortController().signal })
			.then(() => {
				resolved = true;
			});

		await Bun.sleep(60);
		expect(resolved).toBe(false);
		// A sibling of the same parent is not this child: the edge alone is not enough.
		roster.sessions.push(sessionRow({ pid: 9999, parentId: "parent-1" }));
		await Bun.sleep(60);
		expect(resolved).toBe(false);

		roster.sessions.push(sessionRow({ pid: 4242, parentId: "parent-1" }));
		await pending;

		expect(resolved).toBe(true);
	});

	test("fails immediately when the child registered under a different parent", async () => {
		const roster = controllableRoster();
		roster.sessions.push(sessionRow({ pid: 4242, parentId: "someone-else" }));
		const probe = createIntercomRegistrationProbe({
			roster: roster.roster,
			parentId: "parent-1",
			pollMs: 5,
			timeoutMs: 10_000,
		});

		const error = await probe
			.awaitRegistration({ sessionId: "child-1", bootId: 1, pid: 4242, signal: new AbortController().signal })
			.then(
				() => null,
				(cause: unknown) => cause as Error,
			);

		expect(error).toBeInstanceOf(ChildSessionEdgeMismatchError);
		expect(error?.message).toContain("someone-else");
		expect(error?.message).toContain("parent-1");
		// A child registers once, so a wrong edge is not a slow registration: it is
		// reported on the first observation rather than polled to the timeout.
		expect(roster.calls).toBe(1);
	});

	test("times out naming the child, its pid and the expected parent", async () => {
		const roster = controllableRoster();
		const probe = createIntercomRegistrationProbe({
			roster: roster.roster,
			parentId: "parent-1",
			pollMs: 5,
			timeoutMs: 60,
		});

		const error = await probe
			.awaitRegistration({ sessionId: "child-1", bootId: 1, pid: 4242, signal: new AbortController().signal })
			.then(
				() => null,
				(cause: unknown) => cause as Error,
			);

		expect(error?.message).toContain("child-1");
		expect(error?.message).toContain("4242");
		expect(error?.message).toContain("parent-1");
		expect(roster.calls).toBeGreaterThan(1);
	});

	test("surfaces the roster's own failure when the broker is unreachable", async () => {
		const roster = controllableRoster();
		roster.failWith(new Error("broker socket closed"));
		const probe = createIntercomRegistrationProbe({
			roster: roster.roster,
			parentId: "parent-1",
			pollMs: 5,
			timeoutMs: 60,
		});

		const error = await probe
			.awaitRegistration({ sessionId: "child-1", bootId: 1, pid: 4242, signal: new AbortController().signal })
			.then(
				() => null,
				(cause: unknown) => cause as Error,
			);

		expect(error?.message).toContain("broker socket closed");
	});

	test("stops waiting when the child is stopped", async () => {
		const roster = controllableRoster();
		const probe = createIntercomRegistrationProbe({
			roster: roster.roster,
			parentId: "parent-1",
			pollMs: 5,
			timeoutMs: 10_000,
		});
		const controller = new AbortController();

		const pending = probe.awaitRegistration({
			sessionId: "child-1",
			bootId: 1,
			pid: 4242,
			signal: controller.signal,
		});
		await Bun.sleep(20);
		controller.abort();

		const error = await pending.then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error?.message).toContain("was cancelled");
	});
});
