import { beforeEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@cornfield/coding-agent/registry/agent-registry";
import type { AgentSession } from "@cornfield/coding-agent/session/agent-session";

const fakeSession = {} as AgentSession;

describe("AgentRegistry (upgraded, parked/activity/expected CAS)", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	test("registers with defaults and emits registered", () => {
		let eventType: string | undefined;
		registry.onChange(e => {
			eventType = e.type;
		});
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		expect(ref.status).toBe("running");
		expect(eventType).toBe("registered");
	});

	test("setStatus transitions running→idle→parked and clears activity", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		registry.setActivity("a", "working on X");
		expect(ref.activity).toBe("working on X");
		expect(registry.setStatus("a", "idle")).toBe(true);
		expect(ref.status).toBe("idle");
		expect(ref.activity).toBeUndefined();
		expect(registry.setStatus("a", "parked")).toBe(true);
		expect(ref.status).toBe("parked");
	});

	test("setActivity is dropped for non-running refs", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		registry.setStatus("a", "idle");
		registry.setActivity("a", "stale work");
		expect(ref.activity).toBeUndefined();
	});

	test("setActivity strips control chars but keeps ANSI text harmless", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		registry.setActivity("a", "multi\nline\ttask with \x1b[31mcolor\x1b[0m");
		// ESC (Cc) is stripped so the terminal cannot interpret it; remaining
		// "[31m" text is inert — the roster is safe without screens inflexible.
		expect(ref.activity).toBe("multi line task with [31mcolor [0m");
	});

	test("aborted is terminal: setStatus cannot resurrect", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		registry.setStatus("a", "aborted");
		expect(registry.setStatus("a", "running")).toBe(false);
		expect(ref.status).toBe("aborted");
		// tombstone rejects session attach too
		expect(registry.attachSession("a", fakeSession)).toBe(false);
	});

	test("attachSession/detachSession honor expected ref (CAS)", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: null });
		expect(registry.attachSession("a", fakeSession, undefined, ref)).toBe(true);
		expect(ref.session).toBe(fakeSession);
		const other = registry.register({ id: "b", displayName: "B", kind: "sub", session: null });
		expect(registry.detachSession("a", other)).toBe(false);
		expect(registry.detachSession("a", ref)).toBe(true);
		expect(ref.session).toBeNull();
	});

	test("setHistory merges defined keys and emits metadata_changed", () => {
		const ref = registry.register({ id: "a", displayName: "A", kind: "sub", session: fakeSession });
		let changed = false;
		registry.onChange(e => {
			if (e.type === "metadata_changed") changed = true;
		});
		expect(registry.setHistory("a", { modelRole: "smol", resolvedModel: undefined })).toBe(true);
		expect(ref.history?.modelRole).toBe("smol");
		expect(ref.history?.resolvedModel).toBeUndefined();
		expect(changed).toBe(true);
	});

	test("registerIfAvailable: absent id registers, parked same-ref reuses, mismatch fails", () => {
		expect(registry.registerIfAvailable({ id: "a", displayName: "A", kind: "sub", session: null }, null)).toBe(
			registry.get("a"),
		);
		// occupied id refuses a second claim
		expect(
			registry.registerIfAvailable({ id: "a", displayName: "A", kind: "sub", session: null }, null),
		).toBeUndefined();
		// parked same-ref is reusable
		registry.setStatus("a", "parked");
		expect(
			registry.registerIfAvailable({ id: "a", displayName: "A", kind: "sub", session: null }, registry.get("a")!),
		).toBe(registry.get("a"));
		// a different expected ref never claims
		const stray = registry.register({ id: "x", displayName: "X", kind: "sub", session: fakeSession });
		expect(
			registry.registerIfAvailable({ id: "a", displayName: "A", kind: "sub", session: null }, stray),
		).toBeUndefined();
	});

	test("listVisibleTo excludes self, advisor, and parked/aborted refs", () => {
		registry.register({ id: "main", displayName: "Main", kind: "main", session: fakeSession });
		registry.register({ id: "s1", displayName: "S1", kind: "sub", session: fakeSession });
		registry.register({ id: "s2", displayName: "S2", kind: "sub", session: fakeSession });
		registry.register({ id: "adv", displayName: "Adv", kind: "advisor", session: fakeSession });
		registry.setStatus("s2", "parked");
		registry.setStatus("s1", "idle");

		const visible = registry.listVisibleTo("main");
		expect(visible.map(r => r.id)).toEqual(["s1"]);
	});
});
